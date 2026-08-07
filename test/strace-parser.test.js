import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseStrace } from "../src/strace-parser.js";
import { buildReport } from "../src/report.js";

test("parses strace file, process, and network events", async () => {
  const text = await readFile(new URL("./fixtures/unit/postinstall.strace", import.meta.url), "utf8");
  const events = parseStrace(text);

  assert.equal(events.length, 6); // First 4 are dropped as wrapper noise
  assert.equal(events.stats.rawLines, 12);
  assert.equal(events.stats.unparsedLines, 0);
  assert.equal(events.stats.resumedLines, 1);
  assert.equal(events.stats.missingYy, false); // It actually does have some hand-authored -yy annotations
  
  // The first kept event is now the execve of curl
  assert.equal(events[0].kind, "process");
  assert.equal(events[0].command, "/usr/bin/curl");
  assert.equal(events[2].kind, "network");
  assert.equal(events[2].endpoint, "203.0.113.10:443");
  assert.equal(events[2].status, "pending");
  assert.equal(events[3].paths[0], "/home/dev/project/.env");
  assert.equal(events[3].unresolvedPath, false);
  assert.equal(events[4].endpoint, "[::1]:9");
  assert.equal(events[5].paths[0], "/tmp/slow.txt");
});

test("builds suspicious path report", async () => {
  const text = await readFile(new URL("./fixtures/unit/postinstall.strace", import.meta.url), "utf8");
  const events = parseStrace(text);
  const report = buildReport({
    packageName: "suspect",
    scriptName: "postinstall",
    command: "node postinstall.js",
    cwd: "/home/dev/project",
    packageDir: "/home/dev/project/node_modules/suspect",
    exitCode: 0,
    events,
  });

  // report.files is 2 instead of 5 because wrapper opens are dropped
  assert.equal(report.summary.fileCount, 2); 
  assert.equal(report.summary.processCount, 1); // Only curl is kept
  assert.equal(report.summary.networkCount, 2);
  assert.equal(report.suspicious.length, 1); // id_rsa is dropped because it happened in the wrapper
  assert.equal(report.suspicious[0].label, "environment file");
  assert.equal(report.trace.unparsedLines, 0);
  assert.equal(report.network[0].status, "pending");
});

test("attributes events to child processes in adversarial fixture", async () => {
  const text = await readFile(new URL("./fixtures/unit/adversarial.strace", import.meta.url), "utf8");
  const events = parseStrace(text);
  const report = buildReport({
    packageName: "suspect",
    scriptName: "postinstall",
    command: "node postinstall.js",
    cwd: "/home/dev/project",
    events,
  });

  const curlNetwork = report.network.find(n => n.endpoint === "203.0.113.10:443");
  assert.ok(curlNetwork);
  assert.equal(curlNetwork.processCommand, "/usr/bin/curl");

  const sshRead = report.suspicious.find(s => s.label === "ssh material");
  assert.ok(sshRead);
  assert.equal(sshRead.processCommand, "/usr/bin/curl");
});

test("tracks child processes in benign fixture", async () => {
  const text = await readFile(new URL("./fixtures/unit/benign.strace", import.meta.url), "utf8");
  const events = parseStrace(text);
  const report = buildReport({
    packageName: "safe",
    scriptName: "postinstall",
    command: "node postinstall.js",
    cwd: "/home/dev/project",
    events,
  });

  assert.equal(report.summary.suspiciousCount, 0);
  const fileAccess = report.files.find(f => f.path === "/home/dev/project/node_modules/safe/build/output.node");
  assert.ok(fileAccess);
});

test("D1: captures shell payload in-place exec (bash ./steal.sh)", async () => {
  const text = await readFile(new URL("./fixtures/unit/steal.strace", import.meta.url), "utf8");
  const events = parseStrace(text);
  const report = buildReport({
    packageName: "suspect",
    scriptName: "postinstall",
    command: "bash ./steal.sh",
    cwd: "/home/dev/project",
    events,
  });

  assert.equal(report.summary.suspiciousCount, 1);
  assert.equal(report.suspicious[0].label, "ssh material");
  assert.equal(report.suspicious[0].path, "/home/dev/.ssh/id_rsa");
});

test("PATH probe suppression: collapses unresolved and suppresses resolved", async () => {
  const text = await readFile(new URL("./fixtures/unit/probes.strace", import.meta.url), "utf8");
  const events = parseStrace(text);
  const report = buildReport({
    packageName: "suspect",
    scriptName: "postinstall",
    command: "bash ./payload.sh",
    cwd: "/home/dev/project",
    events,
  });

  // curl: 2 failures suppressed because of 1 success
  // missing: 1 failure kept (collapsed), 1 failure suppressed
  // Total suppressed: 3
  assert.equal(report.summary.pathSearchProbesSuppressed, 3);
  
  // The only files kept are the first probe for `missing` and the successful one for `curl`
  assert.equal(report.summary.fileCount, 2);
  assert.ok(report.files.find(f => f.path === "/usr/local/bin/missing"));
  assert.ok(report.files.find(f => f.path === "/bin/curl"));
});
