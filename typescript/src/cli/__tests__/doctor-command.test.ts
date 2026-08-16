import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

import {
  checkNodeVersion,
  registerDoctorCommand,
  type CheckResult,
} from '../doctor.js';

let previousExitCode: typeof process.exitCode;

async function runJsonDoctor(results: CheckResult[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerDoctorCommand(program, async () => results);
  await program.parseAsync(['node', 'openrappter', 'doctor', '--json']);
}

beforeEach(() => {
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
});

describe('doctor --json process contract', () => {
  it('returns a failing exit status when a check fails', async () => {
    await runJsonDoctor([
      { name: 'Node.js', status: 'pass', message: 'ok' },
      { name: 'Disk', status: 'fail', message: 'full' },
    ]);

    expect(process.exitCode).toBe(1);
  });

  it('does not fail the process for warnings alone', async () => {
    await runJsonDoctor([
      { name: 'Node.js', status: 'pass', message: 'ok' },
      { name: 'FFmpeg', status: 'warn', message: 'not installed' },
    ]);

    expect(process.exitCode).toBeUndefined();
  });
});

describe('doctor Node.js support floor', () => {
  it.each(['v18.20.0', 'v20.8.9'])('fails unsupported %s', (version) => {
    expect(checkNodeVersion(version).status).toBe('fail');
  });

  it.each(['v20.9.0', 'v20.10.0', 'v21.0.0', 'v22.0.0'])(
    'passes supported %s',
    (version) => {
      expect(checkNodeVersion(version).status).toBe('pass');
    },
  );
});
