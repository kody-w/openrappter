import { openrappterHome } from '../infra/openrappter-home.js';
/**
 * UpdateAgent - Self-update agent for openrappter.
 *
 * Checks the public GitHub repo for new releases, compares against the
 * local version, and performs updates (git pull + rebuild).
 *
 * Actions: check, update, changelog
 */

import { execSync, execFileSync } from 'child_process';
import fs from 'fs/promises';
import { readFileSync } from 'fs';
import path from 'path';
import { appleScriptLiteral } from './applescript.js';
import https from 'https';
import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';


export const __manifest__ = {
  schema: 'rapp-agent/1.0',
  name: '@openrappter/update',
  version: '1.0.0',
  display_name: 'Update',
  description: 'Check for updates and self-update openrappter from the public repo.',
  author: 'Kody Wildfeuer',
  ring: 'ga',
  capabilities: [
    'filesystem-write',
    'network',
    'process-exec'
  ],
  tags: [
    'openrappter',
    'update'
  ],
  category: 'general',
  quality_tier: 'official',
  requires_env: []
} as const;
const REPO_OWNER = 'kody-w';
const REPO_NAME = 'openrappter';
const LOCAL_VERSION_FILE = 'package.json';

export class UpdateAgent extends BasicAgent {
  private homeDir: string;
  private tsDir: string;

