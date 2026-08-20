// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { snapshotDesktopUi } from '../services/desktop-control.js';
import '../components/config.js';

// `config` is one of the views DesktopControlAgent is told it can navigate to,
// so whatever that surface renders is reachable by an agent snapshot. The view
// already redacts config values twice over -- raw mode holds the file in a
// <textarea>, and scalars go in an <input>, both excluded from snapshots, with
// inputs reported only as empty/set -- but nested values fall back to a <pre>
// JSON dump that prints them verbatim. These tests pin the invariant the other
// two paths already keep: a config value never reaches a model-visible
// snapshot, whichever shape it happens to render in.
describe('the config view keeps config values out of model-visible snapshots', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  async function renderConfig(config: unknown, expand: string): Promise<HTMLElement> {
    document.body.innerHTML = '';
    const element = document.createElement('openrappter-config') as HTMLElement & {
      configState: unknown;
      expandedSections: Set<string>;
      updateComplete: Promise<boolean>;
    };
    element.configState = {
      client: null,
      raw: JSON.stringify(config, null, 2),
      hash: 'test-hash',
      format: 'json',
      dirty: false,
      loading: false,
      saving: false,
      error: null,
    };
    element.expandedSections = new Set([expand]);
    document.body.append(element);
    await element.updateComplete;

    // jsdom lays nothing out and the snapshot drops elements with no client
    // rects, so without this the surface would look empty for the wrong reason.
    for (const node of element.shadowRoot!.querySelectorAll<HTMLElement>('*')) {
      node.getClientRects = () => [{ width: 10, height: 10 }] as unknown as DOMRectList;
    }
    return element;
  }

  it('redacts a channel token that renders as a nested JSON dump', async () => {
    // A channel with any array field -- `allowFrom` is in the schema -- fails
    // the "all sub-values are flat" check, so the whole object renders as JSON.
    const element = await renderConfig(
      {
        channels: {
          telegram: {
            enabled: true,
            botToken: 'secret-bot-token-do-not-leak',
            allowFrom: ['user-1'],
          },
        },
      },
      'channels',
    );
    const shadow = element.shadowRoot!;

    // Anti-vacuity: the operator must still be able to read their own config,
    // and a surface that rendered nothing would pass the assertion below.
    expect(shadow.querySelectorAll('pre').length).toBeGreaterThan(0);
    expect(shadow.textContent ?? '').toContain('secret-bot-token-do-not-leak');

    expect(JSON.stringify(snapshotDesktopUi())).not.toContain('secret-bot-token-do-not-leak');
  });

  it('redacts the gateway auth password that renders as an input', async () => {
    const element = await renderConfig(
      { gateway: { port: 18790, auth: { mode: 'password', password: 'secret-gateway-password' } } },
      'gateway',
    );
    const shadow = element.shadowRoot!;

    // Anti-vacuity: input values are not text content, so assert the field
    // actually carries the secret before asserting the snapshot does not.
    const values = Array.from(shadow.querySelectorAll('input')).map((input) => input.value);
    expect(values).toContain('secret-gateway-password');

    expect(JSON.stringify(snapshotDesktopUi())).not.toContain('secret-gateway-password');
  });
});
