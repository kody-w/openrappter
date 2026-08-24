export const GITHUB_DEVICE_LOGIN_URL = 'https://github.com/login/device';

export function isAllowedGithubDeviceLoginUrl(value: string): boolean {
  if (value !== GITHUB_DEVICE_LOGIN_URL) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && url.pathname === '/login/device'
      && url.search === ''
      && url.hash === '';
  } catch {
    return false;
  }
}
