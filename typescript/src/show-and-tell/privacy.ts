import { sanitizeFlightValue } from '../flight-recorder/redaction.js';
import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';

const OPAQUE_PATH_SEGMENT =
  /^(?:[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f-]{27,}|[A-Za-z0-9_-]{36,})$/i;
const JWT_TOKEN =
  /(?:^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,})(?:$|[^A-Za-z0-9_-])/;

const PRIVATE_CONTEXT =
  /\b(?:1password|bitwarden|keychain|password|passkey|credential|secret|token|private key|security code|sign[ -]?in|log[ -]?in|incognito|inprivate|private browsing)\b/i;

const NAMED_KEYS = new Set([
  'return', 'enter', 'tab', 'space', 'delete', 'escape', 'esc',
  'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
]);

function isNonTextKeyCommand(value: string): boolean {
  const parts = value.toLowerCase().split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 1) return NAMED_KEYS.has(parts[0]);
  const modifiers = new Set(['cmd', 'command', 'ctrl', 'control', 'alt', 'option', 'shift']);
  return (
    parts.slice(0, -1).every((part) => modifiers.has(part)) &&
    (NAMED_KEYS.has(parts.at(-1) ?? '') || /^[a-z0-9]$/.test(parts.at(-1) ?? ''))
  );
}

export function sanitizeShowAndTellValue<T>(value: T): T {
  return sanitizeFlightValue(value) as T;
}

export function sanitizeShowAndTellText(value: unknown, maxLength = 1000): string {
  if (typeof value !== 'string') return '';
  const bounded = Array.from(value).slice(0, maxLength).join('');
  const sanitized = sanitizeFlightValue(bounded);
  return typeof sanitized === 'string' ? sanitized : '';
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function containsJwt(value: unknown): boolean {
  if (typeof value === 'string') {
    return JWT_TOKEN.test(value) || JWT_TOKEN.test(decoded(value));
  }
  if (Array.isArray(value)) return value.some(containsJwt);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsJwt);
  }
  return false;
}

function isOpaquePathSegment(segment: string): boolean {
  const candidate = decoded(segment);
  if (JWT_TOKEN.test(candidate)) return true;
  if (OPAQUE_PATH_SEGMENT.test(candidate)) return true;
  if (candidate.length < 16 || !/^[A-Za-z0-9_-]+$/.test(candidate)) return false;
  const counts = new Map<string, number>();
  for (const character of candidate) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / candidate.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= 3.5;
}

export function privacyReducedUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname
      .split('/')
      .map((segment) => (isOpaquePathSegment(segment) ? ':id' : segment))
      .join('/');
    return sanitizeShowAndTellText(parsed.toString(), 1000);
  } catch {
    return '';
  }
}

export function privacyReducedPath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const value = sanitizeShowAndTellText(raw.trim(), 1000);
  const normalized = value.replace(/\\/g, '/');
  const home = homedir().replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalized === '~' || normalized.startsWith('~/')) return normalized;
  if (normalized === home) return '~';
  if (normalized.startsWith(`${home}/`)) return `~${normalized.slice(home.length)}`;
  if (/^(?:[A-Za-z]:\/|\/)/.test(normalized)) {
    const basename = normalized.split('/').filter(Boolean).at(-1) ?? 'path';
    return `<absolute>/${basename}`;
  }
  return '';
}

export function isPrivateContext(app: string, window: string, url = ''): boolean {
  return PRIVATE_CONTEXT.test(`${app} ${window} ${decoded(url)}`);
}

export function artifactContainsSensitiveText(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as unknown;
    return containsJwt(parsed) ||
      !isDeepStrictEqual(sanitizeFlightValue(parsed), parsed);
  } catch {
    return containsJwt(content) || content
      .split(/\r?\n/)
      .some((line) => sanitizeFlightValue(line) !== line);
  }
}

/**
 * Fixed-width replacement for anything sensitive.
 *
 * The width is constant on purpose. A mask that mirrors the length of what it
 * hid still discloses the length, which is enough to distinguish a four digit
 * PIN from a passphrase, or to confirm a guessed account number's shape.
 */
