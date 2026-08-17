import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, join } from 'path';

/**
 * The runtime loads bundled skills from `<package>/skills/`, but `files` in
 * package.json never listed that directory, so the published tarball carried
 * the loader and none of the 52 skills it reads.
 *
 * `loadBundledSkills` swallows a missing directory and returns an empty list,
 * so an install with zero skills is indistinguishable from one that genuinely
 * has none. Nothing failed; there were simply no skills.
 *
 * These assert against what npm would really put in the tarball. The working
 * tree is not what users get, so checking the working tree proves nothing.
 */

const PKG_DIR = resolve(__dirname, '../../..');
const SKILLS_DIR = join(PKG_DIR, 'skills');

function onDiskSkillCount(): number {
  return readdirSync(SKILLS_DIR, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && existsSync(join(SKILLS_DIR, entry.name, 'SKILL.md')),
  ).length;
}

let cache: string[] | undefined;

/** File paths npm would publish. The listing goes to stderr as `npm notice`. */
function packedFiles(): string[] {
  if (cache) return cache;
  // --ignore-scripts skips the prepack build; file selection is unaffected and
  // the check drops from minutes to about a second.
  const result = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts'], {
    cwd: PKG_DIR,
    encoding: 'utf-8',
  });
  if (result.error) throw result.error;
  cache = (result.stderr || '')
    .split('\n')
    .filter((line) => line.startsWith('npm notice'))
    .map((line) => line.replace(/^npm notice\s*/, '').trim())
    // entries look like "1.2kB skills/weather/SKILL.md"
    .map((line) => line.replace(/^[\d.]+\s*[kMG]?B\s+/, ''))
    .filter((line) => line && !line.includes(' '));
  return cache;
}

describe('bundled skills are actually published', () => {
  it('package.json declares the skills directory', () => {
    const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf-8')) as {
      files: string[];
    };
    expect(pkg.files).toContain('skills/');
  });

  it('there are bundled skills on disk to publish', () => {
    expect(onDiskSkillCount()).toBeGreaterThan(0);
  });

  it('every bundled SKILL.md on disk is in the tarball', () => {
    const packed = packedFiles().filter(
      (path) => path.startsWith('skills/') && path.endsWith('SKILL.md'),
    );
    // Exact, not "greater than zero": shipping a subset is the same silent
    // failure in a smaller form.
    expect(packed.length).toBe(onDiskSkillCount());
  });

  it('ships the assets the loader reads, not only the loader', () => {
    const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf-8')) as {
      files: string[];
    };
    // The loader lives in dist/, which the prepack build produces and
    // packedFiles() deliberately skips. Assert dist/ is *declared* for
    // publication rather than that it happens to be built right now, or this
    // passes or fails depending on whether anyone has run a build.
    expect(pkg.files).toContain('dist/');
    expect(packedFiles().some((path) => path.startsWith('skills/'))).toBe(true);
  });
});
