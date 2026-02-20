import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(__dirname, '../..');

describe('CLI flags', () => {
  let indexSource: string;

  beforeAll(async () => {
    indexSource = await fs.readFile(path.join(srcRoot, 'index.ts'), 'utf-8');
  });

  it('should have --web flag in commander config', () => {
    expect(indexSource).toContain("--web");
  });

  it('should have --daemon flag in commander config', () => {
    expect(indexSource).toContain("--daemon");
  });

  it('should have TTY guard on onboard command', () => {
    expect(indexSource).toContain('process.stdin.isTTY');
  });
});

describe('install.sh TTY guard', () => {
  it('should check for interactive TTY before onboard wizard', async () => {
    const installSh = await fs.readFile(
      path.resolve(srcRoot, '../../install.sh'),
      'utf-8'
    );
    // install.sh uses gum_is_tty to guard interactive prompts
    expect(installSh).toContain('gum_is_tty');
    expect(installSh).toContain('/dev/tty');
  });
});
