import { sanitizeFlightValue } from '../flight-recorder/redaction.js';
import { isDeepStrictEqual } from 'node:util';

const OPAQUE_PATH_SEGMENT =
  /^(?:[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f-]{27,}|[A-Za-z0-9_-]{36,})$/i;
const JWT_TOKEN =
  /(?:^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,})(?:$|[^A-Za-z0-9_-])/;

const PRIVATE_CONTEXT =
  /\b(?:1password|bitwarden|keychain|password|passkey|credential|secret|token|private key|security code|sign[ -]?in|log[ -]?in)\b/i;

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
