import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { ARTIFACT_POLICY, invariant } from './common.mjs';

const execute = promisify(execFile);

export async function command(executable, args, options = {}) {
  return execute(executable, args, { timeout: 180_000, maxBuffer: 16 * 1024 * 1024, ...options, shell: false });
}

export function requireMacArm64() {
  invariant(process.platform === 'darwin' && process.arch === 'arm64', 'This operation requires macOS Apple Silicon');
}

export function validateTeamIdentifier(teamIdentifier) {
  invariant(typeof teamIdentifier === 'string' && /^[A-Z0-9]{10}$/u.test(teamIdentifier), 'A trusted ten-character Apple Team ID is required');
}

export class AppleVerifier {
  async application(appPath, { mode, teamIdentifier, version }) {
    requireMacArm64();
    appPath = path.resolve(appPath);
    const plist = path.join(appPath, 'Contents/Info.plist');
    const property = async name => (await command('/usr/libexec/PlistBuddy', ['-c', `Print :${name}`, plist])).stdout.trim();
    invariant(await property('CFBundleIdentifier') === ARTIFACT_POLICY.bundleIdentifier, 'Application bundle identity mismatch');
    invariant(await property('CFBundleExecutable') === 'RAPP Work', 'Application executable identity mismatch');
    invariant(await property('CFBundleShortVersionString') === version, 'Application version mismatch');
    if (mode === 'development-unsigned') return null;
    validateTeamIdentifier(teamIdentifier);
    await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--all-architectures', appPath]);
    await command('/usr/bin/codesign', ['--verify', '--strict', '-R',
      `=anchor apple generic and identifier "${ARTIFACT_POLICY.bundleIdentifier}" and certificate leaf[subject.OU] = "${teamIdentifier}"`, appPath]);
    const details = await command('/usr/bin/codesign', ['--display', '--verbose=4', appPath]);
    const text = `${details.stdout}\n${details.stderr}`;
    invariant(text.includes(`Identifier=${ARTIFACT_POLICY.bundleIdentifier}\n`), 'Signed application identifier mismatch');
    invariant(text.includes(`TeamIdentifier=${teamIdentifier}\n`), 'Application signer is not the trusted Apple team');
    invariant(/^Authority=Developer ID Application:/mu.test(text), 'A Developer ID Application signature is required');
    invariant(/^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*\bruntime\b[^)]*\)/imu.test(text), 'Production requires the hardened runtime');
    invariant(/^Timestamp=.+/mu.test(text) && !/^Timestamp=(?:none|Not set)/imu.test(text), 'Production requires a secure signing timestamp');
    await command('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
    await command('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
    return { teamIdentifier, bundleIdentifier: ARTIFACT_POLICY.bundleIdentifier, hardenedRuntime: true, notarized: true, stapled: true };
  }

  async dmg(dmgPath, { mode, teamIdentifier }) {
    requireMacArm64();
    dmgPath = path.resolve(dmgPath);
    if (mode === 'development-unsigned') return;
    validateTeamIdentifier(teamIdentifier);
    await command('/usr/bin/codesign', ['--verify', '--strict', '-R',
      `=anchor apple generic and certificate leaf[subject.OU] = "${teamIdentifier}"`, dmgPath]);
    const details = await command('/usr/bin/codesign', ['--display', '--verbose=4', dmgPath]);
    invariant(`${details.stdout}\n${details.stderr}`.includes(`TeamIdentifier=${teamIdentifier}\n`), 'DMG signer is not the trusted Apple team');
    await command('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', dmgPath]);
    await command('/usr/bin/xcrun', ['stapler', 'validate', dmgPath]);
  }
}
