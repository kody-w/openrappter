import { CopilotTokenError } from '../providers/copilot-token.js';

const GITHUB_USER_URL = 'https://api.github.com/user';
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export interface VerifiedGitHubIdentity {
  id: number;
  login: string;
}

export async function resolveVerifiedGitHubIdentity(
  token: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<VerifiedGitHubIdentity> {
  let response: Response;
  try {
    response = await fetchImpl(GITHUB_USER_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
      redirect: 'error',
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new CopilotTokenError('offline');
  }

  if (response.url && response.url !== GITHUB_USER_URL) {
    throw new CopilotTokenError('exchange-error');
  }
  if (response.status === 401) {
    throw new CopilotTokenError('http-401', 401);
  }
  if (response.status === 403) {
    throw new CopilotTokenError('http-403', 403);
  }
  if (!response.ok) {
    throw new CopilotTokenError('exchange-error', response.status);
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new CopilotTokenError('exchange-error');
  }
  if (!value || typeof value !== 'object') {
    throw new CopilotTokenError('exchange-error');
  }
  const { id, login } = value as Record<string, unknown>;
  if (
    typeof id !== 'number'
    || !Number.isSafeInteger(id)
    || id <= 0
    || typeof login !== 'string'
    || !GITHUB_LOGIN.test(login)
  ) {
    throw new CopilotTokenError('exchange-error');
  }
  return { id, login };
}
