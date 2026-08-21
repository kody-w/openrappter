import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

import type { Command } from 'commander';

import {
  RAPPID_CARD_FIXTURE_NAMES,
  RAPPID_CARD_TEST_PROFILE,
  SqliteCardStateStore,
  buildRappidCardFixture,
  makeDeepLink,
  manifestHash,
  parseManifestJson,
  renderRappidCardQrPng,
  renderRappidCardQrSvg,
  simulateRappidCard,
  simulateRappidCardFixtureInput,
  simulateRappidCardFixture,
  writeRappidCardFixtureDeck,
} from '../rappid-card/index.js';
import type {
  CardAlgorithm,
  CardProviders,
  CardTrustProvider,
  QrArtifactFormat,
  RappidCardFixtureName,
  RappidCardManifest,
} from '../rappid-card/index.js';

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

async function readLink(
  value: string | undefined,
  manifest: RappidCardManifest,
): Promise<string> {
  if (!value) return makeDeepLink(manifest);
  if (value.startsWith('rappid://')) return value;
  return (await readFile(value, 'utf8')).trim();
}

interface TrustBundle {
  policy: unknown;
  authorization: unknown;
  revocations: unknown;
  authorityKeys: Record<string, string>;
}

async function explicitTrustProvider(path: string): Promise<CardTrustProvider> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('trust file must be a closed trust-bundle object');
  }
  const bundle = raw as Partial<TrustBundle>;
  if (
    bundle.policy === undefined
    || bundle.authorization === undefined
    || bundle.revocations === undefined
    || bundle.authorityKeys === null
    || typeof bundle.authorityKeys !== 'object'
    || Array.isArray(bundle.authorityKeys)
    || Object.keys(bundle).sort().join(',')
      !== 'authorityKeys,authorization,policy,revocations'
  ) {
    throw new Error(
      'trust file requires exactly policy, authorization, revocations, and authorityKeys',
    );
  }
  for (const [keyId, publicKey] of Object.entries(bundle.authorityKeys)) {
    if (
      !/^[a-z][a-z0-9._-]{0,63}$/.test(keyId)
      || typeof publicKey !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/.test(publicKey)
    ) {
      throw new Error(`trust authority ${keyId} is invalid`);
    }
  }
  return {
    getPolicyForOrigin: () => structuredClone(bundle.policy),
    getAuthorization: () => structuredClone(bundle.authorization),
    getRevocations: () => structuredClone(bundle.revocations),
    getAuthorityKey(keyId: string, _algorithm: CardAlgorithm) {
      return bundle.authorityKeys![keyId] ?? null;
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
    fixture?: boolean;
    trust?: string;
    state?: string;
  },
): Promise<void> {
  const manifest = parseManifestJson(await readFile(cardPath, 'utf8'));
  const link = await readLink(options.link, manifest);
  const fixture = matchingFixture(manifest);
  let snapshot;
  if (options.fixture === true) {
    if (!fixture || manifest.profile !== RAPPID_CARD_TEST_PROFILE) {
      throw new Error('--fixture accepts only a generated test-profile card');
    }
    fixture.deepLink = link;
    fixture.providers = {
      ...fixture.providers,
      manifests: { getManifest: () => structuredClone(manifest) },
    };
    snapshot = await simulateRappidCardFixtureInput(fixture, false);
  } else {
    if (!options.trust || !options.state) {
      throw new Error(
        'production verification requires explicit --trust and --state files',
      );
    }
    const providers: CardProviders = {
      manifests: { getManifest: () => structuredClone(manifest) },
      trust: await explicitTrustProvider(options.trust),
      content: { getPart: () => null },
      challenge: { respond: () => '0'.repeat(86) },
    };
    const stateStore = await SqliteCardStateStore.open(options.state);
    try {
      snapshot = await simulateRappidCard(link, {
        approve: false,
        providers,
        stateStore,
      });
    } finally {
      stateStore.close();
    }
  }
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
    .description('Write the deterministic signed-trust fixture deck and real QR artifacts')
    .option('--format <format>', 'svg, png, or both', qrFormat, 'svg')
    .action(async (directory: string, options: { format: QrArtifactFormat }) => {
      print(await writeRappidCardFixtureDeck(directory, options.format));
    });

  for (const [name, description] of [
    ['inspect', 'Parse, hash, and preview-verify a closed RAPPID card manifest'],
    ['verify', 'Verify a card and report a non-zero exit code on any failed control'],
  ] as const) {
    command
      .command(`${name} <card>`)
      .description(description)
      .option('--link <uri-or-file>', 'Exact link or a file containing it')
      .option('--fixture', 'Use only the built-in signed synthetic fixture authority')
      .option('--trust <file>', 'Explicit signed production trust bundle; no ambient credentials')
      .option('--state <sqlite>', 'Durable transactional replay/trust-sequence database')
      .action(async (
        card: string,
        options: {
          link?: string;
          fixture?: boolean;
          trust?: string;
          state?: string;
        },
      ) => inspectCard(card, options));
  }

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
    .description('Run one deterministic signed-trust fixture; --approve is required to hydrate')
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
