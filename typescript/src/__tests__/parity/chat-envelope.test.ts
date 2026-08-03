/**
 * The `/chat` envelope, per `rapp-runtime-parity/1.0` §2.4 and KERNEL §2.2.
 *
 * The envelope had no tests at all, which is how `"model":"unknown"` shipped
 * and stayed: every required key was present, so the shape looked correct while
 * two of the six carried no information.
 */
import { describe, it, expect } from 'vitest';
import {
  buildChatEnvelope,
  unattributedModel,
  ENVELOPE_REQUIRED_KEYS,
} from '../../gateway/chat-envelope.js';

describe('chat envelope — PARITY §2.4', () => {
  it('emits all six frozen keys', () => {
    const envelope = buildChatEnvelope({ content: 'hi', sessionId: 's1' });
    for (const key of ENVELOPE_REQUIRED_KEYS) {
      expect(envelope, `missing ${key}`).toHaveProperty(key);
    }
  });

  it('never emits assistant_response (KERNEL §2.2 prohibition)', () => {
    const envelope = buildChatEnvelope({ content: 'hi', sessionId: 's1' });
    expect(envelope).not.toHaveProperty('assistant_response');
  });

  it('reports the model that answered when the backend names one', () => {
    const envelope = buildChatEnvelope({
      content: 'hi',
      sessionId: 's1',
      model: 'gpt-4.1',
      requestedModel: 'gpt-4.1',
      backendKind: 'copilot-sdk',
    });
    expect(envelope.model).toBe('gpt-4.1');
    expect(envelope.requested_model).toBe('gpt-4.1');
  });

  it('keeps the two apart when a fallback switched models', () => {
    const envelope = buildChatEnvelope({
      content: 'hi',
      sessionId: 's1',
      model: 'gpt-4.1',
      requestedModel: 'claude-sonnet-5',
      backendKind: 'copilot-sdk',
    });
    expect(envelope.requested_model).toBe('claude-sonnet-5');
    expect(envelope.model).toBe('gpt-4.1');
    expect(envelope.model).not.toBe(envelope.requested_model);
  });

  describe('unattributed models', () => {
    it('never returns the bare word "unknown"', () => {
      const delegated = buildChatEnvelope({
        content: 'hi',
        sessionId: 's1',
        backendKind: 'copilot-cli',
      });
      expect(delegated.model).not.toBe('unknown');
      expect(delegated.requested_model).not.toBe('unknown');
    });

    it('says the CLI chose, and stays distinct from the request', () => {
      const envelope = buildChatEnvelope({
        content: 'hi',
        sessionId: 's1',
        backendKind: 'copilot-cli',
      });
      expect(envelope.model).toBe('copilot-cli:auto');
      expect(envelope.requested_model).toBe('auto');
    });

    it('does not pass the requested model off as the answering model', () => {
      // The tempting shortcut. It would make attribution look proven when the
      // backend never confirmed which model served the request.
      const envelope = buildChatEnvelope({
        content: 'hi',
        sessionId: 's1',
        requestedModel: 'gpt-5.4',
        backendKind: 'copilot-cli',
      });
      expect(envelope.requested_model).toBe('gpt-5.4');
      expect(envelope.model).toBe('copilot-cli:unreported');
      expect(envelope.model).not.toBe('gpt-5.4');
    });

    it('distinguishes a delegated choice from an unreported one', () => {
      expect(unattributedModel('copilot-cli', 'auto')).toBe('copilot-cli:auto');
      expect(unattributedModel('copilot-cli', 'gpt-5.4')).toBe('copilot-cli:unreported');
    });

    it('does not dress the placeholder backend up as a real one', () => {
      expect(unattributedModel('unknown', 'auto')).toBe('no-backend:auto');
      expect(unattributedModel(undefined, 'auto')).toBe('no-backend:auto');
    });
  });

  describe('voice seam', () => {
    it('splits the |||VOICE||| sentinel out of response', () => {
      const envelope = buildChatEnvelope({
        content: 'written form|||VOICE|||spoken form',
        sessionId: 's1',
      });
      expect(envelope.response).not.toContain('|||VOICE|||');
      expect(envelope.voice_response).toBe('spoken form');
      expect(envelope.voice_mode).toBe(true);
    });

    it('reports voice_mode false and omits voice_response without a sentinel', () => {
      const envelope = buildChatEnvelope({ content: 'plain reply', sessionId: 's1' });
      expect(envelope.voice_mode).toBe(false);
      expect(envelope).not.toHaveProperty('voice_response');
      expect(envelope.response).toBe('plain reply');
    });
  });
});
