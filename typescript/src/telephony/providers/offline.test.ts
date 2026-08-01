import { describe, expect, it, vi } from 'vitest';

import {
  GoogleVoiceProvider,
  MacNativeProvider,
  NoProviderError,
  buildSendScript,
  osaEscape,
  resolveProvider,
} from '../index.js';
import type { GoogleVoiceDriver } from './google-voice.js';
import { CallAgent } from '../call-agent.js';
import { smsSpeaker } from './google-voice.js';
import type { CallObjective, CallProvider, ProviderCapability } from '../types.js';

/**
 * Degrading gracefully when there is no cloud account.
 *
 * The value here is not that a fallback exists — it is that the fallback never
 * pretends to be the thing it replaced. An agent that reports "booked" after
 * quietly doing nothing is worse than an agent that says it cannot help.
 */

const FRIDAY = '2026-08-07';

function fakeProvider(name: string, capability: ProviderCapability, available = true): CallProvider {
  return {
    name,
    capability,
    isAvailable: async () => available,
    dial: async (r) => ({ id: `${name}-1`, provider: name, to: r.to, direction: 'outbound' as const }),
    say: async () => {},
    listen: async () => null,
    hangup: async () => {},
  };
}

const cloudVoice = (available = true) =>
  fakeProvider('cloud', { modality: 'voice', autonomous: true, onDevice: false, summary: 'speaks' }, available);
const deviceSms = (available = true) =>
  fakeProvider('device-sms', { modality: 'sms', autonomous: true, onDevice: true, summary: 'texts' }, available);
const deviceHandoff = (available = true) =>
  fakeProvider('device-handoff', { modality: 'handoff', autonomous: false, onDevice: true, summary: 'connects you' }, available);

describe('the fallback ladder', () => {
  it('prefers a real voice line when one is configured', async () => {
    const resolved = await resolveProvider({ candidates: [cloudVoice(), deviceSms()] });
    expect(resolved.provider.name).toBe('cloud');
    expect(resolved.rehearsal).toBe(false);
  });

  it('drops to on-device text when the cloud is not configured', async () => {
    const resolved = await resolveProvider({ candidates: [cloudVoice(false), deviceSms()] });
    expect(resolved.provider.name).toBe('device-sms');
    expect(resolved.capability.onDevice).toBe(true);
    expect(resolved.skipped[0].reason).toMatch(/not configured/);
  });

  it('says out loud which rung it landed on', async () => {
    const resolved = await resolveProvider({ candidates: [cloudVoice(false), deviceSms()] });
    expect(resolved.notice).toContain('device-sms');
    expect(resolved.notice).toContain('texts');
  });

  it('warns when the best it can do is hand the owner a call', async () => {
    const resolved = await resolveProvider({ candidates: [deviceHandoff()] });
    expect(resolved.capability.autonomous).toBe(false);
    expect(resolved.notice).toMatch(/you will need to talk/i);
  });

  it('prefers negotiating by text over handing off a call', async () => {
    // Doing the job badly beats not doing the job.
    const resolved = await resolveProvider({ candidates: [deviceHandoff(), deviceSms()] });
    expect(resolved.provider.name).toBe('device-handoff');

    const ordered = await resolveProvider({ candidates: [deviceSms(), deviceHandoff()] });
    expect(ordered.provider.name).toBe('device-sms');
  });

  it('refuses rather than downgrading when autonomy is required', async () => {
    await expect(resolveProvider({ candidates: [deviceHandoff()], requireAutonomous: true })).rejects.toThrow(
      NoProviderError,
    );
  });

  it('refuses to leave the device when told not to', async () => {
    await expect(resolveProvider({ candidates: [cloudVoice()], requireOnDevice: true })).rejects.toThrow(
      NoProviderError,
    );
  });

  it('explains every rung it skipped', async () => {
    try {
      await resolveProvider({ candidates: [cloudVoice(false), deviceSms(false)] });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as NoProviderError;
      expect(err.skipped).toHaveLength(2);
      expect(err.message).toMatch(/RETELL_API_KEY/);
      expect(err.message).toMatch(/GOOGLE_VOICE_ACCOUNT/);
      expect(err.message).toMatch(/rehearse/);
    }
  });

  it('treats a rung that throws as unavailable, not fatal', async () => {
    const broken: CallProvider = {
      ...deviceSms(),
      name: 'broken',
      isAvailable: async () => {
        throw new Error('browser is not running');
      },
    };
    const resolved = await resolveProvider({ candidates: [broken, deviceSms()] });
    expect(resolved.provider.name).toBe('device-sms');
    expect(resolved.skipped[0].reason).toMatch(/browser is not running/);
  });

  it('never silently substitutes a rehearsal for a real call', async () => {
    // rehearse must be asked for, never fallen back into
    await expect(resolveProvider({ candidates: [cloudVoice(false)] })).rejects.toThrow(NoProviderError);

    const rehearsal = await resolveProvider({ candidates: [cloudVoice(false)], rehearse: ['hi'] });
    expect(rehearsal.rehearsal).toBe(true);
    expect(rehearsal.notice).toMatch(/no call was placed/i);
  });

  it('honours an explicit preference', async () => {
    const resolved = await resolveProvider({ candidates: [cloudVoice(), deviceSms()], prefer: 'device-sms' });
    expect(resolved.provider.name).toBe('device-sms');
    await expect(
      resolveProvider({ candidates: [cloudVoice(), deviceSms()], prefer: 'nope' }),
    ).rejects.toThrow(/named "nope"/);
  });
});

