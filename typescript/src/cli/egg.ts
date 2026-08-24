import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Command } from 'commander';
import { sha256 } from '../egg/archive.js';
import { OrganismEggService } from '../egg/service.js';
import type { EggMode, ImportSemantics } from '../egg/types.js';
import { VERSION } from '../version.js';

function nextDefaultOutput(mode: EggMode): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.resolve(`OpenRappter-${stamp}-${mode}.egg`);
}

function sourceCommit(): string {
  if (/^[0-9a-f]{40}$/.test(process.env.OPENRAPPTER_SOURCE_COMMIT ?? '')) {
    return process.env.OPENRAPPTER_SOURCE_COMMIT as string;
  }
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return `package-sha256:${sha256(fs.readFileSync(new URL('../index.js', import.meta.url)))}`;
  }
}

async function passphraseFromStdin(requested: boolean | undefined): Promise<string | undefined> {
  if (!requested) return undefined;
  if (process.stdin.isTTY) {
    throw new Error('Passphrases are accepted only on stdin, never as command arguments or environment variables');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const passphrase = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  if (!passphrase) throw new Error('No passphrase was received on stdin');
  return passphrase;
}

function service(): OrganismEggService {
  return new OrganismEggService();
}

function print(value: unknown, json: boolean | undefined): void {
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.log(value);
}

export function registerEggCommand(program: Command): void {
  const egg = program
    .command('egg')
    .description('Export, inspect, diff, and transactionally restore an OpenRappter organism .egg');

  egg.command('export')
    .description('Export a private-by-default RAPP/1 organism egg')
    .option('--mode <mode>', 'portable or sealed-backup', 'portable')
    .option('-o, --output <path>', 'new .egg path (never overwritten)')
    .option('--include-history', 'include sessions, messages, and Flight history')
    .option('--include-media', 'include owned/licensed local sound and MIDI')
    .option('--media <paths...>', 'specific media paths under the organism home')
    .option('--acknowledge-unknown-license', 'explicitly include selected media with unknown license')
    .option('--passphrase-stdin', 'read sealed-backup passphrase from stdin')
    .option('--json', 'print machine-readable result')
    .action(async (options: {
      mode: string;
      output?: string;
      includeHistory?: boolean;
      includeMedia?: boolean;
      media?: string[];
      acknowledgeUnknownLicense?: boolean;
      passphraseStdin?: boolean;
      json?: boolean;
    }) => {
      if (options.mode !== 'portable' && options.mode !== 'sealed-backup') {
        throw new Error('--mode must be portable or sealed-backup');
      }
      if (options.mode === 'sealed-backup' && !options.passphraseStdin) {
        throw new Error('sealed-backup requires --passphrase-stdin');
      }
      const passphrase = await passphraseFromStdin(options.passphraseStdin);
      const output = path.resolve(options.output ?? nextDefaultOutput(options.mode));
      const result = await service().export({
        mode: options.mode,
        output,
        passphrase,
        includeHistory: options.includeHistory,
        includeMedia: options.includeMedia || Boolean(options.media?.length),
        mediaPaths: options.media,
        acknowledgeUnknownLicense: options.acknowledgeUnknownLicense,
        sourceVersion: VERSION,
        sourceCommit: sourceCommit(),
        sourceRing: process.env.OPENRAPPTER_RING ?? 'stable',
      });
      print(options.json ? result : (
        `Created ${result.output}\n${result.manifest.dimensions.files} files, `
        + `${result.manifest.dimensions.bytes} bytes, digest ${result.digest}\n`
        + `permissions: ${result.permissions}`
      ), options.json);
    });

  egg.command('inspect <file>')
    .description('Verify an egg without executing content; sealed payloads stay encrypted by default')
    .option('--decrypt', 'decrypt sealed payload using stdin')
    .option('--passphrase-stdin', 'read passphrase from stdin')
    .option('--json', 'print machine-readable result')
    .action(async (file: string, options: {
      decrypt?: boolean;
      passphraseStdin?: boolean;
      json?: boolean;
    }) => {
      if (options.decrypt && !options.passphraseStdin) {
        throw new Error('--decrypt requires --passphrase-stdin');
      }
      const passphrase = await passphraseFromStdin(options.passphraseStdin);
      const result = service().inspect(path.resolve(file), passphrase);
      print(options.json ? result : (
        `${result.header.mode} ${result.header.organismRappid}\n`
        + `${result.header.dimensions.files} files, ${result.header.dimensions.bytes} bytes\n`
        + `root ${result.header.rootDigest}\n`
        + (result.decrypted ? 'payload verified' : 'payload remains encrypted')
      ), options.json);
    });

  egg.command('diff <file>')
    .description('Compare an egg with the current organism without mutation')
    .option('--semantics <kind>', 'restore or clone', 'restore')
    .option('--passphrase-stdin', 'read sealed egg passphrase from stdin')
    .option('--json', 'print machine-readable result')
    .action(async (file: string, options: {
      semantics: string;
      passphraseStdin?: boolean;
      json?: boolean;
    }) => {
      if (options.semantics !== 'restore' && options.semantics !== 'clone') {
        throw new Error('--semantics must be restore or clone');
      }
      const result = await service().diff(path.resolve(file), {
        passphrase: await passphraseFromStdin(options.passphraseStdin),
        semantics: options.semantics,
      });
      print(options.json ? result : (
        `${result.compatible ? 'compatible' : 'identity mismatch'}: `
        + `${result.entries.filter((entry) => entry.change !== 'unchanged').length} changes\n`
        + `approval ${result.approvalBinding}`
      ), options.json);
    });

  egg.command('import <file>')
    .description('Preview or explicitly apply a verified organism restore/clone')
    .option('--preview', 'verify and show the complete diff without mutation')
    .option('--apply', 'apply transactionally after an exact preview approval')
    .option('--approval <digest>', 'action-bound approval digest printed by preview')
    .option('--semantics <kind>', 'restore or clone', 'restore')
    .option('--passphrase-stdin', 'read sealed/rollback passphrase from stdin')
    .option('--json', 'print machine-readable result')
    .action(async (file: string, options: {
      preview?: boolean;
      apply?: boolean;
      approval?: string;
      semantics: string;
      passphraseStdin?: boolean;
      json?: boolean;
    }) => {
      if (options.preview === options.apply) {
        throw new Error('Choose exactly one of --preview or --apply');
      }
      if (options.semantics !== 'restore' && options.semantics !== 'clone') {
        throw new Error('--semantics must be restore or clone');
      }
      if (options.apply && !options.passphraseStdin) {
        throw new Error('--apply requires --passphrase-stdin to encrypt the rollback egg');
      }
      const passphrase = await passphraseFromStdin(options.passphraseStdin);
      const result = await service().import({
        eggPath: path.resolve(file),
        passphrase,
        rollbackPassphrase: passphrase,
        semantics: options.semantics as ImportSemantics,
        approval: options.approval,
        apply: options.apply === true,
      });
      print(options.json ? result : (
        result.applied
          ? `Applied ${result.preview.eggDigest}; rollback ${result.rollbackEgg}; ${result.health}`
          : `Preview only: ${result.preview.entries.length} entries\napproval ${result.preview.approvalBinding}`
      ), options.json);
    });
}
