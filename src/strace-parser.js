const PROCESS_SYSCALLS = new Set(["execve", "clone", "clone3", "fork", "vfork"]);
const FILE_SYSCALLS = new Set([
  "access",
  "chmod",
  "chown",
  "creat",
  "copy_file_range",
  "faccessat",
  "faccessat2",
  "fchmodat",
  "fchownat",
  "ftruncate",
  "link",
  "linkat",
  "lstat",
  "mkdir",
  "mknod",
  "newfstatat",
  "open",
  "openat",
  "openat2",
  "readlink",
  "readlinkat",
  "rename",
  "renameat",
  "renameat2",
  "rmdir",
  "stat",
  "statx",
  "symlink",
  "truncate",
  "unlink",
  "unlinkat",
]);
const NETWORK_SYSCALLS = new Set(["connect", "sendto", "recvfrom", "socket"]);

export function parseStrace(text) {
  const result = parseStraceDocument(text);
  Object.defineProperty(result.events, "stats", {
    value: result.stats,
    enumerable: false,
  });
  return result.events;
}

export function parseStraceDocument(text) {
  const missingYy = !/=\s+-?\d+<|<(TCP|UDP|UNIX)/.test(text);

  const events = [];
  const unfinished = new Map();
  const processTree = new Map();
  const pathProbes = new Map();
  const stats = {
    rawLines: 0,
    parsedLines: 0,
    unparsedLines: 0,
    unfinishedLines: 0,
    resumedLines: 0,
    missingYy,
  };

  let rootPid;

  for (const line of text.split(/\r?\n/)) {
    const prepared = prepareLine(line, unfinished, stats);
    if (!prepared) {
      continue;
    }

    const event = parseStraceLine(prepared);
    if (event) {
      if (event.kind === "ignored") continue;

      if (!rootPid && event.pid) rootPid = event.pid;

      const pInfo = processTree.get(event.pid) || { execCount: 0, command: undefined };

      if (event.syscall === "execve" && event.status === "ok") {
        pInfo.execCount++;
        pInfo.command = event.command;
      }

      processTree.set(event.pid, pInfo);

      if (["clone", "clone3", "fork", "vfork"].includes(event.syscall) && event.status === "ok") {
        const childPid = Number(event.result);
        if (!Number.isNaN(childPid)) {
          processTree.set(childPid, {
            ppid: event.pid,
            execCount: 0,
            command: pInfo.command
          });
        }
      }

      const isRoot = event.pid === rootPid;
      let isNoise = isRoot && pInfo.execCount <= 1;

      if (event.syscall === "execve") {
        if (event.status === "failed") {
          if (isRoot && pInfo.execCount === 1) isNoise = false;
          if (!isNoise) {
            const key = event.argv0 || event.command;
            const probes = pathProbes.get(event.pid) || new Map();
            probes.set(key, event);
            pathProbes.set(event.pid, probes);
          }
          continue;
        } else if (event.status === "ok") {
          const key = event.argv0 || event.command;
          const probes = pathProbes.get(event.pid);
          if (probes) probes.delete(key);
        }
      }

      if (isNoise) continue;

      if (pInfo.command) {
        event.processCommand = pInfo.command;
      }
      if (pInfo.ppid) {
        event.parentPid = pInfo.ppid;
      }

      events.push(event);
      stats.parsedLines += 1;
    } else {
      stats.unparsedLines += 1;
    }
  }

  stats.unparsedLines += unfinished.size;

  for (const [pid, probes] of pathProbes.entries()) {
    for (const probe of probes.values()) {
      const pInfo = processTree.get(pid);
      if (pInfo && pInfo.command) probe.processCommand = pInfo.command;
      if (pInfo && pInfo.ppid) probe.parentPid = pInfo.ppid;
      events.push(probe);
      stats.parsedLines += 1;
    }
  }

  // Ensure deterministic sort for probes added at the end
  events.sort((a, b) => (a.pid || 0) - (b.pid || 0));

  return { events, stats };
}

export function parseStraceLine(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  if (/^(?:\d+\s+)?(\+\+\+|---)/.test(trimmed) || trimmed.startsWith("#")) {
    return { kind: "ignored" };
  }

  const match = /^(?:(\d+)\s+)?([a-zA-Z0-9_]+)\((.*)\)\s+=\s+(.+)$/.exec(trimmed);
  if (!match) {
    return null;
  }

  const [, pidText, syscall, argsText, resultText] = match;
  const event = {
    pid: pidText ? Number(pidText) : undefined,
    syscall,
    result: resultText.trim(),
    raw: trimmed,
    status: classifyResult(resultText),
  };

  if (PROCESS_SYSCALLS.has(syscall)) {
    event.kind = "process";
    const strings = extractStrings(argsText);
    event.paths = strings.slice(0, 1);
    event.command = event.paths[0];
    if (syscall === "execve" && strings.length > 1) {
      event.argv0 = strings[1];
    }
  } else if (FILE_SYSCALLS.has(syscall)) {
    event.kind = "file";
    const res = extractFilePaths(syscall, argsText, trimmed);
    event.paths = res.paths;
    event.unresolvedPath = res.unresolved;
    event.access = classifyFileAccess(syscall, argsText);
  } else if (NETWORK_SYSCALLS.has(syscall)) {
    event.kind = "network";
    event.endpoint = extractEndpoint(argsText);
    if (syscall === "connect" && !event.endpoint) {
      event.endpoint = "unparsed";
    }
  } else {
    event.kind = "other";
  }

  if (event.status === "failed") {
    event.failed = true;
  }

  return event;
}

