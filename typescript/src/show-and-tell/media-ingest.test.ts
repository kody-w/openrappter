import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ShowAndTellAgent } from '../agents/ShowAndTellAgent.js';
import { ShowAndTellStore } from './store.js';
import type { VerifiedMediaAsset } from '../media/ingest.js';

const roots: string[] = [];

function root(): string {
  const parent = path.join(process.cwd(), '.show-media-tests');
  mkdirSync(parent, { recursive: true });
  const value = mkdtempSync(path.join(parent, 'case-'));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
  rmSync(path.join(process.cwd(), '.show-media-tests'), { recursive: true, force: true });
});

describe('Show-and-Tell verified media seam', () => {
  it('records a descriptor-resolved private path without accepting a renderer path', async () => {
    const directory = root();
    const store = new ShowAndTellStore(directory);
    await store.initialize();
    const session = await store.createSession({
      title: 'Video demonstration',
      intentHint: 'Learn from a local recording',
    });
    const digest = 'a'.repeat(64);
    const asset: VerifiedMediaAsset = {
      schema: 'openrappter-media-asset/1.0',
      id: `sha256:${digest}`,
      digest,
      size: 150 * 1024 * 1024,
      mimeType: 'video/mp4',
      kind: 'video',
      displayName: 'showcase.mp4',
      storage: 'local-private',
      verified: true,
      deduplicated: false,
      createdAt: new Date().toISOString(),
      privatePath: path.join(directory, 'private', digest),
    };
    const agent = new ShowAndTellAgent({
      store,
      localSurface: true,
      resolveMediaAsset: async (assetId) => {
        expect(assetId).toBe(asset.id);
        return asset;
      },
    });
    const result = JSON.parse(await agent.perform({
      action: 'media',
      session_id: session.id,
      asset_id: asset.id,
      path: '/renderer/ignored/path',
    })) as Record<string, unknown>;
    expect(result).toMatchObject({
      status: 'success',
      action: 'media',
      session_id: session.id,
    });
    expect(JSON.stringify(result)).not.toContain(asset.privatePath);

    const event = (await store.events(session.id))
      .find((candidate) => candidate.type === 'media.attached');
    expect(event?.data).toMatchObject({
      asset: {
        id: asset.id,
        digest,
        verified: true,
      },
      verifiedPrivatePath: asset.privatePath,
      localOnly: true,
    });
    store.close();
  });
});
