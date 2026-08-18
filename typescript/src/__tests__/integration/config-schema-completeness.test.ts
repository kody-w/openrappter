import { describe, it, expect } from 'vitest';

import { openRappterConfigSchema, channelConfigSchema } from '../../config/schema.js';
import { readIMessageConfig } from '../../channels/imessage-gateway.js';

/**
 * Settings the product reads have to survive the schema that validates them.
 *
 * There are two config systems. The CLI loads `~/.openrappter/config.json`
 * through `env.ts` and reads fields off the raw object; `config/loader.ts`
 * parses `config.json5` and runs it through Zod. Zod strips unknown keys rather
 * than rejecting them, so a key one side depends on and the other has never
 * heard of disappears silently.
 *
 * `readIMessageConfig` reads `mode`, `pollInterval` and `staleAfterMs`.
 * `channelConfigSchema` knew only `enabled`, `allowFrom` and `mentionGating`.
 * A config running the iMessage channel over BlueBubbles therefore came back out
 * of the schema without its transport, and re-reading it selected the
 * `applescript` default — a working setup quietly reconfigured.
 *
 * Nothing routes channels through the schema today, so this was latent. It is
 * the kind of latent that stops being latent the moment someone wires the two
 * systems together, which is exactly the sort of change that looks safe.
 */

describe('config the runtime reads survives the schema', () => {
  it('keeps every iMessage setting readIMessageConfig understands', () => {
    const working = {
      channels: {
        imessage: {
          enabled: true,
          mode: 'bluebubbles',
          pollInterval: 500,
          staleAfterMs: 60_000,
          allowFrom: ['+15550000000'],
        },
      },
    };

    const direct = readIMessageConfig(working);
    const viaSchema = readIMessageConfig(openRappterConfigSchema.parse(working));

    expect(viaSchema).toEqual(direct);
    // Named explicitly: an equality that passed because both sides defaulted
    // would prove nothing.
    expect(viaSchema.mode).toBe('bluebubbles');
    expect(viaSchema.pollInterval).toBe(500);
  });

  it('declares the keys the iMessage reader looks for', () => {
    const shape = Object.keys(channelConfigSchema.shape).sort();
    expect(shape).toEqual([
      'allowFrom',
      'enabled',
      'mentionGating',
      'mode',
      'pollInterval',
      'staleAfterMs',
    ]);
  });

  it('still rejects a mode the reader would not accept', () => {
    const result = channelConfigSchema.safeParse({ enabled: true, mode: 'carrier-pigeon' });
    expect(result.success).toBe(false);
  });
});
