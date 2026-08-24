import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve('.test-output', 'organism-egg-cli-integration');
const HOME = path.join(ROOT, 'home');
const BINARY = path.resolve('bin', 'openrappter.mjs');
const PASSPHRASE = 'synthetic-integration-passphrase';

interface Preview {
  preview: {
    approvalBinding: string;
    previewHandle: string;
    nonce: string;
    targetRappid: string;
  };
}

function runCliUnchecked(
  args: string[],
  input?: string,
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [BINARY, ...args], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      OPENRAPPTER_HOME: HOME,
      OPENRAPPTER_RING: 'synthetic-integration',
    },
    encoding: 'utf8',
    input,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function runCli(args: string[], input?: string): string {
  const result = runCliUnchecked(args, input);
  if (result.status !== 0) {
    throw new Error(
      `openrappter ${args.join(' ')} failed (${result.status})\n`
      + `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
  }
  return String(result.stdout ?? '');
}

function parsePreview(output: string): Preview {
  return JSON.parse(output) as Preview;
}

function applyArgs(egg: string, preview: Preview['preview']): string[] {
  return [
    'egg', 'import', egg,
    '--apply',
    '--semantics', 'clone',
    '--approval', preview.approvalBinding,
    '--preview-handle', preview.previewHandle,
    '--nonce', preview.nonce,
    '--target-rappid', preview.targetRappid,
    '--passphrase-stdin',
    '--json',
  ];
}

function memoryVersion(): number {
  return (JSON.parse(
    fs.readFileSync(path.join(HOME, 'memory.json'), 'utf8'),
  ) as { version: number }).version;
}

describe('installed organism egg CLI release path', () => {
  beforeEach(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(path.join(HOME, 'agents'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(HOME, 'rappid.tail'), `${'d'.repeat(64)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(HOME, 'memory.json'), '{"version":1}\n', { mode: 0o600 });
    fs.writeFileSync(
      path.join(HOME, 'agents', 'lineage.jsonl'),
      '{"generation":1,"synthetic":true}\n',
      { mode: 0o600 },
    );
  });

  afterEach(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, '.home-egg-runtime'), { recursive: true, force: true });
  });

  it('pins preview bytes across the reported path swap and rejects adjacent approval bypasses', () => {
    const egg = path.join(ROOT, 'portable.egg');
    runCli([
      'egg', 'export',
      '--mode', 'portable',
      '--output', egg,
      '--json',
    ]);
    fs.writeFileSync(path.join(HOME, 'memory.json'), '{"version":2}\n', { mode: 0o600 });
    const preview = parsePreview(runCli([
      'egg', 'import', egg,
      '--preview',
      '--semantics', 'clone',
      '--json',
    ]));

    const wrongNonce = runCliUnchecked([
      ...applyArgs(egg, preview.preview),
    ].map((value, index, values) => (
      values[index - 1] === '--nonce' ? '00000000-0000-4000-8000-000000000000' : value
    )), `${PASSPHRASE}\n`);
    expect(wrongNonce.status).not.toBe(0);
    expect(memoryVersion()).toBe(2);

    const wrongTarget = runCliUnchecked([
      ...applyArgs(egg, preview.preview),
    ].map((value, index, values) => (
      values[index - 1] === '--target-rappid'
        ? `rappid:@openrappter/organism:${'e'.repeat(64)}`
        : value
    )), `${PASSPHRASE}\n`);
    expect(wrongTarget.status).not.toBe(0);
    expect(memoryVersion()).toBe(2);

    const wrongApproval = runCliUnchecked([
      ...applyArgs(egg, preview.preview),
    ].map((value, index, values) => (
      values[index - 1] === '--approval' ? 'f'.repeat(64) : value
    )), `${PASSPHRASE}\n`);
    expect(wrongApproval.status).not.toBe(0);
    expect(memoryVersion()).toBe(2);

    // This is the reported before-fix path: the file selected during preview
    // is replaced before apply. Apply must use the immutable private handle,
    // not reread this path.
    fs.writeFileSync(egg, 'path swapped after preview', { mode: 0o600 });
    const applied = JSON.parse(
      runCli(applyArgs(egg, preview.preview), `${PASSPHRASE}\n`),
    ) as { applied: boolean; preview: { eggDigest: string } };
    expect(applied.applied).toBe(true);
    expect(memoryVersion()).toBe(1);

    const replay = runCliUnchecked(
      applyArgs(egg, preview.preview),
      `${PASSPHRASE}\n`,
    );
    expect(replay.status).not.toBe(0);
    expect(memoryVersion()).toBe(1);
  }, 180_000);

  it('consumes a stale-base preview once and refuses its replay', () => {
    const egg = path.join(ROOT, 'stale.egg');
    runCli([
      'egg', 'export',
      '--mode', 'portable',
      '--output', egg,
      '--json',
    ]);
    fs.writeFileSync(path.join(HOME, 'memory.json'), '{"version":2}\n', { mode: 0o600 });
    const preview = parsePreview(runCli([
      'egg', 'import', egg,
      '--preview',
      '--semantics', 'clone',
      '--json',
    ]));
    fs.writeFileSync(path.join(HOME, 'memory.json'), '{"version":3}\n', { mode: 0o600 });

    const stale = runCliUnchecked(
      applyArgs(egg, preview.preview),
      `${PASSPHRASE}\n`,
    );
    expect(stale.status).not.toBe(0);
    expect(`${stale.stdout}\n${stale.stderr}`).toMatch(/changed after preview/i);
    expect(memoryVersion()).toBe(3);

    const replay = runCliUnchecked(
      applyArgs(egg, preview.preview),
      `${PASSPHRASE}\n`,
    );
    expect(replay.status).not.toBe(0);
    expect(`${replay.stdout}\n${replay.stderr}`).toMatch(/ENOENT|consumed|preview/i);
    expect(memoryVersion()).toBe(3);
  }, 180_000);
});
