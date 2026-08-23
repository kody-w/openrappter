#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PRIVILEGED = [
  /\bnpm\s+publish\b/,
  /\btwine\s+upload\b/,
  /pypa\/gh-action-pypi-publish/,
  /\bgh\s+release\b/,
  /softprops\/action-gh-release/,
  /\bnpm\s+dist-tag\b/,
  /\bgit\s+push\b.*\btag/,
  /installer[-_ ]?(?:channel|manifest).*(?:write|publish|update)/i,
];

export function auditWorkflows(workflowDir) {
  const violations = [];
  let privilegedCount = 0;
  for (const name of fs.readdirSync(workflowDir).filter(file => file.endsWith('.yml'))) {
    const text = fs.readFileSync(path.join(workflowDir, name), 'utf8');
    if (name.startsWith('release-constitution')) continue;
    const lines = text.split('\n');
    const jobStarts = lines
      .map((line, index) => (/^  [A-Za-z0-9_-]+:\s*$/.test(line) ? index : -1))
      .filter(index => index >= 0);
    for (let index = 0; index < lines.length; index += 1) {
      if (!PRIVILEGED.some(pattern => pattern.test(lines[index]))) continue;
      privilegedCount += 1;
      const start = [...jobStarts].reverse().find(candidate => candidate <= index) ?? -1;
      const end = jobStarts.find(candidate => candidate > start) ?? lines.length;
      const jobName = start >= 0 ? lines[start].trim().replace(/:$/, '') : '<none>';
      const block = lines.slice(start, end).join('\n');
      if (!/needs:\s*(?:\[[^\]]*\brelease-constitution\b[^\]]*\]|release-constitution)/.test(block)) {
        violations.push(`${name}:${index + 1} privileged publish in job ${jobName} bypasses release-constitution`);
      }
    }
  }
  if (privilegedCount < 3) violations.push(`anti-vacuity: found only ${privilegedCount} privileged publish operations`);
  return { privilegedCount, violations };
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = auditWorkflows(path.join(root, '.github', 'workflows'));
  if (result.violations.length) {
    console.error(result.violations.join('\n'));
    process.exit(1);
  }
  console.log(`Release Constitution: ${result.privilegedCount} privileged operations are gated`);
}
