/**
 * OAuth Integration
 * Handles OAuth flows for various providers
 */

import { randomBytes, createHash } from 'crypto';

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes?: string[];
}

export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt?: number;
  scope?: string;
}

export interface OAuthProvider {
  name: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl?: string;
  scopes: string[];
}

const PROVIDERS: Record<string, OAuthProvider> = {
  github: {
    name: 'GitHub',
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userInfoUrl: 'https://api.github.com/user',
    scopes: ['read:user', 'user:email'],
  },
  google: {
    name: 'Google',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    scopes: ['openid', 'email', 'profile'],
  },
  microsoft: {
    name: 'Microsoft',
    authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    userInfoUrl: 'https://graph.microsoft.com/v1.0/me',
    scopes: ['openid', 'email', 'profile', 'User.Read'],
  },
  discord: {
    name: 'Discord',
    authorizationUrl: 'https://discord.com/api/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    userInfoUrl: 'https://discord.com/api/users/@me',
    scopes: ['identify', 'email'],
  },
  slack: {
    name: 'Slack',
    authorizationUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    userInfoUrl: 'https://slack.com/api/users.identity',
    scopes: ['identity.basic', 'identity.email'],
  },
  copilot: {
    name: 'GitHub Copilot',
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userInfoUrl: 'https://api.github.com/user',
    scopes: ['read:user'],
  },
  qwen: {
    name: 'Qwen',
    authorizationUrl: 'https://auth.aliyun.com/authorize',
    tokenUrl: 'https://auth.aliyun.com/token',
    scopes: ['openid'],
  },
};

export class OAuthClient {
  private config: OAuthConfig;
  private provider: OAuthProvider;
  private codeVerifiers = new Map<string, string>();

  constructor(providerName: string, config: OAuthConfig) {
    const provider = PROVIDERS[providerName.toLowerCase()];
    if (!provider) {
      throw new Error(`Unknown OAuth provider: ${providerName}`);
    }

    this.provider = provider;
    this.config = config;
  }

  /**
   * Generate authorization URL with PKCE
   */
  getAuthorizationUrl(state?: string): { url: string; state: string; codeVerifier: string } {
    const generatedState = state ?? randomBytes(16).toString('hex');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    // Store code verifier for later
    this.codeVerifiers.set(generatedState, codeVerifier);

    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: (this.config.scopes ?? this.provider.scopes).join(' '),
      state: generatedState,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return {
      url: `${this.provider.authorizationUrl}?${params}`,
      state: generatedState,
      codeVerifier,
    };
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCode(code: string, state: string): Promise<OAuthToken> {
    const codeVerifier = this.codeVerifiers.get(state);
    if (!codeVerifier) {
      throw new Error('Invalid state or code verifier not found');
    }

    this.codeVerifiers.delete(state);

    const params = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code,
      redirect_uri: this.config.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    });

