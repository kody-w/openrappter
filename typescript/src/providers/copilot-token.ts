/**
 * Direct GitHub Copilot token exchange — no CLI dependency.
 *
 * Flow: GitHub token → Copilot API token (cached, with expiry)
 * The Copilot token is then used to hit an OpenAI-compatible API.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Constants ────────────────────────────────────────────────────────────────

const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
export const DEFAULT_COPILOT_API_BASE_URL = 'https://api.individual.githubcopilot.com';

/** 5-minute safety margin before considering a token expired */
const TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1000;

// ── Types ────────────────────────────────────────────────────────────────────

export interface CachedCopilotToken {
  token: string;
  /** milliseconds since epoch */
  expiresAt: number;
  /** milliseconds since epoch */
  updatedAt: number;
}

export interface ResolvedCopilotToken {
  token: string;
  expiresAt: number;
  source: string;
  baseUrl: string;
}

// ── Token cache ──────────────────────────────────────────────────────────────

function getDefaultCachePath(): string {
  return path.join(os.homedir(), '.openrappter', 'credentials', 'copilot-token.json');
}

function loadCachedToken(cachePath: string): CachedCopilotToken | null {
  try {
    const data = fs.readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(data) as CachedCopilotToken;
    if (typeof parsed.token === 'string' && typeof parsed.expiresAt === 'number') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function saveCachedToken(cachePath: string, token: CachedCopilotToken): void {
  try {
    const dir = path.dirname(cachePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(cachePath, JSON.stringify(token, null, 2), { mode: 0o600 });
  } catch {
    // Non-fatal — token just won't be cached
  }
}

/** Delete the on-disk cached Copilot API token so the next call re-exchanges */
export function clearCachedCopilotToken(cachePath?: string): void {
  try {
    fs.unlinkSync(cachePath ?? getDefaultCachePath());
  } catch { /* file may not exist */ }
}

function isTokenUsable(cache: CachedCopilotToken, now = Date.now()): boolean {
  return cache.expiresAt - now > TOKEN_SAFETY_MARGIN_MS;
}

// ── Base URL extraction ──────────────────────────────────────────────────────

/**
 * The Copilot token is a semicolon-delimited string with key=value pairs.
 * One of them is `proxy-ep=<hostname>` which tells us the API base URL.
 * We convert `proxy.*` → `api.*` to get the final URL.
 */
export function deriveCopilotApiBaseUrl(token: string): string {
  const match = token.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
  const proxyEp = match?.[1]?.trim();
  if (!proxyEp) return DEFAULT_COPILOT_API_BASE_URL;

  const host = proxyEp.replace(/^https?:\/\//, '').replace(/^proxy\./i, 'api.');
  if (!host) return DEFAULT_COPILOT_API_BASE_URL;

  return `https://${host}`;
}

// ── Token response parsing ───────────────────────────────────────────────────

function parseCopilotTokenResponse(value: unknown): {
  token: string;
  expiresAt: number;
  apiEndpoint?: string;
} {
  if (!value || typeof value !== 'object') {
    throw new Error('Unexpected response from GitHub Copilot token endpoint');
  }

  const rec = value as Record<string, unknown>;
  const token = rec.token;
  const expiresAt = rec.expires_at;

  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new Error('Copilot token response missing token');
  }

  // GitHub returns unix seconds; defensively handle ms too
  let expiresAtMs: number;
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt)) {
    expiresAtMs = expiresAt > 10_000_000_000 ? expiresAt : expiresAt * 1000;
  } else if (typeof expiresAt === 'string' && expiresAt.trim().length > 0) {
    const parsed = Number.parseInt(expiresAt, 10);
    if (!Number.isFinite(parsed)) {
      throw new Error('Copilot token response has invalid expires_at');
    }
    expiresAtMs = parsed > 10_000_000_000 ? parsed : parsed * 1000;
  } else {
    throw new Error('Copilot token response missing expires_at');
  }

  // The exchange response includes an `endpoints` object with the canonical
  // API URL for this account (e.g. enterprise tenants get a routed host).
  // Prefer it over parsing `proxy-ep` from the token string.
  let apiEndpoint: string | undefined;
  const endpoints = rec.endpoints;
  if (endpoints && typeof endpoints === 'object') {
    const api = (endpoints as Record<string, unknown>).api;
    if (typeof api === 'string' && api.length > 0) {
      apiEndpoint = api;
    }
  }

  return { token, expiresAt: expiresAtMs, apiEndpoint };
}

/**
 * GitHub Copilot's token exchange accepts two auth header prefixes:
 *   - `token <ghu_…>` for user device-code tokens
 *   - `Bearer <token>` for Enterprise/SAML SSO / PAT-derived tokens
 *
 * Always sending `token` rejects Enterprise tokens with HTTP 401. Mirror
 * RAPP's brainstem heuristic: `token` only for ghu_-prefixed values.
 */
function authHeaderForGithubToken(token: string): string {
  return token.startsWith('ghu_') ? `token ${token}` : `Bearer ${token}`;
}

// ── Main resolver ────────────────────────────────────────────────────────────

/**
 * Exchange a GitHub token for a Copilot API token.
 *
 * - Returns a cached token if it's still valid (with 5-min safety margin)
 * - Otherwise exchanges via `https://api.github.com/copilot_internal/v2/token`
 * - Caches the result locally
 * - Extracts the API base URL from the token's `proxy-ep` field
 */
export async function resolveCopilotApiToken(params: {
  githubToken: string;
  cachePath?: string;
  fetchImpl?: typeof fetch;
}): Promise<ResolvedCopilotToken> {
  const cachePath = params.cachePath ?? getDefaultCachePath();
  const fetchImpl = params.fetchImpl ?? fetch;

  // 1. Try cache
  const cached = loadCachedToken(cachePath);
  if (cached && isTokenUsable(cached)) {
    return {
      token: cached.token,
      expiresAt: cached.expiresAt,
      source: `cache:${cachePath}`,
      baseUrl: deriveCopilotApiBaseUrl(cached.token),
    };
  }

  // 2. Exchange token — editor headers required for Enterprise/Business Copilot.
  // Match the User-Agent/Editor-Plugin-Version that RAPP brainstem uses
  // (known-good against Copilot Enterprise tenants).
  const res = await fetchImpl(COPILOT_TOKEN_URL, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Authorization': authHeaderForGithubToken(params.githubToken),
      'Editor-Version': 'vscode/1.95.0',
      'Editor-Plugin-Version': 'copilot/1.0.0',
      'User-Agent': 'GitHubCopilotChat/0.22.2024',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 404 || res.status === 401 || res.status === 403) {
      throw new Error(
        `GitHub token does not have Copilot API access (HTTP ${res.status}). ` +
        `Sign in with a GitHub account that has Copilot enabled.`
      );
    }
    throw new Error(`Copilot token exchange failed: HTTP ${res.status}${body ? ` — ${body}` : ''}`);
  }

  const parsed = parseCopilotTokenResponse(await res.json());

  // 3. Cache
  const payload: CachedCopilotToken = {
    token: parsed.token,
    expiresAt: parsed.expiresAt,
    updatedAt: Date.now(),
  };
  saveCachedToken(cachePath, payload);

  return {
    token: payload.token,
    expiresAt: payload.expiresAt,
    source: `fetched:${COPILOT_TOKEN_URL}`,
    // Prefer the endpoint from the JSON response (handles Enterprise tenants
    // with routed hosts), fall back to parsing the token's `proxy-ep` field.
    baseUrl: parsed.apiEndpoint ?? deriveCopilotApiBaseUrl(payload.token),
  };
}
