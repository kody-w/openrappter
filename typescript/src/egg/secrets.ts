import JSON5 from 'json5';
import YAML from 'yaml';
import { isSecretKey } from '../security/secret-keys.js';
import {
  containsSecretShapedText,
  REDACTED,
  redactSecrets,
} from '../security/redact.js';

const TEXT_MIME = /^(?:text\/|application\/(?:json|x-ndjson|yaml|toml))/;

function redactAssignments(text: string, separator: '=' | ':'): string {
  return text.split(/\r?\n/).map((line) => {
    const match = line.match(
      separator === '='
        ? /^(\s*)(["']?)([A-Za-z_][A-Za-z0-9_. -]*)\2(\s*=\s*)(.*)$/
        : /^(\s*)(["']?)([A-Za-z_][A-Za-z0-9_. -]*)\2(\s*:\s*)(.*)$/,
    );
    if (!match || !isSecretKey(match[3].trim())) return line;
    return `${match[1]}${match[2]}${match[3]}${match[2]}${match[4]}"${REDACTED}"`;
  }).join('\n');
}

export function sanitizePortableStructured(
  filePath: string,
  mime: string,
  bytes: Uint8Array,
): Uint8Array {
  const extension = filePath.toLowerCase().split('.').pop() ?? '';
  const text = Buffer.from(bytes).toString('utf8');
  let sanitized: string;
  if (extension === 'json') {
    sanitized = `${JSON.stringify(redactSecrets(JSON.parse(text)), null, 2)}\n`;
  } else if (extension === 'json5') {
    sanitized = `${JSON.stringify(redactSecrets(JSON5.parse(text)), null, 2)}\n`;
  } else if (extension === 'jsonl') {
    sanitized = text.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try {
        return JSON.stringify(redactSecrets(JSON.parse(line)));
      } catch {
        throw new Error(`${filePath}:${index + 1} is not valid JSONL`);
      }
    }).join('\n') + (text.endsWith('\n') ? '\n' : '');
  } else if (extension === 'yaml' || extension === 'yml') {
    sanitized = YAML.stringify(redactSecrets(YAML.parse(text)));
  } else if (extension === 'toml' || extension === 'env') {
    sanitized = redactAssignments(text, '=');
  } else if (TEXT_MIME.test(mime)) {
    sanitized = text;
  } else {
    // Binary formats are retained byte-exact, then raw-scanned below. A
    // sensitive format without a structural parser must never reach here.
    if (/config|credential|auth|secret|token/i.test(filePath)) {
      throw new Error(`Portable export cannot safely parse sensitive format ${filePath}`);
    }
    assertNoPortableSecrets(filePath, bytes);
    return bytes;
  }
  const output = Buffer.from(sanitized, 'utf8');
  assertNoPortableSecrets(filePath, output);
  return output;
}

export function assertNoPortableSecrets(filePath: string, bytes: Uint8Array): void {
  const raw = Buffer.from(bytes);
  const utf8 = raw.toString('utf8');
  const latin1 = raw.toString('latin1');
  if (containsSecretShapedText(utf8) || containsSecretShapedText(latin1)) {
    throw new Error(`Portable egg secret-shape scan rejected ${filePath}`);
  }
}
