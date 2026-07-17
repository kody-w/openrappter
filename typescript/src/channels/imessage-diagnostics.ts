import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  getIMessageServiceStatus,
  type IMessageLaunchAgentOptions,
  type IMessageServiceStatus,
  type LaunchdCommandResult,
} from './imessage-launchd.js';
import {
  normalizeIMessageAddress,
  type IMessageConfig,
} from './imessage.js';

export interface IMessageDiagnosticResult {
  platformSupported: boolean;
  enabled: boolean;
  allowlistEntries: number;
  databaseReadable: boolean;
  databaseQueryable: boolean;
  databaseMaxRowId?: number;
  automationAvailable: boolean;
  iMessageServiceCount?: number;
  tokenConfigured: boolean;
  service: IMessageServiceStatus;
  ready: boolean;
  reasons: string[];
}

export interface IMessageDiagnosticOptions {
  config: IMessageConfig;
  tokenConfigured: boolean;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  commandRunner?: (
    executable: string,
    args: readonly string[],
  ) => Promise<LaunchdCommandResult>;
  accessFile?: (filePath: string) => Promise<void>;
  launchAgent?: IMessageLaunchAgentOptions;
}

const defaultCommandRunner = (
  executable: string,
  args: readonly string[],
): Promise<LaunchdCommandResult> => new Promise(resolve => {
  execFile(
    executable,
    [...args],
    {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    },
    (error, stdout) => {
      resolve({
        exitCode:
          error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
        stdout: String(stdout),
      });
    },
  );
});

export async function diagnoseIMessage(
  options: IMessageDiagnosticOptions,
): Promise<IMessageDiagnosticResult> {
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const accessFile =
    options.accessFile
    ?? (filePath => fs.access(filePath, fs.constants.R_OK));
  const databasePath = path.join(
    homeDirectory,
    'Library',
    'Messages',
    'chat.db',
  );
  const allowlistEntries = (options.config.allowFrom ?? [])
    .map(normalizeIMessageAddress)
    .filter((entry): entry is string => entry !== null).length;
  const reasons: string[] = [];
  const platformSupported = platform === 'darwin';
  if (!platformSupported) reasons.push('unsupported_platform');
  if (!options.config.enabled) reasons.push('channel_disabled');
  if (allowlistEntries === 0) reasons.push('allowlist_empty');

  let databaseReadable = false;
  try {
    await accessFile(databasePath);
    databaseReadable = true;
  } catch {
    reasons.push('database_unreadable');
  }

  let databaseQueryable = false;
  let databaseMaxRowId: number | undefined;
  if (databaseReadable) {
    const query = await commandRunner(
      '/usr/bin/sqlite3',
      [
        '-readonly',
        databasePath,
        'SELECT COALESCE(MAX(ROWID), 0) FROM message;',
      ],
    );
    const rowId = Number.parseInt(query.stdout.trim(), 10);
    if (
      query.exitCode === 0
      && Number.isSafeInteger(rowId)
      && rowId >= 0
    ) {
      databaseQueryable = true;
      databaseMaxRowId = rowId;
    } else {
      reasons.push('database_query_failed');
    }
  }

  let automationAvailable = false;
  let iMessageServiceCount: number | undefined;
  if (platformSupported) {
    const automation = await commandRunner(
      '/usr/bin/osascript',
      [
        '-e',
        'tell application "Messages" to return count of (every service whose service type is iMessage)',
      ],
    );
    const serviceCount = Number.parseInt(automation.stdout.trim(), 10);
    if (
      automation.exitCode === 0
      && Number.isSafeInteger(serviceCount)
      && serviceCount > 0
    ) {
      automationAvailable = true;
      iMessageServiceCount = serviceCount;
    } else {
      reasons.push('messages_automation_unavailable');
    }
  }

  if (!options.tokenConfigured) reasons.push('copilot_token_missing');
  const service = await getIMessageServiceStatus({
    homeDirectory,
    commandRunner,
    ...options.launchAgent,
  });
  if (!service.installed) reasons.push('launch_agent_not_installed');
  if (service.installed && !service.loaded) reasons.push('launch_agent_not_loaded');
  if (service.loaded && !service.live) reasons.push('gateway_not_live');
  if (service.live && !service.ready) {
    reasons.push(service.readinessReason ?? 'gateway_not_ready');
  }

  return {
    platformSupported,
    enabled: options.config.enabled === true,
    allowlistEntries,
    databaseReadable,
    databaseQueryable,
    databaseMaxRowId,
    automationAvailable,
    iMessageServiceCount,
    tokenConfigured: options.tokenConfigured,
    service,
    ready:
      platformSupported
      && options.config.enabled === true
      && allowlistEntries > 0
      && databaseReadable
      && databaseQueryable
      && automationAvailable
      && options.tokenConfigured
      && service.loaded
      && service.live
      && service.ready,
    reasons: Array.from(new Set(reasons)),
  };
}
