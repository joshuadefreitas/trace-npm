const SECRET_PATTERNS = [
  { label: "OpenAI API key", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: "GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { label: "AWS access key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "private key block", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

export function scanTextForSecrets(text) {
  const findings = [];

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.regex.test(text)) {
      findings.push({ label: pattern.label });
    }
  }

  return findings;
}

export function redactSecrets(text) {
  let redacted = text;
  const findings = [];

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.regex.test(redacted)) {
      findings.push({ label: pattern.label });
      redacted = redacted.replace(pattern.regex, (match) => `${match.slice(0, 4)}••••`);
    }
  }

  return { text: redacted, findings };
}
