import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DocScannerAgent } from '../DocScannerAgent.js';
import { NotesIntakeAgent } from '../NotesIntakeAgent.js';

/**
 * A directory that does not exist must not look like an empty one.
 *
 * Both agents walk a tree with `readdir(...)` wrapped in `catch { return []; }`.
 * That is right *below* the root — one unreadable subdirectory should not abort
 * a scan of everything else — and wrong *at* it. Given a path that does not
 * exist, both answered:
 *
 *     {"status":"success","summary":{"total_files":0,...}}
 *
 * which a caller cannot tell apart from a real, empty directory. Someone who
 * mistypes a path is told the scan worked and found nothing.
 *
 * Reproduced against the built agents before the change, for
 * `/tmp/definitely-not-a-real-directory-xyz`.
 *
 * These are the first behavioural tests for either agent. Both were constructed
 * by `builtin-agents-load.test.ts`, which proves they load and nothing more.
 */

const MISSING = path.join(os.tmpdir(), 'openrappter-no-such-dir-9f3a2b');

async function parsed(result: string): Promise<Record<string, unknown>> {
  return JSON.parse(result) as Record<string, unknown>;
}

describe('scanning a directory that is not there', () => {
  it('DocScanner reports the failure instead of an empty success', async () => {
    const out = await parsed(await new DocScannerAgent().perform({ path: MISSING }));
    expect(out.status).toBe('error');
    expect(String(out.message)).toContain('Failed to scan');
  });

  it('NotesIntake reports the failure instead of an empty success', async () => {
    const out = await parsed(await new NotesIntakeAgent().perform({ path: MISSING }));
    expect(out.status).toBe('error');
    expect(String(out.message)).toContain('Failed to scan');
  });

  it('an empty directory is still a success, and still distinguishable', async () => {
    // The point is the distinction. If the fix had turned every quiet scan into
    // an error it would have traded one indistinguishable pair for another.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openrappter-empty-'));
    try {
      const doc = await parsed(await new DocScannerAgent().perform({ path: dir }));
      expect(doc.status).toBe('success');
      expect((doc.summary as { total_files: number }).total_files).toBe(0);

      const notes = await parsed(await new NotesIntakeAgent().perform({ path: dir }));
      expect(notes.status).toBe('success');
      expect(notes.notes_scanned).toBe(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('a directory with content still scans', async () => {
    // Anti-vacuity: without this, returning an error for everything would pass
    // the two assertions above that matter most.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openrappter-docs-'));
    try {
      await fs.writeFile(path.join(dir, 'note.md'), '# Title\n\n- [ ] TODO: something\n');
      const doc = await parsed(await new DocScannerAgent().perform({ path: dir }));
      expect(doc.status).toBe('success');
      expect((doc.summary as { total_files: number }).total_files).toBe(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('an unreadable subdirectory does not abort the scan', async () => {
    // The behaviour the swallow was there for, kept: only the root propagates.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openrappter-partial-'));
    try {
      await fs.writeFile(path.join(dir, 'readable.md'), 'content\n');
      const locked = path.join(dir, 'locked');
      await fs.mkdir(locked);
      await fs.chmod(locked, 0o000);

      const doc = await parsed(await new DocScannerAgent().perform({ path: dir }));
      expect(doc.status).toBe('success');
      expect((doc.summary as { total_files: number }).total_files).toBe(1);

      await fs.chmod(locked, 0o755);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