function prepareLine(line, unfinished, stats) {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  stats.rawLines += 1;

  const unfinishedMatch = /^(\d+)\s+(.+)<unfinished \.\.\.>$/.exec(trimmed);
  if (unfinishedMatch) {
    stats.unfinishedLines += 1;
    unfinished.set(unfinishedMatch[1], unfinishedMatch[2]);
    return null;
  }

  const resumedMatch = /^(\d+)\s+<\.\.\. ([a-zA-Z0-9_]+) resumed>(.*)$/.exec(trimmed);
  if (resumedMatch) {
    stats.resumedLines += 1;
    const [, pid, syscall, suffix] = resumedMatch;
    const prefix = unfinished.get(pid);
    unfinished.delete(pid);
    if (prefix?.startsWith(`${syscall}(`)) {
      return `${pid} ${prefix}${suffix}`;
    }
    stats.unparsedLines += 1;
    return null;
  }

  return trimmed;
}

function extractStrings(text) {
  const strings = [];
  const regex = /"((?:\\"|[^"])*)"/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    strings.push(match[1].replaceAll('\\"', '"'));
  }
  return strings;
}

function extractFilePaths(syscall, argsText, rawLine) {
  const resultPath = extractResultPath(rawLine);
  if (resultPath) {
    return { paths: [resultPath], unresolved: false };
  }

  const strings = extractStrings(argsText);
  let paths = [];
  let unresolved = false;

  if (strings.length > 0) {
    let rawPaths = [];
    if (syscall === "rename" || syscall === "renameat" || syscall === "renameat2" || syscall === "link" || syscall === "linkat") {
      rawPaths = [strings[0], strings[1]].filter(Boolean);
    } else if (syscall === "symlink") {
      rawPaths = [strings[1]].filter(Boolean);
    } else {
      rawPaths = [strings[0]].filter(Boolean);
    }

    for (const p of rawPaths) {
      const res = resolveRelativePath(p, argsText);
      paths.push(res.path);
      if (res.unresolved) unresolved = true;
    }
  }

  return { paths, unresolved };
}

function extractResultPath(rawLine) {
  const resultPath = /=\s+-?\d+<([^>]+?)(?:<[^>]*>)?>/.exec(rawLine);
  if (resultPath?.[1]?.startsWith("/")) {
    return resultPath[1];
  }
  return undefined;
}

function resolveRelativePath(value, argsText) {
  if (value.startsWith("/")) {
    return { path: value, unresolved: false };
  }

  const dirfd = /^[^,]+<([^>]+)>/.exec(argsText);
  if (dirfd?.[1]?.startsWith("/")) {
    return { path: `${dirfd[1].replace(/\/$/, "")}/${value.replace(/^\.\//, "")}`, unresolved: false };
  }

  return { path: value, unresolved: true };
}

function classifyFileAccess(syscall, argsText) {
  if (["unlink", "unlinkat", "rmdir", "rename", "renameat", "renameat2"].includes(syscall)) {
    return "write";
  }

  if (["mkdir", "creat", "chmod", "chown", "symlink"].includes(syscall)) {
    return "write";
  }

  if (syscall === "open" || syscall === "openat") {
    if (/\b(O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND)\b/.test(argsText)) {
      return "write";
    }
    return "read";
  }

  if (syscall === "execve") {
    return "execute";
  }

  if (["access", "faccessat", "faccessat2", "lstat", "newfstatat", "readlink", "readlinkat", "stat", "statx"].includes(syscall)) {
    return "read";
  }

  return "unknown";
}

function extractEndpoint(argsText) {
  const address = /sin_addr=inet_addr\("([^"]+)"\)/.exec(argsText);
  const port = /sin_port=htons\((\d+)\)/.exec(argsText);
  if (address && port) {
    return `${address[1]}:${port[1]}`;
  }

  const ipv6Address = /inet_pton\(AF_INET6,\s*"([^"]+)"/.exec(argsText);
  const ipv6Port = /sin6_port=htons\((\d+)\)/.exec(argsText);
  if (ipv6Address && ipv6Port) {
    return `[${ipv6Address[1]}]:${ipv6Port[1]}`;
  }

  const unix = /sun_path="([^"]+)"/.exec(argsText);
  if (unix) {
    return `unix:${unix[1]}`;
  }

  return undefined;
}

function classifyResult(resultText) {
  if (/^-1\s+E(INPROGRESS|AGAIN|WOULDBLOCK)\b/.test(resultText.trim())) {
    return "pending";
  }

  if (resultText.trim().startsWith("-1 ")) {
    return "failed";
  }

  return "ok";
}