describe('Google Voice', () => {
  function driver(overrides: Partial<GoogleVoiceDriver> = {}): GoogleVoiceDriver {
    return {
      isSignedIn: async () => true,
      sendSms: async () => 'thread-1',
      awaitReply: async () => null,
      placeBridgedCall: async () => 'bridged-1',
      ...overrides,
    };
  }

  it('is on-device and needs no key', async () => {
    const provider = new GoogleVoiceProvider({ driver: driver() });
    expect(provider.capability.onDevice).toBe(true);
    expect(await provider.isAvailable()).toBe(true);
  });

  it('is unavailable when nobody is signed in', async () => {
    const provider = new GoogleVoiceProvider({ driver: driver({ isSignedIn: async () => false }) });
    expect(await provider.isAvailable()).toBe(false);
  });

  it('checks the configured account, not just any session', async () => {
    const isSignedIn = vi.fn(async () => true);
    const provider = new GoogleVoiceProvider({ driver: driver({ isSignedIn }), account: 'someone@example.com' });
    await provider.isAvailable();
    expect(isSignedIn).toHaveBeenCalledWith('someone@example.com');
  });

  it('carries a whole text negotiation', async () => {
    const sent: string[] = [];
    const replies = ['Seven is booked. I could do seven forty-five?', 'Booked, see you then.'];
    let turn = 0;

    const provider = new GoogleVoiceProvider({
      driver: driver({
        sendSms: async (_to, text) => {
          sent.push(text);
          return 'thread-1';
        },
        awaitReply: async () => replies[turn++] ?? null,
      }),
    });

    const objective: CallObjective = {
      goal: 'Book a table for 2 on Friday at 7pm',
      constraints: [{ kind: 'not_after', time: '20:00', label: 'no later than 8pm' }],
      ideal: { start: `${FRIDAY}T19:00:00` },
    };

    const agent = new CallAgent({ provider, speaker: smsSpeaker as never });
    const result = await agent.placeCall({ to: '+15551234567', objective, date: FRIDAY, hint: 'evening' });

    // Same decision as on a voice call: legal, but not what was asked for.
    expect(result.outcome).toBe('escalated');
    expect(result.offer?.start).toBe(`${FRIDAY}T19:45:00`);
    expect(sent[0]).toContain('Book a table for 2');
    // and it is phrased as a text, not as speech
    expect(sent.join(' ')).not.toMatch(/call you (straight )?back/i);
  });

  it('refuses to claim it spoke on a bridged call', async () => {
    const provider = new GoogleVoiceProvider({ driver: driver(), mode: 'handoff' });
    expect(provider.capability.autonomous).toBe(false);

    const handle = await provider.dial({ to: '+15551234567' });
    await expect(provider.say(handle, 'hello')).rejects.toThrow(/cannot speak/i);
  });

  it('reports the bridged call it placed', async () => {
    const placeBridgedCall = vi.fn(async () => 'bridged-9');
    const provider = new GoogleVoiceProvider({ driver: driver({ placeBridgedCall }), mode: 'handoff' });

    const handle = await provider.dial({ to: '+15551234567' });

    expect(placeBridgedCall).toHaveBeenCalledWith('+15551234567');
    expect(handle.externalId).toBe('bridged-9');
  });

  it('has nothing to hang up on a text thread', async () => {
    const provider = new GoogleVoiceProvider({ driver: driver() });
    await expect(provider.hangup()).resolves.toBeUndefined();
  });
});

describe('macOS native', () => {
  it('escapes AppleScript so a message cannot become a script', () => {
    expect(osaEscape('say "hi" \\ bye')).toBe('say \\"hi\\" \\\\ bye');

    const script = buildSendScript('+15551234567', 'Table for 2" ; do shell script "rm -rf /');
    // The injected quote must be escaped, so it stays inside the string literal.
    expect(script).toContain('\\"');
    expect(script.match(/send "/g)).toHaveLength(1);
  });

  it('is only autonomous when it can read replies', async () => {
    const withoutReader = new MacNativeProvider({ mode: 'sms' });
    const withReader = new MacNativeProvider({ mode: 'sms', awaitReply: async () => null });

    if (process.platform === 'darwin') {
      expect(await withoutReader.isAvailable()).toBe(false);
      expect(await withReader.isAvailable()).toBe(true);
    } else {
      expect(await withReader.isAvailable()).toBe(false);
    }
  });

  it('refuses to speak on a tel: handoff', async () => {
    const exec = vi.fn(async (_file: string, _args: string[]) => undefined);
    const provider = new MacNativeProvider({ mode: 'handoff', exec });

    const handle = await provider.dial({ to: '+15551234567' });

    expect(exec).toHaveBeenCalledWith('open', ['tel:+15551234567']);
    await expect(provider.say(handle, 'hello')).rejects.toThrow(/cannot speak/i);
  });

  it('sends through Messages in sms mode', async () => {
    const exec = vi.fn(async (_file: string, _args: string[]) => undefined);
    const provider = new MacNativeProvider({ mode: 'sms', exec, awaitReply: async () => null });

    const handle = await provider.dial({ to: '+15551234567' });
    await provider.say(handle, 'Table for two at seven?');

    expect(exec).toHaveBeenCalledWith('osascript', ['-e', expect.stringContaining('Table for two at seven?')]);
    // dialling an SMS thread must not ring anyone
    expect(exec.mock.calls.some((c) => c[0] === 'open')).toBe(false);
  });
});
