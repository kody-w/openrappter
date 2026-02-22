import { describe, it, expect, beforeEach } from 'vitest';
import { DeviceCodeFlow, DeviceCodeResponse, TokenResponse } from '../../auth/device-code.js';
import { AuthProfileStore } from '../../auth/profiles.js';
import { OAuthClient, OAuthTokenStore, OAuthToken } from '../../auth/oauth.js';

describe('Device Code Flow', () => {
  it('should instantiate with config', () => {
    const flow = new DeviceCodeFlow({
      tokenUrl: 'https://example.com/token',
      deviceCodeUrl: 'https://example.com/device',
      clientId: 'test-id',
      scopes: ['read']
    });
    expect(flow).toBeDefined();
  });

  it('should have requestDeviceCode method', () => {
    const flow = new DeviceCodeFlow({
      tokenUrl: 'https://example.com/token',
      deviceCodeUrl: 'https://example.com/device',
      clientId: 'test-id',
      scopes: ['read']
    });
    expect(typeof flow.requestDeviceCode).toBe('function');
  });

  it('should have pollForToken method', () => {
    const flow = new DeviceCodeFlow({
      tokenUrl: 'https://example.com/token',
      deviceCodeUrl: 'https://example.com/device',
      clientId: 'test-id',
      scopes: ['read']
    });
    expect(typeof flow.pollForToken).toBe('function');
  });

  it('DeviceCodeResponse should have correct shape', () => {
    const mockResponse: DeviceCodeResponse = {
      device_code: 'ABC123',
      user_code: 'ABCD-1234',
      verification_uri: 'https://example.com/verify',
      expires_in: 900,
      interval: 5
    };

    expect(mockResponse.device_code).toBeDefined();
    expect(mockResponse.user_code).toBeDefined();
    expect(mockResponse.verification_uri).toBeDefined();
    expect(mockResponse.expires_in).toBeDefined();
    expect(mockResponse.interval).toBeDefined();
    expect(typeof mockResponse.device_code).toBe('string');
    expect(typeof mockResponse.user_code).toBe('string');
    expect(typeof mockResponse.verification_uri).toBe('string');
    expect(typeof mockResponse.expires_in).toBe('number');
    expect(typeof mockResponse.interval).toBe('number');
  });

  it('TokenResponse should have correct shape', () => {
    const mockToken: TokenResponse = {
      access_token: 'token123',
      token_type: 'bearer',
      scope: 'read write'
    };

    expect(mockToken.access_token).toBeDefined();
    expect(mockToken.token_type).toBeDefined();
    expect(typeof mockToken.access_token).toBe('string');
    expect(typeof mockToken.token_type).toBe('string');

    // Scope is optional
    const minimalToken: TokenResponse = {
      access_token: 'token456',
      token_type: 'bearer'
    };
    expect(minimalToken.access_token).toBeDefined();
    expect(minimalToken.token_type).toBeDefined();
  });
});

describe('Auth Profile Store', () => {
  let store: AuthProfileStore;

  beforeEach(() => {
    store = new AuthProfileStore();
    // Clear existing profiles for clean tests
    const existing = store.list();
    existing.forEach(p => store.remove(p.provider, p.id));
  });

  it('should instantiate', () => {
    expect(store).toBeDefined();
  });

  it('should have CRUD methods', () => {
    expect(typeof store.add).toBe('function');
    expect(typeof store.get).toBe('function');
    expect(typeof store.list).toBe('function');
    expect(typeof store.setDefault).toBe('function');
    expect(typeof store.remove).toBe('function');
  });

  it('should add a profile', () => {
    const profile = store.add({
      id: 'test1',
      provider: 'anthropic',
      type: 'api-key',
      token: 'sk-test'
    });

    expect(profile.id).toBe('test1');
    expect(profile.createdAt).toBeDefined();
    expect(profile.provider).toBe('anthropic');
    expect(profile.type).toBe('api-key');
    expect(profile.token).toBe('sk-test');
  });

  it('should list profiles', () => {
    store.add({
      id: 'test1',
      provider: 'anthropic',
      type: 'api-key',
      token: 'sk-test'
    });

    expect(store.list().length).toBeGreaterThan(0);
  });

  it('should list by provider', () => {
    store.add({
      id: 'test1',
      provider: 'anthropic',
      type: 'api-key',
      token: 'sk-test'
    });

    expect(store.list('anthropic').length).toBeGreaterThan(0);
    expect(store.list('nonexistent')).toHaveLength(0);
  });

  it('should get profile by provider', () => {
    store.add({
      id: 'test1',
      provider: 'anthropic',
      type: 'api-key',
      token: 'sk-test'
    });

    const p = store.get('anthropic');
    expect(p?.id).toBe('test1');
  });

  it('should get profile by id', () => {
    store.add({
      id: 'test1',
      provider: 'anthropic',
      type: 'api-key',
      token: 'sk-test'
    });

    const p = store.get('anthropic', 'test1');
    expect(p).toBeDefined();
    expect(p?.id).toBe('test1');
  });

  it('first profile should be default', () => {
    store.add({
      id: 'test1',
      provider: 'anthropic',
      type: 'api-key',
      token: 'sk-test'
    });

    const p = store.get('anthropic');
    expect(p?.default).toBe(true);
  });

  it('should set default', () => {
    store.add({
      id: 'test1',
      provider: 'anthropic',
      type: 'api-key',
      token: 'sk-test1'
    });

    store.add({
      id: 'test2',
      provider: 'anthropic',
      type: 'api-key',
      token: 'sk-test2'
    });

    // Set test2 as default
    store.setDefault('anthropic', 'test2');

    const p = store.get('anthropic');
    expect(p?.id).toBe('test2');
    expect(p?.default).toBe(true);
  });

  it('should remove profile', () => {
    store.add({
      id: 'test1',
      provider: 'anthropic',
      type: 'api-key',
      token: 'sk-test'
    });

    expect(store.remove('anthropic', 'test1')).toBe(true);
    expect(store.get('anthropic', 'test1')).toBeUndefined();
  });

  it('should support all auth types', () => {
    const apiKeyProfile = store.add({
      id: 'test-api-key',
      provider: 'anthropic',
      type: 'api-key',
      token: 'sk-test'
    });
    expect(apiKeyProfile.type).toBe('api-key');

    const oauthProfile = store.add({
      id: 'test-oauth',
      provider: 'github',
      type: 'oauth',
      token: 'oauth-token',
      refreshToken: 'refresh-token'
    });
    expect(oauthProfile.type).toBe('oauth');

    const deviceCodeProfile = store.add({
      id: 'test-device',
      provider: 'copilot',
      type: 'device-code',
      token: 'device-token'
    });
    expect(deviceCodeProfile.type).toBe('device-code');
  });
});

