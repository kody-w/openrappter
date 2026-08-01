/**
 * Choosing how to reach someone, and saying so out loud.
 *
 * The ladder degrades from a cloud voice API all the way down to this machine
 * on its own. What it never does is silently substitute a weaker capability for
 * a stronger one: if the agent ends up texting instead of speaking, or handing
 * you a connected call instead of handling it, the owner is told in the same
 * breath as the result.
 *
 *   retell / twilio   speaks and listens          needs an account + keys
 *   google-voice sms  negotiates by text          on-device, your own number
 *   macos sms         negotiates by text          on-device, Messages
 *   google-voice call connects YOU to them        on-device, no autonomy
 *   macos tel:        rings from your iPhone      on-device, no autonomy
 *   simulation        rehearsal only              never presented as real
 *
 * Nothing here reads a credential. Cloud providers configure themselves from
 * the environment; the on-device ones use sessions the owner is already signed
 * in to. No account identifier is hardcoded in this repo.
 */

import type { CallProvider, Modality, ProviderCapability } from '../types.js';
import { capabilityOf } from '../types.js';
import { RetellProvider } from './retell.js';
import { TwilioProvider } from './twilio.js';
import { GoogleVoiceProvider, type GoogleVoiceDriver } from './google-voice.js';
import { MacNativeProvider } from './macos.js';
import { SimulationProvider } from './simulation.js';

export interface ResolveOptions {
  /** Forces one backend by name. Fails loudly if it is not available. */
  prefer?: string;
  /** Required for the Google Voice rungs. */
  googleVoiceDriver?: GoogleVoiceDriver;
  googleVoiceAccount?: string;
  /** Reads inbound texts, which is what makes the on-device SMS rungs autonomous. */
  awaitReply?: (from: string, timeoutMs: number) => Promise<string | null>;
  /** Scripted replies. Only ever produces a rehearsal, never a real call. */
  rehearse?: string[];
  /** Refuse anything that cannot conduct the exchange itself. */
  requireAutonomous?: boolean;
  /** Refuse anything that would send data to a third party. */
  requireOnDevice?: boolean;
  /** Candidate list, for tests. */
  candidates?: CallProvider[];
}

export interface Resolution {
  provider: CallProvider;
  capability: ProviderCapability;
  /** True when this is a rehearsal rather than a real call. */
  rehearsal: boolean;
  /** Rungs that were tried and why they were skipped. */
  skipped: { name: string; reason: string }[];
  /** One line for the owner. */
  notice: string;
}

export class NoProviderError extends Error {
  readonly skipped: { name: string; reason: string }[];

  constructor(skipped: { name: string; reason: string }[], requirement?: string) {
    super(
      `No way to reach anyone is available${requirement ? ` that is ${requirement}` : ''}.\n` +
        skipped.map((s) => `  - ${s.name}: ${s.reason}`).join('\n') +
        '\n\nOptions:\n' +
        '  - cloud voice: set RETELL_API_KEY (+ RETELL_AGENT_ID or RETELL_FROM_NUMBER),\n' +
        '    or TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER\n' +
        '  - on-device by text: sign in to Google Voice in your browser and set\n' +
        '    GOOGLE_VOICE_ACCOUNT, or use Messages on a Mac paired to your iPhone\n' +
        '  - practise with no call at all: pass rehearse',
    );
    this.name = 'NoProviderError';
    this.skipped = skipped;
  }
}

function buildLadder(options: ResolveOptions): CallProvider[] {
  if (options.candidates) return options.candidates;

  const ladder: CallProvider[] = [new RetellProvider(), new TwilioProvider()];

  if (options.googleVoiceDriver) {
    ladder.push(
      new GoogleVoiceProvider({
        driver: options.googleVoiceDriver,
        account: options.googleVoiceAccount,
        mode: 'sms',
      }),
    );
  }

  ladder.push(new MacNativeProvider({ mode: 'sms', awaitReply: options.awaitReply }));

  // Handoff rungs last: they get the owner a connected call, but the agent
  // cannot conduct it, so they are a worse outcome than negotiating by text.
  if (options.googleVoiceDriver) {
    ladder.push(
      new GoogleVoiceProvider({
        driver: options.googleVoiceDriver,
        account: options.googleVoiceAccount,
        mode: 'handoff',
      }),
    );
  }
  ladder.push(new MacNativeProvider({ mode: 'handoff' }));

  return ladder;
}

function label(provider: CallProvider): string {
  const capability = capabilityOf(provider);
  return `${provider.name} (${capability.modality})`;
}

export async function resolveProvider(options: ResolveOptions = {}): Promise<Resolution> {
  const skipped: { name: string; reason: string }[] = [];

  if (options.rehearse?.length) {
    const provider = new SimulationProvider({ peers: [{ number: '*', replies: options.rehearse }] });
    return {
      provider,
      capability: {
        modality: 'voice',
        autonomous: true,
        onDevice: true,
        summary: 'a rehearsal against scripted replies — nobody was called',
      },
      rehearsal: true,
      skipped,
      notice: 'Rehearsal only — no call was placed.',
    };
  }

  for (const provider of buildLadder(options)) {
    const capability = capabilityOf(provider);

    if (options.prefer && provider.name !== options.prefer) continue;
    if (options.requireAutonomous && !capability.autonomous) {
      skipped.push({ name: label(provider), reason: 'cannot conduct the exchange itself' });
      continue;
    }
    if (options.requireOnDevice && !capability.onDevice) {
      skipped.push({ name: label(provider), reason: 'would send data to a third party' });
      continue;
    }

    let available = false;
    try {
      available = await provider.isAvailable();
    } catch (error) {
      skipped.push({ name: label(provider), reason: (error as Error).message });
      continue;
    }

    if (!available) {
      skipped.push({ name: label(provider), reason: 'not configured or not signed in' });
      continue;
    }

    return {
      provider,
      capability,
      rehearsal: false,
      skipped,
      notice: capability.autonomous
        ? `Using ${provider.name}: ${capability.summary}.`
        : `Using ${provider.name}: ${capability.summary}. I will set it up, but you will need to talk.`,
    };
  }

  const requirement = options.requireOnDevice
    ? 'fully on-device'
    : options.requireAutonomous
      ? 'able to handle the whole exchange'
      : options.prefer
        ? `named "${options.prefer}"`
        : undefined;

  throw new NoProviderError(skipped, requirement);
}

/** Which modality the phrasing should follow. */
export function speakerModality(capability: ProviderCapability): Modality {
  return capability.modality;
}
