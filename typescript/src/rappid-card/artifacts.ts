import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { canonical } from './contract.js';
import { loadRappidCardDeck } from './fixtures.js';
import { renderRappidCardQrPng, renderRappidCardQrSvg } from './qr.js';

export type QrArtifactFormat = 'svg' | 'png' | 'both';

export async function writeRappidCardFixtureDeck(
  directory: string,
  format: QrArtifactFormat = 'svg',
): Promise<{ directory: string; fixtures: number; files: string[]; provenance: string }> {
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  const files: string[] = [];
  const deck = loadRappidCardDeck();
  for (const vector of deck.vectors) {
    const target = join(root, vector.name);
    await mkdir(target, { recursive: true });
    const outputs: Record<string, string> = {
      '.rappid-card.json': canonical(vector.frame),
      'rappid-card.link.txt': `${vector.link}\n`,
      'runtime-policy.json': canonical(vector.runtime_policy),
      'authority-view.json': canonical(vector.authority_view),
      'revocation-view.json': canonical(vector.revocation_view),
    };
    for (const [name, text] of Object.entries(outputs)) {
      const path = join(target, name);
      await writeFile(path, text, 'utf8');
      files.push(path);
    }
    if (
      vector.expected.step !== 'parse'
      && (format === 'svg' || format === 'both')
    ) {
      const path = join(target, 'rappid-card.svg');
      await writeFile(path, await renderRappidCardQrSvg(vector.link), 'utf8');
      files.push(path);
    }
    if (
      vector.expected.step !== 'parse'
      && (format === 'png' || format === 'both')
    ) {
      const path = join(target, 'rappid-card.png');
      await writeFile(path, await renderRappidCardQrPng(vector.link));
      files.push(path);
    }
  }
  return {
    directory: root,
    fixtures: deck.vectors.length,
    files,
    provenance: 'rapp-1 commit 392f850',
  };
}
