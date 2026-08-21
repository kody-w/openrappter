import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

import type { Command } from 'commander';

import {
  RAPPID_CARD_FIXTURE_NAMES,
  RAPPID_CARD_PROTOCOL,
  RAPPID_CARD_TEST_PROFILE,
  BoundedReplayCache,
  buildRappidCardFixture,
  makeDeepLink,
  manifestHash,
  parseManifestJson,
  renderRappidCardQrPng,
  renderRappidCardQrSvg,
  simulateRappidCard,
  simulateRappidCardFixture,
  writeRappidCardFixtureDeck,
} from '../rappid-card/index.js';
import type {
  CardAlgorithm,
  CardKeyProvider,
  CardMode,
  CardProviders,
  QrArtifactFormat,
  RappidCardFixtureName,
  RappidCardManifest,
} from '../rappid-card/index.js';
import { VERSION } from '../version.js';

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function fixtureName(value: string): RappidCardFixtureName {
  if (!RAPPID_CARD_FIXTURE_NAMES.includes(value as RappidCardFixtureName)) {
    throw new Error(
      `fixture must be one of: ${RAPPID_CARD_FIXTURE_NAMES.join(', ')}`,
    );
  }
  return value as RappidCardFixtureName;
}

function qrFormat(value: string): QrArtifactFormat {
  if (value !== 'svg' && value !== 'png' && value !== 'both') {
    throw new Error('format must be svg, png, or both');
  }
  return value;
}

function cardMode(value: string): CardMode {
  if (value !== 'fixture' && value !== 'production') {
    throw new Error('mode must be fixture or production');
  }
  return value;
}

async function readLink(value: string | undefined, manifest: RappidCardManifest): Promise<string> {
  if (!value) return makeDeepLink(manifest);
  if (value.startsWith('rappid://')) return value;
  return (await readFile(value, 'utf8')).trim();
}

async function explicitKeyProvider(path: string | undefined): Promise<CardKeyProvider> {
  if (!path) return { getKey: () => null };
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('key file must be an object mapping key ids to 64 hex characters');
  }
  const keys = new Map<string, Uint8Array>();
  for (const [keyId, value] of Object.entries(raw)) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
      throw new Error(`key file entry ${keyId} must be 64 lowercase hex characters`);
    }
    keys.set(keyId, Buffer.from(value, 'hex'));
  }
  return {
    getKey(keyId: string, _algorithm: CardAlgorithm) {
      return keys.get(keyId) ?? null;
    },
  };
}

function matchingFixture(manifest: RappidCardManifest) {
  const hash = manifestHash(manifest);
  return RAPPID_CARD_FIXTURE_NAMES
    .map((name) => buildRappidCardFixture(name))
    .find((fixture) => manifestHash(fixture.manifest) === hash);
}

async function inspectCard(
  cardPath: string,
  options: {
    link?: string;
    mode: CardMode;
    keys?: string;
    approve?: boolean;
  },
): Promise<void> {
  const manifest = parseManifestJson(await readFile(cardPath, 'utf8'));
  const link = await readLink(options.link, manifest);
  const fixture = matchingFixture(manifest);
  let providers: CardProviders;
  if (options.mode === 'fixture' && fixture) {
    providers = {
      ...fixture.providers,
      manifests: {
        getManifest: () => structuredClone(manifest),
      },
    };
  } else {
    providers = {
      manifests: { getManifest: () => structuredClone(manifest) },
      keys: await explicitKeyProvider(options.keys),
      revocations: { isRevoked: () => false },
      content: { getPart: () => null },
      challenge: { respond: () => '0'.repeat(64) },
    };
  }
  const snapshot = await simulateRappidCard(link, {
    approve: options.approve === true,
    policy: {
      mode: options.mode,
      now:
        options.mode === 'fixture' && fixture
          ? fixture.policy.now
          : new Date().toISOString().replace('.000Z', 'Z'),
      runtimeName: 'openrappter',
      runtimeVersion: VERSION,
      protocol: RAPPID_CARD_PROTOCOL,
      maxClassification: 'restricted',
      grantedScopes: [
        'identity:read',
        'traits:read',
        'skill:hydrate',
        'sonic:hydrate',
        'capability:hydrate',
      ],
    },
    providers,
    replayCache: new BoundedReplayCache(),
  });
  print({
    file: cardPath,
    profile: manifest.profile,
    syntheticFixture: manifest.profile === RAPPID_CARD_TEST_PROFILE,
    canonicalManifestHash: manifestHash(manifest),
    exactDeepLink: link,
    simulation: snapshot,
  });
  if (snapshot.state === 'failed') process.exitCode = 1;
}

export function registerRappidCardCommand(program: Command): void {
  const command = program
    .command('rappid-card')
    .description('Generate, inspect, verify, render, and simulate virtual RAPPID Debug Cards');

  command
    .command('fixtures <directory>')
    .description('Write the deterministic .rappid-card.json fixture deck and real QR artifacts')
    .option('--format <format>', 'svg, png, or both', qrFormat, 'svg')
    .action(async (directory: string, options: { format: QrArtifactFormat }) => {
      print(await writeRappidCardFixtureDeck(directory, options.format));
    });

  command
    .command('inspect <card>')
    .description('Parse, hash, and preview-verify a closed RAPPID card manifest')
    .option('--link <uri-or-file>', 'Exact link or a file containing it')
    .option('--mode <mode>', 'fixture or production', cardMode, 'fixture')
    .option('--keys <file>', 'Explicit key-id to hex-key JSON; never read ambient credentials')
    .action(async (
      card: string,
      options: { link?: string; mode: CardMode; keys?: string },
    ) => inspectCard(card, options));

  command
    .command('verify <card>')
    .description('Verify a card and report a non-zero exit code on any failed control')
    .option('--link <uri-or-file>', 'Exact link or a file containing it')
    .option('--mode <mode>', 'fixture or production', cardMode, 'fixture')
    .option('--keys <file>', 'Explicit key-id to hex-key JSON; never read ambient credentials')
    .action(async (
      card: string,
      options: { link?: string; mode: CardMode; keys?: string },
    ) => inspectCard(card, options));

  command
    .command('qr <link> <output>')
    .description('Render the exact compact deep link as a scannable QR SVG or PNG')
    .option('--format <format>', 'svg or png', (value) => {
      const format = qrFormat(value);
      if (format === 'both') throw new Error('qr accepts svg or png, not both');
      return format;
    }, 'svg')
    .action(async (
      link: string,
      output: string,
      options: { format: 'svg' | 'png' },
    ) => {
      if (options.format === 'png') {
        await writeFile(output, await renderRappidCardQrPng(link));
      } else {
        await writeFile(output, await renderRappidCardQrSvg(link), 'utf8');
      }
      print({ output, format: options.format, exactDeepLink: link });
    });

  command
    .command('simulate <fixture>')
    .description('Run one deterministic fixture; --approve is required to hydrate and wake')
    .option('--approve', 'Explicitly approve permitted content hydration', false)
    .action(async (value: string, options: { approve: boolean }) => {
      const name = fixtureName(value);
      const fixture = buildRappidCardFixture(name);
      print({
        fixture: name,
        exactDeepLink: fixture.deepLink,
        simulation: await simulateRappidCardFixture(name, options.approve),
      });
    });
}
