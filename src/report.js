const SENSITIVE_PATH_PATTERNS = [
  { label: "ssh material", regex: /(^|\/)\.ssh(\/|$)/ },
  { label: "aws credentials", regex: /(^|\/)\.aws(\/|$)/ },
  { label: "gcloud credentials", regex: /(^|\/)\.config\/gcloud(\/|$)/ },
  { label: "npm token config", regex: /(^|\/)\.npmrc$/ },
  { label: "environment file", regex: /(^|\/)\.env(\.|$)/ },
  { label: "shell profile", regex: /(^|\/)\.(zshrc|bashrc|bash_profile|profile)$/ },
  { label: "macOS keychain", regex: /\/Library\/Keychains(\/|$)/ },
];

export function buildReport(input) {
  const files = new Map();
  const processes = [];
  const network = [];
  const suspicious = [];
  const homeDir = input.homeDir;

  for (const event of input.events) {
    if (event.kind === "file") {
      for (const rawPath of event.paths ?? []) {
        const normalized = redactHome(normalizePath(rawPath), homeDir);
        const existing = files.get(normalized) ?? {
          path: normalized,
          access: new Set(),
          syscalls: new Set(),
          statuses: new Set(),
        };
        existing.access.add(event.access);
        existing.syscalls.add(event.syscall);
        existing.statuses.add(event.status ?? "unknown");
        files.set(normalized, existing);

        for (const finding of classifySensitivePath(normalized)) {
          suspicious.push({
            type: "sensitive-path",
            label: finding.label,
            path: normalized,
            syscall: event.syscall,
            access: event.access,
            pid: event.pid,
            processCommand: event.processCommand,
          });
        }
      }
    }

    if (event.kind === "process" && event.command) {
      processes.push({
        pid: event.pid,
        command: redactHome(event.command, homeDir),
        syscall: event.syscall,
        status: event.status ?? "unknown",
        failed: event.failed,
        result: event.result,
      });
    }

    if (event.kind === "network" && (event.endpoint || event.syscall === "connect")) {
      network.push({
        pid: event.pid,
        endpoint: event.endpoint ?? "unparsed",
        syscall: event.syscall,
        status: event.status ?? "unknown",
        raw: event.endpoint ? undefined : event.raw,
        processCommand: event.processCommand,
      });
    }
  }

  const dedupedSuspicious = dedupeFindings(suspicious);

  return {
    schemaVersion: 1,
    package: input.packageName,
    script: input.scriptName,
    command: input.command,
    cwd: input.cwd,
    packageDir: input.packageDir,
    exitCode: input.exitCode,
    trace: input.traceStats ?? {
      rawLines: input.events.length,
      parsedLines: input.events.length,
      unparsedLines: 0,
    },
    summary: {
      eventCount: input.events.length,
      fileCount: files.size,
      processCount: processes.length,
      networkCount: network.length,
      suspiciousCount: dedupedSuspicious.length,
    },
    files: [...files.values()].map((file) => ({
      path: file.path,
      access: [...file.access].sort(),
      syscalls: [...file.syscalls].sort(),
      statuses: [...file.statuses].sort(),
    })).sort((a, b) => a.path.localeCompare(b.path)),
    processes,
    network,
    suspicious: dedupedSuspicious,
    limitations: [
      ...(input.traceStats?.missingYy ? ["WARNING: The trace was captured without '-yy' dirfd annotations. Relative paths could not be fully resolved and may be incomplete."] : []),
      "This report is evidence, not a verdict. It does not prove a package is safe.",
      "Connection status 'pending' means a non-blocking connection was initiated; final outcome was not determined.",
      "Hostnames are not resolved. Network endpoints are reported as observed addresses where available.",
      "File contents are not captured; only file access metadata is reported.",
      "Only traced file/process/network syscalls are represented.",
      "A clean report can miss input-dependent behavior or untraced syscall classes.",
    ],
  };
}

export function renderMarkdownReport(report) {
  const lines = [];
  lines.push(`# trace-npm report`);
  lines.push("");
  lines.push(`- Package: \`${report.package}\``);
  lines.push(`- Script: \`${report.script}\``);
  lines.push(`- Command: \`${report.command}\``);
  if (report.exitCode !== undefined) {
    lines.push(`- Exit code: \`${report.exitCode}\``);
  }
  lines.push(`- Events: \`${report.summary.eventCount}\``);
  lines.push(`- Raw trace lines: \`${report.trace.rawLines}\``);
  lines.push(`- Unparsed trace lines: \`${report.trace.unparsedLines}\``);
  lines.push(`- Files touched: \`${report.summary.fileCount}\``);
  lines.push(`- Processes spawned: \`${report.summary.processCount}\``);
  lines.push(`- Network endpoints: \`${report.summary.networkCount}\``);
  lines.push(`- Suspicious findings: \`${report.summary.suspiciousCount}\``);
  lines.push("");

  if (report.suspicious.length > 0) {
    lines.push(`## Suspicious Findings`);
    lines.push("");
    for (const finding of report.suspicious) {
      const byCommand = finding.processCommand ? ` by \`${finding.processCommand}\`` : "";
      lines.push(`- ${finding.label}: \`${finding.path}\`${byCommand} (${finding.access}, ${finding.syscall})`);
    }
    lines.push("");
  }

  if (report.network.length > 0) {
    lines.push(`## Network`);
    lines.push("");
    for (const event of report.network) {
      const byCommand = event.processCommand ? ` by \`${event.processCommand}\`` : "";
      lines.push(`- \`${event.endpoint}\`${byCommand} via \`${event.syscall}\` (${event.status})`);
    }
    lines.push("");
  }

  if (report.processes.length > 0) {
    lines.push(`## Processes`);
    lines.push("");
    for (const event of report.processes) {
      if (event.failed && event.syscall === "execve") {
        const error = event.result.replace(/^-1\s+/, "");
        lines.push(`- attempted: \`${event.command}\` (${error})`);
      } else {
        lines.push(`- \`${event.command}\` via \`${event.syscall}\` (${event.status})`);
      }
    }
    lines.push("");
  }

  if (report.files.length > 0) {
    lines.push(`## Files`);
    lines.push("");
    for (const file of report.files) {
      lines.push(`- \`${file.path}\` [${file.access.join(", ")}] via ${file.syscalls.map((name) => `\`${name}\``).join(", ")} (${file.statuses.join(", ")})`);
    }
    lines.push("");
  }

  lines.push(`## Limitations`);
  lines.push("");
  for (const limitation of report.limitations) {
    lines.push(`- ${limitation}`);
  }
  if (report.trace.unparsedLines > 0) {
    lines.push(`- ${report.trace.unparsedLines} trace lines could not be parsed and are not represented in detail.`);
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function normalizePath(value) {
  return value.replaceAll("//", "/");
}

function redactHome(value, homeDir) {
  if (!homeDir) {
    return value;
  }
  const normalizedHome = normalizePath(homeDir);
  const normalizedValue = normalizePath(value);
  if (normalizedValue === normalizedHome) {
    return "~";
  }
  if (normalizedValue.startsWith(`${normalizedHome}/`)) {
    return `~/${normalizedValue.slice(normalizedHome.length + 1)}`;
  }
  return value;
}

function classifySensitivePath(filePath) {
  return SENSITIVE_PATH_PATTERNS.filter((pattern) => pattern.regex.test(filePath));
}

function dedupeFindings(findings) {
  const seen = new Set();
  const result = [];

  for (const finding of findings) {
    const key = `${finding.type}:${finding.label}:${finding.path}:${finding.syscall}:${finding.access}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(finding);
    }
  }

  return result;
}