export const SENSITIVE_MASK = '[redacted]';

export type SensitiveKind =
  | 'jwt'
  | 'token'
  | 'authorization'
  | 'credential-url'
  | 'private-key'
  | 'assignment'
  | 'payment-card'
  | 'government-id'
  | 'email'
  | 'sanitizer'
  | 'unscanned';

export interface SensitiveFinding {
  /** JSON-ish path of the value that matched, e.g. `$.steps[0].detail`. */
  path: string;
  kind: SensitiveKind;
  count: number;
}

/**
 * Kinds that must never reach an artifact. The rest are privacy problems that
 * masking genuinely solves — a person's address is not a credential, but it
 * still has no business being frozen into a shared skill.
 */
export const SENSITIVE_SECRET_KINDS: ReadonlySet<SensitiveKind> = new Set([
  'jwt',
  'token',
  'authorization',
  'credential-url',
  'private-key',
  'assignment',
  'sanitizer',
]);

interface SensitiveRule {
  kind: SensitiveKind;
  pattern: RegExp;
  /** Optional second opinion; a match that fails it is not reported. */
  confirm?: (match: string) => boolean;
}

/**
 * Ordered most specific first: the scan rewrites text as it goes, so a JWT is
 * masked as a JWT before the generic token rule can claim part of it.
 *
 * Mirrored in `python/openrappter/show_and_tell.py`. Keep both in step.
 */
const SENSITIVE_RULES: readonly SensitiveRule[] = [
  {
    kind: 'private-key',
    pattern:
      /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
  },
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
  },
  {
    kind: 'token',
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|xapp-[0-9]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{35}|tskey-[a-z]+-[A-Za-z0-9]{10,})\b/g,
  },
  { kind: 'authorization', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  {
    kind: 'credential-url',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@\S*/gi,
  },
  {
    kind: 'assignment',
    pattern:
      /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|credential)\s*[:=]\s*["']?[^\s"',;]{6,}/gi,
  },
  {
    kind: 'payment-card',
    // Ends on a digit so the mask cannot swallow the space after the number.
    pattern: /\b\d(?:[ -]?\d){12,18}\b/g,
    confirm: (match) => isLuhnValid(match),
  },
  { kind: 'government-id', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    kind: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g,
  },
];

const MAX_SCAN_DEPTH = 12;
const MAX_SCAN_NODES = 5_000;

/** Code-unit comparison, so TypeScript and Python order results identically. */
export function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function isLuhnValid(candidate: string): boolean {
  const digits = candidate.replace(/[^0-9]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function maskText(value: string): { text: string; counts: Map<SensitiveKind, number> } {
  const counts = new Map<SensitiveKind, number>();
  let text = value;
  for (const rule of SENSITIVE_RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    text = text.replace(pattern, (match) => {
      if (rule.confirm && !rule.confirm(match)) return match;
      counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + 1);
      return SENSITIVE_MASK;
    });
  }
  if (text !== SENSITIVE_MASK) {
    // The Flight Recorder sanitizer is the last opinion, applied per line the
    // way `artifactContainsSensitiveText` reads a document. Handing it a whole
    // multi-line artifact instead makes it re-serialise embedded JSON, and a
    // reformat is not a secret — treating one as a secret would block honest
    // exports and teach everyone to ignore the warning.
    const lines = text.split('\n');
    let changed = false;
    const sanitizedLines = lines.map((line) => {
      const sanitized = sanitizeFlightValue(line);
      if (typeof sanitized === 'string' && sanitized !== line) {
        counts.set('sanitizer', (counts.get('sanitizer') ?? 0) + 1);
        changed = true;
        return sanitized;
      }
      return line;
    });
    if (changed) text = sanitizedLines.join('\n');
  }
  return { text, counts };
}

/**
 * Masks every sensitive run in `value` with a fixed-width marker, keeping the
 * surrounding sentence intact so a reviewer can still see what the step did.
 */
export function maskSensitiveText(value: string): string {
  return maskText(value).text;
}

interface ScanState {
  findings: Map<string, SensitiveFinding>;
  nodes: number;
}

function record(
  state: ScanState,
  path: string,
  kind: SensitiveKind,
  count: number,
): void {
  const key = `${path}\u0000${kind}`;
  const existing = state.findings.get(key);
  if (existing) existing.count += count;
  else state.findings.set(key, { path, kind, count });
}

function walk(
  value: unknown,
  path: string,
  depth: number,
  state: ScanState,
  mask: boolean,
): unknown {
  state.nodes += 1;
  if (depth > MAX_SCAN_DEPTH || state.nodes > MAX_SCAN_NODES) {
    record(state, path, 'unscanned', 1);
    return mask ? SENSITIVE_MASK : value;
  }
  if (typeof value === 'string') {
    const { text, counts } = maskText(value);
    for (const [kind, count] of counts) record(state, path, kind, count);
    return mask ? text : value;
  }
  if (Array.isArray(value)) {
    const mapped = value.map((item, index) =>
      walk(item, `${path}[${index}]`, depth + 1, state, mask),
    );
    return mask ? mapped : value;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const mapped: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      mapped[key] = walk(item, `${path}.${key}`, depth + 1, state, mask);
    }
    return mask ? mapped : value;
  }
  return value;
}

