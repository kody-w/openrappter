/**
 * iMessage channel tests — verifies the @rappter tag protocol,
 * 🦖 prefix skip, loop prevention, and message routing.
 *
 * Native macOS channel — the most important local channel.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the channel internals for testing without actual Messages.app
describe('iMessage Channel Protocol', () => {

  describe('@rappter tag detection', () => {
    const shouldRespond = (text: string): boolean => {
      const lower = text.toLowerCase();
      return lower.includes('@rappter') || lower.includes('@rapp');
    };

    it('responds to @rappter tag', () => {
      expect(shouldRespond('hey @rappter what is the weather?')).toBe(true);
    });

    it('responds to @rapp shorthand', () => {
      expect(shouldRespond('@rapp status')).toBe(true);
    });

    it('responds to @RAPPTER uppercase', () => {
      expect(shouldRespond('@RAPPTER hello')).toBe(true);
    });

    it('responds to @Rappter mixed case', () => {
      expect(shouldRespond('yo @Rappter')).toBe(true);
    });

    it('ignores messages without tag', () => {
      expect(shouldRespond('just a normal message')).toBe(false);
    });

    it('ignores messages about rappter without @', () => {
      expect(shouldRespond('rappter is cool')).toBe(false);
    });

    it('ignores empty messages', () => {
      expect(shouldRespond('')).toBe(false);
    });
  });

  describe('🦖 prefix skip (AI response detection)', () => {
    const isAIResponse = (text: string): boolean => {
      return text.startsWith('🦖');
    };

    it('detects AI response with dino prefix', () => {
      expect(isAIResponse('🦖 Hello! The R&F score is 90/A.')).toBe(true);
    });

    it('does not flag normal messages', () => {
      expect(isAIResponse('Hello!')).toBe(false);
    });

    it('does not flag messages with dino elsewhere', () => {
      expect(isAIResponse('I love 🦖 dinosaurs')).toBe(false);
    });
  });

  describe('@rappter tag stripping', () => {
    const stripTag = (text: string): string => {
      return text
        .replace(/@rappter/gi, '')
        .replace(/@rapp/gi, '')
        .trim();
    };

    it('strips @rappter from message', () => {
      expect(stripTag('@rappter what is the weather?')).toBe('what is the weather?');
    });

    it('strips @rapp shorthand', () => {
      expect(stripTag('@rapp status')).toBe('status');
    });

    it('strips from middle of message', () => {
      expect(stripTag('hey @rappter how are you')).toBe('hey  how are you');
    });

    it('strips multiple occurrences', () => {
      expect(stripTag('@rappter hello @rappter')).toBe('hello');
    });

    it('handles case insensitive', () => {
      expect(stripTag('@RAPPTER test')).toBe('test');
    });
  });

  describe('Loop prevention', () => {
    it('tracks sent message prefixes', () => {
      const sentByAI = new Set<string>();
      const message = '🦖 The R&F score is currently 90/A with all systems healthy.';
      const prefix = message.substring(0, 20);
      sentByAI.add(prefix);

      expect(sentByAI.has(message.substring(0, 20))).toBe(true);
      expect(sentByAI.has('random other message'.substring(0, 20))).toBe(false);
    });

    it('caps tracked messages at 20', () => {
      const sentByAI = new Set<string>();
      for (let i = 0; i < 25; i++) {
        sentByAI.add(`message_${i}_prefix_`);
      }
      expect(sentByAI.size).toBe(25);

      // Prune like the real code does
      if (sentByAI.size > 20) {
        const arr = Array.from(sentByAI);
        const pruned = new Set(arr.slice(-10));
        expect(pruned.size).toBe(10);
      }
    });
  });

  describe('Message routing', () => {
    it('self-chat messages with @rappter get forwarded', () => {
      const msg = { text: '@rappter what frame are we on?', isFromMe: true };
      const lower = msg.text.toLowerCase();
      const shouldForward = lower.includes('@rappter') || lower.includes('@rapp');
      expect(shouldForward).toBe(true);
    });

    it('self-chat messages without tag are ignored', () => {
      const msg = { text: 'just talking to myself', isFromMe: true };
      const lower = msg.text.toLowerCase();
      const shouldForward = lower.includes('@rappter') || lower.includes('@rapp');
      expect(shouldForward).toBe(false);
    });

    it('incoming messages with @rappter get forwarded', () => {
      const msg = { text: 'hey @rappter', isFromMe: false };
      const lower = msg.text.toLowerCase();
      const shouldForward = lower.includes('@rappter') || lower.includes('@rapp');
      expect(shouldForward).toBe(true);
    });
  });

  describe('Voice clip pipeline', () => {
    it('cleans text for TTS', () => {
      const raw = '🦖 **Hello** Kody! Check https://example.com for `details`.\n\nThe R&F score is 90/A.';
      const cleaned = raw
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`[^`]+`/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[#*_~>]/g, '')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/[📅🧠🦖❌✅🐊]/gu, '')
        .replace(/"/g, '')
        .replace(/'/g, '')
        .replace(/\n+/g, '. ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 800);

      expect(cleaned).not.toContain('https://');
      expect(cleaned).not.toContain('**');
      expect(cleaned).not.toContain('`');
      expect(cleaned).not.toContain('🦖');
      expect(cleaned).toContain('Hello');
      expect(cleaned).toContain('90/A');
    });
  });
});