describe('OAuth Client', () => {
  it('should instantiate with known provider', () => {
    const client = new OAuthClient('github', {
      clientId: 'test',
      clientSecret: 'secret',
      redirectUri: 'http://localhost:3000/callback'
    });
    expect(client).toBeDefined();
  });

  it('should support all providers', () => {
    const providers = ['github', 'google', 'microsoft', 'discord', 'slack', 'copilot', 'qwen'];

    providers.forEach(provider => {
      expect(() => {
        new OAuthClient(provider, {
          clientId: 'test',
          clientSecret: 'secret',
          redirectUri: 'http://localhost:3000/callback'
        });
      }).not.toThrow();
    });
  });

  it('should reject unknown provider', () => {
    expect(() => {
      new OAuthClient('unknown_provider', {
        clientId: '',
        clientSecret: '',
        redirectUri: ''
      });
    }).toThrow();
  });

  it('should generate auth URL', () => {
    const client = new OAuthClient('github', {
      clientId: 'test',
      clientSecret: 'secret',
      redirectUri: 'http://localhost:3000/callback'
    });

    const { url, state, codeVerifier } = client.getAuthorizationUrl();

    expect(url).toContain('github.com');
    expect(state).toBeDefined();
    expect(codeVerifier).toBeDefined();
    expect(typeof url).toBe('string');
    expect(typeof state).toBe('string');
    expect(typeof codeVerifier).toBe('string');
    expect(url).toContain('client_id=test');
    expect(url).toContain('redirect_uri=http');
  });

  it('should check token expiry', () => {
    const client = new OAuthClient('github', {
      clientId: 'test',
      clientSecret: 'secret',
      redirectUri: 'http://localhost:3000/callback'
    });

    // Token without expiry should not be expired
    expect(client.isTokenExpired({
      accessToken: 'x',
      tokenType: 'bearer'
    })).toBe(false);

    // Token expired in the past
    expect(client.isTokenExpired({
      accessToken: 'x',
      tokenType: 'bearer',
      expiresAt: Date.now() - 1000
    })).toBe(true);

    // Token expiring soon (within 1 minute buffer)
    expect(client.isTokenExpired({
      accessToken: 'x',
      tokenType: 'bearer',
      expiresAt: Date.now() + 30000 // 30 seconds
    })).toBe(true);

    // Token with plenty of time left
    expect(client.isTokenExpired({
      accessToken: 'x',
      tokenType: 'bearer',
      expiresAt: Date.now() + 3600000 // 1 hour
    })).toBe(false);
  });
});

describe('OAuth Token Store', () => {
  let store: OAuthTokenStore;

  beforeEach(() => {
    store = new OAuthTokenStore();
  });

  it('should store and retrieve tokens', () => {
    const token: OAuthToken = {
      accessToken: 'test-token',
      tokenType: 'bearer',
      expiresAt: Date.now() + 3600000
    };

    store.setToken('user1', 'github', token);
    const retrieved = store.getToken('user1', 'github');

    expect(retrieved).toBeDefined();
    expect(retrieved?.accessToken).toBe('test-token');
    expect(retrieved?.tokenType).toBe('bearer');
  });

  it('should return undefined for missing tokens', () => {
    expect(store.getToken('user1', 'github')).toBeUndefined();
  });

  it('should remove tokens', () => {
    const token: OAuthToken = {
      accessToken: 'test-token',
      tokenType: 'bearer'
    };

    store.setToken('user1', 'github', token);
    expect(store.getToken('user1', 'github')).toBeDefined();

    const removed = store.removeToken('user1', 'github');
    expect(removed).toBe(true);
    expect(store.getToken('user1', 'github')).toBeUndefined();
  });

  it('should get all user tokens', () => {
    const githubToken: OAuthToken = {
      accessToken: 'github-token',
      tokenType: 'bearer'
    };

    const googleToken: OAuthToken = {
      accessToken: 'google-token',
      tokenType: 'bearer'
    };

    store.setToken('user1', 'github', githubToken);
    store.setToken('user1', 'google', googleToken);
    store.setToken('user2', 'github', githubToken); // Different user

    const user1Tokens = store.getUserTokens('user1');

    expect(user1Tokens).toHaveLength(2);
    expect(user1Tokens.some(t => t.providerId === 'github')).toBe(true);
    expect(user1Tokens.some(t => t.providerId === 'google')).toBe(true);

    // User2 should only have 1 token
    const user2Tokens = store.getUserTokens('user2');
    expect(user2Tokens).toHaveLength(1);
    expect(user2Tokens[0].providerId).toBe('github');
  });
});
