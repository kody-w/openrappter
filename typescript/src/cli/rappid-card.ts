import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

import type { Command } from 'commander';

import {
  H,
  RAPPID_CARD_FIXTURE_NAMES,
  SQLiteCardState,
  buildRappidCardFixture,
  parseCardLink,
  readCardResource,
  renderRappidCardQrPng,
  renderRappidCardQrSvg,
  simulateRappidCardFixture,
  verifyCardLink,
  loadRappidCardTrustConfig,
  writeRappidCardFixtureDeck,
} from '../rappid-card/index.js';
import type { QrArtifactFormat } from '../rappid-card/index.js';

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function qrFormat(value: string): QrArtifactFormat {
  if (value !== 'svg' && value !== 'png' && value !== 'both') {
    throw new Error('format must be svg, png, or both');
  }
  return value;
}

async function readLink(value: string): Promise<string> {
  return value.startsWith('rappid://')
    ? value
    : (await readFile(value, 'utf8')).trim();
}

async function inspect(cardPath: string, linkValue: string) {
  const bytes = await readFile(cardPath);
  const frame = readCardResource(bytes);
  const linkText = await readLink(linkValue);
  const parsedLink = parseCardLink(linkText);
  return {
    frame,
    link: linkText,
    parsed_link: parsedLink,
    payload_particle: H('rapp/1:particle', frame.payload),
    canonical_bytes: bytes.byteLength,
  };
}

interface HistoricalBundle {
  runtime_policy_authority: string;
  runtime_policy: Parameters<typeof verifyCardLink>[0]['runtime_policy'];
  authority_view: Parameters<typeof verifyCardLink>[0]['authority_view'];
  revocation_view: Parameters<typeof verifyCardLink>[0]['revocation_view'];
  now_utc: string;
  connection_id: string;
  fetch_trace: Parameters<typeof verifyCardLink>[0]['fetch_trace'];
  hydrated_parts_b64: Record<string, string>;
  continuity: Parameters<typeof verifyCardLink>[0]['continuity'];
}

async function loadHistoricalBundle(path: string): Promise<HistoricalBundle> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  const keys = [
    'authority_view',
    'connection_id',
    'continuity',
    'fetch_trace',
    'hydrated_parts_b64',
    'now_utc',
    'revocation_view',
    'runtime_policy',
    'runtime_policy_authority',
  ];
  if (
    raw === null
    || typeof raw !== 'object'
    || Array.isArray(raw)
    || JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify(keys)
  ) {
    throw new Error(
      'historical bundle has the wrong closed schema; trust roots are forbidden',
    );
  }
  return raw as HistoricalBundle;
}

