import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface DiagnosticCheck {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
  detail?: string;
}

export async function runDiagnostics(): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];

  // Check Node version
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0], 10);
  if (majorVersion >= 18) {
    checks.push({
      name: 'Node Version',
      status: 'ok',
      message: `Node ${nodeVersion} is supported`,
    });
  } else {
    checks.push({
      name: 'Node Version',
      status: 'error',
      message: `Node ${nodeVersion} is not supported`,
      detail: 'Requires Node >= 18',
    });
  }

  // Check config directory exists
  const configDir = join(homedir(), '.openrappter');
  if (existsSync(configDir)) {
    checks.push({
      name: 'Config Directory',
      status: 'ok',
      message: 'Config directory exists',
      detail: configDir,
    });
  } else {
    checks.push({
      name: 'Config Directory',
      status: 'warn',
      message: 'Config directory does not exist',
      detail: configDir,
    });
  }

  // Check config parseable
  const configPath = join(configDir, 'config.json5');
  if (existsSync(configPath)) {
    try {
      readFileSync(configPath, 'utf-8');
      checks.push({
        name: 'Config File',
        status: 'ok',
        message: 'Config file is readable',
      });
    } catch (error) {
      checks.push({
        name: 'Config File',
        status: 'error',
        message: 'Config file is not readable',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    checks.push({
      name: 'Config File',
      status: 'warn',
      message: 'Config file does not exist',
      detail: configPath,
    });
  }

  // Check directory writable
  const testFile = join(configDir, '.diagnostic-test');
  try {
    writeFileSync(testFile, 'test', 'utf-8');
    unlinkSync(testFile);
    checks.push({
      name: 'Directory Writable',
      status: 'ok',
      message: 'Config directory is writable',
    });
  } catch (error) {
    checks.push({
      name: 'Directory Writable',
      status: 'error',
      message: 'Config directory is not writable',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  // Check gateway reachable
  try {
    const response = await fetch('http://localhost:18790/health', {
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) {
      checks.push({
        name: 'Gateway',
        status: 'ok',
        message: 'Gateway is reachable',
      });
    } else {
      checks.push({
        name: 'Gateway',
        status: 'warn',
        message: 'Gateway returned non-OK status',
        detail: `Status: ${response.status}`,
      });
    }
  } catch (error) {
    checks.push({
      name: 'Gateway',
      status: 'warn',
      message: 'Gateway is not reachable',
      detail: 'May not be running',
    });
  }

  // Check providers configured
  const providers = [
    { name: 'Anthropic', key: 'ANTHROPIC_API_KEY' },
    { name: 'OpenAI', key: 'OPENAI_API_KEY' },
    { name: 'GitHub', key: 'GITHUB_TOKEN' },
  ];

  const configuredProviders = providers.filter((p) => process.env[p.key]);
  if (configuredProviders.length > 0) {
    checks.push({
      name: 'Providers',
      status: 'ok',
      message: `${configuredProviders.length} provider(s) configured`,
      detail: configuredProviders.map((p) => p.name).join(', '),
    });
  } else {
    checks.push({
      name: 'Providers',
      status: 'warn',
      message: 'No providers configured',
      detail: 'Set API keys in environment variables',
    });
  }

  return checks;
}
