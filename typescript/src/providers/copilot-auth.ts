/**
 * GitHub Copilot device code authentication flow.
 *
 * Implements the OAuth device flow to get a GitHub access token
 * without requiring the gh CLI or any browser-based redirect.
 *
 * Flow:
 *  1. Request device code from GitHub
 *  2. User visits URL and enters code
 *  3. Poll for access token
 *  4. Token is used for Copilot API token exchange
 */

// ── Constants ────────────────────────────────────────────────────────────────

/** Same client ID used by GitHub Copilot / OpenClaw */
export const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

type DeviceTokenResponse =
  | { access_token: string; token_type: string; scope?: string }
  | { error: string; error_description?: string };

// ── Device code request ──────────────────────────────────────────────────────

/**
 * Request a device code from GitHub for the OAuth device flow.
 */
export async function requestDeviceCode(options?: {
  scope?: string;
  fetchImpl?: typeof fetch;
}): Promise<DeviceCodeResponse> {
  const scope = options?.scope ?? 'read:user';
  const fetchImpl = options?.fetchImpl ?? fetch;

  const body = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    scope,
  });

  const res = await fetchImpl(DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`GitHub device code request failed: HTTP ${res.status}`);
  }

  const json = (await res.json()) as DeviceCodeResponse;
  if (!json.device_code || !json.user_code || !json.verification_uri) {
    throw new Error('GitHub device code response missing required fields');
  }

  return json;
}

// ── Token polling ────────────────────────────────────────────────────────────

/**
 * Poll GitHub for an access token after the user has entered the device code.
 *
 * @param deviceCode - The device_code from requestDeviceCode()
 * @param intervalMs - Polling interval in milliseconds
 * @param expiresAt - Timestamp (ms) when the device code expires
 * @returns The GitHub access token
 */
export async function pollForAccessToken(params: {
  deviceCode: string;
  intervalMs: number;
  expiresAt: number;
  fetchImpl?: typeof fetch;
  onPoll?: () => void;
}): Promise<string> {
  const fetchImpl = params.fetchImpl ?? fetch;

  const body = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    device_code: params.deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });

  while (Date.now() < params.expiresAt) {
    params.onPoll?.();

    const res = await fetchImpl(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!res.ok) {
      throw new Error(`GitHub access token request failed: HTTP ${res.status}`);
    }

    const json = (await res.json()) as DeviceTokenResponse;

    if ('access_token' in json && typeof json.access_token === 'string') {
      return json.access_token;
    }

    const err = 'error' in json ? json.error : 'unknown';

    if (err === 'authorization_pending') {
      await new Promise((r) => setTimeout(r, params.intervalMs));
      continue;
    }
    if (err === 'slow_down') {
      await new Promise((r) => setTimeout(r, params.intervalMs + 2000));
      continue;
    }
    if (err === 'expired_token') {
      throw new Error('GitHub device code expired — run login again');
    }
    if (err === 'access_denied') {
      throw new Error('GitHub login was cancelled by the user');
    }

    const desc = 'error_description' in json ? json.error_description : undefined;
    throw new Error(`GitHub device flow error: ${err}${desc ? ` — ${desc}` : ''}`);
  }

  throw new Error('GitHub device code expired — run login again');
}

// ── Convenience ──────────────────────────────────────────────────────────────

/**
 * Run the full device code flow: request code → display to user → poll for token.
 *
 * @param onCode Callback with the user code and verification URL for display
 * @returns GitHub access token
 */
export async function deviceCodeLogin(
  onCode: (code: string, url: string) => void,
  options?: { scope?: string; fetchImpl?: typeof fetch },
): Promise<string> {
  const device = await requestDeviceCode(options);

  onCode(device.user_code, device.verification_uri);

  const expiresAt = Date.now() + device.expires_in * 1000;
  const intervalMs = Math.max(1000, device.interval * 1000);

  return pollForAccessToken({
    deviceCode: device.device_code,
    intervalMs,
    expiresAt,
    fetchImpl: options?.fetchImpl,
  });
}
