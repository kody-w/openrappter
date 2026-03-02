/**
 * UpdateAgent - Self-update agent for openrappter.
 *
 * Checks the public GitHub repo for new releases, compares against the
 * local version, and performs updates (git pull + rebuild).
 *
 * Actions: check, update, changelog
 */

import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import https from 'https';
import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';

const REPO_OWNER = 'kody-w';
const REPO_NAME = 'openrappter';
const LOCAL_VERSION_FILE = 'package.json';

export class UpdateAgent extends BasicAgent {
  private homeDir: string;
  private tsDir: string;

  constructor() {
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
    this.homeDir = path.join(os.homedir(), '.openrappter');
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
        require('fs').readFileSync(path.join(this.tsDir, LOCAL_VERSION_FILE), 'utf-8'),
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
        path: `/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
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
            const release = JSON.parse(data);
            if (!release.tag_name) { resolve(null); return; }
            // Strip 'v' prefix from tag
            const version = release.tag_name.replace(/^v/, '');
            resolve({
              tag: release.tag_name,
              version,
              name: release.name || release.tag_name,
              body: release.body || '',
              published: release.published_at || '',
              url: release.html_url || '',
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

    // Skip bar-only releases
    if (latest.tag.includes('-bar')) {
      return JSON.stringify({
        status: 'up_to_date',
        local_version: local,
        latest_version: local,
        message: 'You are on the latest version.',
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

    try {
      // Stash any local changes
      execSync('git stash --include-untracked 2>/dev/null || true', {
        cwd: this.homeDir,
        stdio: 'pipe',
        timeout: 10000,
      });

      // Pull latest
      const pullOutput = execSync('git pull origin main 2>&1', {
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

      // Pop stash
      execSync('git stash pop 2>/dev/null || true', {
        cwd: this.homeDir,
        stdio: 'pipe',
        timeout: 10000,
      });

      const newVersion = this.getLocalVersion();

      // Send notification about the update
      if (process.platform === 'darwin' && !alreadyUpToDate) {
        try {
          const msg = `Updated: ${local} → ${newVersion}`;
          execSync(
            `osascript -e 'display notification "${msg}" with title "🦖 openrappter updated"'`,
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
      return JSON.stringify({
        status: 'error',
        message: `Update failed: ${(err as Error).message}`,
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
