// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { handleDesktopUiCommand, snapshotDesktopUi } from '../services/desktop-control.js';
import '../components/debug.js';

interface Snapshot {
  text: string;
  elements: { ref: string; tag: string; text: string; type: string }[];
}

// `debug` is in the enforced navigable view list in desktop-control.ts, so an
// agent can reach this surface. That matters because the RPC console invokes
// whatever gateway method is typed into it, which turns the bounded desktop
// vocabulary (navigate/snapshot/click/input/select/scroll/wait) into "call any
// gateway method and read the answer". config.get alone returns the entire
// config file and, unlike config.set/config.apply, carries no auth
// requirement. These tests pin both halves: a model cannot read the console's
// output, and cannot drive the console either.
describe('the debug RPC console is not usable by desktop automation', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  async function renderDebug(state: Record<string, unknown>): Promise<HTMLElement> {
    document.body.innerHTML = '';
    const element = document.createElement('openrappter-debug') as HTMLElement & {
      updateComplete: Promise<boolean>;
    };
    document.body.append(element);
    await element.updateComplete;
    // The view fetches status and models on connect. Those calls fail here and
    // overwrite the very fields under test, so apply the fixture only once they
    // have settled.
    await new Promise((resolve) => setTimeout(resolve, 0));
    Object.assign(element, state);
    await element.updateComplete;

    // jsdom lays nothing out and the snapshot drops elements with no client
    // rects, so without this every assertion below would pass for the wrong
    // reason: an empty snapshot trivially contains no secret.
    for (const node of element.shadowRoot!.querySelectorAll<HTMLElement>('*')) {
      node.getClientRects = () => [{ width: 10, height: 10 }] as unknown as DOMRectList;
    }
    return element;
  }

  const findRef = (shot: Snapshot, match: (e: Snapshot['elements'][number]) => boolean): string => {
    const hits = shot.elements.filter(match);
    // Guard the guard: if this ever matches zero or many, the assertions below
    // would be testing something other than the control they name.
    expect(hits).toHaveLength(1);
    return hits[0].ref;
  };

  it('keeps an RPC result out of the snapshot while still showing it to the operator', async () => {
    // The shape config.get actually returns: the raw config file as a string.
    const element = await renderDebug({
      rpcResult: JSON.stringify(
        { raw: '{"gateway":{"auth":{"password":"rpc-console-secret"}}}' },
        null,
        2,
      ),
    });

    // Anti-vacuity: the operator's own view must genuinely contain the secret,
    // otherwise this passes against a console that rendered nothing at all.
    expect(element.shadowRoot!.textContent).toContain('rpc-console-secret');

    expect(JSON.stringify(snapshotDesktopUi())).not.toContain('rpc-console-secret');
  });

  it('does not offer the console controls as refs an agent could drive', async () => {
    await renderDebug({ rpcMethod: 'config.get', rpcParams: '{}' });
    const shot = snapshotDesktopUi() as unknown as Snapshot;

    // Anti-vacuity: the view must be reachable at all, or "no console controls"
    // would be equally true of a snapshot that found nothing.
    expect(shot.elements.length).toBeGreaterThan(0);

    expect(shot.elements.some((e) => e.text.startsWith('Call'))).toBe(false);
    expect(shot.elements.some((e) => e.tag === 'input' && e.type === 'text')).toBe(false);
    expect(shot.elements.some((e) => e.tag === 'textarea')).toBe(false);
  });

  it('still refuses the console controls if the card stops being private', async () => {
    // Defence in depth. The private boundary on the card is what hides these
    // controls today; this proves the per-control markers stand on their own,
    // so restructuring the card cannot quietly hand an agent arbitrary RPC.
    const element = await renderDebug({ rpcMethod: 'config.get' });
    // Select the console's own card rather than the first private element on
    // the page, so this keeps testing the console if anything else is marked.
    const card = element
      .shadowRoot!.querySelector('.rpc-form')!
      .closest('[data-desktop-private]') as HTMLElement;
    expect(card).toBeTruthy();
    card.removeAttribute('data-desktop-private');

    const shot = snapshotDesktopUi() as unknown as Snapshot;
    // With the boundary gone the controls really are back in reach, which is
    // precisely why each one carries its own marker.
    const method = findRef(shot, (e) => e.tag === 'input' && e.type === 'text');
    const params = findRef(shot, (e) => e.tag === 'textarea');
    const call = findRef(shot, (e) => e.text.startsWith('Call'));

    await expect(
      handleDesktopUiCommand({ action: 'input', args: { ref: method, value: 'config.get' } }),
    ).rejects.toThrow(/sensitive/i);
    await expect(
      handleDesktopUiCommand({ action: 'input', args: { ref: params, value: '{}' } }),
    ).rejects.toThrow(/sensitive/i);
    await expect(
      handleDesktopUiCommand({ action: 'click', args: { ref: call } }),
    ).rejects.toThrow(/sensitive/i);
  });

  it('leaves the fixed-shape diagnostic cards readable', async () => {
    // Scope guard. Only the console renders whatever the operator asked for;
    // status, models and heartbeat render known-shape payloads and are the
    // reason to read this view. Marking the whole view private would satisfy
    // every test above while destroying the diagnostics, so pin it here.
    await renderDebug({ statusJson: '{"uptimeSeconds":42}' });
    expect(JSON.stringify(snapshotDesktopUi())).toContain('uptimeSeconds');
  });
});
