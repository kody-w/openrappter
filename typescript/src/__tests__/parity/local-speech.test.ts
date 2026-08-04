/**
 * Speech state must come from the engine, not from having called `speak()`.
 *
 * The fake engine here is deliberately hostile: it can accept an utterance and
 * then never fire anything, which is exactly what autoplay policy does and is
 * the case a naive implementation reports as success.
 */
import { describe, it, expect } from 'vitest';
import {
  createLocalSpeech,
  spokenLineFrom,
  deriveSpokenLine,
  SPEECH_STATES,
} from '../../voice/local-speech.js';

class FakeUtterance {
  text: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  constructor(text: string) {
    this.text = text;
    this.onstart = null;
    this.onend = null;
    this.onerror = null;
  }
}

type FakeVoice = { name: string; lang: string; localService: boolean };
type EngineConfig = {
  voices?: FakeVoice[];
  behaviour?: 'speak' | 'error' | 'silent';
  synth?: any;
};

function fakeEngine(config: EngineConfig = {}) {
  const voices = config.voices ?? [
    { name: 'Samantha', lang: 'en-US', localService: true },
    { name: 'Albert', lang: 'en-US', localService: true },
    { name: 'Google US English', lang: 'en-US', localService: false },
  ];
  const engine = {
    spoken: [] as FakeUtterance[],
    cancelled: 0,
    getVoices: () => voices,
    addEventListener: () => {},
    removeEventListener: () => {},
    cancel() {
      engine.cancelled += 1;
    },
    speak(utterance: FakeUtterance) {
      engine.spoken.push(utterance);
      const behaviour = config.behaviour ?? 'speak';
      if (behaviour === 'silent') return; // Accepted, never starts. The trap.
      queueMicrotask(() => {
        if (behaviour === 'error') {
          utterance.onerror?.({ error: 'not-allowed' });
          return;
        }
        utterance.onstart?.();
        utterance.onend?.();
      });
    },
  };
  return engine;
}

/** The doubles here are intentionally partial implementations. */
function fakeOpts(storage: unknown) {
  return {
    synth: fakeEngine() as unknown as SpeechSynthesis,
    Utterance: FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
    storage: storage as Storage,
  };
}

function make(config: EngineConfig = {}, options: Record<string, unknown> = {}) {
  const synth = config.synth ?? fakeEngine(config);
  const speech = createLocalSpeech({
    synth: synth as unknown as SpeechSynthesis,
    Utterance: FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
    storage: null,
    startTimeoutMs: 20,
    voicesTimeoutMs: 20,
    ...options,
  });
  return { speech, synth };
}

describe('local speech — voice selection', () => {
  it('never selects a network voice', async () => {
    const { speech } = make();
    await speech.ready();
    expect(speech.voice!.name).toBe('Samantha');
    expect(speech.localVoices.every((v: FakeVoice) => v.localService === true)).toBe(true);
  });

  it('reports not-available rather than using a network voice', async () => {
    const { speech } = make({
      voices: [{ name: 'Google US English', lang: 'en-US', localService: false }],
    });
    const status = await speech.ready();
    expect(status.state).toBe(SPEECH_STATES.UNAVAILABLE);
    expect(status.detail.reason).toContain('network-backed');
    expect(status.localVoices).toBe(0);
  });

  it('says so when the machine has no voices at all', async () => {
    const { speech } = make({ voices: [] });
    const status = await speech.ready();
    expect(status.state).toBe(SPEECH_STATES.UNAVAILABLE);
    expect(status.detail.reason).toContain('No speech voices');
  });

  it('reports no engine rather than throwing', async () => {
    const speech = createLocalSpeech({ synth: null, Utterance: null, storage: null });
    const status = await speech.ready();
    expect(status.state).toBe(SPEECH_STATES.UNAVAILABLE);
    expect(status.detail.reason).toContain('no speech synthesis engine');
  });

  it('skips novelty voices even though they are local', async () => {
    const { speech } = make({
      voices: [
        { name: 'Zarvox', lang: 'en-US', localService: true },
        { name: 'Daniel', lang: 'en-GB', localService: true },
      ],
    });
    await speech.ready();
    expect(speech.voice!.name).toBe('Daniel');
  });

  it('falls back to a novelty voice rather than silence if it is all there is', async () => {
    const { speech } = make({
      voices: [{ name: 'Zarvox', lang: 'en-US', localService: true }],
    });
    const status = await speech.ready();
    expect(status.state).not.toBe(SPEECH_STATES.UNAVAILABLE);
    expect(speech.voice!.name).toBe('Zarvox');
  });

  it('waits for voiceschanged when getVoices() is empty at first', async () => {
    // The classic bug: the list is async and the first call returns [].
    let calls = 0;
    let listener: (() => void) | null = null;
    const late = [{ name: 'Samantha', lang: 'en-US', localService: true }];
    const synth = {
      getVoices: () => (calls++ === 0 ? [] : late),
      addEventListener: (_event: string, fn: () => void) => { listener = fn; },
      removeEventListener: () => {},
      cancel: () => {},
      speak: () => {},
    };
    const { speech } = make({ synth });
    const readyPromise = speech.ready();
    (listener as unknown as (() => void) | null)?.();
    const status = await readyPromise;
    expect(status.state).not.toBe(SPEECH_STATES.UNAVAILABLE);
    expect(speech.voice!.name).toBe('Samantha');
  });
});

