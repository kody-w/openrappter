/**
 * `openrappter login <provider>` printed:
 *
 *     Credentials have been saved to your config.
 *
 * Nothing saved anything. `initiateOAuthFlow` (`auth/oauth.ts`) runs the OAuth
 * dance and *returns* an `OAuthToken`; the module performs no filesystem
 * writes at all, and the `OAuthTokenStore` beside it is two in-memory `Map`s
 * that the flow never calls. The token is garbage-collected when the process
 * exits.
 *
 * Same class as the macOS Bar reporting `.success` from a discarded write
 * (#316) and the memory CLI that persisted nothing (#204): the user is told to
 * stop worrying about something that did not happen. Here it is worse than
 * useless -- someone told their credentials are stored has no reason to
 * re-authenticate, and no reason to look for why the integration is silent.
 *
 * The command stays dormant (see `dormant-cli-commands-stay-dormant.test.ts`);
 * this only makes it stop lying if it is ever wired up.
 *
 * These two assertions are deliberately coupled. If someone implements real
 * persistence, the second one fails and forces the message to be revisited --
 * so the code cannot become *more* correct while the text stays wrong in the
 * other direction.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const LOGIN = resolve(__dirname, '../../cli/login.ts');
const OAUTH = resolve(__dirname, '../../auth/oauth.ts');

describe('login does not claim a save that never happens', () => {
  it('the command makes no claim of saving credentials', () => {
    const text = readFileSync(LOGIN, 'utf-8');

    // Only the strings the command actually prints; the doc comment above
    // this file's fix explains the history and legitimately says "saved".
    const printed = [...text.matchAll(/console\.log\(\s*'([^']*)'/g)].map((m) => m[1]);
    expect(printed.length).toBeGreaterThan(2);

    // A *positive* claim only. "This token was NOT saved" is the correction,
    // not the defect, so negated forms are excluded explicitly rather than by
    // loosening the pattern.
    const claims = printed
      .filter((line) => /\b(saved|stored|persisted)\b/i.test(line))
      .filter((line) => !/\b(not|never|no)\b/i.test(line));
    expect(claims).toEqual([]);
  });

  it('tells the user the token is discarded', () => {
    const printed = readFileSync(LOGIN, 'utf-8');
    expect(printed).toMatch(/NOT saved/);
  });

  it('the OAuth flow still has no persistence to claim', () => {
    const text = readFileSync(OAUTH, 'utf-8');

    // Guard the guard: a regex that matched nothing would make the check below
    // pass against any file at all.
    expect(text).toMatch(/export async function initiateOAuthFlow/);

    // If this fails, credentials ARE now persisted somewhere -- go update the
    // message in cli/login.ts to say where.
    const writes = /writeFileSync|writeFile\(|appendFileSync|fs\.promises\.write/.test(text);
    expect(writes).toBe(false);
  });
});
