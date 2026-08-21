import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

import type { Command } from 'commander';

import {
  H,
  RAPPID_CARD_FIXTURE_NAMES,
  SQLiteCardState,
  CardTrustStore,
  buildRappidCardFixture,
  parseCardLink,
  readCardResource,
  renderRappidCardQrPng,
  renderRappidCardQrSvg,
  simulateRappidCardFixture,
  verifyCardLink,
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
    .requiredOption('--state <sqlite>', 'Durable SQLite nonce/sequence state')
    .action(async (
      card: string,
      options: {
        link: string;
        scenario?: string;
        bundle?: string;
        state: string;
      },
    ) => {
      if (Boolean(options.scenario) === Boolean(options.bundle)) {
        throw new Error('verify requires exactly one of --scenario or --bundle');
      }
      const inspected = await inspect(card, options.link);
      if (options.scenario) {
        if (!RAPPID_CARD_FIXTURE_NAMES.includes(options.scenario)) {
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
      const bundle = JSON.parse(await readFile(options.bundle, 'utf8')) as {
        runtime_policy_authority: string;
        runtime_policy: Parameters<typeof verifyCardLink>[0]['runtime_policy'];
        authority_view: Parameters<typeof verifyCardLink>[0]['authority_view'];
        revocation_view: Parameters<typeof verifyCardLink>[0]['revocation_view'];
        trust: Array<{ kid: string; spki_der_b64: string }>;
        now_utc: string;
        connection_id: string;
        fetch_trace: Parameters<typeof verifyCardLink>[0]['fetch_trace'];
        hydrated_parts_b64: Record<string, string>;
        continuity: Parameters<typeof verifyCardLink>[0]['continuity'];
      };
      const state = await SQLiteCardState.open(options.state);
      const trust = new CardTrustStore(
        Object.fromEntries(
          bundle.trust.map((entry) => [
            entry.kid,
            Buffer.from(entry.spki_der_b64, 'base64'),
          ]),
        ),
        bundle.runtime_policy_authority,
      );
      const verdict = verifyCardLink({
        uri: inspected.link,
        frame: inspected.frame,
        trust,
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
      print(verdict);
      if (!verdict.ok) process.exitCode = 1;
    });

  command
    .command('simulate <scenario>')
    .description('Run one vendored mandatory PR9 scenario')
    .requiredOption('--state <sqlite>', 'Durable SQLite nonce/sequence state')
    .action(async (scenario: string, options: { state: string }) => {
      if (!RAPPID_CARD_FIXTURE_NAMES.includes(scenario)) {
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
