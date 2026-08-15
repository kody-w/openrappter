import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertPrivateDirectory,
  hardenPrivatePath,
  syncParentDirectory,
} from '../flight-recorder/permissions.js';
import {
  DESKTOP_COMMAND_SCHEMA,
  DESKTOP_RESULT_SCHEMA,
  type DesktopCommand,
  type DesktopCommandResult,
  type DesktopControlAction,
} from './types.js';

const MAX_COMMAND_BYTES = 1_500_000;
const hardenedDirectories = new Set<string>();

function privateDirectory(directory: string): void {
  const resolved = path.resolve(directory);
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const linked = lstatSync(resolved);
  if (linked.isSymbolicLink() || !linked.isDirectory()) {
    throw new Error(`Desktop control path is not a directory: ${resolved}`);
  }
  if (!hardenedDirectories.has(resolved)) {
    hardenPrivatePath(resolved, true);
    assertPrivateDirectory(resolved);
    hardenedDirectories.add(resolved);
  }
}

function atomicPrivateJson(file: string, value: unknown): void {
  const content = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(content, 'utf8') > MAX_COMMAND_BYTES) {
    throw new Error('Desktop control command is too large.');
  }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  if (process.platform !== 'win32') hardenPrivatePath(temporary);
  renameSync(temporary, file);
  syncParentDirectory(path.dirname(file));
}

function readJson<T>(file: string): T {
  const linked = lstatSync(file);
  if (linked.isSymbolicLink() || !linked.isFile()) {
    throw new Error(`Desktop control message is not a regular file: ${file}`);
  }
  const content = readFileSync(file, 'utf8');
  if (Buffer.byteLength(content, 'utf8') > MAX_COMMAND_BYTES) {
    throw new Error('Desktop control message is too large.');
  }
  return JSON.parse(content) as T;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function desktopControlRoot(): string {
  return path.resolve(
    process.env.OPENRAPPTER_DESKTOP_CONTROL_DIR ??
      path.join(os.homedir(), '.openrappter', 'desktop-control'),
  );
}

export class DesktopCommandQueue {
  readonly root: string;
  readonly commandsDir: string;
  readonly processingDir: string;
  readonly resultsDir: string;

  constructor(root = desktopControlRoot()) {
    this.root = path.resolve(root);
    this.commandsDir = path.join(this.root, 'commands');
    this.processingDir = path.join(this.root, 'processing');
    this.resultsDir = path.join(this.root, 'results');
    privateDirectory(this.commandsDir);
    privateDirectory(this.processingDir);
    privateDirectory(this.resultsDir);
    this.recoverStaleClaims();
  }

  async execute(
    action: DesktopControlAction,
    args: Record<string, unknown> = {},
    timeoutMs = action === 'install_agent'
      ? process.env.OPENRAPPTER_DESKTOP_SMOKE === '1'
        ? 60_000
        : 20 * 60_000
      : 30_000,
  ): Promise<DesktopCommandResult> {
    const now = Date.now();
    const command: DesktopCommand = {
      schema: DESKTOP_COMMAND_SCHEMA,
      id: `${String(now).padStart(13, '0')}-${randomUUID()}`,
      action,
      args,
      createdAt: now,
      expiresAt: now + timeoutMs,
    };
    const commandPath = path.join(this.commandsDir, `${command.id}.json`);
    const resultPath = path.join(this.resultsDir, `${command.id}.json`);
    atomicPrivateJson(commandPath, command);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(resultPath)) {
        const result = readJson<DesktopCommandResult>(resultPath);
        unlinkSync(resultPath);
        if (
          result.schema !== DESKTOP_RESULT_SCHEMA ||
          result.id !== command.id
        ) {
          throw new Error('Desktop control returned a mismatched response.');
        }
        return result;
      }
      await delay(100);
    }
    rmSync(commandPath, { force: true });
    rmSync(path.join(this.processingDir, `${command.id}.json`), {
      force: true,
    });
    rmSync(resultPath, { force: true });
    throw new Error(
      'OpenRappter Desktop did not answer the UI command. Open the Electron app and try again.',
    );
  }

  claimNext(): DesktopCommand | null {
    const ordered = readdirSync(this.commandsDir)
      .filter((file) => /^[a-z0-9-]+\.json$/i.test(file))
      .map((name) => ({
        name,
        mtime: statSync(
          path.join(this.commandsDir, name),
          { bigint: true },
        ).mtimeNs,
      }))
      .sort((left, right) =>
        left.mtime < right.mtime
          ? -1
          : left.mtime > right.mtime
            ? 1
            : left.name.localeCompare(right.name));
    for (const { name } of ordered) {
      const source = path.join(this.commandsDir, name);
      const claimed = path.join(this.processingDir, name);
      try {
        renameSync(source, claimed);
      } catch {
        continue;
      }
      try {
        const command = readJson<DesktopCommand>(claimed);
        if (
          command.schema !== DESKTOP_COMMAND_SCHEMA ||
          typeof command.id !== 'string' ||
          command.expiresAt < Date.now()
        ) {
          rmSync(claimed, { force: true });
          continue;
        }
        return command;
      } catch {
        rmSync(claimed, { force: true });
      }
    }
    return null;
  }

  complete(
    command: DesktopCommand,
    outcome: { status: 'success'; result: unknown } | { status: 'error'; error: string },
  ): void {
    const response: DesktopCommandResult = {
      schema: DESKTOP_RESULT_SCHEMA,
      id: command.id,
      status: outcome.status,
      ...(outcome.status === 'success'
        ? { result: outcome.result }
        : { error: outcome.error }),
      completedAt: Date.now(),
    };
    atomicPrivateJson(
      path.join(this.resultsDir, `${command.id}.json`),
      response,
    );
    rmSync(path.join(this.processingDir, `${command.id}.json`), { force: true });
  }

  private recoverStaleClaims(): void {
    const staleBefore = Date.now() - 30 * 60_000;
    for (const name of readdirSync(this.processingDir).filter((file) =>
      file.endsWith('.json'))) {
      const claimed = path.join(this.processingDir, name);
      try {
        if (statSync(claimed).mtimeMs >= staleBefore) continue;
        renameSync(claimed, path.join(this.commandsDir, name));
      } catch {
        rmSync(claimed, { force: true });
      }
    }
  }
}
