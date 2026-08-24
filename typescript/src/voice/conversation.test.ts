import { describe, expect, it, vi } from 'vitest';
import {
  GrailVoiceConversation,
  type VoiceConversationClock,
  type VoiceConversationDependencies,
} from './conversation.js';
import {
  DEFAULT_GRAIL_VOICE_SETTINGS,
  reviewGrailVoiceSettings,
} from './grail-adapter.js';

class FakeClock implements VoiceConversationClock {
  nowMs = 1_000;
  private id = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();

  now = () => this.nowMs;
  setTimeout = (callback: () => void, delayMs: number) => {
    const id = ++this.id;
    this.timers.set(id, { at: this.nowMs + delayMs, callback });
    return id;
  };
  clearTimeout = (id: unknown) => {
    this.timers.delete(Number(id));
  };
  advance(ms: number): void {
    this.nowMs += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.nowMs) {
        this.timers.delete(id);
        timer.callback();
      }
    }
  }
}

function settings(overrides: Record<string, unknown> = {}) {
  return reviewGrailVoiceSettings({
    ...DEFAULT_GRAIL_VOICE_SETTINGS,
    outputEnabled: true,
    autoSpeak: true,
    inputEnabled: true,
    continuousConversation: true,
    transcriptPolicy: 'auto',
    ...overrides,
  });
}

function harness(overrides: Partial<VoiceConversationDependencies> = {}) {
  const clock = new FakeClock();
  const states: string[] = [];
  let run = 0;
  const deps: VoiceConversationDependencies = {
    transcribeLocal: vi.fn(async () => `turn ${run + 1}`),
    showTranscript: vi.fn(),
    sendTranscript: vi.fn(async () => ({ runId: `run_${++run}` })),
    speakAssistant: vi.fn(async () => undefined),
    cancelSpeech: vi.fn(async () => undefined),
    stopCapture: vi.fn(async () => undefined),
    onState: (snapshot) => states.push(snapshot.state),
    ...overrides,
  };
  const conversation = new GrailVoiceConversation(settings(), deps, clock);
  return { conversation, deps, states, clock };
}

