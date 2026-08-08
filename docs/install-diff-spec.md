# `trace-npm diff` — design spec

**Status:** proposed, not implemented.
**Author:** design pass, 8 August 2026.

---

## The problem it solves

`trace-npm run` needs `strace`, so live tracing is Linux-only. That is the single
biggest limit on who can use this tool: most developers evaluating a suspicious
package are sitting at a Mac.

`diff` is the portable subset. It answers a narrower question using only
facilities every platform has:

> **What did this lifecycle script change on disk?**

No syscalls, no ptrace, no privileges. Snapshot, run, snapshot, compare.

It does **not** replace `run`. On Linux, `run` sees strictly more. `diff` exists
so that the answer to "can I use this?" stops being "only on Linux."

---

## What it cannot see

This section is not a caveat at the end. It is the design constraint, and it
belongs at the top of the spec for the same reason it belongs in the report:
someone will read the output detached from everything else.

A disk diff is blind to:

- **Network activity.** Credentials read and posted to a remote host produce no
  disk change at all. A completely clean `diff` is consistent with total
  compromise.
- **Reads.** Only writes are visible. A script that reads `~/.ssh/id_rsa` and
  exfiltrates it looks identical to a script that does nothing.
- **Process spawns.** Anything that ran and exited leaves no trace.
- **Environment variables.** Read, or set for a child process.
- **Transient files.** Created and deleted inside the window. Invisible.
- **Anything outside the scanned roots.**

`run` sees all of the above on Linux. `diff` sees none of them anywhere.

**Therefore the report's headline must not be a verdict.** It must state the
question it answered, in the artifact, every time:

```
This report covers filesystem changes only. It cannot see network
activity, file reads, spawned processes, or environment variables.
A clean diff is not evidence that a package is safe.
```

---

## The attribution problem

The naive design — snapshot, `npm install`, snapshot — is close to useless,
because npm itself writes thousands of files. The script's changes drown in the
install's changes, and separating them requires knowing what npm would have done
anyway.

**Design: isolate the script, not the install.**

```
1. npm install --ignore-scripts        # npm does its work, scripts do not run
2. snapshot                            # baseline: post-install, pre-script
3. run the lifecycle script            # the subject
4. snapshot                            # after
5. diff 2 against 4
```

Everything in that diff is attributable to the script, because nothing else ran
between the two snapshots. This mirrors what `run` already does and reuses the
same `--i-understand-this-executes-untrusted-code` gate, because step 3 is still
executing untrusted code — `diff` is not a safer mode, it is a blinder one.

---

## Scan roots

Three roots, each justified:

| root | why | default |
|---|---|---|
| the project directory | where a script plants files, patches configs, edits `package.json` | on |
| the synthetic `HOME` | reuses `run`'s canary home; catches writes to `.npmrc`, `.ssh`, shell profiles | on |
| the real `HOME` | a script escaping the synthetic home is a finding in itself | off, opt-in |

`/tmp` and system paths are excluded by default and the exclusion is **counted
and reported**, per rule 4. Silent exclusion is the defect.

---

## What to record per file

Two-tier, because hashing a large `node_modules` on every run is the difference
between a tool people use and one they don't.

**Tier 1 — always, cheap.** `path`, `size`, `mtimeMs`, `mode`, `isSymlink`,
`symlinkTarget`. One `lstat` per entry. Detects created, deleted, resized,
chmod'd, and re-linked files.

**Tier 2 — content hash, selective.** A file needs hashing only if tier 1 says it
existed before and after with identical size and mtime, and it sits in a
sensitive location. That catches the case tier 1 misses: an in-place edit that
preserves size and restores mtime.

Sensitive by default: `package.json`, `.npmrc`, `.git/config`, `.git/hooks/*`,
anything under `.ssh`, shell profiles, `*.pth`, and any executable bit set.

Hash with `sha256`, streamed, and record `filesHashed` and `filesSkipped` in the
report. **A number that says how much was not checked is the point.**

---

## Findings, ranked

The report ranks by what a reader should look at first, not alphabetically:

1. **Wrote outside the package directory** — the strongest disk-only signal.
2. **Touched credential or config paths** — `.npmrc`, `.ssh`, `.git/config`,
   `.git/hooks`, shell profiles.
3. **Created an executable** — new file with a mode bit set.
4. **Modified in place with size and mtime preserved** — only detectable via
   tier 2, and deliberate mtime restoration is itself a signal worth naming.
5. **Symlink created pointing outside the project.**
6. Everything else, counted, not enumerated.

---

## Open questions, to settle before implementing

1. **mtime granularity.** Some filesystems have coarse timestamps; APFS and ext4
   differ. A fast script could write inside one tick and be missed by tier 1.
   Does tier 2 need to cover more, and what does that cost on a real
   `node_modules`? **Measure before deciding.**
2. **Do we snapshot `node_modules` at all?** It is the largest tree and the most
   likely place for a planted file. Skipping it is fast and wrong. Include it,
   measure, then optimise.
3. **Windows.** `mode` and the executable bit do not mean the same thing. Either
   support it properly or state plainly that `diff` is macOS and Linux.
4. **Can the canary home contribute anything without `strace`?** Reads are
   invisible, and `atime` is unreliable under `relatime`. Current answer: no —
   which must be said, because a user who knows `run` uses canaries will assume
   `diff` does too.

---

## Success criteria

`diff` is worth shipping if, and only if:

- it runs on macOS with no privileges and no Docker;
- on a package with a known malicious postinstall that writes to disk, it names
  the file;
- on a benign package, it produces **zero** findings — a tool that cries wolf on
  `esbuild` gets uninstalled, and rule 4 warns about exactly this;
- every report states the four blindnesses above, in the artifact;
- the counts of skipped and unhashed files appear in every report.

The second and third criteria need real fixtures — generated by running real
packages and committing what came out, never hand-authored.