describe('local speech — honest state', () => {
  it('resolves spoke only when the engine fires end', async () => {
    const { speech } = make();
    await speech.ready();
    speech.setEnabled(true);
    speech.noteUserGesture();
    const result = await speech.speak('all done');
    expect(result.state).toBe(SPEECH_STATES.SPOKE);
  });

  it('does NOT claim it spoke when the engine silently drops it', async () => {
    // speak() was called and returned normally. Nothing was said.
    const { speech, synth } = make({ behaviour: 'silent' });
    await speech.ready();
    speech.setEnabled(true);
    speech.noteUserGesture();
    const result = await speech.speak('into the void');
    expect(synth.spoken).toHaveLength(1);
    expect(result.state).toBe(SPEECH_STATES.BLOCKED);
    expect(result.state).not.toBe(SPEECH_STATES.SPOKE);
    expect(result.detail.reason).toContain('never started');
  });

  it('surfaces an engine error as blocked-or-unknown', async () => {
    const { speech } = make({ behaviour: 'error' });
    await speech.ready();
    speech.setEnabled(true);
    speech.noteUserGesture();
    const result = await speech.speak('blocked');
    expect(result.state).toBe(SPEECH_STATES.BLOCKED);
    expect(result.detail.reason).toContain('not-allowed');
  });

  it('emits speaking before spoke', async () => {
    const seen: string[] = [];
    const { speech } = make({}, { onState: (state: string) => seen.push(state) });
    await speech.ready();
    speech.setEnabled(true);
    speech.noteUserGesture();
    await speech.speak('hello');
    expect(seen).toContain(SPEECH_STATES.SPEAKING);
    expect(seen[seen.length - 1]).toBe(SPEECH_STATES.SPOKE);
  });

  it('will not start without a user gesture', async () => {
    const { speech, synth } = make();
    await speech.ready();
    speech.setEnabled(true);
    const result = await speech.speak('too early');
    expect(result.state).toBe(SPEECH_STATES.BLOCKED);
    expect(result.detail.reason).toContain('user gesture');
    expect(synth.spoken).toHaveLength(0);
  });
});

describe('local speech — the off switch', () => {
  it('is off by default', async () => {
    const { speech } = make();
    expect(speech.enabled).toBe(false);
  });

  it('says nothing while switched off', async () => {
    const { speech, synth } = make();
    await speech.ready();
    speech.noteUserGesture();
    const result = await speech.speak('should stay quiet');
    expect(synth.spoken).toHaveLength(0);
    expect(result.detail.reason).toContain('switched off');
  });

  it('persists across sessions', async () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => { store.set(key, value); },
    };
    const first = createLocalSpeech(fakeOpts(storage));
    first.setEnabled(true);
    const second = createLocalSpeech(fakeOpts(storage));
    expect(second.enabled).toBe(true);

    second.setEnabled(false);
    const third = createLocalSpeech(fakeOpts(storage));
    expect(third.enabled).toBe(false);
  });

  it('survives storage being unavailable', () => {
    const storage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    const speech = createLocalSpeech(fakeOpts(storage));
    expect(speech.enabled).toBe(false);
    expect(() => speech.setEnabled(true)).not.toThrow();
    expect(speech.enabled).toBe(true);
  });
});