describe('Grail voice conversation state machine', () => {
  it('runs a deterministic two-turn continuous loop without overlapping turns', async () => {
    const { conversation, deps, states } = harness();
    await conversation.beginListening('continuous');
    await conversation.submitEndpoint(new Uint8Array([1, 2, 3]));
    expect(conversation.snapshot).toMatchObject({ state: 'thinking', runId: 'run_1' });
    await conversation.assistantFinal({
      runId: 'run_1',
      text: 'First answer',
      ticket: 'ticket-1',
    });
    expect(conversation.snapshot.state).toBe('listening');

    await conversation.submitEndpoint(new Uint8Array([4, 5, 6]));
    await conversation.assistantFinal({
      runId: 'run_2',
      text: 'Second answer',
      ticket: 'ticket-2',
    });

    expect(conversation.snapshot.state).toBe('listening');
    expect(deps.sendTranscript).toHaveBeenCalledTimes(2);
    expect(deps.speakAssistant).toHaveBeenCalledTimes(2);
    expect(states).toEqual(expect.arrayContaining([
      'listening',
      'endpointing',
      'transcribing',
      'sending',
      'thinking',
      'speaking',
    ]));
  });

  it('supports push-to-talk and review-before-send policy', async () => {
    const { deps, clock } = harness();
    const conversation = new GrailVoiceConversation(
      settings({ continuousConversation: false, transcriptPolicy: 'review' }),
      deps,
      clock,
    );
    await conversation.pushToTalkPressed('Space');
    expect(conversation.snapshot.state).toBe('listening');
    await conversation.pushToTalkReleased(new Uint8Array([9]));
    expect(conversation.snapshot).toMatchObject({
      state: 'paused',
      reason: 'transcript-review',
      transcript: 'turn 1',
    });
    expect(deps.showTranscript).toHaveBeenCalledWith('turn 1', true);
    expect(deps.sendTranscript).not.toHaveBeenCalled();
    await conversation.confirmTranscript();
    expect(deps.sendTranscript).toHaveBeenCalledWith('turn 1', expect.any(AbortSignal));
  });

  it('barge-in cancels speech before opening the microphone', async () => {
    let finishSpeech!: () => void;
    const speech = new Promise<void>((resolve) => { finishSpeech = resolve; });
    const { conversation, deps } = harness({
      speakAssistant: vi.fn(async () => speech),
    });
    await conversation.beginListening('continuous');
    await conversation.submitEndpoint(new Uint8Array([1]));
    const finalizing = conversation.assistantFinal({
      runId: 'run_1',
      text: 'Long response',
      ticket: 'ticket',
    });
    await Promise.resolve();
    expect(conversation.snapshot.state).toBe('speaking');
    await conversation.beginListening('barge-in');
    expect(deps.cancelSpeech).toHaveBeenCalledTimes(1);
    expect(conversation.snapshot.state).toBe('listening');
    finishSpeech();
    await finalizing;
    expect(conversation.snapshot.state).toBe('listening');
  });

  it('suppresses self-echo instead of sending assistant speech back to Copilot', async () => {
    const { deps, clock } = harness({
      transcribeLocal: vi.fn(async () => 'The lights are already off'),
    });
    const conversation = new GrailVoiceConversation(settings(), deps, clock);
    conversation.noteSpokenText('The lights are already off.');
    await conversation.beginListening('continuous');
    await conversation.submitEndpoint(new Uint8Array([1]));
    expect(deps.sendTranscript).not.toHaveBeenCalled();
    expect(conversation.snapshot).toMatchObject({
      state: 'listening',
      reason: 'echo-suppressed',
    });
  });

  it('cancels capture, transcription, sending, speech, and pending restarts', async () => {
    const { conversation, deps } = harness();
    await conversation.beginListening('continuous');
    await conversation.cancel('manual');
    expect(deps.stopCapture).toHaveBeenCalledTimes(1);
    expect(deps.cancelSpeech).toHaveBeenCalledTimes(1);
    expect(conversation.snapshot).toMatchObject({ state: 'cancelled', reason: 'manual' });
    await expect(conversation.submitEndpoint(new Uint8Array([1]))).rejects.toThrow(/not listening/i);
  });

  it('suppresses a late assistant final after manual stop', async () => {
    const { conversation, deps } = harness();
    await conversation.beginListening('continuous');
    await conversation.submitEndpoint(new Uint8Array([1]));
    await conversation.cancel('manual');
    await expect(conversation.assistantFinal({
      runId: 'run_1',
      text: 'late',
      ticket: 'late',
    })).resolves.toBe(true);
    expect(deps.speakAssistant).not.toHaveBeenCalled();
  });

  it.each([
    ['offline', 'offline'],
    ['auth', 'auth'],
    ['model-unavailable', 'model-unavailable'],
  ] as const)('surfaces %s and recovers only by explicit action', async (code, state) => {
    const { conversation } = harness();
    await conversation.beginListening('continuous');
    conversation.fail(code);
    expect(conversation.snapshot.state).toBe(state);
    await conversation.recover();
    expect(conversation.snapshot.state).toBe('listening');
  });

  it.each([
    ['The ElevenLabs credential is invalid.', 'auth'],
    ['The selected model is unavailable.', 'model-unavailable'],
    ['Network unreachable while offline.', 'offline'],
  ] as const)('maps speech failure %s to %s', async (message, state) => {
    const { deps, clock } = harness({
      speakAssistant: vi.fn(async () => {
        throw new Error(message);
      }),
    });
    const conversation = new GrailVoiceConversation(settings(), deps, clock);
    await conversation.beginListening('continuous');
    await conversation.submitEndpoint(new Uint8Array([1]));
    await conversation.assistantFinal({
      runId: 'run_1',
      text: 'answer',
      ticket: 'ticket',
    });
    expect(conversation.snapshot.state).toBe(state);
  });

  it('pauses for tool approval and cannot voice-approve or resume while pending', async () => {
    const { conversation, deps } = harness();
    await conversation.beginListening('continuous');
    await conversation.submitEndpoint(new Uint8Array([1]));
    await conversation.approvalRequested('approval-1');
    expect(conversation.snapshot).toMatchObject({
      state: 'paused',
      reason: 'tool-approval',
      approvalId: 'approval-1',
    });
    expect(deps.cancelSpeech).toHaveBeenCalled();
    await expect(conversation.resumeAfterApproval(1)).rejects.toThrow(/pending/i);
    await conversation.resumeAfterApproval(0);
    expect(conversation.snapshot).toMatchObject({
      state: 'thinking',
      runId: 'run_1',
      reason: 'approval-resolved',
    });
    expect('approve' in conversation).toBe(false);
  });

  it('holds an assistant final received during approval until explicit resume', async () => {
    const { conversation, deps } = harness();
    await conversation.beginListening('continuous');
    await conversation.submitEndpoint(new Uint8Array([1]));
    await conversation.approvalRequested('approval-1');
    await expect(conversation.assistantFinal({
      runId: 'run_1',
      text: 'after approval',
      ticket: 'ticket',
    })).resolves.toBe(true);
    expect(deps.speakAssistant).not.toHaveBeenCalled();
    await conversation.resumeAfterApproval(0);
    expect(deps.speakAssistant).toHaveBeenCalledTimes(1);
    expect(conversation.snapshot.state).toBe('listening');
  });

  it('rejects double endpoint and stale final races without duplicate sends', async () => {
    let finishTranscription!: (text: string) => void;
    const pending = new Promise<string>((resolve) => { finishTranscription = resolve; });
    const { conversation, deps } = harness({
      transcribeLocal: vi.fn(async () => pending),
    });
    await conversation.beginListening('continuous');
    const first = conversation.submitEndpoint(new Uint8Array([1]));
    await expect(conversation.submitEndpoint(new Uint8Array([2]))).rejects.toThrow(/turn.*active/i);
    finishTranscription('one turn');
    await first;
    await conversation.assistantFinal({
      runId: 'stale',
      text: 'wrong',
      ticket: 'wrong',
    });
    expect(deps.speakAssistant).not.toHaveBeenCalled();
    expect(deps.sendTranscript).toHaveBeenCalledTimes(1);
  });

  it('sends only final transcript externally; raw microphone bytes stay local', async () => {
    const audio = new Uint8Array([99, 98, 97]);
    const { conversation, deps } = harness({
      transcribeLocal: vi.fn(async (localAudio) => {
        expect(localAudio).toBe(audio);
        return 'final local transcript';
      }),
    });
    await conversation.beginListening('continuous');
    await conversation.submitEndpoint(audio);
    expect(deps.sendTranscript).toHaveBeenCalledWith(
      'final local transcript',
      expect.any(AbortSignal),
    );
    expect(JSON.stringify(vi.mocked(deps.sendTranscript).mock.calls)).not.toContain('99,98,97');
  });

  it('times out a noisy/hung operation and requires recovery', async () => {
    const { deps, clock } = harness({
      transcribeLocal: vi.fn(async () => new Promise<string>(() => {})),
    });
    const conversation = new GrailVoiceConversation(
      settings({ operationTimeoutMs: 1_000 }),
      deps,
      clock,
    );
    await conversation.beginListening('continuous');
    const pending = conversation.submitEndpoint(new Uint8Array([1]));
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(1_001);
    await pending;
    expect(conversation.snapshot).toMatchObject({
      state: 'error',
      reason: 'transcription-timeout',
    });
  });
});
