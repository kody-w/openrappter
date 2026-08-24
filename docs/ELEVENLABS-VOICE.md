# ElevenLabs voice

ElevenLabs is an optional TypeScript desktop speech provider. It does not
replace system speech or local VibeVoice: Voice mode remains off by default,
defaults to local, and can always be switched to `system` or `local`.

## Security and data boundary

- The renderer submits a key once over trusted Electron IPC. Electron main
  verifies it, encrypts it with `safeStorage` (the operating-system credential
  service), and writes only ciphertext to the private application-data
  directory. The renderer can update, delete, or test a key, but cannot read it.
- Production requests are hard-coded to `https://api.elevenlabs.io` and the
  exact subscription, voices, models, and streaming TTS paths. There is no
  production base-URL option.
- The gateway signs the final assistant `voiceText`. Electron main verifies
  this short-lived ticket and synthesizes its embedded text. Arbitrary renderer
  text, user prompts, and conversation history cannot enter the remote path.
- Audio stays in memory and plays through the existing desktop renderer path.
  There is no ElevenLabs disk cache. The typed `VoiceAudioDescriptor` seam can
  describe organism egg sounds without importing or depending on an organism,
  XPedition, or Grail shell.

The public Python agent contract does not include desktop playback, Electron
IPC, or secure OS credentials. ElevenLabs therefore remains TypeScript desktop
owned rather than introducing a second Python implementation. The stable safe
wire shapes are recorded in `tests/elevenlabs-voice-wire.json`.

## Back-and-forth conversation

The default, shell-neutral Grail adapter owns immutable reviewed voice settings:
output, auto-speak, `system|local|elevenlabs`, verified voice/model, input,
continuous mode, a closed push-to-talk choice, input device, transcript policy,
background pause, wake-lock policy, and bounded VAD/timeouts. Credential setup
is a separate write-only flow and is never part of exported display settings.

The conversation controller follows:

`idle → listening → endpointing → transcribing → sending → thinking → speaking → listening`

It also exposes paused, cancelled, error, offline, auth, and model-unavailable
states. Local Web Audio capture is echo-cancelled, memory-bounded, and sent only
to the Electron main process for existing local Whisper transcription. Audio is
discarded immediately. Only the final endpointed/confirmed transcript enters
`chat.send`; only signed final assistant voice text enters remote TTS.

Silence VAD, push-to-talk release, and maximum duration can endpoint a turn.
Barge-in aborts playback before reopening the microphone. Assistant-text echo is
suppressed for a bounded window. Hidden/minimized windows pause capture, wake
locks are optional and listening-only, device loss fails closed, and resuming
requires a visible human action. Any execution approval pauses the loop;
voice code has no approve method and cannot resume while `exec.pending` is
non-empty.

### One local STT authority

Voice input does not create a second Whisper runtime. Skills Recorder
narration, Voice conversation, walkthrough evidence, and desktop smoke all
acquire the same ref-counted `NarrationService`, the same
`Xenova/whisper-small` q8 pipeline, the same application-data model cache, and
the same pinned revision (`2d67713f236afa48a18992566e7647f6ca848e13`).

The authority serializes a bounded PCM/request queue, exposes model download
progress and ready/offline/error/busy health, supports request-id cancellation,
unloads only after the last owner releases, and cancels all work on desktop
shutdown. A failed inference clears and rebuilds the cached pipeline once; it
never downloads a second model or changes the package pin. Recorder and Voice
can coexist, and Voice waits on an in-progress Recorder download rather than
starting another.

The public reference in `localFirstTools` was used only for interaction
vocabulary (separate input/output groups, continuous mode, PTT, visible
listening/speaking state, pause). Its branding, assets, unsafe browser speech,
API-key export, and arbitrary endpoint patterns were not copied.

## Safe live smoke

After review, the operator performs the one permitted live check:

1. Open **Chat → Voice settings** and select **ElevenLabs**.
2. Paste the key into the password field and choose **Verify & save**. The key
   is not echoed, logged, placed in an environment variable, or returned.
3. Choose a verified voice/model, then select **Safe live smoke**. The fixed
   phrase is “OpenRappter voice check.” The UI plays memory-backed audio and
   reports only provider, voice id, duration, and a truncated SHA-256.
4. Choose **Delete key** if the credential was test-only.

Never pass a key as a command-line argument. No live credential is needed by
the build or test suite; all transport tests use injected mocked `fetch`.
