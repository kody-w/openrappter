/**
 * Skills Ecosystem Parity Tests
 *
 * Exercises the real SkillsRegistry (src/skills/registry.ts) — discovery,
 * install/enable lifecycle, and the on-disk lock file. The previous version of
 * this file built literal objects and asserted on their own shape, so it passed
 * no matter what the product did. Its most misleading test claimed skills store
 * their lock file at `~/.openrappter/skills/.clawhub/lock.json` and "verified"
 * it with `expect(lockPath).toContain('.clawhub/lock.json')` — a string
 * compared against a substring of itself. That path is a Python-runtime concept
 * (python/openrappter/clawhub.py); the TypeScript SkillsRegistry actually writes
 * `openrappter-skills.lock`. These tests use the real registry against a scratch
 * directory and assert the real behaviour.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createSkillsRegistry } from '../../skills/registry.js';
import type { SkillManifest } from '../../skills/registry.js';

/** Scratch roots live under the repo's gitignored temp dir, never /tmp. */
const SCRATCH_ROOT = join(process.cwd(), '.vitest-tmp');
const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const dir = mkdtempSync(join(SCRATCH_ROOT, 'skills-'));
  scratchDirs.push(dir);
  return dir;
}

function seedSkill(skillsDir: string, manifest: SkillManifest, skillMd?: string): void {
  const dir = join(skillsDir, manifest.id.replace('/', '--'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  if (skillMd !== undefined) writeFileSync(join(dir, 'SKILL.md'), skillMd);
}

const weather: SkillManifest = {
  id: 'weather',
  name: 'Weather',
  version: '1.0.0',
  description: 'Get weather forecasts',
  author: 'openrappter',
  tags: ['weather', 'utility'],
};

describe('Skills Ecosystem Parity', () => {
  describe('Installed skills discovery', () => {
    it('reports no installed skills for a fresh registry', async () => {
      const registry = createSkillsRegistry(scratch());
      await registry.initialize();
      expect(registry.getInstalled()).toHaveLength(0);
    });

    it('discovers a skill seeded on disk via its manifest', async () => {
      const dir = scratch();
      seedSkill(dir, weather);

      const registry = createSkillsRegistry(dir);
      await registry.initialize();

      const installed = registry.getInstalled();
      expect(installed).toHaveLength(1);
      expect(installed[0].manifest.id).toBe('weather');
      expect(installed[0].manifest.description).toBe('Get weather forecasts');
    });
  });

  describe('Lock file', () => {
    it('writes the lock file as openrappter-skills.lock (not .clawhub/lock.json)', async () => {
      const dir = scratch();
      seedSkill(dir, weather);

      const registry = createSkillsRegistry(dir);
      await registry.initialize(); // scanning an unseen dir persists the lock file

      expect(existsSync(join(dir, 'openrappter-skills.lock'))).toBe(true);
      // The `.clawhub/lock.json` path claimed by the old test belongs to the
      // Python runtime only; the TypeScript registry never creates it.
      expect(existsSync(join(dir, '.clawhub', 'lock.json'))).toBe(false);
    });

    it('records installed skills inside the lock file', async () => {
      const dir = scratch();
      seedSkill(dir, weather);

      await createSkillsRegistry(dir).initialize();

      const lock = JSON.parse(
        readFileSync(join(dir, 'openrappter-skills.lock'), 'utf8')
      ) as { skills: Array<{ manifest: SkillManifest }> };
      expect(lock.skills.map((s) => s.manifest.id)).toContain('weather');
    });
  });

  describe('Enable / disable lifecycle', () => {
    it('excludes a disabled skill from getEnabled but keeps it installed', async () => {
      const dir = scratch();
      seedSkill(dir, weather);
      const registry = createSkillsRegistry(dir);
      await registry.initialize();

      expect(registry.getEnabled().map((s) => s.manifest.id)).toContain('weather');

      expect(await registry.disableSkill('weather')).toBe(true);
      expect(registry.getEnabled()).toHaveLength(0);
      expect(registry.getInstalled()).toHaveLength(1); // still installed, just off

      expect(await registry.enableSkill('weather')).toBe(true);
      expect(registry.getEnabled().map((s) => s.manifest.id)).toContain('weather');
    });

    it('returns false when enabling a skill that is not installed', async () => {
      const registry = createSkillsRegistry(scratch());
      await registry.initialize();
      expect(await registry.enableSkill('does-not-exist')).toBe(false);
    });
  });

  describe('Uninstall', () => {
    it('removes the skill from the registry and deletes its directory', async () => {
      const dir = scratch();
      seedSkill(dir, weather);
      const registry = createSkillsRegistry(dir);
      await registry.initialize();

      const skillDir = join(dir, 'weather');
      expect(existsSync(skillDir)).toBe(true);

      expect(await registry.uninstall('weather')).toBe(true);
      expect(registry.getInstalled()).toHaveLength(0);
      expect(existsSync(skillDir)).toBe(false);
    });
  });

  describe('Loading a skill', () => {
    it('loads manifest-derived fields for an installed skill', async () => {
      const dir = scratch();
      seedSkill(dir, weather);
      const registry = createSkillsRegistry(dir);
      await registry.initialize();

      const skill = await registry.loadSkill('weather');
      expect(skill).not.toBeNull();
      expect(skill?.name).toBe('Weather');
      expect(skill?.version).toBe('1.0.0');
    });

    it('returns null when loading a skill that is not installed', async () => {
      const registry = createSkillsRegistry(scratch());
      await registry.initialize();
      expect(await registry.loadSkill('nope')).toBeNull();
    });
  });
});
