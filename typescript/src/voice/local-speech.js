/**
 * Local-first browser speech. One module, three surfaces.
 *
 * This is the membrane: openrappter's web chat, the anatomy page at
 * `/bones`, and the vbrainstem all speak through this file so the two faces
 * cannot drift apart. It is plain ES-module JavaScript rather than TypeScript
 * precisely so the single-file surfaces can inline the same bytes the bundled
 * UI imports.
 *
 * ## What it speaks
 *
 * `voice_response`, never `response`. PARITY §2.4 splits the reply at the
 * `|||VOICE|||` seam: `response` is what you SHOW — markdown, links, detail —
 * and `voice_response` is what you SAY, which is short and conversational.
 * They differ on purpose. Reading the shown text aloud means reading markdown
 * punctuation aloud, which is why `speak()` refuses input that still looks
 * like markup rather than narrating asterisks.
 *
 * ## Why local voices only
 *
 * `SpeechSynthesisVoice.localService` distinguishes an on-device engine from
 * a vendor's cloud one. Chrome ships both, and its *default* is frequently a
 * network voice — so the obvious implementation quietly streams everything the
 * organism says to a third party. That is the exact inverse of the GOD-layer
 * thesis, and it fails silently and sounds better while doing it. This module
 * will not use a network voice. If the machine has none that are local it says
 * so and stays quiet.
 *
 * ## Why the state machine has three arms and not two
 *
 * Calling `speechSynthesis.speak()` tells you nothing. Autoplay policy drops
 * the utterance with no error, a missing engine drops it, and a backgrounded
 * tab defers it — in every case `speak()` returns normally and a naive caller
 * reports success. So state is derived from the utterance's own `start`, `end`
 * and `error` events, plus a watchdog for the case where *no* event ever
 * arrives. Same discipline as `burrow.js`: alive, absent, and an explicit
 * "I could not tell", never a boolean guess.
 */

/** @typedef {'idle'|'speaking'|'spoke'|'not-available'|'blocked-or-unknown'} SpeechState */

export const SPEECH_STATES = /** @type {const} */ ({
  IDLE: 'idle',
  SPEAKING: 'speaking',
  /** The engine fired `end`. This is the only state that proves audio ran. */
  SPOKE: 'spoke',
  /** No local voice, or no speech engine at all. Nothing was attempted. */
  UNAVAILABLE: 'not-available',
  /** We asked and could not confirm: autoplay block, engine error, silence. */
  BLOCKED: 'blocked-or-unknown',
});

const DEFAULT_STORAGE_KEY = 'openrappter.speech.enabled';

/**
 * Voices that are technically local but are novelty or accessibility timbres.
 * Taking `getVoices()[0]` or the `default` flag lands on one of these often
 * enough to matter — macOS has historically defaulted to "Albert" or similar
 * on a fresh profile, which sounds like a joke and reads as a broken product.
 */
const NOVELTY = new Set([
  'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos',
  'deranged', 'good news', 'jester', 'junior', 'organ', 'superstar',
  'trinoids', 'whisper', 'wobble', 'zarvox', 'ralph', 'fred', 'kathy',
  'princess', 'bruce', 'agnes', 'vicki', 'victoria', 'grandma', 'grandpa',
  'eddy', 'flo', 'reed', 'rocko', 'sandy', 'shelley', 'wobble',
]);

/**
 * Known-good on-device voices, best first. These are picked for being
 * intelligible at speed rather than for being the most "natural" — a voice
 * that is pleasant but mushy is worse for a short spoken line.
 */
const PREFERRED = [
  'samantha', 'alex', 'daniel', 'karen', 'moira', 'tessa', 'fiona',
  'serena', 'allison', 'ava', 'susan', 'tom', 'nicky', 'aaron',
  'google us english', 'microsoft aria', 'microsoft guy', 'microsoft zira',
];

