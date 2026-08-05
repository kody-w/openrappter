/**
 * A twin's page is the twin's. — #138
 *
 * Every instance on a device derives its designation and called name from the
 * DEVICE tail (`~/.openrappter/rappid.tail`), so a hatched twin's anatomy page
 * was byte-identical to the alpha's. Measured on a live twin beside the alpha:
 *
 *   alpha  designation=openrappter-RM-0059  name=Rame  home=~/.openrappter
 *   slate  designation=openrappter-RM-0059  name=Rame  home=~/.openrappter
 *
 * while the gateway knew exactly who was answering (`/health` → instance:
 * alpha | slate), and the twin itself said so in words when asked over the
 * same POST /chat the surgeon screen uses:
 *
 *   slate: "I'm Rame (openrappter-RM-0059), a hatched twin on this device."
 *
 * It knew its ROLE and wore the alpha's NAME.
 *
 * Whether a twin should have a designation of its own is a one-way door — the
 * tail is minted once and never re-rolled — and belongs to the owner. Being
 * able to tell WHICH rappter you are reading does not, so that is what these
 * pin.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readAnatomy } from '../../gateway/anatomy.js';
import { renderAnatomyPage } from '../../gateway/anatomy-page.js';
import {
  declareCurrentInstance,
  __resetCurrentInstanceForTest,
} from '../../infra/current-instance.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const homes: string[] = [];
afterEach(() => {
  for (const d of homes.splice(0)) rmSync(d, { recursive: true, force: true });
  __resetCurrentInstanceForTest();
});

function sandboxHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'anatomy-home-'));
  homes.push(home);
  return home;
}

describe('the anatomy surface names the rappter it belongs to', () => {
  it('carries the twin name a hatched twin is serving as', () => {
    const home = sandboxHome();
    declareCurrentInstance('slate');

    expect(readAnatomy(home).vitals.instance).toBe('slate');
  });

  it('says alpha when it is the alpha', () => {
    // The negative control. `undefined` is a real answer the alpha declares,
    // and must not be confused with never having declared.
    const home = sandboxHome();
    declareCurrentInstance(undefined);

    expect(readAnatomy(home).vitals.instance).toBe('alpha');
  });

  it('omits the field entirely when nothing declared, rather than guessing', () => {
    // Guessing `alpha` here is the same collapse #129 and #131 were about:
    // an unchecked default that reads exactly like a verified answer.
    const home = sandboxHome();

    expect(readAnatomy(home).vitals.instance).toBeUndefined();
  });

  it('marks a twin on the page, and stops claiming the designation is its own', () => {
    const home = sandboxHome();
    declareCurrentInstance('slate');

    const page = renderAnatomyPage(readAnatomy(home));

    expect(page).toContain('twin · slate');
    // The tooltip must not tell a twin's viewer the designation came from its
    // own rappid, because on a twin it did not.
    expect(page).not.toContain('derived from its rappid; never changes');
    expect(page).toContain('shared with the alpha');
  });

  it('leaves the alpha page unmarked and its claim intact', () => {
    const home = sandboxHome();
    declareCurrentInstance(undefined);

    const page = renderAnatomyPage(readAnatomy(home));

    // Assert on the rendered tag, not the class name: the stylesheet defines
    // `.twintag` unconditionally, so searching for that string matches the CSS
    // on every page and would pass for a reason that has nothing to do with
    // what is being claimed.
    expect(page).not.toContain('twin · ');
    expect(page).toContain('derived from its rappid; never changes');
  });
});
