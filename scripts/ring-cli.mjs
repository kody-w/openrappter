#!/usr/bin/env node
/**
 * Ring CLI — the seam between GitHub Actions and scripts/ring.mjs.
 *
 * Subcommands
 *   version   --ring <r> [--sha <s>] [--date <d>] [--counter <n>]
 *             Print the version a ring should publish. Base version is read
 *             from typescript/package.json unless --base is given.
 *
 *   dist-tag  --ring <r>
 *             Print the npm dist-tag a ring owns.
 *
 *   promote   --version <v> --from <r> --to <r> [--published <csv>]
 *             Validate a promotion and print the dist-tag to move. Exits
 *             nonzero (with a reason) if the promotion is illegal.
 *
 *   manifest  --out <path>
 *             Write the Pages channel manifest from live npm dist-tags.
 *
 * Every subcommand is fail-closed: invalid input exits nonzero rather than
 * emitting a value a workflow might then publish.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PRERELEASE_RINGS,
  PRODUCTION_PACKAGE,
  RINGS,
  isProductionPackage,
  packageForRing,
  planPromotion,
  repoForRing,
  requireRing,
  ringVersion,
} from './ring.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_JSON = resolve(ROOT, 'typescript/package.json');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function packageName() {
  return JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')).name;
}

function baseVersion(args) {
  if (args.base) return String(args.base);
  return JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')).version;
}

function fail(message) {
  process.stderr.write(`ring-cli: ${message}\n`);
  process.exit(1);
}

/** Read live dist-tags from the registry. Returns {} when the package is new. */
async function fetchDistTags(name) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  });
  if (response.status === 404) return {};
  if (!response.ok) throw new Error(`registry responded ${response.status} for ${name}`);
  const body = await response.json();
  return body['dist-tags'] ?? {};
}

const commands = {
  version(args) {
    const ring = requireRing(String(args.ring ?? ''));
    const counter = args.counter === undefined ? undefined : Number(args.counter);
    process.stdout.write(
      `${ringVersion({
        ring,
        baseVersion: baseVersion(args),
        sha: args.sha === undefined ? undefined : String(args.sha),
        date: args.date === undefined ? undefined : String(args.date),
        counter,
      })}\n`,
    );
  },

  // Which npm package a ring publishes to. Prerelease rings each own a
  // distinct package, so production is unreachable from ring work.
  package(args) {
    const ring = requireRing(String(args.ring ?? ''));
    const name = packageForRing(ring);
    if (args['assert-not-production'] && isProductionPackage(name)) {
      fail(`ring ${ring} resolves to the production package ${name}`);
    }
    process.stdout.write(`${name}\n`);
  },

  repo(args) {
    process.stdout.write(`${repoForRing(requireRing(String(args.ring ?? '')))}\n`);
  },

  promote(args) {
    const published = String(args.published ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);

    const plan = planPromotion({
      version: String(args.version ?? ''),
      from: String(args.from ?? ''),
      to: String(args.to ?? ''),
      publishedVersions: published,
    });

    // Consumed by the workflow via $GITHUB_OUTPUT.
    process.stdout.write(`${JSON.stringify(plan)}\n`);
  },

  async manifest(args) {
    const channels = {};
    // Each ring is a separate package, so this is one registry read per ring.
    await Promise.all(RINGS.map(async (ring) => {
      const name = packageForRing(ring);
      let version = null;
      try {
        version = (await fetchDistTags(name)).latest ?? null;
      } catch {
        version = null;
      }
      channels[ring] = {
        ring,
        package: name,
        repo: repoForRing(ring),
        production: isProductionPackage(name),
        version,
        install: `npm install -g ${name}`,
        installer:
          ring === 'stable'
            ? 'curl -fsSL https://kody-w.github.io/openrappter/install.sh | bash'
            : `curl -fsSL https://kody-w.github.io/openrappter/install.sh | bash -s -- --channel ${ring}`,
      };
    }));

    const manifest = {
      schema: 'openrappter-channels/2.0',
      productionPackage: PRODUCTION_PACKAGE,
      // Least-stable first; promotion always advances exactly one step.
      train: RINGS,
      prereleaseRings: PRERELEASE_RINGS,
      // Every prerelease ring lives in its own package and repo, so nothing a
      // ring does can be served to `npm install openrappter`.
      isolation: 'package-per-ring',
      channels,
    };

    const json = `${JSON.stringify(manifest, null, 2)}\n`;
    if (args.out) {
      writeFileSync(resolve(ROOT, String(args.out)), json);
      process.stderr.write(`wrote ${args.out}\n`);
    } else {
      process.stdout.write(json);
    }
  },
};

const [, , command, ...rest] = process.argv;

if (!command || !(command in commands)) {
  process.stderr.write(
    `usage: ring-cli <version|dist-tag|promote|manifest> [options]\nrings: ${RINGS.join(' -> ')}\n`,
  );
  process.exit(2);
}

try {
  await commands[command](parseArgs(rest));
} catch (error) {
  fail(error.message);
}
