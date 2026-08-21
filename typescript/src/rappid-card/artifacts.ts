import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  RAPPID_CARD_FILENAME,
} from './types.js';
import {
  RAPPID_CARD_FIXTURE_NAMES,
  buildRappidCardFixture,
  listRappidCardFixtures,
} from './fixtures.js';
import {
  renderRappidCardQrPng,
  renderRappidCardQrSvg,
} from './qr.js';

export type QrArtifactFormat = 'svg' | 'png' | 'both';

export interface FixtureDeckWriteResult {
  directory: string;
  fixtures: number;
  files: string[];
}

export async function writeRappidCardFixtureDeck(
  directory: string,
  format: QrArtifactFormat = 'svg',
): Promise<FixtureDeckWriteResult> {
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  const files: string[] = [];
  const deck = {
    schema: 'rappid-card-fixture-deck/1',
    fixtures: listRappidCardFixtures(),
  };
  const deckPath = join(root, 'deck.json');
  await writeFile(deckPath, `${JSON.stringify(deck, null, 2)}\n`, 'utf8');
  files.push(deckPath);

  for (const name of RAPPID_CARD_FIXTURE_NAMES) {
    const fixture = buildRappidCardFixture(name);
    const fixtureDirectory = join(root, name);
    await mkdir(fixtureDirectory, { recursive: true });
    const cardPath = join(fixtureDirectory, RAPPID_CARD_FILENAME);
    const linkPath = join(fixtureDirectory, 'rappid-card.link.txt');
    await writeFile(
      cardPath,
      `${JSON.stringify(fixture.manifest, null, 2)}\n`,
      'utf8',
    );
    await writeFile(linkPath, `${fixture.deepLink}\n`, 'utf8');
    files.push(cardPath, linkPath);
    if (format === 'svg' || format === 'both') {
      const svgPath = join(fixtureDirectory, 'rappid-card.svg');
      await writeFile(
        svgPath,
        await renderRappidCardQrSvg(fixture.deepLink),
        'utf8',
      );
      files.push(svgPath);
    }
    if (format === 'png' || format === 'both') {
      const pngPath = join(fixtureDirectory, 'rappid-card.png');
      await writeFile(
        pngPath,
        await renderRappidCardQrPng(fixture.deepLink),
      );
      files.push(pngPath);
    }
  }
  return {
    directory: root,
    fixtures: RAPPID_CARD_FIXTURE_NAMES.length,
    files,
  };
}
