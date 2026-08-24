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
