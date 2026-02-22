/**
 * GitAgent Parity Tests
 *
 * Tests the GitAgent — a git repository operations agent with injectable
 * exec function for testability. All tests use mock execFn to avoid
 * real git operations.
 *
 * Mirrors Python agents/git_agent.py
 */

import { describe, it, expect } from 'vitest';
import { GitAgent } from '../../agents/GitAgent.js';
import type { ExecFn } from '../../agents/GitAgent.js';
import { BasicAgent } from '../../agents/BasicAgent.js';

/**
 * Creates a mock exec function that pattern-matches commands against a
 * response map. Falls back to { stdout: '', stderr: 'Unknown command' }
 * for unrecognised commands.
 */
function createMockExec(responses: Record<string, { stdout: string; stderr: string }>): ExecFn {
  return (cmd: string, _cwd?: string) => {
    for (const [pattern, response] of Object.entries(responses)) {
      if (cmd.includes(pattern)) {
        return response;
      }
    }
    return { stdout: '', stderr: 'Unknown command' };
  };
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('GitAgent', () => {
  describe('Constructor', () => {
    it('should have name "Git"', () => {
      const agent = new GitAgent();
      expect(agent.name).toBe('Git');
    });

    it('should have metadata.name "Git"', () => {
      const agent = new GitAgent();
      expect(agent.metadata.name).toBe('Git');
    });

    it('action enum should have exactly 6 values', () => {
      const agent = new GitAgent();
      const actionParam = agent.metadata.parameters.properties.action;
      expect(actionParam.enum).toHaveLength(6);
      expect(actionParam.enum).toEqual(['status', 'diff', 'log', 'branch', 'commit', 'pr']);
    });

    it('should extend BasicAgent', () => {
      const agent = new GitAgent();
      expect(agent).toBeInstanceOf(BasicAgent);
    });
  });

  // -------------------------------------------------------------------------
  // No action / unknown action
  // -------------------------------------------------------------------------

  describe('No action / unknown action', () => {
    it('should return error JSON when no action is provided', async () => {
      const agent = new GitAgent({ execFn: createMockExec({}) });
      const result = await agent.perform({});
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('No action specified');
    });

    it('should return error JSON for an unknown action', async () => {
      const agent = new GitAgent({ execFn: createMockExec({}) });
      const result = await agent.perform({ action: 'rebase' });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('Unknown action');
      expect(parsed.message).toContain('rebase');
    });
  });

  // -------------------------------------------------------------------------
  // status action
  // -------------------------------------------------------------------------

  describe('status action', () => {
    it('should report clean=true and empty files array when working tree is clean', async () => {
      const exec = createMockExec({
        'git status --porcelain': { stdout: '', stderr: '' },
      });
      const agent = new GitAgent({ execFn: exec });
      const result = await agent.perform({ action: 'status' });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.action).toBe('status');
      expect(parsed.clean).toBe(true);
      expect(parsed.files).toEqual([]);
    });

    it('should parse modified and untracked files from porcelain output', async () => {
      const exec = createMockExec({
        'git status --porcelain': {
          stdout: 'M  src/app.ts\n?? new.txt',
          stderr: '',
        },
      });
      const agent = new GitAgent({ execFn: exec });
      const result = await agent.perform({ action: 'status' });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.clean).toBe(false);
      expect(parsed.files).toHaveLength(2);
      expect(parsed.files[0].file).toBe('src/app.ts');
      expect(parsed.files[0].status).toBe('M');
      expect(parsed.files[1].file).toBe('new.txt');
      expect(parsed.files[1].status).toBe('??');
    });
  });

  // -------------------------------------------------------------------------
  // diff action
  // -------------------------------------------------------------------------

  describe('diff action', () => {
    it('should report has_changes=false when there are no changes', async () => {
      const exec = createMockExec({
        'git diff --stat': { stdout: '', stderr: '' },
        'git diff': { stdout: '', stderr: '' },
      });
      const agent = new GitAgent({ execFn: exec });
      const result = await agent.perform({ action: 'diff' });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.action).toBe('diff');
      expect(parsed.truncated).toBe(false);
      expect(parsed.diff).toBe('');
      // data_slush should encode has_changes=false
      expect(parsed.data_slush.signals.has_changes).toBe(false);
    });

    it('should include diff content and set truncated=false for short diffs', async () => {
      const diffContent = '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new';
      const exec = createMockExec({
        'git diff --stat': { stdout: 'src/app.ts | 2 +-', stderr: '' },
        'git diff': { stdout: diffContent, stderr: '' },
      });
      const agent = new GitAgent({ execFn: exec });
      const result = await agent.perform({ action: 'diff' });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.diff).toBe(diffContent);
      expect(parsed.truncated).toBe(false);
      expect(parsed.stat).toBe('src/app.ts | 2 +-');
    });

    it('should truncate diff content longer than 10000 characters', async () => {
      const longDiff = 'x'.repeat(15000);
      const exec = createMockExec({
        'git diff --stat': { stdout: 'many files changed', stderr: '' },
        'git diff': { stdout: longDiff, stderr: '' },
      });
      const agent = new GitAgent({ execFn: exec });
      const result = await agent.perform({ action: 'diff' });
      const parsed = JSON.parse(result);

      expect(parsed.truncated).toBe(true);
      expect(parsed.diff).toHaveLength(10000);
      expect(parsed.data_slush.signals.truncated).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // log action
  // -------------------------------------------------------------------------

  describe('log action', () => {
    it('should return parsed commits array from git log output', async () => {
      const commit1 = JSON.stringify({
        hash: 'abc1234567890',
        short: 'abc1234',
        author: 'Alice',
        date: '2026-01-01 12:00:00 +0000',
        subject: 'feat: initial commit',
      });
      const commit2 = JSON.stringify({
        hash: 'def5678901234',
        short: 'def5678',
        author: 'Bob',
        date: '2026-01-02 09:00:00 +0000',
        subject: 'fix: bug squash',
      });
      const exec = createMockExec({
        'git log': { stdout: `${commit1}\n${commit2}`, stderr: '' },
      });
      const agent = new GitAgent({ execFn: exec });
      const result = await agent.perform({ action: 'log' });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.action).toBe('log');
      expect(parsed.commits).toHaveLength(2);
      expect(parsed.commits[0].author).toBe('Alice');
      expect(parsed.commits[1].subject).toBe('fix: bug squash');
      expect(parsed.count).toBe(2);
    });

    it('should respect the count parameter in the git log command', async () => {
      const capturedCmds: string[] = [];
      const capturingExec: ExecFn = (cmd) => {
        capturedCmds.push(cmd);
        return { stdout: '', stderr: '' };
      };
      const agent = new GitAgent({ execFn: capturingExec });
      await agent.perform({ action: 'log', count: 5 });

      const logCmd = capturedCmds.find(c => c.includes('git log'));
      expect(logCmd).toBeDefined();
      expect(logCmd).toContain('-5');
    });
  });

  // -------------------------------------------------------------------------
  // branch action
  // -------------------------------------------------------------------------

  describe('branch action', () => {
    it('should list branches and current branch when no name is provided', async () => {
      const exec = createMockExec({
        'git branch --format': { stdout: 'main\nfeat/new-feature\nfix/bug-123', stderr: '' },
        'git branch --show-current': { stdout: 'main', stderr: '' },
      });
      const agent = new GitAgent({ execFn: exec });
      const result = await agent.perform({ action: 'branch' });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.action).toBe('branch');
      expect(parsed.branches).toHaveLength(3);
      expect(parsed.branches).toContain('main');
      expect(parsed.current).toBe('main');
    });

    it('should create a new branch when name is provided', async () => {
      const exec = createMockExec({
        'git checkout -b': {
          stdout: "Switched to a new branch 'feature/my-branch'",
          stderr: '',
        },
      });
      const agent = new GitAgent({ execFn: exec });
      const result = await agent.perform({ action: 'branch', name: 'feature/my-branch' });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.action).toBe('branch');
      expect(parsed.created).toBe('feature/my-branch');
    });
  });

  // -------------------------------------------------------------------------
  // commit action
  // -------------------------------------------------------------------------

  describe('commit action', () => {
    it('should stage files and commit successfully with files and message', async () => {
      const capturedCmds: string[] = [];
      const exec: ExecFn = (cmd) => {
        capturedCmds.push(cmd);
        if (cmd.includes('git commit')) {
          return { stdout: '[main abc1234] Add feature', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      };
      const agent = new GitAgent({ execFn: exec });
      const result = await agent.perform({
        action: 'commit',
        files: ['src/app.ts', 'src/utils.ts'],
        message: 'Add feature',
      });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.action).toBe('commit');
      expect(parsed.message).toBe('Add feature');
      expect(parsed.output).toBe('[main abc1234] Add feature');

      // Should have issued a git add command with the files
      const addCmd = capturedCmds.find(c => c.startsWith('git add'));
      expect(addCmd).toBeDefined();
      expect(addCmd).toContain('src/app.ts');
      expect(addCmd).toContain('src/utils.ts');
    });

    it('should return error when message is missing', async () => {
      const agent = new GitAgent({ execFn: createMockExec({}) });
      const result = await agent.perform({ action: 'commit', files: ['src/app.ts'] });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('message is required');
    });
  });

  // -------------------------------------------------------------------------
  // pr action
  // -------------------------------------------------------------------------

  describe('pr action', () => {
    it('should create PR successfully with title and default base branch', async () => {
      const exec = createMockExec({
        'gh pr create': {
          stdout: 'https://github.com/owner/repo/pull/42',
          stderr: '',
        },
      });
      const agent = new GitAgent({ execFn: exec });
      const result = await agent.perform({
        action: 'pr',
        title: 'Add new feature',
      });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('success');
      expect(parsed.action).toBe('pr');
      expect(parsed.title).toBe('Add new feature');
      expect(parsed.base).toBe('main');
      expect(parsed.output).toBe('https://github.com/owner/repo/pull/42');
    });

    it('should return error when title is missing', async () => {
      const agent = new GitAgent({ execFn: createMockExec({}) });
      const result = await agent.perform({ action: 'pr', body: 'Some body' });
      const parsed = JSON.parse(result);

      expect(parsed.status).toBe('error');
      expect(parsed.message).toContain('title is required');
    });
  });

  // -------------------------------------------------------------------------
  // data_slush
  // -------------------------------------------------------------------------

  describe('data_slush', () => {
    it('status action result should include data_slush with source_agent="Git"', async () => {
      const exec = createMockExec({
        'git status --porcelain': { stdout: '', stderr: '' },
      });
      const agent = new GitAgent({ execFn: exec });
      const result = await agent.perform({ action: 'status' });
      const parsed = JSON.parse(result);

      expect(parsed.data_slush).toBeDefined();
      expect(parsed.data_slush.source_agent).toBe('Git');
    });

    it('status action data_slush should encode file_count and clean signals', async () => {
      const exec = createMockExec({
        'git status --porcelain': { stdout: 'M  src/app.ts', stderr: '' },
      });
      const agent = new GitAgent({ execFn: exec });
      const result = await agent.perform({ action: 'status' });
      const parsed = JSON.parse(result);

      expect(parsed.data_slush.signals).toBeDefined();
      expect(parsed.data_slush.signals.file_count).toBe(1);
      expect(parsed.data_slush.signals.clean).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Python parity
  // -------------------------------------------------------------------------

  describe('Python Parity', () => {
    it('metadata schema should match expected shape: action enum equals Python enum', () => {
      const agent = new GitAgent();
      const props = agent.metadata.parameters.properties;

      // All parameters present in both runtimes
      expect(props).toHaveProperty('action');
      expect(props).toHaveProperty('count');
      expect(props).toHaveProperty('name');
      expect(props).toHaveProperty('files');
      expect(props).toHaveProperty('message');
      expect(props).toHaveProperty('title');
      expect(props).toHaveProperty('body');
      expect(props).toHaveProperty('base');

      // Action enum matches Python implementation
      expect(props.action.enum).toEqual(['status', 'diff', 'log', 'branch', 'commit', 'pr']);

      // Required array is empty in both runtimes
      expect(agent.metadata.parameters.required).toEqual([]);
    });

    it('all action results should return JSON with a status field', async () => {
      const exec = createMockExec({
        'git status --porcelain': { stdout: '', stderr: '' },
        'git diff --stat': { stdout: '', stderr: '' },
        'git diff': { stdout: '', stderr: '' },
        'git log': { stdout: '', stderr: '' },
        'git branch --format': { stdout: 'main', stderr: '' },
        'git branch --show-current': { stdout: 'main', stderr: '' },
      });
      const agent = new GitAgent({ execFn: exec });
      const actions = ['status', 'diff', 'log', 'branch'];

      for (const action of actions) {
        const result = await agent.perform({ action });
        const parsed = JSON.parse(result);
        expect(parsed).toHaveProperty('status');
        expect(parsed).toHaveProperty('action', action);
      }
    });
  });
});
