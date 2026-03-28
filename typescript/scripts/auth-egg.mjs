import { requestDeviceCode, pollForAccessToken } from '../dist/providers/copilot-auth.js';
import { saveGitHubToken } from '../dist/copilot-check.js';
import { loadEnv, saveEnv } from '../dist/env.js';
import { createCipheriv, randomBytes } from 'crypto';
import { writeFileSync } from 'fs';
import { execSync } from 'child_process';

const recipient = process.argv[2] || 'rappter1@icloud.com';

// 1. Get device code
const device = await requestDeviceCode();
console.log('Got device code:', device.user_code);

// 2. Encrypt into egg.json
const key = randomBytes(32);
const iv = randomBytes(16);
const cipher = createCipheriv('aes-256-gcm', key, iv);
const payload = JSON.stringify({
  user_code: device.user_code,
  verification_uri: device.verification_uri,
  instructions: 'Open the URL and enter the code to authenticate OpenRappter with GitHub Copilot.',
  expires_in: device.expires_in,
});
let encrypted = cipher.update(payload, 'utf8', 'base64');
encrypted += cipher.final('base64');
const authTag = cipher.getAuthTag().toString('base64');

const egg = {
  _type: 'openrappter-auth-egg',
  encrypted,
  iv: iv.toString('base64'),
  authTag,
  key: key.toString('base64'),
  quick_auth: {
    url: device.verification_uri,
    code: device.user_code,
    hint: 'Open the URL and enter the code. That is it!',
  },
};

const eggPath = '/tmp/egg.json';
writeFileSync(eggPath, JSON.stringify(egg, null, 2));
console.log('Wrote egg.json');

// 3. Send via iMessage
const msg = `Open ${device.verification_uri} and enter code: ${device.user_code}`;
const escaped = msg.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const script = `
tell application "Messages"
  set targetService to 1st account whose service type = iMessage
  set targetBuddy to participant "${recipient}" of targetService
  send "${escaped}" to targetBuddy
  send POSIX file "${eggPath}" to targetBuddy
end tell
`;
execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 15000 });
console.log(`Sent auth egg + code to ${recipient}`);

// 4. Poll for token
console.log('Polling for authorization (waiting for you to enter the code)...');
const expiresAt = Date.now() + device.expires_in * 1000;
const intervalMs = Math.max(1000, device.interval * 1000);

try {
  const token = await pollForAccessToken({
    deviceCode: device.device_code,
    intervalMs,
    expiresAt,
    onPoll: () => process.stdout.write('.'),
  });
  console.log('\nToken obtained:', token.substring(0, 10) + '...');

  // Save everywhere
  saveGitHubToken(token, 'device_code');
  const env = await loadEnv();
  env.GITHUB_TOKEN = token;
  await saveEnv(env);
  console.log('Token saved — restart the daemon to pick it up');
} catch (err) {
  console.error('\nAuth failed:', err.message);
}
