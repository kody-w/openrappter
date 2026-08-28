#!/usr/bin/env node
/**
 * Static Data Covenant harvester for beta/index.html.
 *
 * beta/index.html previously called api.github.com directly from the
 * visitor's browser (unauthenticated) to list releases and resolve a
 * release tag's commit SHA. Per RAR CONSTITUTION.md Article XXIV, a
 * visitor's browser must never call api.github.com — CI harvests once and
 * commits static JSON instead.
 *
 * This script re-harvests beta/data/releases.json (the full, unfiltered
 * GitHub releases API response, so page code that reads any field of a
 * release keeps working unchanged) and beta/data/commits.json (a map of
 * tag_name -> { sha } for every release, trimmed to just the field the
 * page actually reads — the full commits/{ref} response includes a
 * `files` diff that can run to hundreds of KB per release and the page
 * never looks at it).
 *
 * Usage:
 *   node beta/scripts/harvest-release-data.mjs [owner/repo]
 *
 * Defaults to kody-w/openrappter. Set GH_TOKEN (or GITHUB_TOKEN) in the
 * environment to harvest with a higher rate limit; unauthenticated works
 * too, just slower/lower-ceiling.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, '..', 'data');

const repo = process.argv[2] || 'kody-w/openrappter';
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

async function ghFetch(url) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'openrappter-covenant-harvester' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} for ${url}`);
  }
  return response.json();
}

async function main() {
  mkdirSync(dataDir, { recursive: true });

  const releases = await ghFetch(`https://api.github.com/repos/${repo}/releases?per_page=30`);
  writeFileSync(path.join(dataDir, 'releases.json'), JSON.stringify(releases, null, 2) + '\n');
  console.log(`[harvest] wrote ${releases.length} releases for ${repo}`);

  const commits = {};
  for (const release of releases) {
    const tag = release.tag_name;
    if (!tag) continue;
    const encoded = encodeURIComponent(tag);
    try {
      const commitData = await ghFetch(`https://api.github.com/repos/${repo}/commits/${encoded}`);
      commits[tag] = { sha: commitData.sha };
      console.log(`[harvest] ${tag} -> ${commitData.sha.slice(0, 12)}`);
    } catch (error) {
      console.error(`[harvest] FAILED to resolve commit for ${tag}: ${error.message}`);
    }
    // Be polite to the unauthenticated rate limit when GH_TOKEN is absent.
    await new Promise((resolve) => setTimeout(resolve, token ? 0 : 300));
  }
  writeFileSync(path.join(dataDir, 'commits.json'), JSON.stringify(commits, null, 2) + '\n');
  console.log(`[harvest] wrote ${Object.keys(commits).length} commit entries`);
}

main().catch((error) => {
  console.error(`[harvest] ERROR: ${error.message}`);
  process.exit(1);
});
