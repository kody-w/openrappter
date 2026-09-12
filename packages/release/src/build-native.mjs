import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { command, requireMacArm64 } from './apple.mjs';

export async function buildNativeInstaller(output = fileURLToPath(new URL('../dist/rapp-work-installer', import.meta.url))) {
  requireMacArm64();
  await mkdir(path.dirname(output), { recursive: true });
  const scratch = path.join(path.dirname(output), `.compiler-${randomUUID()}`);
  await mkdir(scratch, { mode: 0o700 });
  try {
    await command('/usr/bin/clang', [
      '-arch', 'arm64', '-mmacosx-version-min=12.0', '-Os', '-Wall', '-Wextra', '-Werror',
      fileURLToPath(new URL('../native/replace.c', import.meta.url)), '-o', output,
    ], { env: { ...process.env, TMPDIR: scratch } });
  } finally { await rm(scratch, { recursive: true, force: true }); }
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildNativeInstaller();
}
