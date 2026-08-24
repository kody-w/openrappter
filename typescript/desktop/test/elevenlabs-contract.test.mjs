import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../src/preload.cts', import.meta.url), 'utf8');
const client = readFileSync(
  new URL('../../src/voice/elevenlabs.ts', import.meta.url),
  'utf8',
);
const agent = readFileSync(
  new URL('../../src/agents/TTSAgent.ts', import.meta.url),
  'utf8',
);
const narration = readFileSync(
  new URL('../src/narration.ts', import.meta.url),
  'utf8',
);

test('ElevenLabs credentials remain in the authenticated desktop main process', () => {
  assert.match(main, /safeStorage/);
  assert.match(main, /secure-credentials\.json/);
  assert.match(main, /credential\.set/);
  assert.match(main, /credential\.delete/);
  assert.doesNotMatch(main, /credential\.get/);
  assert.doesNotMatch(preload, /apiKey|credential\.get/);
  assert.doesNotMatch(agent, /ELEVENLABS_API_KEY/);
});

test('remote speech requires a signed exact-assistant-text ticket', () => {
  assert.match(main, /verifySpeechTicket\(ticket, voiceTicketKey\)/);
  assert.match(main, /OPENRAPPTER_VOICE_TICKET_KEY: voiceTicketKey/);
  assert.doesNotMatch(preload, /voiceTicketKey|OPENRAPPTER_VOICE_TICKET_KEY/);
  assert.match(main, /Invalid or expired assistant speech authorization/);
  assert.match(main, /selectedVoiceProvider === 'elevenlabs'/);
  const remoteBranch = main.slice(
    main.indexOf("if (selectedVoiceProvider === 'elevenlabs')"),
    main.indexOf("if (!vibeVoice().isInstalled())"),
  );
  assert.doesNotMatch(remoteBranch, /input\.text/);
  assert.match(remoteBranch, /authorized\.text/);
});

test('the transport cannot be redirected to an arbitrary endpoint', () => {
  assert.match(client, /export const ELEVENLABS_ORIGIN = 'https:\/\/api\.elevenlabs\.io'/);
  assert.doesNotMatch(client, /baseUrl\??:/);
  assert.match(client, /assertAllowedPath/);
  assert.match(client, /redirect: 'error'/);
});

test('voice IPC is trusted, bounded, cancellable, and never exposes a key read action', () => {
  assert.match(main, /validateTrustedRequest\(event, request\)/);
  assert.match(main, /submitted\.length < 20 \|\| submitted\.length > 256/);
  assert.match(main, /voiceOutputQueue\?\.cancelAll\(\)/);
  assert.match(main, /maxQueued: 2/);
  assert.match(main, /maxQueuedCharacters: 5_000/);
});

test('conversation settings are reviewed separately from secure credentials', () => {
  assert.match(main, /action === 'settings\.save'/);
  assert.match(main, /reviewGrailVoiceSettings/);
  assert.match(main, /openrappter-voice-preferences\/2\.0/);
  assert.match(main, /settings: currentVoiceSettings\(\)/);
  assert.doesNotMatch(
    main.slice(
      main.indexOf('function saveVoicePreferences'),
      main.indexOf('async function loadVoiceRuntime'),
    ),
    /apiKey|credential/,
  );
});

test('conversation microphone audio is ephemeral local-Whisper input', () => {
  const branch = main.slice(
    main.indexOf("action === 'voice.transcribe'"),
    main.indexOf("if (action !== 'transcribe')"),
  );
  assert.match(branch, /narration\(\)\.transcribe/);
  assert.match(branch, /45-second local safety limit/);
  assert.doesNotMatch(branch, /writeFile|appendEvent|fetch|elevenLabs/);
});

test('one ref-counted narration service owns every local Whisper caller', () => {
  assert.equal((main.match(/new NarrationService\(/g) ?? []).length, 1);
  assert.match(main, /owner: 'voice-conversation'/);
  assert.match(main, /owner: 'skills-recorder'/);
  assert.match(main, /stt\.acquire\('buddy-evidence'\)/);
  assert.match(narration, /private readonly owners = new Map/);
  assert.match(narration, /private readonly queue/);
  assert.match(narration, /restartCount/);
  assert.match(narration, /shutdown\(\)/);
  assert.match(main, /narrationService\?\.shutdown\(\)/);
});
