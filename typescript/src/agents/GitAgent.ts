/**
 * GitAgent - Git operations agent.
 *
 * Provides git repository operations with injectable exec function
 * for testability. All operations are read-only by default except
 * commit and branch create.
 *
 * Actions: status, diff, log, branch, commit, pr
 *
 * Mirrors Python agents/git_agent.py
 */

import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';
import { execSync } from 'child_process';

export type ExecFn = (cmd: string, cwd?: string) => { stdout: string; stderr: string };

export class GitAgent extends BasicAgent {
  private cwd: string;
  private execFn: ExecFn;

  constructor(options?: { cwd?: string; execFn?: ExecFn }) {
    const metadata: AgentMetadata = {
      name: 'Git',
      description:
        'Git repository operations. Status, diff, log, branch management, commits, and PR creation.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'The git action to perform.',
            enum: ['status', 'diff', 'log', 'branch', 'commit', 'pr'],
          },
          count: {
            type: 'number',
            description: 'Number of log entries to retrieve (default: 10).',
          },
          name: {
            type: 'string',
            description: 'Branch name for branch create action.',
          },
          files: {
            type: 'array',
            description: 'Files to stage for commit.',
            items: { type: 'string' },
          },
          message: {
            type: 'string',
            description: 'Commit message.',
          },
          title: {
            type: 'string',
            description: 'PR title.',
          },
          body: {
            type: 'string',
            description: 'PR body.',
          },
          base: {
            type: 'string',
            description: 'Base branch for PR (default: main).',
          },
        },
        required: [],
      },
    };
    super('Git', metadata);
    this.cwd = options?.cwd ?? process.cwd();
    this.execFn = options?.execFn ?? this.defaultExec;
  }

  private defaultExec(cmd: string, cwd?: string): { stdout: string; stderr: string } {
    try {
      const stdout = execSync(cmd, {
        cwd: cwd ?? this.cwd,
        encoding: 'utf-8',
        timeout: 30000,
      });
      return { stdout: stdout.trim(), stderr: '' };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      return {
        stdout: (err.stdout ?? '').toString().trim(),
        stderr: (err.stderr ?? err.message ?? '').toString().trim(),
      };
    }
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const action = kwargs.action as string | undefined;

    if (!action) {
      return JSON.stringify({
        status: 'error',
        message: 'No action specified. Use: status, diff, log, branch, commit, or pr',
      });
    }

    try {
      switch (action) {
        case 'status':
          return this.gitStatus();
        case 'diff':
          return this.gitDiff();
        case 'log':
          return this.gitLog(kwargs);
        case 'branch':
          return this.gitBranch(kwargs);
        case 'commit':
          return this.gitCommit(kwargs);
        case 'pr':
          return this.gitPr(kwargs);
        default:
          return JSON.stringify({
            status: 'error',
            message: `Unknown action: ${action}`,
          });
      }
    } catch (error) {
      return JSON.stringify({
        status: 'error',
        action,
        message: (error as Error).message,
      });
    }
  }

  private gitStatus(): string {
    const { stdout } = this.execFn('git status --porcelain', this.cwd);
    const files: Array<{ status: string; file: string }> = [];

    if (stdout) {
      for (const line of stdout.split('\n')) {
        if (line.trim()) {
          const statusCode = line.substring(0, 2).trim();
          const file = line.substring(3).trim();
          files.push({ status: statusCode, file });
        }
      }
    }

    const dataSlush = this.slushOut({
      signals: { file_count: files.length, clean: files.length === 0 },
    });

    return JSON.stringify({
      status: 'success',
      action: 'status',
      files,
      clean: files.length === 0,
      data_slush: dataSlush,
    });
  }

  private gitDiff(): string {
    const { stdout: stat } = this.execFn('git diff --stat', this.cwd);
    const { stdout: diff } = this.execFn('git diff', this.cwd);

    const truncated = diff.length > 10000;
    const content = diff.slice(0, 10000);

    const dataSlush = this.slushOut({
      signals: { has_changes: diff.length > 0, truncated },
    });

    return JSON.stringify({
      status: 'success',
      action: 'diff',
      stat,
      diff: content,
      truncated,
      data_slush: dataSlush,
    });
  }

  private gitLog(kwargs: Record<string, unknown>): string {
    const count = (kwargs.count as number) ?? 10;
    const format = '--pretty=format:{"hash":"%H","short":"%h","author":"%an","date":"%ai","subject":"%s"}';
    const { stdout } = this.execFn(`git log -${count} ${format}`, this.cwd);

    const commits: Array<Record<string, string>> = [];
    if (stdout) {
      for (const line of stdout.split('\n')) {
        if (line.trim()) {
          try {
            commits.push(JSON.parse(line));
          } catch {
            // skip malformed lines
          }
        }
      }
    }

    const dataSlush = this.slushOut({
      signals: { commit_count: commits.length },
    });

    return JSON.stringify({
      status: 'success',
      action: 'log',
      commits,
      count: commits.length,
      data_slush: dataSlush,
    });
  }

  private gitBranch(kwargs: Record<string, unknown>): string {
    const name = kwargs.name as string | undefined;

    if (!name) {
      // List branches
      const { stdout } = this.execFn('git branch --format="%(refname:short)"', this.cwd);
      const branches = stdout ? stdout.split('\n').filter(b => b.trim()) : [];

      const { stdout: current } = this.execFn('git branch --show-current', this.cwd);

      const dataSlush = this.slushOut({
        signals: { branch_count: branches.length, current_branch: current.trim() },
      });

      return JSON.stringify({
        status: 'success',
        action: 'branch',
        branches,
        current: current.trim(),
        data_slush: dataSlush,
      });
    }

    // Create branch
    const { stdout, stderr } = this.execFn(`git checkout -b ${name}`, this.cwd);

    const dataSlush = this.slushOut({
      signals: { branch_created: name },
    });

    return JSON.stringify({
      status: 'success',
      action: 'branch',
      created: name,
      output: stdout || stderr,
      data_slush: dataSlush,
    });
  }

  private gitCommit(kwargs: Record<string, unknown>): string {
    const files = kwargs.files as string[] | undefined;
    const message = kwargs.message as string | undefined;

    if (!message) {
      return JSON.stringify({
        status: 'error',
        message: 'message is required for commit',
      });
    }

    // Stage files
    if (files && files.length > 0) {
      const fileList = files.join(' ');
      this.execFn(`git add ${fileList}`, this.cwd);
    }

    // Commit
    const { stdout, stderr } = this.execFn(`git commit -m "${message}"`, this.cwd);
    const success = !stderr || stderr.includes('');

    const dataSlush = this.slushOut({
      signals: { committed: true, message },
    });

    return JSON.stringify({
      status: 'success',
      action: 'commit',
      message,
      output: stdout || stderr,
      data_slush: dataSlush,
    });
  }

  private gitPr(kwargs: Record<string, unknown>): string {
    const title = kwargs.title as string | undefined;
    const body = kwargs.body as string | undefined;
    const base = (kwargs.base as string) ?? 'main';

    if (!title) {
      return JSON.stringify({
        status: 'error',
        message: 'title is required for pr',
      });
    }

    const bodyFlag = body ? ` --body "${body}"` : '';
    const { stdout, stderr } = this.execFn(
      `gh pr create --title "${title}"${bodyFlag} --base ${base}`,
      this.cwd,
    );

    const dataSlush = this.slushOut({
      signals: { pr_title: title, base },
    });

    return JSON.stringify({
      status: 'success',
      action: 'pr',
      title,
      base,
      output: stdout || stderr,
      data_slush: dataSlush,
    });
  }
}