/** Markdown that must never reach the synthesiser as spoken punctuation. */
const MARKDOWN_NOISE = /[*_`~#>|\[\]]|\bhttps?:\/\/\S+/;

function scoreVoice(voice, lang) {
  const name = (voice.name || '').toLowerCase();
  if (NOVELTY.has(name)) return -1;

  let score = 0;
  const preferredIndex = PREFERRED.findIndex(p => name.includes(p));
  if (preferredIndex !== -1) score += 100 - preferredIndex;

  const voiceLang = (voice.lang || '').toLowerCase().replace('_', '-');
  const want = (lang || 'en-US').toLowerCase().replace('_', '-');
  if (voiceLang === want) score += 50;
  else if (voiceLang.split('-')[0] === want.split('-')[0]) score += 25;
  else score -= 40;

  // Apple's "(Enhanced)" / "(Premium)" downloads are markedly better and are
  // still fully on-device.
  if (/enhanced|premium/.test(name)) score += 30;
  return score;
}

/**
 * Resolve `getVoices()` reliably.
 *
 * `getVoices()` returns `[]` on first call in Chrome, Edge and Safari because
 * the list loads asynchronously — the single most common way browser TTS ships
 * broken. `voiceschanged` fixes it, except when voices are *already* loaded and
 * the event therefore never fires. So: try now, subscribe, and also poll, and
 * resolve on whichever arrives first.
 */
function loadVoices(synth, timeoutMs = 2000) {
  return new Promise(resolve => {
    const immediate = synth.getVoices();
    if (immediate && immediate.length) {
      resolve(immediate);
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      try {
        synth.removeEventListener('voiceschanged', onChanged);
      } catch {
        synth.onvoiceschanged = null;
      }
      resolve(synth.getVoices() || []);
    };

    const onChanged = () => {
      const list = synth.getVoices();
      if (list && list.length) finish();
    };

    try {
      synth.addEventListener('voiceschanged', onChanged);
    } catch {
      synth.onvoiceschanged = onChanged;
    }

    const poll = setInterval(onChanged, 100);
    // Resolving empty is a real answer — "this machine has no voices" — not a
    // failure to wait long enough.
    const timer = setTimeout(finish, timeoutMs);
  });
}

/**
 * @param {object} [options]
 * @param {Storage|null} [options.storage]      Where the off switch persists.
 * @param {string} [options.storageKey]
 * @param {SpeechSynthesis|null} [options.synth] Injectable for tests.
 * @param {(state: SpeechState, detail: object) => void} [options.onState]
 * @param {string} [options.lang]
 * @param {number} [options.startTimeoutMs]     Watchdog for a silent drop.
 * @param {number} [options.voicesTimeoutMs]    How long to wait for voiceschanged.
 */
export function createLocalSpeech(options = {}) {
  const synth = options.synth
    ?? (typeof globalThis !== 'undefined' ? globalThis.speechSynthesis : null);
  const Utterance = options.Utterance
    ?? (typeof globalThis !== 'undefined' ? globalThis.SpeechSynthesisUtterance : null);
  const storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
  const lang = options.lang ?? 'en-US';
  const startTimeoutMs = options.startTimeoutMs ?? 3000;
  const voicesTimeoutMs = options.voicesTimeoutMs ?? 2000;
  const onState = options.onState ?? (() => {});

  let storage = options.storage;
  if (storage === undefined) {
    try {
      storage = globalThis.localStorage;
    } catch {
      storage = null; // Private mode / blocked storage is not an error here.
    }
  }

  let voices = [];
  let chosen = null;
  let loaded = false;
  let state = SPEECH_STATES.IDLE;
  let lastDetail = {};
  /** Chrome garbage-collects a live utterance mid-speech; holding it prevents that. */
  // The assignment is the whole purpose, so this is written and never read.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let held = null;
  let gestureSeen = false;
  let watchingLate = false;

  /**
   * Re-check after we already answered "no local voice".
   *
   * The engine populates its list asynchronously and can miss any deadline on a
   * cold start. Latching that first empty answer is how a machine with 180
   * local voices ends up permanently told it has none.
   */
  function watchForLateVoices() {
    if (watchingLate || !synth) return;
    watchingLate = true;
    const recheck = () => {
      const list = synth.getVoices() || [];
      const local = list.filter(v => v.localService === true);
      if (!local.length) return;
      voices = list;
      const ranked = local
        .map(v => ({ voice: v, score: scoreVoice(v, lang) }))
        .sort((a, b) => b.score - a.score);
      chosen = (ranked.find(r => r.score >= 0) ?? ranked[0]).voice;
      loaded = true;
      watchingLate = false;
      clearInterval(poll);
      try {
        synth.removeEventListener('voiceschanged', recheck);
      } catch {
        synth.onvoiceschanged = null;
      }
      // Tell the surface, so it repaints instead of waiting for a reload.
      setState(SPEECH_STATES.IDLE, {
        voice: chosen.name,
        localVoices: local.length,
        networkVoices: list.length - local.length,
        reason: 'voices finished loading after the initial check',
      });
    };
    try {
      synth.addEventListener('voiceschanged', recheck);
    } catch {
      synth.onvoiceschanged = recheck;
    }
    // Chrome does not always fire the event when the list fills in late.
    const poll = setInterval(recheck, 400);
    if (typeof poll?.unref === 'function') poll.unref();
  }

  function setState(next, detail = {}) {
    state = next;
    lastDetail = detail;
    try {
      onState(next, detail);
    } catch {
      // A rendering callback must never take down speech.
    }
  }

  function readEnabled() {
    if (!storage) return false;
    try {
      // Default OFF. Audio that starts by itself on first load is a hostile
      // default, and the browser would block it anyway.
      return storage.getItem(storageKey) === 'true';
    } catch {
      return false;
    }
  }

  let enabled = readEnabled();

  return {
    SPEECH_STATES,

    get state() {
      return state;
    },
    get detail() {
      return lastDetail;
    },
    get enabled() {
      return enabled;
    },
    get voice() {
      return chosen;
    },

    /** Every local voice on this machine, best first. */
    get localVoices() {
      return voices.filter(v => v.localService === true);
    },

    /**
     * Record that a real user gesture happened.
     *
     * Autoplay policy is the difference between "spoke" and "silently did
     * nothing that looks identical in code". Surfaces call this from a click.
     */
    noteUserGesture() {
      gestureSeen = true;
    },

    setEnabled(value) {
      enabled = Boolean(value);
      try {
        storage?.setItem(storageKey, String(enabled));
      } catch {
        // Persisting is best-effort; the toggle still works this session.
      }
      if (!enabled) this.stop();
      return enabled;
    },

    /**
     * Discover voices and choose one deliberately.
     * Safe to call repeatedly; the work happens once.
     */
    /**
     * Discover voices and choose one deliberately.
     *
     * A negative answer is never cached. `voiceschanged` can fire well after
     * our deadline on a cold start — verified in the wild: this returned "no
     * voices are installed" on a machine that had 180 a moment later, and the
     * surface stayed wrong forever because the empty result had been latched.
     * So an empty list keeps listening, and a later arrival flips the state
     * through `onState` rather than waiting for someone to reload the page.
     */
    async ready() {
      if (loaded && chosen) return this.status();
      if (!synth || !Utterance) {
        loaded = true;
        setState(SPEECH_STATES.UNAVAILABLE, {
          reason: 'This browser has no speech synthesis engine.',
        });
        return this.status();
      }

      voices = await loadVoices(synth, voicesTimeoutMs);

      const local = voices.filter(v => v.localService === true);
      if (!local.length) {
        // Deliberately do NOT fall back to a network voice.
        const networkCount = voices.length;
        // Keep listening. An empty list at this moment is not proof the device
        // has no voices — only that none had loaded yet.
        watchForLateVoices();
        setState(SPEECH_STATES.UNAVAILABLE, {
          reason: networkCount
            ? `This browser offers ${networkCount} voice(s), but all of them are `
              + 'network-backed. Speaking would send the reply to a vendor, so '
              + 'speech is off.'
            : 'No speech voices are installed on this device.',
          networkVoices: networkCount,
          localVoices: 0,
        });
        return this.status();
      }
      loaded = true;

      const ranked = local
        .map(v => ({ voice: v, score: scoreVoice(v, lang) }))
        .sort((a, b) => b.score - a.score);
      // Every candidate here is already local; a novelty voice beats silence.
      chosen = (ranked.find(r => r.score >= 0) ?? ranked[0]).voice;
      setState(SPEECH_STATES.IDLE, {
        voice: chosen.name,
        localVoices: local.length,
        networkVoices: voices.length - local.length,
      });
      return this.status();
    },

    status() {
      return {
        state,
        detail: lastDetail,
        enabled,
        voice: chosen ? { name: chosen.name, lang: chosen.lang } : null,
        localVoices: voices.filter(v => v.localService === true).length,
        networkVoices: voices.filter(v => v.localService !== true).length,
      };
    },

    stop() {
      held = null;
      try {
        synth?.cancel();
      } catch {
        // Cancelling a queue that is not running is not an error.
      }
    },

    /**
     * Speak one line and resolve with the state the ENGINE reported.
     *
     * Resolves `spoke` only on the utterance's own `end` event. Never resolves
     * `spoke` because `speak()` was called.
     *
     * @param {string} text Must be `voice_response`, never `response`.
     * @returns {Promise<{state: SpeechState, detail: object}>}
     */
    async speak(text) {
      const line = String(text ?? '').trim();
      if (!line) {
        return { state: SPEECH_STATES.IDLE, detail: { reason: 'nothing to say' } };
      }
      if (!enabled) {
        return { state: SPEECH_STATES.IDLE, detail: { reason: 'speech is switched off' } };
      }

      if (MARKDOWN_NOISE.test(line)) {
        // The caller handed us `response` (or something built from it). Speaking
        // it would narrate asterisks and URLs. Refuse loudly rather than
        // degrade into nonsense that sounds like a synthesiser bug.
        const detail = {
          reason: 'refused: text contains markdown or a URL, so it is the shown '
            + 'reply rather than the spoken one. Speak voice_response.',
        };
        setState(SPEECH_STATES.BLOCKED, detail);
        return { state: SPEECH_STATES.BLOCKED, detail };
      }

      if (!loaded) await this.ready();
      if (!chosen) {
        return { state: SPEECH_STATES.UNAVAILABLE, detail: lastDetail };
      }

      if (!gestureSeen) {
        const detail = {
          reason: 'held: no user gesture yet, and browsers drop speech started '
            + 'without one. Speech begins after the first click.',
        };
        setState(SPEECH_STATES.BLOCKED, detail);
        return { state: SPEECH_STATES.BLOCKED, detail };
      }

      this.stop();

      return new Promise(resolve => {
        const utterance = new Utterance(line);
        utterance.voice = chosen;
        utterance.lang = chosen.lang || lang;
        utterance.rate = 1.03;
        utterance.pitch = 1.0;
        held = utterance;

        let settled = false;
        const done = (next, detail) => {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          held = null;
          setState(next, detail);
          resolve({ state: next, detail });
        };

        let started = false;
        utterance.onstart = () => {
          started = true;
          setState(SPEECH_STATES.SPEAKING, { voice: chosen.name, text: line });
        };
        utterance.onend = () => done(SPEECH_STATES.SPOKE, { voice: chosen.name, text: line });
        utterance.onerror = event => done(SPEECH_STATES.BLOCKED, {
          reason: `the speech engine reported "${event?.error ?? 'error'}"`,
          voice: chosen.name,
        });

        // The silent-drop case: `speak()` accepted it and the engine never
        // started. Without this the UI shows "speaking" forever and a caller
        // awaiting the promise hangs.
        const watchdog = setTimeout(() => {
          if (started) return; // Long text legitimately outruns the watchdog.
          done(SPEECH_STATES.BLOCKED, {
            reason: 'speech was requested but the engine never started — usually '
              + 'an autoplay block or a backgrounded tab.',
            voice: chosen.name,
          });
        }, startTimeoutMs);

        try {
          synth.speak(utterance);
        } catch (error) {
          done(SPEECH_STATES.BLOCKED, {
            reason: `speak() threw: ${error?.message ?? error}`,
          });
        }
      });
    },
  };
}

/**
 * Pull the spoken line out of a `/chat` envelope.
 *
 * Returns `null` rather than falling back to `response`. There is no safe
 * fallback: `response` is the shown text and speaking it is the bug this whole
 * module exists to avoid.
 */
export function spokenLineFrom(envelope) {
  if (!envelope || typeof envelope !== 'object') return null;
  const voice = envelope.voice_response ?? envelope.voiceText ?? envelope.voiceResponse;
  if (typeof voice === 'string' && voice.trim()) return voice.trim();
  return null;
}

/**
 * Derive a spoken line from a raw reply that has not been split yet.
 *
 * openrappter's gateway already does this server-side in `parseVoiceDelimiter`;
 * this is the same rule for surfaces that talk to a model directly and never
 * see a split envelope, so both faces speak the same half of the same reply.
 *
 * Splitting at the sentinel is the good path. Without one, the first sentence
 * is the fallback — never the whole markdown body, which is what a surface
 * reads aloud when nobody has thought about this.
 *
 * @param {string} raw
 * @returns {string|null} the line to speak, or null if there is nothing sayable
 */
export function deriveSpokenLine(raw) {
  const content = String(raw ?? '');
  if (!content.trim()) return null;

  const marker = content.indexOf('|||VOICE|||');
  if (marker !== -1) {
    const after = content.slice(marker + '|||VOICE|||'.length);
    // A reply may carry further |||TAG||| projections; the spoken part ends at
    // the next marker.
    const next = after.indexOf('|||');
    const voice = (next === -1 ? after : after.slice(0, next)).trim();
    return voice || null;
  }

  // No sentinel: first sentence, with markdown scaffolding removed so the
  // synthesiser is never handed asterisks or fence characters.
  const stripped = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\*\*|`{1,3}|#{1,3}\s|>|---|\[|\]|\(https?:\/\/[^)]*\)/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return null;
  const first = stripped.split(/(?<=[.!?])\s+/)[0]?.trim();
  return first || null;
}
