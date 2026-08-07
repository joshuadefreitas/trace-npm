import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseStrace } from "./strace-parser.js";
import { buildReport, renderMarkdownReport } from "./report.js";
import { redactSecrets } from "./secrets.js";
import { STRACE_FLAGS } from "./constants.js";

const VERSION = "0.1.0-alpha";

export async function main(argv) {
  const command = argv[0];

  if (command === "--version" || command === "-v" || command === "version") {
    console.log(VERSION);
    return;
  }

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "run") {
    await runCommand(argv.slice(1));
    return;
  }

  if (command === "report") {
    await reportCommand(argv.slice(1));
    return;
  }

  throw new Error(`unknown command "${command}"`);
}

function printHelp() {
  console.log(`trace-npm

Forensic reports for npm lifecycle scripts.

Usage:
  trace-npm run --package <name> --script <script> --i-understand-this-executes-untrusted-code [--cwd <dir>] [--json]
  trace-npm report --trace-file <path> --package <name> --script <script> [--json]

Examples:
  trace-npm run --package esbuild --script postinstall --i-understand-this-executes-untrusted-code
  trace-npm report --trace-file ./postinstall.strace --package suspect --script postinstall --json

Notes:
  - Linux + strace is required for "run".
  - "report" works anywhere with a saved strace log.
  - Host execution is unsafe and requires an explicit danger flag.
  - Suspicious findings exit with code 2 by default.
`);
}

async function runCommand(argv) {
  const options = parseOptions(argv);
  requireOption(options.package, "--package");
  requireOption(options.script, "--script");

  if (!options.iUnderstandThisExecutesUntrustedCode) {
    throw new Error(`"run" executes the package script on this machine. Re-run with --i-understand-this-executes-untrusted-code if intentional.`);
  }

  if (process.platform !== "linux") {
    throw new Error(`"run" requires Linux + strace. Use "report --trace-file" on ${process.platform}.`);
  }

  await assertExecutable("strace");

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const packageDir = await resolvePackageDir(cwd, options.package);
  const manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
  const scriptCommand = manifest.scripts?.[options.script];

  if (!scriptCommand) {
    throw new Error(`package "${options.package}" has no "${options.script}" script`);
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "trace-npm-"));
  const traceFile = path.join(tmpDir, "trace.log");
  const syntheticHome = path.join(tmpDir, "home");
  await mkdir(syntheticHome);

  // Populate canary credentials to catch conditional exfiltration
  await mkdir(path.join(syntheticHome, ".ssh"));
  await writeFile(path.join(syntheticHome, ".ssh", "id_rsa"), "CANARY_KEY_DO_NOT_USE\n", { mode: 0o600 });
  await writeFile(path.join(syntheticHome, ".npmrc"), "//registry.npmjs.org/:_authToken=npm_canary_token_do_not_use\n", { mode: 0o600 });
  await mkdir(path.join(syntheticHome, ".aws"));
  await writeFile(path.join(syntheticHome, ".aws", "credentials"), "[default]\naws_access_key_id=CANARY_KEY\naws_secret_access_key=CANARY_SECRET\n", { mode: 0o600 });

  try {
    const env = {
      ...process.env,
      PATH: [
        path.join(cwd, "node_modules", ".bin"),
        path.join(packageDir, "node_modules", ".bin"),
        process.env.PATH ?? "",
      ].join(path.delimiter),
      npm_lifecycle_event: options.script,
      npm_package_name: manifest.name ?? options.package,
      npm_package_version: manifest.version ?? "",
      HOME: syntheticHome,
    };

    const result = await spawnChecked("strace", [
      ...STRACE_FLAGS,
      "-o",
      traceFile,
      "sh",
      "-c",
      scriptCommand,
    ], { cwd: packageDir, env, timeoutMs: Number(options.timeoutMs ?? 60000) });

    const traceText = await readFile(traceFile, "utf8");
    const events = parseStrace(traceText);
    const report = buildReport({
      packageName: options.package,
      scriptName: options.script,
      command: scriptCommand,
      cwd,
      packageDir,
      exitCode: result.code,
      events,
      traceStats: events.stats,
      homeDir: os.homedir(),
    });

    emitReport(report, options);
  } finally {
    if (!options.keepTrace) {
      await rm(tmpDir, { recursive: true, force: true });
    } else {
      console.error(`trace-npm: kept trace at ${traceFile}`);
    }
  }
}

async function reportCommand(argv) {
  const options = parseOptions(argv);
  requireOption(options.traceFile, "--trace-file");
  requireOption(options.package, "--package");
  requireOption(options.script, "--script");

  const traceText = await readFile(path.resolve(options.traceFile), "utf8");
  const events = parseStrace(traceText);
  const report = buildReport({
    packageName: options.package,
    scriptName: options.script,
    command: options.command ?? "(saved trace)",
    cwd: path.resolve(options.cwd ?? process.cwd()),
    packageDir: options.packageDir ? path.resolve(options.packageDir) : undefined,
    exitCode: options.exitCode === undefined ? undefined : Number(options.exitCode),
    events,
    traceStats: events.stats,
    homeDir: options.redactHome === "false" ? undefined : os.homedir(),
  });

  emitReport(report, options);
}

function emitReport(report, options) {
  const rawOutput = options.json ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdownReport(report);
  const { text: output, findings } = redactSecrets(rawOutput);

  if (findings.length > 0) {
    const labels = findings.map((finding) => finding.label).join(", ");
    process.stderr.write(`trace-npm: redacted secret-looking output (${labels})\n`);
  }

  process.stdout.write(output);

  const failOn = options.failOn ?? "suspicious";
  if (failOn === "suspicious" && report.summary.suspiciousCount > 0) {
    process.exitCode = 2;
  } else if (failOn === "network" && report.summary.networkCount > 0) {
    process.exitCode = 2;
  }
}

function parseOptions(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg.includes("=") && arg.startsWith("--")) {
      const [rawKey, ...rawValue] = arg.slice(2).split("=");
      options[toCamelCase(rawKey.replaceAll("-", "_"))] = rawValue.join("=");
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--allow-secrets") {
      options.allowSecrets = true;
    } else if (arg === "--keep-trace") {
      options.keepTrace = true;
    } else if (arg === "--i-understand-this-executes-untrusted-code") {
      options.iUnderstandThisExecutesUntrustedCode = true;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2).replaceAll("-", "_");
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      options[toCamelCase(key)] = next;
      index += 1;
    } else {
      throw new Error(`unexpected argument "${arg}"`);
    }
  }

  return options;
}

function toCamelCase(value) {
  return value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function requireOption(value, name) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
}

async function resolvePackageDir(cwd, packageName) {
  const packagePath = packageName.startsWith("@")
    ? path.join(cwd, "node_modules", ...packageName.split("/"))
    : path.join(cwd, "node_modules", packageName);
  const manifestPath = path.join(packagePath, "package.json");

  try {
    await access(manifestPath, constants.R_OK);
  } catch {
    throw new Error(`could not find installed package at ${manifestPath}`);
  }

  return packagePath;
}

async function assertExecutable(command) {
  await spawnChecked("sh", ["-lc", `command -v ${shellQuote(command)} >/dev/null`], { cwd: process.cwd() });
}

function spawnChecked(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs)
      : undefined;

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (timedOut) {
        reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
        return;
      }
      if (signal) {
        reject(new Error(`${command} terminated by ${signal}`));
        return;
      }
      resolve({ code, stderr });
    });
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
