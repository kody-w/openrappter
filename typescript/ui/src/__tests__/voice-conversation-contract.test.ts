import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const component = readFileSync(
  join(process.cwd(), 'src/components/voice-conversation.ts'),
  'utf8',
);
const chat = readFileSync(
  join(process.cwd(), 'src/components/chat.ts'),
  'utf8',
);

describe('default Grail conversation integration contract', () => {
  it('mounts through the default chat without modifying a pending shell', () => {
    expect(chat).toContain('<openrappter-voice-conversation');
    expect(chat).toContain('.sendTranscript=${this.sendVoiceTranscript}');
    expect(chat).toContain('.speakAssistant=${this.speakVoiceAssistant}');
  });

  it('sends microphone samples only to local narration and sends only transcript to chat', () => {
    expect(component).toContain("action: 'voice.transcribe'");
    expect(component).toContain('samples: audio');
    expect(component).toContain('this.sendTranscript(text, signal)');
    expect(component).not.toMatch(/gateway\.(?:call|request)\([^)]*audio/s);
  });

  it('pauses on approval and exposes no voice approval bypass', () => {
    expect(component).toContain("gateway.on('approval'");
    expect(component).toContain("gateway.call<Array<unknown>>('exec.pending')");
    expect(component).not.toContain('exec.respond');
    expect(component).not.toContain('approved: true');
  });

  it('has background pause, wake-lock release, PTT conflict guards, and accessible indicators', () => {
    expect(component).toContain("document.addEventListener('visibilitychange'");
    expect(component).toContain("backgroundBehavior === 'pause'");
    expect(component).toContain('releaseWakeLock');
    expect(component).toContain('event.repeat');
    expect(component).toContain('input, textarea, select');
    expect(component).toContain('aria-live="polite"');
    expect(component).toContain('aria-live="assertive"');
  });
});
