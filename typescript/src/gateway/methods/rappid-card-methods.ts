import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  RAPPID_CARD_FIXTURE_NAMES,
  buildRappidCardFixture,
  listRappidCardFixtures,
  simulateRappidCardFixture,
} from '../../rappid-card/fixtures.js';

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean },
  ): void;
}

function scenarioName(value: unknown): string {
  if (
    typeof value !== 'string'
    || !RAPPID_CARD_FIXTURE_NAMES.includes(value)
  ) {
    throw new Error(
      `scenario must be one of: ${RAPPID_CARD_FIXTURE_NAMES.join(', ')}`,
    );
  }
  return value;
}

export function registerRappidCardMethods(
  server: MethodRegistrar,
  options: { dataDir: string },
): void {
  const auth = { requiresAuth: true };
  let run = 0;
  const renderQr = async (link: string) => {
    const { renderRappidCardQrSvg } = await import('../../rappid-card/qr.js');
    return renderRappidCardQrSvg(link);
  };

  server.registerMethod(
    'rappid.card.scenarios',
    async () => listRappidCardFixtures(),
    auth,
  );

  server.registerMethod<{ scenario?: string }>(
    'rappid.card.preview',
    async (params) => {
      const name = scenarioName(params?.scenario);
      const vector = buildRappidCardFixture(name);
      return {
        scenario: name,
        exact_link: vector.link,
        qr_svg: await renderQr(vector.link),
        frame: vector.frame,
        expected: vector.expected,
        provenance: 'rapp-1 commit 392f850',
      };
    },
    auth,
  );

  server.registerMethod<{ scenario?: string; approve?: boolean }>(
    'rappid.card.verify',
    async (params) => {
      const name = scenarioName(params?.scenario);
      if (params?.approve !== true) {
        throw new Error('explicit approve=true is required to run hydration');
      }
      const vector = buildRappidCardFixture(name);
      const path = join(
        options.dataDir,
        'rappid-card-debug',
        `${name}-${process.pid}-${run++}.sqlite`,
      );
      try {
        const { verdict } = await simulateRappidCardFixture(name, path);
        return {
          scenario: name,
          exact_link: vector.link,
          qr_svg: await renderQr(vector.link),
          frame: vector.frame,
          expected: vector.expected,
          verification: verdict,
          provenance: 'rapp-1 commit 392f850',
        };
      } finally {
        await Promise.all(
          ['', '-wal', '-shm'].map((suffix) =>
            rm(`${path}${suffix}`, { force: true })),
        );
      }
    },
    auth,
  );
}
