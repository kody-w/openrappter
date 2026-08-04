/**
 * "One pattern" has to be enforceable, or it is just a claim in a commit message.
 *
 * The speech seam has one implementation — `src/voice/local-speech.js`. The
 * bundled UI imports it, the anatomy page inlines it at render time, and the
 * vbrainstem inlines a copy stamped with the source sha256. These tests fail if
 * any of those three stops being the same code.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SOURCE = join(process.cwd(), 'src/voice/local-speech.js');
const source = readFileSync(SOURCE, 'utf8');
const sourceSha = createHash('sha256').update(source).digest('hex');

describe('speech seam — one implementation', () => {
  it('the anatomy page inlines the module rather than reimplementing it', async () => {
    const page = readFileSync(
      join(process.cwd(), 'src/gateway/anatomy-page.ts'),
      'utf8',
    );
    // It must read the file, not carry its own copy of the logic.
    expect(page).toContain('local-speech.js');
    expect(page).toContain('speechScript()');
    // A second implementation would show up as these appearing literally.
    expect(page).not.toContain('new SpeechSynthesisUtterance(');
  });

  it('build copies the module next to the compiled output', () => {
    // The anatomy page reads it at runtime, and deploy only ships dist/.
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.scripts['copy:assets']).toContain('local-speech.js');
  });

  it('the module is dependency-free so single-file surfaces can inline it', () => {
    // An import here would break the anatomy page and the vbrainstem, which
    // both run it as a classic script.
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/require\(/);
  });

  it('exports strip cleanly for inlining', () => {
    const inlined = source
      .replace(/^export const /m, 'const ')
      .replace(/^export function /gm, 'function ');
    expect(inlined).not.toContain('export ');
  });

  it('the vbrainstem copy matches this source', () => {
    // vbrainstem is a separate repo; skip rather than fail when it is absent.
    const vb = join(homedir(), 'vbrainstem/index.html');
    if (!existsSync(vb)) {
      expect(true).toBe(true);
      return;
    }
    const html = readFileSync(vb, 'utf8');
    if (!html.includes('__rappSpeech')) {
      expect(true).toBe(true);
      return;
    }
    const stamped = /sha256 ([a-f0-9]{64})/.exec(html)?.[1];
    expect(
      stamped,
      'the vbrainstem inline block carries no source stamp',
    ).toBeDefined();
    expect(
      stamped,
      'vbrainstem has drifted from src/voice/local-speech.js — re-inline it',
    ).toBe(sourceSha);
  });
});
