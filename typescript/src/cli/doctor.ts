/**
 * Doctor Command
 * System diagnostics and health checks for openrappter.
 *
 * Checks:
 *   - Node.js version (>= 20.9.0)
 *   - npm/pnpm availability
 *   - Git installation
 *   - Python availability (for Python agents)
 *   - FFmpeg availability (for media processing)
 *   - GitHub Copilot CLI status
 *   - API key configuration
 *   - Database connectivity (SQLite)
 *   - Memory system status
 *   - Disk space
 *   - Gateway port availability
 *
 * Output: colored table of check results (pass/warn/fail)
 */

import type { Command } from 'commander';
import { execFileSync, execSync } from 'child_process';
import { existsSync, statfsSync, statSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { createConnection } from 'net';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  detail?: string;
}

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------

function green(s: string): string { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s: string): string { return `\x1b[33m${s}\x1b[0m`; }
function red(s: string): string { return `\x1b[31m${s}\x1b[0m`; }

function colorStatus(status: CheckStatus): string {
  switch (status) {
    case 'pass': return green('PASS');
    case 'warn': return yellow('WARN');
    case 'fail': return red('FAIL');
  }
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

export function checkNodeVersion(version = process.version): CheckResult {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  const current = match?.slice(1).map(Number);
  const minimum = [20, 9, 0];
  let supported = current !== undefined;
  if (current) {
    for (let index = 0; index < minimum.length; index++) {
      if (current[index] === minimum[index]) continue;
      supported = current[index] > minimum[index];
      break;
    }
  }

  if (supported) {
    return {
      name: 'Node.js Version',
      status: 'pass',
      message: `${version} (>= 20.9.0 required)`,
    };
  }
  return {
    name: 'Node.js Version',
    status: 'fail',
    message: `${version} is too old`,
    detail: 'Requires Node.js >= 20.9.0',
  };
}

function checkTool(name: string, cmd: string, displayName: string): CheckResult {
  try {
    const out = execSync(cmd, { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return { name: displayName, status: 'pass', message: out || 'available' };
  } catch {
    return { name: displayName, status: 'warn', message: `${name} not found`, detail: `Install ${name} to enable related features` };
  }
}

function checkNpm(): CheckResult {
  return checkTool('npm', 'npm --version', 'npm');
}

function checkGit(): CheckResult {
  return checkTool('git', 'git --version', 'Git');
}

function checkPython(): CheckResult {
  // Try python3 first, then python
  try {
    const out = execSync('python3 --version', { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    return { name: 'Python', status: 'pass', message: out };
  } catch {
    try {
      const out = execSync('python --version', { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
      return { name: 'Python', status: 'pass', message: out };
    } catch {
      return {
        name: 'Python',
        status: 'warn',
        message: 'Python not found',
        detail: 'Required for Python agent support',
      };
    }
  }
}

function checkFfmpeg(): CheckResult {
  try {
    const out = execFileSync('ffmpeg', ['-version'], {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim().split(/\r?\n/, 1)[0];
    return { name: 'FFmpeg', status: 'pass', message: out || 'available' };
  } catch {
    return {
      name: 'FFmpeg',
      status: 'warn',
      message: 'ffmpeg not found',
      detail: 'Install ffmpeg to enable related features',
    };
  }
}

function checkCopilot(): CheckResult {
  try {
    const out = execSync('gh copilot --version 2>&1 || gh extension list 2>&1', {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    if (out.includes('copilot') || out.includes('github/gh-copilot')) {
      return { name: 'GitHub Copilot CLI', status: 'pass', message: 'Copilot extension available' };
    }
    return {
      name: 'GitHub Copilot CLI',
      status: 'warn',
      message: 'Copilot CLI extension not installed',
      detail: 'Run: gh extension install github/gh-copilot',
    };
  } catch {
    return {
      name: 'GitHub Copilot CLI',
      status: 'warn',
      message: 'GitHub CLI (gh) not found',
      detail: 'Install gh from https://cli.github.com/',
    };
  }
}

function checkApiKeys(): CheckResult {
  const providers = [
    { name: 'Anthropic', key: 'ANTHROPIC_API_KEY' },
    { name: 'OpenAI', key: 'OPENAI_API_KEY' },
    { name: 'GitHub', key: 'GITHUB_TOKEN' },
  ];

  const configured = providers.filter((p) => process.env[p.key]);
  if (configured.length === 0) {
    return {
      name: 'API Keys',
      status: 'warn',
      message: 'No API keys configured',
      detail: 'Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GITHUB_TOKEN',
    };
  }
  return {
    name: 'API Keys',
    status: 'pass',
    message: `${configured.length} provider(s) configured`,
    detail: configured.map((p) => p.name).join(', '),
  };
}

function checkDatabase(): CheckResult {
  const dbPath = join(homedir(), '.openrappter', 'openrappter.db');
  try {
    if (existsSync(dbPath)) {
      const stat = statSync(dbPath);
      return {
        name: 'SQLite Database',
        status: 'pass',
        message: `Database exists (${(stat.size / 1024).toFixed(1)} KB)`,
        detail: dbPath,
      };
    }
    return {
      name: 'SQLite Database',
      status: 'warn',
      message: 'Database not yet created',
      detail: 'Will be created on first run',
    };
  } catch (err) {
    return {
      name: 'SQLite Database',
      status: 'fail',
      message: 'Cannot access database',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function checkMemorySystem(): CheckResult {
  const memPath = join(homedir(), '.openrappter', 'memory.json');
  const memDir = join(homedir(), '.openrappter', 'memories');
  if (existsSync(memPath) || existsSync(memDir)) {
    return { name: 'Memory System', status: 'pass', message: 'Memory storage found' };
  }
  return {
    name: 'Memory System',
    status: 'warn',
    message: 'Memory storage not initialized',
    detail: 'Will be created on first use',
  };
}

function checkDiskSpace(): CheckResult {
  try {
    const stats = statfsSync(tmpdir());
    const availableGB = (stats.bavail * stats.bsize) / (1024 ** 3);
    if (availableGB < 0.5) {
      return {
        name: 'Disk Space',
        status: 'fail',
        message: `Only ${availableGB.toFixed(1)} GB available`,
        detail: 'Low disk space may cause issues',
      };
    }
    if (availableGB < 2) {
      return {
        name: 'Disk Space',
        status: 'warn',
        message: `${availableGB.toFixed(1)} GB available`,
        detail: 'Consider freeing up disk space',
      };
    }
    return {
      name: 'Disk Space',
      status: 'pass',
      message: `${availableGB.toFixed(1)} GB available`,
    };
  } catch {
    return { name: 'Disk Space', status: 'warn', message: 'Could not check disk space' };
  }
}

async function checkGatewayPort(port = 18790): Promise<CheckResult> {
  return new Promise((resolve) => {
    const sock = createConnection(port, '127.0.0.1');
    sock.setTimeout(1500);
    sock.on('connect', () => {
      sock.destroy();
      resolve({
        name: 'Gateway Port',
        status: 'warn',
        message: `Port ${port} is in use (gateway may already be running)`,
      });
    });
    sock.on('error', () => {
      resolve({
        name: 'Gateway Port',
        status: 'pass',
        message: `Port ${port} is available`,
      });
    });
    sock.on('timeout', () => {
      sock.destroy();
      resolve({
        name: 'Gateway Port',
        status: 'pass',
        message: `Port ${port} is available`,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

export async function runDoctorChecks(): Promise<CheckResult[]> {
  const checks: CheckResult[] = [
    checkNodeVersion(),
    checkNpm(),
    checkGit(),
    checkPython(),
    checkFfmpeg(),
    checkCopilot(),
    checkApiKeys(),
    checkDatabase(),
    checkMemorySystem(),
    checkDiskSpace(),
    await checkGatewayPort(),
  ];
  return checks;
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerDoctorCommand(
  program: Command,
  runChecks: () => Promise<CheckResult[]> = runDoctorChecks,
): void {
  program
    .command('doctor')
    .description('Run system diagnostics and health checks')
    .option('--json', 'Output results as JSON')
    .action(async (options: { json?: boolean }) => {
      if (!options.json) {
        console.log('\nRunning OpenRappter diagnostics...\n');
      }

      const results = await runChecks();
      const failed = results.some((result) => result.status === 'fail');

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
        if (failed) process.exitCode = 1;
        return;
      }

      // Calculate column widths for table
      const nameWidth = Math.max(20, ...results.map((r) => r.name.length));

      // Print header
      console.log(`${'Check'.padEnd(nameWidth)}  Status  Message`);
      console.log('-'.repeat(nameWidth + 40));

      for (const result of results) {
        const statusLabel = colorStatus(result.status);
        const name = result.name.padEnd(nameWidth);
        console.log(`${name}  ${statusLabel}  ${result.message}`);
        if (result.detail) {
          console.log(`${''.padEnd(nameWidth)}         ${result.detail}`);
        }
      }

      console.log('');
      const passCount = results.filter((r) => r.status === 'pass').length;
      const warnCount = results.filter((r) => r.status === 'warn').length;
      const failCount = results.filter((r) => r.status === 'fail').length;

      console.log(`Results: ${green(String(passCount))} passed, ${yellow(String(warnCount))} warnings, ${red(String(failCount))} failed`);
      console.log('');

      if (failed) process.exitCode = 1;
    });
}
