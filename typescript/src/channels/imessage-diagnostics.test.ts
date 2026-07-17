import { describe, expect, it } from 'vitest';
import { diagnoseIMessage } from './imessage-diagnostics.js';

describe('iMessage diagnostics', () => {
  it('reports only sanitized readiness facts', async () => {
    const result = await diagnoseIMessage({
      config: {
        enabled: true,
        mode: 'applescript',
        allowFrom: ['(555) 123-4567'],
      },
      tokenConfigured: true,
      platform: 'darwin',
      homeDirectory: '/Users/test',
      accessFile: async () => undefined,
      commandRunner: async (executable, args) => {
        if (executable.endsWith('sqlite3')) {
          return { exitCode: 0, stdout: '42\n' };
        }
        if (executable.endsWith('osascript')) {
          return { exitCode: 0, stdout: '1\n' };
        }
        if (args[0] === 'print') {
          return { exitCode: 0, stdout: 'private launchctl output' };
        }
        return { exitCode: 0, stdout: '' };
      },
      launchAgent: {
        waitForStart: false,
        checkHttp: false,
      },
    });

    expect(result).toMatchObject({
      platformSupported: true,
      enabled: true,
      allowlistEntries: 1,
      databaseReadable: true,
      databaseQueryable: true,
      databaseMaxRowId: 42,
      automationAvailable: true,
      iMessageServiceCount: 1,
      tokenConfigured: true,
    });
    expect(JSON.stringify(result)).not.toContain('+15551234567');
    expect(JSON.stringify(result)).not.toContain('private launchctl output');
  });

  it('returns actionable reason codes without command output', async () => {
    const result = await diagnoseIMessage({
      config: {
        enabled: false,
        allowFrom: ['invalid'],
      },
      tokenConfigured: false,
      platform: 'linux',
      accessFile: async () => {
        throw new Error('private path');
      },
      commandRunner: async () => ({
        exitCode: 1,
        stdout: 'private failure',
      }),
      launchAgent: {
        homeDirectory: '/missing',
        waitForStart: false,
        checkHttp: false,
      },
    });

    expect(result.ready).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      'unsupported_platform',
      'channel_disabled',
      'allowlist_empty',
      'database_unreadable',
      'copilot_token_missing',
      'launch_agent_not_installed',
    ]));
    expect(JSON.stringify(result)).not.toContain('private');
  });
});
