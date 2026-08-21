import {
  RAPPID_CARD_FIXTURE_NAMES,
  buildRappidCardFixture,
  listRappidCardFixtures,
  simulateRappidCardFixture,
} from '../../rappid-card/fixtures.js';
import type {
  RappidCardFixtureName,
} from '../../rappid-card/fixtures.js';

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean },
  ): void;
}

function fixtureName(value: unknown): RappidCardFixtureName {
  if (
    typeof value !== 'string'
    || !RAPPID_CARD_FIXTURE_NAMES.includes(value as RappidCardFixtureName)
  ) {
    throw new Error(
      `fixture must be one of: ${RAPPID_CARD_FIXTURE_NAMES.join(', ')}`,
    );
  }
  return value as RappidCardFixtureName;
}

export function registerRappidCardMethods(server: MethodRegistrar): void {
  const auth = { requiresAuth: true };
  const renderQr = async (deepLink: string) => {
    const { renderRappidCardQrSvg } = await import('../../rappid-card/qr.js');
    return renderRappidCardQrSvg(deepLink);
  };

  server.registerMethod('rappid.card.fixtures', async () =>
    listRappidCardFixtures(), auth);

  server.registerMethod<{ fixture?: string }>(
    'rappid.card.preview',
    async (params) => {
      const name = fixtureName(params?.fixture);
      const fixture = buildRappidCardFixture(name);
      return {
        fixture: name,
        exactDeepLink: fixture.deepLink,
        qrSvg: await renderQr(fixture.deepLink),
        simulation: await simulateRappidCardFixture(name, false),
      };
    },
    auth,
  );

  server.registerMethod<{ fixture?: string; approve?: boolean }>(
    'rappid.card.simulate',
    async (params) => {
      const name = fixtureName(params?.fixture);
      if (params?.approve !== true) {
        throw new Error('explicit approve=true is required to hydrate a RAPPID card');
      }
      const fixture = buildRappidCardFixture(name);
      return {
        fixture: name,
        exactDeepLink: fixture.deepLink,
        qrSvg: await renderQr(fixture.deepLink),
        simulation: await simulateRappidCardFixture(name, true),
      };
    },
    auth,
  );
}
