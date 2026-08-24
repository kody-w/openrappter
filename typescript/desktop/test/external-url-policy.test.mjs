import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  GITHUB_DEVICE_LOGIN_URL,
  isAllowedGithubDeviceLoginUrl,
} from '../dist/external-url-policy.js';

test('allows only the exact GitHub device login URL', () => {
  assert.equal(isAllowedGithubDeviceLoginUrl(GITHUB_DEVICE_LOGIN_URL), true);
  for (const value of [
    'http://github.com/login/device',
    'https://github.com.evil.example/login/device',
    'https://evil.github.com/login/device',
    'https://user:pass@github.com/login/device',
    'https://github.com:443/login/device',
    'https://github.com/login/device/',
    'https://github.com/login/device?redirect=https://evil.example',
    'https://github.com/login/device#redirect',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'https://example.com/',
  ]) {
    assert.equal(isAllowedGithubDeviceLoginUrl(value), false, value);
  }
});
