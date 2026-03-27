/**
 * Release Channel — Switch between production and experimental branches.
 *
 * Think Chrome Stable vs Canary. The user runs one install of openrappter
 * and flips a switch to get the experimental branch. Changes made on the
 * experimental channel can be promoted back to production (digital twin).
 *
 * Channels:
 *   stable       — tracks origin/main (default, production)
 *   experimental — tracks a feature branch (e.g. feat/zen-pong)
 *
 * How it works:
 *   - Channel config lives in ~/.openrappter/channel.json
 *   - `switch` stashes local changes, checks out the target branch, rebuilds
 *   - `promote` cherry-picks experimental commits onto stable (manual enable)
 *   - `status` shows current channel, branch, and drift from stable
 *
 * The install directory is auto-detected from the running process.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

export interface ChannelConfig {
  current: 'stable' | 'experimental';
  stableBranch: string;
  experimentalBranch: string;
  lastSwitch: string;         // ISO timestamp
  promoteEnabled: boolean;    // must be manually enabled
}

const HOME_DIR = path.join(os.homedir(), '.openrappter');
const CHANNEL_FILE = path.join(HOME_DIR, 'channel.json');

const DEFAULT_CONFIG: ChannelConfig = {
  current: 'stable',
  stableBranch: 'main',
  experimentalBranch: '',
  lastSwitch: '',
  promoteEnabled: false,
};

// ── Config persistence ──────────────────────────────────────────────────────

export function loadChannelConfig(): ChannelConfig {
  try {
    const raw = fs.readFileSync(CHANNEL_FILE, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveChannelConfig(config: ChannelConfig): void {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(CHANNEL_FILE, JSON.stringify(config, null, 2) + '\n');
}

// ── Git helpers ─────────────────────────────────────────────────────────────

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function detectRepoDir(): string {
  // Walk up from this file to find the repo root (has .git)
  let dir = path.resolve(__dirname, '..', '..', '..');
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('Cannot find openrappter git repo. Are you running from a git install?');
}

// ── Channel operations ──────────────────────────────────────────────────────

export interface ChannelStatus {
  current: 'stable' | 'experimental';
  branch: string;
  stableBranch: string;
  experimentalBranch: string;
  commitsBehindStable: number;
  commitsAheadStable: number;
  dirty: boolean;
  promoteEnabled: boolean;
}

export function channelStatus(): ChannelStatus {
  const config = loadChannelConfig();
  const repoDir = detectRepoDir();

  const currentBranch = git('rev-parse --abbrev-ref HEAD', repoDir);
  const dirty = git('status --porcelain', repoDir).length > 0;

  let behind = 0;
  let ahead = 0;
  if (config.experimentalBranch && currentBranch !== config.stableBranch) {
    try {
      git(`fetch origin ${config.stableBranch} --quiet`, repoDir);
      const counts = git(`rev-list --left-right --count origin/${config.stableBranch}...HEAD`, repoDir);
      const [b, a] = counts.split('\t').map(Number);
      behind = b;
      ahead = a;
    } catch { /* offline is fine */ }
  }

  return {
    current: config.current,
    branch: currentBranch,
    stableBranch: config.stableBranch,
    experimentalBranch: config.experimentalBranch || '(none)',
    commitsBehindStable: behind,
    commitsAheadStable: ahead,
    dirty,
    promoteEnabled: config.promoteEnabled,
  };
}

export function switchChannel(target: 'stable' | 'experimental', experimentalBranch?: string): string {
  const config = loadChannelConfig();
  const repoDir = detectRepoDir();

  if (target === 'experimental' && experimentalBranch) {
    config.experimentalBranch = experimentalBranch;
  }

  if (target === 'experimental' && !config.experimentalBranch) {
    throw new Error('No experimental branch set. Use: openrappter channel switch experimental <branch>');
  }

  const targetBranch = target === 'stable' ? config.stableBranch : config.experimentalBranch;

  // Stash any local changes
  const dirty = git('status --porcelain', repoDir).length > 0;
  if (dirty) {
    git(`stash push -m "openrappter-channel-switch-${Date.now()}"`, repoDir);
  }

  // Fetch and checkout
  git(`fetch origin ${targetBranch} --quiet`, repoDir);
  git(`checkout ${targetBranch}`, repoDir);
  git(`pull origin ${targetBranch} --quiet`, repoDir);

  config.current = target;
  config.lastSwitch = new Date().toISOString();
  saveChannelConfig(config);

  return `Switched to ${target} channel (${targetBranch})${dirty ? ' — local changes stashed' : ''}`;
}

export function promoteToStable(commits?: number): string {
  const config = loadChannelConfig();

  if (!config.promoteEnabled) {
    throw new Error(
      'Promote is disabled. Enable it with: openrappter channel promote --enable\n' +
      'This cherry-picks experimental commits onto stable. Use with caution.'
    );
  }

  if (config.current !== 'experimental') {
    throw new Error('Must be on experimental channel to promote. Switch first.');
  }

  const repoDir = detectRepoDir();
  const n = commits ?? 1;

  // Get the commit SHAs to promote
  const shas = git(`log --oneline -${n} --format=%H`, repoDir).split('\n').reverse();

  // Switch to stable
  git(`checkout ${config.stableBranch}`, repoDir);
  git(`pull origin ${config.stableBranch} --quiet`, repoDir);

  // Cherry-pick each commit
  const promoted: string[] = [];
  for (const sha of shas) {
    try {
      git(`cherry-pick ${sha}`, repoDir);
      const msg = git(`log --oneline -1 ${sha}`, repoDir);
      promoted.push(msg);
    } catch {
      git('cherry-pick --abort', repoDir);
      throw new Error(`Cherry-pick failed for ${sha}. Aborted. Stable is unchanged.`);
    }
  }

  // Switch back to experimental
  git(`checkout ${config.experimentalBranch}`, repoDir);
  config.lastSwitch = new Date().toISOString();
  saveChannelConfig(config);

  return `Promoted ${promoted.length} commit(s) to ${config.stableBranch}:\n${promoted.map(p => `  ${p}`).join('\n')}`;
}

export function enablePromote(enable: boolean): string {
  const config = loadChannelConfig();
  config.promoteEnabled = enable;
  saveChannelConfig(config);
  return `Promote ${enable ? 'enabled' : 'disabled'}. ${enable ? '⚠️  Cherry-picks will modify stable.' : ''}`;
}
