/**
 * A twin shares the device. It never shares a mouth. — #103
 *
 * #101 made hatching work, and a hatched twin immediately booted the entire
 * device runtime. From a single twin's own startup log, with nothing
 * configured — this was the default:
 *
 *   [channel:imessage] iMessage transport connected
 *   Cron started — 2 jobs scheduled
 *   Cron executing: agent=GoogleVoice message="Check Google Voice and answer
 *                                              anything that deserves it"
 *
 * So while the alpha was running, a twin independently connected iMessage with
 * its own durable queue and ran the agent that answers strangers texting the
 * owner's real phone number. The queues are separate, so neither rappter can
 * see what the other already sent. N twins means a stranger's message is a
 * candidate for N replies from one number.
 *
 * That was harmless for exactly as long as a second rappter could not start.
 *
 * These assert the DECISION — which is the thing that was wrong. The decision
 * is read out of the real source rather than restated here, because a test that
 * restates the rule it is checking passes against code that does the opposite,
 * and that has already happened once in this repo.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(join(here, '..', '..', 'index.ts'), 'utf8');

describe('a hatched twin does not duplicate the alpha\'s outbound channels', () => {
  it('decides twin-ness from the instance name it was hatched under', () => {
    expect(indexSource).toMatch(
      /const isTwin = Boolean\(\(opts\?\.instance \?\? ''\)\.trim\(\)\)/,
    );
  });

  it('passes the instance through to the runtime, not only to the lock and port', () => {
    // The whole defect was that `--instance` reached the lock (#94) and the
    // port (#101) and stopped. If it does not reach startGatewayInProcess,
    // nothing downstream can know it is a twin.
    expect(indexSource).toMatch(/\.\.\.\(lockInstance \? \{ instance: lockInstance \} : \{\}\)/);
  });

  it('never connects iMessage on a twin', () => {
    expect(indexSource).toMatch(/const imessageEnabled = imessageConfig\.enabled && !isTwin/);
    // Every gate that starts the runtime or its durable store must consult the
    // twin-aware flag, not the raw config.
    expect(indexSource).toMatch(/const imessageStore = imessageEnabled/);
    expect(indexSource).toMatch(/if \(imessageEnabled\) \{/);
  });

  it('never starts cron on a twin — that is where GoogleVoice runs', () => {
    expect(indexSource).toMatch(
      /\/\/ ── Cron Service[\s\S]{0,600}?if \(isTwin\) \{[\s\S]{0,400}?\} else try \{/,
    );
  });

  it('does not report a withheld channel as a fault', () => {
    // 'runtime_unavailable' on a twin would describe a deliberate boundary as
    // a malfunction and send someone debugging something that works.
    expect(indexSource).toMatch(/isTwin \? 'reserved_for_alpha' : 'disabled'/);
  });

  it('leaves the alpha with everything it had', () => {
    // isTwin is false when no instance is given, so every gate above collapses
    // to the original expression for the alpha. Guard against the gate being
    // rewritten into something that also catches the alpha.
    expect(indexSource).not.toMatch(/const isTwin = true/);
    expect(indexSource).not.toMatch(/imessageConfig\.enabled && false/);
  });
});

/**
 * The rule has to survive the NEXT channel, not just the ones known today. — #115
 *
 * #103 guarded iMessage and cron and stated the rule generally: *"Hatching a
 * twin must not duplicate any channel that speaks to someone outside this
 * device."* The comment shipped with it claims *"A twin is a peer on /chat and
 * /twin and nothing else."*
 *
 * Telegram was not guarded. `isTwin` appeared five times in index.ts — the
 * definition, the assistant identity, iMessage, cron, and a status label — and
 * the Telegram auto-connect was not among them. Two rappters would poll and
 * answer the same bot account with separate histories, neither able to see what
 * the other had already said to a real person.
 *
 * It was latent only because TELEGRAM_BOT_TOKEN is unset on the machine this
 * was found on. That is configuration, not design: `hydrateManagedEnv()` runs
 * for every gateway process including twins, and `hatch` spawns the child
 * without an env override, so the token reaches a twin readily.
 *
 * Guarding one more channel by name would leave the same hole for the next one.
 * The last test here pins the STRUCTURE instead: every `.connect()` on the
 * gateway startup path must be reachable only when this process is not a twin.
 */
describe('no channel connects on a twin, including ones added later', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.ts'),
    'utf8',
  );

  it('does not connect Telegram on a twin', () => {
    expect(source).toMatch(
      /const telegramToken = isTwin \? undefined : process\.env\.TELEGRAM_BOT_TOKEN/,
    );
  });

  it('leaves the alpha connecting exactly as before', () => {
    // isTwin is false for the alpha, so the expression collapses to the
    // original `process.env.TELEGRAM_BOT_TOKEN`. Guard against a rewrite that
    // also silences the alpha.
    expect(source).not.toMatch(/const telegramToken = undefined/);
    expect(source).toContain('await telegram.connect();');
  });

  it('has no .connect( beyond the one known, twin-gated channel', () => {
    // The structural check, and it is deliberately dumb.
    //
    // The first version of this test searched the twelve lines above each
    // `.connect()` for `isTwin`. It passed when a simulated unguarded
    // `discordChannel.connect()` was inserted just after the Telegram block —
    // because the window found TELEGRAM's guard and accepted it. A proximity
    // heuristic sees what you expected it to see, which is the failure this
    // whole file exists to document.
    //
    // v2 pinned the exact set of call sites and matched `\.connect\(\)` with
    // literal empty parentheses. It passed against
    // `await discord.connect(discordToken)` — #115 reproduced exactly, an
    // ungated outbound channel on the startup path, suite green. A connect
    // taking an argument is the shape a token-bearing channel has, which is the
    // most likely form of the thing this guards. #120
    //
    // Both earlier versions were verified against the single shape their author
    // had in mind, and passed. This matches ANY argument list, and is checked
    // against both shapes before being trusted.
    const connects = source
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /\.connect\(/.test(line));

    expect(connects).toEqual(['await telegram.connect();']);
  });
});
