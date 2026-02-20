/**
 * Tests for the workspace identity & session management module.
 *
 * Uses real temp directories (same pattern as config-integration.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ensureWorkspace,
  loadWorkspaceFiles,
  buildWorkspaceContext,
  parseIdentityMarkdown,
  identityHasValues,
  readOnboardingState,
  truncateContent,
  writeFileIfMissing,
} from './workspace.js';

describe('Workspace', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `openrappter-workspace-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── ensureWorkspace ─────────────────────────────────────────────────────

  describe('ensureWorkspace()', () => {
    it('creates dir and seeds SOUL.md, IDENTITY.md, USER.md', async () => {
      const dir = join(tmpDir, 'ws');
      await ensureWorkspace(dir);

      expect(readFileSync(join(dir, 'SOUL.md'), 'utf-8')).toContain('SOUL.md');
      expect(readFileSync(join(dir, 'IDENTITY.md'), 'utf-8')).toContain('IDENTITY.md');
      expect(readFileSync(join(dir, 'USER.md'), 'utf-8')).toContain('USER.md');
    });

    it('seeds BOOTSTRAP.md on brand new workspace', async () => {
      const dir = join(tmpDir, 'ws');
      await ensureWorkspace(dir);

      const bootstrap = readFileSync(join(dir, 'BOOTSTRAP.md'), 'utf-8');
      expect(bootstrap).toContain('Hello, World');
      expect(bootstrap).toContain('You just woke up');
    });

    it('sets bootstrapSeededAt in state', async () => {
      const dir = join(tmpDir, 'ws');
      await ensureWorkspace(dir);

      const state = await readOnboardingState(dir);
      expect(state.bootstrapSeededAt).toBeDefined();
      expect(state.version).toBe(1);
    });

    it('is idempotent — does not overwrite existing files', async () => {
      const dir = join(tmpDir, 'ws');
      await ensureWorkspace(dir);

      // Modify IDENTITY.md
      const customContent = '# My Custom Identity\n- **Name:** TestBot';
      writeFileSync(join(dir, 'IDENTITY.md'), customContent);

      // Run again
      await ensureWorkspace(dir);

      // Should NOT have overwritten
      expect(readFileSync(join(dir, 'IDENTITY.md'), 'utf-8')).toBe(customContent);
    });

    it('detects legacy users (modified IDENTITY.md) → sets onboardingCompletedAt', async () => {
      const dir = join(tmpDir, 'ws');
      // Seed first
      await ensureWorkspace(dir);

      // Modify IDENTITY.md to simulate user filling it in
      writeFileSync(join(dir, 'IDENTITY.md'), '# My Identity\n- **Name:** Luna');

      // Re-run ensureWorkspace
      await ensureWorkspace(dir);

      const state = await readOnboardingState(dir);
      expect(state.onboardingCompletedAt).toBeDefined();
    });

    it('lifecycle: delete BOOTSTRAP.md → onboardingCompletedAt set', async () => {
      const dir = join(tmpDir, 'ws');
      await ensureWorkspace(dir);

      // Verify bootstrapSeededAt is set but not onboardingCompletedAt
      let state = await readOnboardingState(dir);
      expect(state.bootstrapSeededAt).toBeDefined();
      expect(state.onboardingCompletedAt).toBeUndefined();

      // Delete BOOTSTRAP.md (simulating user deleting it after onboarding)
      unlinkSync(join(dir, 'BOOTSTRAP.md'));

      // Re-run
      await ensureWorkspace(dir);

      state = await readOnboardingState(dir);
      expect(state.onboardingCompletedAt).toBeDefined();
    });
  });

  // ── loadWorkspaceFiles ──────────────────────────────────────────────────

  describe('loadWorkspaceFiles()', () => {
    it('reads all files with content', async () => {
      const dir = join(tmpDir, 'ws');
      await ensureWorkspace(dir);

      const files = await loadWorkspaceFiles(dir);
      const soul = files.find(f => f.name === 'SOUL.md');
      const identity = files.find(f => f.name === 'IDENTITY.md');
      const user = files.find(f => f.name === 'USER.md');
      const bootstrap = files.find(f => f.name === 'BOOTSTRAP.md');

      expect(soul?.missing).toBe(false);
      expect(soul?.content).toContain('SOUL.md');
      expect(identity?.missing).toBe(false);
      expect(user?.missing).toBe(false);
      expect(bootstrap?.missing).toBe(false);
    });

    it('handles missing files (missing: true)', async () => {
      // Empty dir — no files
      const files = await loadWorkspaceFiles(tmpDir);
      for (const f of files) {
        expect(f.missing).toBe(true);
        expect(f.content).toBeUndefined();
      }
    });
  });

  // ── parseIdentityMarkdown ───────────────────────────────────────────────

  describe('parseIdentityMarkdown()', () => {
    it('extracts name, emoji, creature, vibe, avatar', () => {
      const content = `# IDENTITY.md

- **Name:** Luna
- **Creature:** digital familiar
- **Vibe:** warm and curious
- **Emoji:** 🌙
- **Avatar:** avatars/luna.png
`;

      const id = parseIdentityMarkdown(content);
      expect(id.name).toBe('Luna');
      expect(id.creature).toBe('digital familiar');
      expect(id.vibe).toBe('warm and curious');
      expect(id.emoji).toBe('🌙');
      expect(id.avatar).toBe('avatars/luna.png');
    });

    it('skips placeholder values from template', () => {
      const content = `# IDENTITY.md

- **Name:**
  _(pick something you like)_
- **Creature:**
  _(AI? robot? familiar? ghost in the machine? something weirder?)_
- **Vibe:**
  _(how do you come across? sharp? warm? chaotic? calm?)_
`;

      const id = parseIdentityMarkdown(content);
      expect(id.name).toBeUndefined();
      expect(id.creature).toBeUndefined();
      expect(id.vibe).toBeUndefined();
    });

    it('handles empty/malformed content', () => {
      expect(parseIdentityMarkdown('')).toEqual({});
      expect(parseIdentityMarkdown('no colons here')).toEqual({});
      expect(parseIdentityMarkdown('random: value')).toEqual({});
    });
  });

  // ── identityHasValues ──────────────────────────────────────────────────

  describe('identityHasValues()', () => {
    it('returns true when fields populated', () => {
      expect(identityHasValues({ name: 'Luna' })).toBe(true);
      expect(identityHasValues({ emoji: '🌙' })).toBe(true);
      expect(identityHasValues({ name: 'X', vibe: 'chill' })).toBe(true);
    });

    it('returns false for empty identity', () => {
      expect(identityHasValues({})).toBe(false);
      expect(identityHasValues({ name: undefined, emoji: undefined })).toBe(false);
    });
  });

  // ── buildWorkspaceContext ───────────────────────────────────────────────

  describe('buildWorkspaceContext()', () => {
    it('formats files as ## FILENAME sections', () => {
      const files: ReturnType<typeof loadWorkspaceFiles> extends Promise<infer T> ? T : never = [
        { name: 'SOUL.md', path: '/tmp/SOUL.md', content: 'Soul content', missing: false },
        { name: 'IDENTITY.md', path: '/tmp/IDENTITY.md', content: 'Identity content', missing: false },
        { name: 'USER.md', path: '/tmp/USER.md', content: 'User content', missing: false },
        { name: 'BOOTSTRAP.md', path: '/tmp/BOOTSTRAP.md', content: 'Bootstrap content', missing: false },
      ];

      const ctx = buildWorkspaceContext(files, false);
      expect(ctx).toContain('## SOUL.md');
      expect(ctx).toContain('Soul content');
      expect(ctx).toContain('## IDENTITY.md');
      expect(ctx).toContain('## USER.md');
      expect(ctx).toContain('## BOOTSTRAP.md');
    });

    it('excludes BOOTSTRAP.md when onboarding completed', () => {
      const files = [
        { name: 'SOUL.md', path: '/tmp/SOUL.md', content: 'Soul content', missing: false },
        { name: 'IDENTITY.md', path: '/tmp/IDENTITY.md', content: 'Identity content', missing: false },
        { name: 'USER.md', path: '/tmp/USER.md', content: 'User content', missing: false },
        { name: 'BOOTSTRAP.md', path: '/tmp/BOOTSTRAP.md', content: 'Bootstrap content', missing: false },
      ];

      const ctx = buildWorkspaceContext(files, true);
      expect(ctx).toContain('## SOUL.md');
      expect(ctx).toContain('## IDENTITY.md');
      expect(ctx).not.toContain('## BOOTSTRAP.md');
      expect(ctx).not.toContain('Bootstrap content');
    });

    it('includes BOOTSTRAP.md when NOT completed', () => {
      const files = [
        { name: 'SOUL.md', path: '/tmp/SOUL.md', content: 'Soul content', missing: false },
        { name: 'BOOTSTRAP.md', path: '/tmp/BOOTSTRAP.md', content: 'Bootstrap content', missing: false },
      ];

      const ctx = buildWorkspaceContext(files, false);
      expect(ctx).toContain('## BOOTSTRAP.md');
      expect(ctx).toContain('Bootstrap content');
    });
  });

  // ── truncateContent ─────────────────────────────────────────────────────

  describe('truncateContent()', () => {
    it('returns content unchanged when under limit', () => {
      const content = 'short text';
      expect(truncateContent(content, 100)).toBe(content);
    });

    it('applies 70/20 head/tail split with marker', () => {
      // Create content longer than limit
      const content = 'A'.repeat(100);
      const result = truncateContent(content, 50);

      // 70% head = 35 chars, 20% tail = 10 chars
      expect(result).toContain('[...truncated...]');
      expect(result.startsWith('A'.repeat(35))).toBe(true);
      expect(result.endsWith('A'.repeat(10))).toBe(true);
      expect(result.length).toBeLessThan(content.length);
    });
  });

  // ── writeFileIfMissing ──────────────────────────────────────────────────

  describe('writeFileIfMissing()', () => {
    it('creates file when it does not exist', async () => {
      const filePath = join(tmpDir, 'test.md');
      const created = await writeFileIfMissing(filePath, 'hello');
      expect(created).toBe(true);
      expect(readFileSync(filePath, 'utf-8')).toBe('hello');
    });

    it('does not overwrite when file exists', async () => {
      const filePath = join(tmpDir, 'test.md');
      writeFileSync(filePath, 'original');
      const created = await writeFileIfMissing(filePath, 'new content');
      expect(created).toBe(false);
      expect(readFileSync(filePath, 'utf-8')).toBe('original');
    });
  });
});
