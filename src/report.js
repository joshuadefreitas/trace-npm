import { SYSTEM_FILE_PREFIXES } from "./constants.js";

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

  // Pass 1: Identify and suppress failed PATH search probes (ENOENT stat-family events)
  const STAT_SYSCALLS = new Set(["stat", "lstat", "newfstatat", "statx", "access", "faccessat", "faccessat2"]);
  const probes = new Map();

  for (const event of input.events) {
    if (event.kind === "file" && event.paths) {
      const isStat = STAT_SYSCALLS.has(event.syscall);
      for (const rawPath of event.paths) {
        const parts = rawPath.split('/');
        const basename = parts.pop();
        const dir = parts.join('/');
        
        let pidMap = probes.get(event.pid);
        if (!pidMap) { pidMap = new Map(); probes.set(event.pid, pidMap); }
        
        let probeInfo = pidMap.get(basename);
        if (!probeInfo) { probeInfo = { dirs: new Set(), failedEvents: [], hasSuccess: false }; pidMap.set(basename, probeInfo); }
        
        probeInfo.dirs.add(dir);
        
        const isError = event.result && event.result.includes("ENOENT");
        if (isStat && isError) {
          probeInfo.failedEvents.push({ event, rawPath });
        } else if (event.result === "0" || (event.result && !event.result.startsWith("-1"))) {
          probeInfo.hasSuccess = true;
        }
      }
    }
  }

  const suppressedPaths = new Map();
  let pathSearchProbesSuppressed = 0;

  for (const pidMap of probes.values()) {
    for (const info of pidMap.values()) {
      if (info.dirs.size > 1) { // It's a search across multiple directories
        const nonSensitiveFails = info.failedEvents.filter(e => classifySensitivePath(e.rawPath).length === 0);
        
        if (info.hasSuccess) {
          // Resolved successfully: suppress all non-sensitive failed probes
          for (const e of nonSensitiveFails) {
            let s = suppressedPaths.get(e.event);
            if (!s) { s = new Set(); suppressedPaths.set(e.event, s); }
            s.add(e.rawPath);
            pathSearchProbesSuppressed++;
          }
        } else {
          // Never resolves: collapse to ONE entry (keep the first, suppress the rest)
          if (nonSensitiveFails.length > 0) {
            for (let i = 1; i < nonSensitiveFails.length; i++) {
              let s = suppressedPaths.get(nonSensitiveFails[i].event);
              if (!s) { s = new Set(); suppressedPaths.set(nonSensitiveFails[i].event, s); }
              s.add(nonSensitiveFails[i].rawPath);
              pathSearchProbesSuppressed++;
            }
          }
        }
      }
    }
  }

  // Pass 2: Build the report
  for (const event of input.events) {
    if (event.kind === "file") {
      for (const rawPath of event.paths ?? []) {
        if (suppressedPaths.get(event)?.has(rawPath)) {
          continue; // suppressed PATH probe
        }
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
      pathSearchProbesSuppressed,
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

export function renderMarkdownReport(report, options = {}) {
  const isSystemFile = (p) => SYSTEM_FILE_PREFIXES.some(prefix => p.startsWith(prefix));
  const systemFilesHidden = !options.verbose ? report.files.filter(f => isSystemFile(f.path)).length : 0;
  const visibleFiles = report.files.length - systemFilesHidden;

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
  lines.push(`- Files touched: \`${report.summary.fileCount}\`${systemFilesHidden > 0 ? ` (${visibleFiles} outside system paths)` : ""}`);
  lines.push(`- Processes spawned: \`${report.summary.processCount}\``);
  lines.push(`- Network endpoints: \`${report.summary.networkCount}\``);
  lines.push(`- Suspicious findings: \`${report.summary.suspiciousCount}\``);
  if (report.summary.pathSearchProbesSuppressed > 0) {
    lines.push(`- Suppressed PATH probes: \`${report.summary.pathSearchProbesSuppressed}\``);
  }
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
    const isDns = (ep) => ep.endsWith(":53") || ep.includes("/var/run/nscd/socket");
    const realConnections = report.network.filter((e) => !isDns(e.endpoint));
    const dnsConnections = report.network.filter((e) => isDns(e.endpoint));

    if (realConnections.length > 0) {
      lines.push(`## Network`);
      lines.push("");
      for (const event of realConnections) {
        const byCommand = event.processCommand ? ` by \`${event.processCommand}\`` : "";
        lines.push(`- \`${event.endpoint}\`${byCommand} via \`${event.syscall}\` (${event.status})`);
      }
      lines.push("");
    }

    if (dnsConnections.length > 0) {
      lines.push(`### Name resolution (${dnsConnections.length} events)`);
      for (const event of dnsConnections) {
        lines.push(`- \`${event.endpoint}\``);
      }
      lines.push("");
    }
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

  if (!options.brief && report.files.length > 0) {
    if (systemFilesHidden > 0) {
      lines.push(`## Files (${visibleFiles} shown, ${systemFilesHidden} system and loader paths hidden — use --verbose)`);
    } else {
      lines.push(`## Files`);
    }
    lines.push("");
    for (const file of report.files) {
      if (!options.verbose && isSystemFile(file.path)) {
        continue;
      }
      lines.push(`- \`${file.path}\` [${file.access.join(", ")}] via ${file.syscalls.map((name) => `\`${name}\``).join(", ")} (${file.statuses.join(", ")})`);
    }
    lines.push("");
  }

  if (!options.brief) {
    lines.push(`## Limitations`);
    lines.push("");
    for (const limitation of report.limitations) {
      lines.push(`- ${limitation}`);
    }
    if (report.trace.unparsedLines > 0) {
      lines.push(`- ${report.trace.unparsedLines} trace lines could not be parsed and are not represented in detail.`);
    }
    lines.push("");
  } else {
    lines.push(`- Run without \`--brief\` for the full report.`);
    lines.push("");
  }

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
