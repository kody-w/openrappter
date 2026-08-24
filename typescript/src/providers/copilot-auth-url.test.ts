import { describe, expect, it } from 'vitest';
import {
  GITHUB_DEVICE_VERIFICATION_URL,
  isAllowedGithubDeviceVerificationUri,
  requestDeviceCode,
} from './copilot-auth.js';

describe('GitHub device verification URL policy', () => {
  it('allows only the exact HTTPS GitHub device path', () => {
    expect(isAllowedGithubDeviceVerificationUri(
      GITHUB_DEVICE_VERIFICATION_URL,
    )).toBe(true);
    for (const value of [
      'http://github.com/login/device',
      'https://github.com.evil.example/login/device',
      'https://evil.github.com/login/device',
      'https://user:pass@github.com/login/device',
      'https://github.com/login/device/',
      'https://github.com/login/device?next=https://evil.example',
      'https://github.com/login/device#next',
      'file:///login/device',
      'javascript:alert(1)',
    ]) {
      expect(isAllowedGithubDeviceVerificationUri(value)).toBe(false);
    }
  });

  it('rejects unexpected response origins and verification URLs', async () => {
    await expect(requestDeviceCode({
      fetchImpl: async () => ({
        ok: true,
        url: 'https://github.com.evil.example/login/device/code',
        json: async () => ({
          device_code: 'device',
          user_code: 'CODE',
          verification_uri: GITHUB_DEVICE_VERIFICATION_URL,
          expires_in: 900,
          interval: 5,
        }),
      }) as Response,
    })).rejects.toThrow('unexpected URL');

    await expect(requestDeviceCode({
      fetchImpl: async () => ({
        ok: true,
        url: 'https://github.com/login/device/code',
        json: async () => ({
          device_code: 'device',
          user_code: 'CODE',
          verification_uri: 'https://github.com.evil.example/login/device',
          expires_in: 900,
          interval: 5,
        }),
      }) as Response,
    })).rejects.toThrow('missing required fields');
  });
});