function sortFindings(state: ScanState): SensitiveFinding[] {
  // Code-unit order, not locale order: Python sorts these same findings and
  // the two runtimes have to agree on the result, not on a collation table.
  return [...state.findings.values()].sort(
    (left, right) =>
      compareStrings(left.path, right.path) || compareStrings(left.kind, right.kind),
  );
}

/**
 * Walks a whole payload — nested objects, arrays, and strings — and reports
 * every sensitive value it finds, by path and kind. Reporting the path and the
 * kind rather than the value keeps the report itself safe to store and show.
 */
export function scanSensitivePayload(
  value: unknown,
  basePath = '$',
): SensitiveFinding[] {
  const state: ScanState = { findings: new Map(), nodes: 0 };
  walk(value, basePath, 0, state, false);
  return sortFindings(state);
}

/** Returns a masked copy of the payload alongside what was masked. */
export function maskSensitivePayload<T>(
  value: T,
  basePath = '$',
): { value: T; findings: SensitiveFinding[] } {
  const state: ScanState = { findings: new Map(), nodes: 0 };
  const masked = walk(value, basePath, 0, state, true) as T;
  return { value: masked, findings: sortFindings(state) };
}

/** True when any finding is of a kind that must never reach an artifact. */
export function hasSecretFindings(findings: readonly SensitiveFinding[]): boolean {
  return findings.some((finding) => SENSITIVE_SECRET_KINDS.has(finding.kind));
}

export function safeComputerActionData(
  action: string,
  kwargs: Record<string, unknown>,
  result?: Record<string, unknown>,
): Record<string, unknown> {
  const data: Record<string, unknown> = { action };
  if (action === 'type') {
    const text = typeof kwargs.text === 'string' ? kwargs.text : '';
    data.textLength = Array.from(text).length;
    data.textStored = false;
  } else if (action === 'key') {
    const key = typeof kwargs.text === 'string' ? kwargs.text : '';
    if (isNonTextKeyCommand(key)) {
      data.key = sanitizeShowAndTellText(key, 80);
    } else {
      data.keyLength = Array.from(key).length;
      data.keyStored = false;
    }
  } else if (action === 'open_app' || action === 'activate_app') {
    data.app = sanitizeShowAndTellText(kwargs.text, 120);
  } else {
    for (const key of ['x', 'y', 'end_x', 'end_y', 'direction', 'amount']) {
      if (kwargs[key] !== undefined) data[key] = kwargs[key];
    }
  }
  if (typeof result?.status === 'string') data.status = result.status;
  return sanitizeShowAndTellValue(data);
}