    const response = await fetch(this.provider.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      token_type: string;
      expires_in?: number;
      scope?: string;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenType: data.token_type,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      scope: data.scope,
    };
  }

  /**
   * Refresh access token
   */
  async refreshToken(refreshToken: string): Promise<OAuthToken> {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    const response = await fetch(this.provider.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token refresh failed: ${error}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      token_type: string;
      expires_in?: number;
      scope?: string;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      tokenType: data.token_type,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      scope: data.scope,
    };
  }

  /**
   * Get user info
   */
  async getUserInfo(accessToken: string): Promise<Record<string, unknown>> {
    if (!this.provider.userInfoUrl) {
      throw new Error('User info endpoint not available');
    }

    const response = await fetch(this.provider.userInfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to get user info: ${error}`);
    }

    return response.json() as Promise<Record<string, unknown>>;
  }

  /**
   * Check if token is expired
   */
  isTokenExpired(token: OAuthToken): boolean {
    if (!token.expiresAt) return false;
    return Date.now() >= token.expiresAt - 60000; // 1 minute buffer
  }
}

/**
 * OAuth Token Store
 */
export class OAuthTokenStore {
  private tokens = new Map<string, OAuthToken>();
  private clients = new Map<string, OAuthClient>();

  /**
   * Register an OAuth client
   */
  registerClient(providerId: string, client: OAuthClient): void {
    this.clients.set(providerId, client);
  }

  /**
   * Store a token
   */
  setToken(userId: string, providerId: string, token: OAuthToken): void {
    const key = `${userId}:${providerId}`;
    this.tokens.set(key, token);
  }

  /**
   * Get a token
   */
  getToken(userId: string, providerId: string): OAuthToken | undefined {
    const key = `${userId}:${providerId}`;
    return this.tokens.get(key);
  }

  /**
   * Get a valid token, refreshing if needed
   */
  async getValidToken(userId: string, providerId: string): Promise<OAuthToken | null> {
    const token = this.getToken(userId, providerId);
    if (!token) return null;

    const client = this.clients.get(providerId);
    if (!client) return token;

    // Check if expired and refresh
    if (client.isTokenExpired(token) && token.refreshToken) {
      try {
        const newToken = await client.refreshToken(token.refreshToken);
        this.setToken(userId, providerId, newToken);
        return newToken;
      } catch {
        // Refresh failed, return null
        return null;
      }
    }

    return token;
  }

  /**
   * Remove a token
   */
  removeToken(userId: string, providerId: string): boolean {
    const key = `${userId}:${providerId}`;
    return this.tokens.delete(key);
  }

  /**
   * Get all tokens for a user
   */
  getUserTokens(userId: string): Array<{ providerId: string; token: OAuthToken }> {
    const result: Array<{ providerId: string; token: OAuthToken }> = [];
    for (const [key, token] of this.tokens) {
      if (key.startsWith(`${userId}:`)) {
        const providerId = key.slice(userId.length + 1);
        result.push({ providerId, token });
      }
    }
    return result;
  }
}

export function createOAuthClient(providerName: string, config: OAuthConfig): OAuthClient {
  return new OAuthClient(providerName, config);
}

export function createOAuthTokenStore(): OAuthTokenStore {
  return new OAuthTokenStore();
}

/**
 * Initiate a full OAuth flow with a local callback server.
 */
export async function initiateOAuthFlow(
  provider: string,
  options?: { port?: number; clientId?: string; clientSecret?: string }
): Promise<OAuthToken> {
  const { createServer } = await import('http');
  const port = options?.port ?? 18791;
  const redirectUri = `http://localhost:${port}/callback`;

  const client = new OAuthClient(provider, {
    clientId: options?.clientId ?? process.env[`${provider.toUpperCase()}_CLIENT_ID`] ?? '',
    clientSecret: options?.clientSecret ?? process.env[`${provider.toUpperCase()}_CLIENT_SECRET`] ?? '',
    redirectUri,
  });

  const { url, state } = client.getAuthorizationUrl();

  // Open browser
  const open = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  const { exec } = await import('child_process');
  exec(`${open} "${url}"`);

  console.log(`\nOpen this URL if the browser did not open:\n${url}\n`);

  // Wait for callback
  return new Promise<OAuthToken>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const reqUrl = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (reqUrl.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = reqUrl.searchParams.get('code');
      const returnedState = reqUrl.searchParams.get('state');

      if (!code || returnedState !== state) {
        res.writeHead(400);
        res.end('Invalid callback');
        server.close();
        reject(new Error('Invalid OAuth callback'));
        return;
      }

      try {
        const token = await client.exchangeCode(code, state);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Authentication successful!</h2><p>You can close this window.</p></body></html>');
        server.close();
        resolve(token);
      } catch (err) {
        res.writeHead(500);
        res.end('Token exchange failed');
        server.close();
        reject(err);
      }
    });

    server.listen(port, () => {
      console.log(`Waiting for OAuth callback on port ${port}...`);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('OAuth flow timed out'));
    }, 300000);
  });
}