  constructor(homeDir?: string) {
    const metadata: AgentMetadata = {
      name: 'Update',
      description: 'Check for updates and self-update openrappter from the public repo.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'The update action to perform.',
            enum: ['check', 'update', 'changelog'],
          },
        },
        required: [],
      },
    };
    super('Update', metadata);
    // Injectable so the stash handling can be tested against a real repository
    // rather than a replica of it.
    this.homeDir = homeDir ?? openrappterHome();
    this.tsDir = path.join(this.homeDir, 'typescript');
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    let action = (kwargs.action as string) || 'check';

    // Parse from query for --exec usage
    const query = kwargs.query as string | undefined;
    if (query && !kwargs.action) {
      const q = query.toLowerCase().trim();
      if (q === 'update' || q === 'install' || q === 'upgrade') action = 'update';
      else if (q === 'changelog' || q === 'changes' || q === 'log') action = 'changelog';
      else action = 'check';
    }

    switch (action) {
      case 'check':
        return this.checkForUpdate();
      case 'update':
        return this.performUpdate();
      case 'changelog':
        return this.getChangelog();
      default:
        return JSON.stringify({ status: 'error', message: `Unknown action: ${action}` });
    }
  }

  private getLocalVersion(): string {
    try {
      const pkg = JSON.parse(
        readFileSync(path.join(this.tsDir, LOCAL_VERSION_FILE), 'utf-8'),
      );
      return pkg.version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  private async fetchLatestRelease(): Promise<{
    tag: string;
    version: string;
    name: string;
    body: string;
    published: string;
    url: string;
  } | null> {
    return new Promise((resolve) => {
      const options = {
        hostname: 'api.github.com',
        path: `/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=10`,
        method: 'GET',
        headers: {
          'User-Agent': 'openrappter-updater',
          Accept: 'application/vnd.github.v3+json',
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const releases = JSON.parse(data);
            if (!Array.isArray(releases)) { resolve(null); return; }
            // Find first non-bar, non-prerelease, non-draft release
            const release = releases.find((r: Record<string, unknown>) =>
              r.tag_name && !(r.tag_name as string).includes('-bar') && !r.draft && !r.prerelease
            );
            if (!release) { resolve(null); return; }
            const version = (release.tag_name as string).replace(/^v/, '');
            resolve({
              tag: release.tag_name as string,
              version,
              name: (release.name as string) || release.tag_name as string,
              body: (release.body as string) || '',
              published: (release.published_at as string) || '',
              url: (release.html_url as string) || '',
            });
          } catch {
            resolve(null);
          }
        });
      });

      req.on('error', () => resolve(null));
      req.setTimeout(10000, () => { req.destroy(); resolve(null); });
      req.end();
    });
  }

  private compareVersions(local: string, remote: string): number {
    const a = local.split('.').map(Number);
    const b = remote.split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const av = a[i] || 0;
      const bv = b[i] || 0;
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
    return 0;
  }

  private async checkForUpdate(): Promise<string> {
    const local = this.getLocalVersion();
    const latest = await this.fetchLatestRelease();

    if (!latest) {
      return JSON.stringify({
        status: 'error',
        message: 'Could not reach GitHub API. Check your internet connection.',
        local_version: local,
      });
    }

    const cmp = this.compareVersions(local, latest.version);

    return JSON.stringify({
      status: cmp < 0 ? 'update_available' : 'up_to_date',
      local_version: local,
      latest_version: latest.version,
      release_name: latest.name,
      release_url: latest.url,
      published: latest.published,
      message: cmp < 0
        ? `Update available: ${local} → ${latest.version}. Run: openrappter --exec Update "update"`
        : 'You are on the latest version.',
      data_slush: this.slushOut({
        signals: {
          local_version: local,
          latest_version: latest.version,
          update_available: cmp < 0,
        },
      }),
    });
  }

  private async performUpdate(): Promise<string> {
    const local = this.getLocalVersion();

    // Check if we're in a git repo
    const isGitRepo = await (async () => {
      try {
        await fs.access(path.join(this.homeDir, '.git'));
        return true;
      } catch {
        return false;
      }
    })();

    if (!isGitRepo) {
      return JSON.stringify({
        status: 'error',
        message: 'Not a git repo. Re-install with: curl -fsSL https://kody-w.github.io/openrappter/install.sh | bash',
      });
    }

    const stashLabel = `openrappter-update-${Date.now()}`;
    let stashed = false;
    try {
      // Stash any local changes.
      //
      // `git stash` on a clean tree prints "No local changes to save" and
      // exits 0 without creating an entry, so an unconditional `git stash pop`
      // afterwards restores whatever was on top of the stack — which may be
      // work the owner stashed days ago, and pop drops it. Only pop what this
      // update actually saved.
      const stashOutput = execFileSync(
        'git',
        ['stash', 'push', '--include-untracked', '-m', stashLabel],
        { cwd: this.homeDir, encoding: 'utf-8', timeout: 10000 },
      );
      stashed = !stashOutput.includes('No local changes to save');

      // Pull latest
      const pullOutput = execFileSync('git', ['pull', 'origin', 'main'], {
        cwd: this.homeDir,
        encoding: 'utf-8',
        timeout: 30000,
      });

      const alreadyUpToDate = pullOutput.includes('Already up to date');

      if (!alreadyUpToDate) {
        // Rebuild TypeScript
        execSync('npm ci --ignore-scripts && npm run build', {
          cwd: this.tsDir,
          encoding: 'utf-8',
          timeout: 120000,
          stdio: 'pipe',
        });
      }

      // Restore what we stashed. A failing pop leaves conflict markers in the
      // working tree and keeps the entry; reporting success there would tell
      // the owner their update worked while their build is full of `<<<<<<<`.
      if (stashed) {
        try {
          execFileSync('git', ['stash', 'pop'], {
            cwd: this.homeDir,
            encoding: 'utf-8',
            timeout: 10000,
          });
        } catch {
          return JSON.stringify({
            status: 'error',
            message:
              `Updated, but your local changes could not be restored: they conflict `
              + `with the new version. They are safe in the stash entry "${stashLabel}" — `
              + `resolve with: git stash pop`,
          });
        }
      }

      const newVersion = this.getLocalVersion();

      // Send notification about the update
      if (process.platform === 'darwin' && !alreadyUpToDate) {
        try {
          const msg = `Updated: ${local} → ${newVersion}`;
          execFileSync(
            'osascript',
            ['-e', `display notification "${appleScriptLiteral(msg)}" with title "🦖 openrappter updated"`],
            { timeout: 5000, stdio: 'pipe' },
          );
        } catch { /* non-critical */ }
      }

      return JSON.stringify({
        status: 'success',
        previous_version: local,
        new_version: newVersion,
        already_up_to_date: alreadyUpToDate,
        message: alreadyUpToDate
          ? `Already on latest version (${local}).`
          : `Updated successfully: ${local} → ${newVersion}. Restart the daemon to apply.`,
        restart_needed: !alreadyUpToDate,
      });
    } catch (err) {
      // Anything failing between the stash and the pop leaves the owner's work
      // saved but not restored. Saying "Update failed" alone sends them looking
      // for changes that are sitting in a stash entry they never made.
      const stranded = stashed
        ? ` Your local changes are saved in the stash entry "${stashLabel}" — `
          + 'restore them with: git stash pop'
        : '';
      return JSON.stringify({
        status: 'error',
        message: `Update failed: ${(err as Error).message}.${stranded}`,
        local_version: local,
      });
    }
  }

  private async getChangelog(): Promise<string> {
    try {
      const changelog = await fs.readFile(
        path.join(this.homeDir, 'CHANGELOG.md'),
        'utf-8',
      );
      // Return last 2000 chars (most recent entries)
      return JSON.stringify({
        status: 'success',
        changelog: changelog.slice(0, 2000),
        local_version: this.getLocalVersion(),
      });
    } catch {
      return JSON.stringify({
        status: 'error',
        message: 'CHANGELOG.md not found.',
      });
    }
  }
}
