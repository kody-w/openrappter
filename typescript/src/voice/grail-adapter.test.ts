import { describe, expect, it } from 'vitest';
import {
  ALLOWED_PUSH_TO_TALK_KEYS,
  DefaultGrailVoiceIntegrationAdapter,
  DEFAULT_GRAIL_VOICE_SETTINGS,
  reviewGrailVoiceSettings,
  serializeGrailVoiceSettings,
} from './grail-adapter.js';

describe('default Grail voice settings adapter', () => {
  it('has every reviewed input/output setting and keeps voice off by default', () => {
    expect(DEFAULT_GRAIL_VOICE_SETTINGS).toMatchObject({
      outputEnabled: false,
      autoSpeak: false,
      provider: 'local',
      inputEnabled: false,
      continuousConversation: false,
      pushToTalkKey: 'Space',
      transcriptPolicy: 'review',
      backgroundBehavior: 'pause',
      wakeLock: 'never',
    });
  });

  it('accepts only closed push-to-talk choices and rejects shortcut conflicts', () => {
    expect(ALLOWED_PUSH_TO_TALK_KEYS).toEqual([
      'Space',
      'KeyV',
      'KeyT',
      'ControlRight',
      'AltRight',
    ]);
    expect(() => reviewGrailVoiceSettings({
      ...DEFAULT_GRAIL_VOICE_SETTINGS,
      pushToTalkKey: 'MetaLeft',
    } as never)).toThrow(/push-to-talk/i);
    expect(() => reviewGrailVoiceSettings({
      ...DEFAULT_GRAIL_VOICE_SETTINGS,
      pushToTalkKey: 'KeyV',
    }, { reservedKeys: ['KeyV'] })).toThrow(/conflicts/i);
  });

  it('returns immutable bounded settings and excludes credentials from persistence', () => {
    const reviewed = reviewGrailVoiceSettings({
      ...DEFAULT_GRAIL_VOICE_SETTINGS,
      silenceMs: 999_999,
      maxListenMs: -1,
      operationTimeoutMs: 999_999,
      inputDeviceId: 'device-1',
      apiKey: 'must-not-persist',
    } as never);
    expect(Object.isFrozen(reviewed)).toBe(true);
    expect(reviewed.silenceMs).toBe(2_000);
    expect(reviewed.maxListenMs).toBe(5_000);
    expect(reviewed.operationTimeoutMs).toBe(60_000);
    const serialized = serializeGrailVoiceSettings(reviewed);
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('must-not-persist');
    expect(JSON.parse(serialized).inputDeviceId).toBe('device-1');
  });

  it('rejects a disconnected selected input device', () => {
    expect(() => reviewGrailVoiceSettings({
      ...DEFAULT_GRAIL_VOICE_SETTINGS,
      inputDeviceId: 'missing-device',
    }, {
      availableInputDeviceIds: ['default', 'microphone-1'],
    })).toThrow(/input device/i);
  });

  it('commits reviewed immutable settings and discards uncommitted drafts', () => {
    const adapter = new DefaultGrailVoiceIntegrationAdapter();
    const committed = adapter.reviewAndCommit({ inputEnabled: true });
    expect(committed.inputEnabled).toBe(true);
    expect(Object.isFrozen(committed)).toBe(true);
    const discarded = adapter.discardDraft();
    expect(discarded).toBe(committed);
    expect(adapter.serialize()).not.toContain('credential');
  });
});