describe('local speech — speaks voice_response, never response', () => {
  it('takes voice_response from the envelope', () => {
    expect(spokenLineFrom({
      response: '## Heading\n\nA **long** shown answer with [links](http://x).',
      voice_response: 'Short spoken line.',
    })).toBe('Short spoken line.');
  });

  it('accepts the streaming field name too', () => {
    expect(spokenLineFrom({ voiceText: 'from the event' })).toBe('from the event');
  });

  it('returns null rather than falling back to response', () => {
    // There is no safe fallback: `response` is the shown text.
    expect(spokenLineFrom({ response: 'shown only' })).toBeNull();
    expect(spokenLineFrom({ response: 'x', voice_response: '   ' })).toBeNull();
    expect(spokenLineFrom(null)).toBeNull();
  });

  it('refuses to narrate markdown if a caller passes the shown reply', async () => {
    const { speech, synth } = make();
    await speech.ready();
    speech.setEnabled(true);
    speech.noteUserGesture();
    const result = await speech.speak('## Heading\n\n**bold** and `code`');
    expect(synth.spoken).toHaveLength(0);
    expect(result.state).toBe(SPEECH_STATES.BLOCKED);
    expect(result.detail.reason).toContain('voice_response');
  });

  it('refuses a bare URL', async () => {
    const { speech, synth } = make();
    await speech.ready();
    speech.setEnabled(true);
    speech.noteUserGesture();
    const result = await speech.speak('see https://example.com for details');
    expect(synth.spoken).toHaveLength(0);
    expect(result.state).toBe(SPEECH_STATES.BLOCKED);
  });

  it('speaks an ordinary conversational line', async () => {
    const { speech, synth } = make();
    await speech.ready();
    speech.setEnabled(true);
    speech.noteUserGesture();
    const result = await speech.speak("I've updated the registry — three entries changed.");
    expect(synth.spoken).toHaveLength(1);
    expect(result.state).toBe(SPEECH_STATES.SPOKE);
  });
});

describe('deriveSpokenLine — one seam rule for both faces', () => {
  it('takes the half after the sentinel', () => {
    expect(deriveSpokenLine('Shown **markdown** body.|||VOICE|||Spoken line.'))
      .toBe('Spoken line.');
  });

  it('stops at the next modality marker', () => {
    expect(deriveSpokenLine('shown|||VOICE|||spoken part|||HOLO|||{"a":1}'))
      .toBe('spoken part');
  });

  it('falls back to the first sentence, not the whole body', () => {
    // The bug this replaces: a surface reading an entire markdown reply aloud.
    const raw = '## Report\n\nThe registry is **clean**. Three entries changed. See https://x.dev for detail.';
    const line = deriveSpokenLine(raw);
    expect(line).toBe('Report The registry is clean.');
    expect(line).not.toContain('**');
    expect(line).not.toContain('http');
  });

  it('drops fenced code rather than narrating it', () => {
    const line = deriveSpokenLine('Done.\n\n```js\nconst x = 1;\n```');
    expect(line).toBe('Done.');
  });

  it('returns null when there is nothing sayable', () => {
    expect(deriveSpokenLine('')).toBeNull();
    expect(deriveSpokenLine('   ')).toBeNull();
    expect(deriveSpokenLine(null as unknown as string)).toBeNull();
  });

  it('produces a line the speaker will actually accept', async () => {
    // The derived line must survive the markdown refusal, or the two halves of
    // this module would disagree with each other.
    const line = deriveSpokenLine('## Heading\n\nAll **done** here. More detail follows.');
    const { speech, synth } = make();
    await speech.ready();
    speech.setEnabled(true);
    speech.noteUserGesture();
    const result = await speech.speak(line!);
    expect(result.state).toBe(SPEECH_STATES.SPOKE);
    expect(synth.spoken).toHaveLength(1);
  });
});