export function registerRappidCardCommand(program: Command): void {
  const command = program
    .command('rappid-card')
    .description('Inspect and verify exact RAPP/1 calling-card/debug-card frames');

  command
    .command('fixtures <directory>')
    .description('Export the vendored PR9 conformance deck and QR artifacts')
    .option('--format <format>', 'svg, png, or both', qrFormat, 'svg')
    .action(async (directory: string, options: { format: QrArtifactFormat }) => {
      print(await writeRappidCardFixtureDeck(directory, options.format));
    });

  command
    .command('inspect <card>')
    .description('Parse canonical eleven-key frame bytes and compact URI')
    .requiredOption('--link <uri-or-file>', 'Exact compact URI or link file')
    .action(async (card: string, options: { link: string }) => {
      print(await inspect(card, options.link));
    });

  command
    .command('verify <card>')
    .description('Verify one vendored scenario at its exact ordered PR9 step')
    .requiredOption('--link <uri-or-file>', 'Exact compact URI or link file')
    .option('--scenario <name>', 'PR9 mandatory scenario')
    .option('--bundle <json>', 'Explicit production verification bundle')
    .option('--trust-config <json>', 'Mode-0600 local production trust roots')
    .requiredOption('--state <sqlite>', 'Durable SQLite nonce/sequence state')
    .action(async (
      card: string,
      options: {
        link: string;
        scenario?: string;
        bundle?: string;
        trustConfig?: string;
        state: string;
      },
    ) => {
      if (Boolean(options.scenario) === Boolean(options.bundle)) {
        throw new Error('verify requires exactly one of --scenario or --bundle');
      }
      const inspected = await inspect(card, options.link);
      if (options.scenario) {
        if (!RAPPID_CARD_FIXTURE_NAMES.some((name) => name === options.scenario)) {
          throw new Error(`unknown PR9 scenario: ${options.scenario}`);
        }
        const fixture = buildRappidCardFixture(options.scenario);
        if (
          JSON.stringify(inspected.frame) !== JSON.stringify(fixture.frame)
          || inspected.link !== fixture.link
        ) {
          print({
            ok: false,
            step: 'content-address',
            reason: 'card/link bytes do not equal the selected vendored scenario',
            result: null,
          });
          process.exitCode = 1;
          return;
        }
        const { verdict } = await simulateRappidCardFixture(
          options.scenario,
          options.state,
        );
        print(verdict);
        if (verdict.ok !== fixture.expected.ok) process.exitCode = 1;
        return;
      }
      if (!options.bundle) throw new Error('verification bundle is required');
      const bundle = await loadHistoricalBundle(options.bundle);
      const local = await loadRappidCardTrustConfig(options.trustConfig);
      if (
        bundle.runtime_policy_authority
        !== local.config.runtime_policy_authority
      ) {
        throw new Error(
          'bundle runtime-policy authority is not locally configured',
        );
      }
      print({
        ok: false,
        status: 'unavailable',
        reason: 'live-adapter-required',
        detail:
          'production awake verification requires local clock, connection, fetch, hydration, and continuity adapters',
      });
      process.exitCode = 1;
    });

  command
    .command('inspect-offline <card>')
    .description('Historical cryptographic/policy inspection; never returns awake')
    .requiredOption('--link <uri-or-file>', 'Exact compact URI or link file')
    .requiredOption('--bundle <json>', 'Historical verifier evidence')
    .requiredOption('--trust-config <json>', 'Mode-0600 local production trust roots')
    .requiredOption('--state <sqlite>', 'Isolated historical sequence state')
    .action(async (
      card: string,
      options: {
        link: string;
        bundle: string;
        trustConfig: string;
        state: string;
      },
    ) => {
      const inspected = await inspect(card, options.link);
      const bundle = await loadHistoricalBundle(options.bundle);
      const local = await loadRappidCardTrustConfig(options.trustConfig);
      if (
        bundle.runtime_policy_authority
        !== local.config.runtime_policy_authority
      ) {
        throw new Error(
          'bundle runtime-policy authority is not locally configured',
        );
      }
      const state = await SQLiteCardState.open(options.state);
      const verdict = verifyCardLink({
        uri: inspected.link,
        frame: inspected.frame,
        trust: local.trust,
        now_utc: bundle.now_utc,
        runtime_policy: bundle.runtime_policy,
        authority_view: bundle.authority_view,
        revocation_view: bundle.revocation_view,
        state,
        connection_id: bundle.connection_id,
        fetch_trace: bundle.fetch_trace,
        hydrated: Object.fromEntries(
          Object.entries(bundle.hydrated_parts_b64).map(([name, value]) => [
            name,
            Buffer.from(value, 'base64'),
          ]),
        ),
        continuity: bundle.continuity,
      });
      print({
        status: 'offline-only',
        awake: false,
        cryptographic_policy_ok: verdict.ok,
        verdict: {
          ok: verdict.ok,
          step: verdict.step,
          reason: verdict.reason,
          result: null,
        },
      });
      if (!verdict.ok) process.exitCode = 1;
    });

  command
    .command('simulate <scenario>')
    .description('Run one vendored mandatory PR9 scenario')
    .requiredOption('--state <sqlite>', 'Durable SQLite nonce/sequence state')
    .action(async (scenario: string, options: { state: string }) => {
      if (!RAPPID_CARD_FIXTURE_NAMES.some((name) => name === scenario)) {
        throw new Error(`unknown PR9 scenario: ${scenario}`);
      }
      const fixture = buildRappidCardFixture(scenario);
      const { verdict } = await simulateRappidCardFixture(scenario, options.state);
      print(verdict);
      const expected = fixture.expected;
      if (
        verdict.ok !== expected.ok
        || verdict.step !== expected.step
        || (
          expected.reason_contains !== null
          && !verdict.reason.includes(expected.reason_contains)
        )
      ) {
        process.exitCode = 1;
      }
    });

  command
    .command('qr <link> <output>')
    .description('Render the exact canonical compact URI as QR SVG or PNG')
    .option('--format <format>', 'svg or png', (value) => {
      const format = qrFormat(value);
      if (format === 'both') throw new Error('qr accepts svg or png, not both');
      return format;
    }, 'svg')
    .action(async (
      linkValue: string,
      output: string,
      options: { format: 'svg' | 'png' },
    ) => {
      const link = await readLink(linkValue);
      parseCardLink(link);
      if (options.format === 'png') {
        await writeFile(output, await renderRappidCardQrPng(link));
      } else {
        await writeFile(output, await renderRappidCardQrSvg(link), 'utf8');
      }
      print({ output, format: options.format, link });
    });
}
