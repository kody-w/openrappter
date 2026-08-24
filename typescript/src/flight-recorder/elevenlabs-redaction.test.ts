import { describe, expect, it } from 'vitest';
import {
  sanitizeFlightMetadata,
  sanitizeFlightValue,
  summarizeFlightError,
} from './redaction.js';

describe('ElevenLabs secret redaction', () => {
  const keys = [
    `sk_${'e'.repeat(40)}`,
    `xi_${'f'.repeat(40)}`,
  ];

  it.each(keys)('redacts provider key formats from arbitrary values', (key) => {
    expect(JSON.stringify(sanitizeFlightValue(`failure carried ${key}`))).not.toContain(key);
    expect(JSON.stringify(sanitizeFlightMetadata({ message: `failure carried ${key}` }))).not.toContain(key);
    expect(JSON.stringify(summarizeFlightError(new Error(`failure carried ${key}`)))).not.toContain(key);
  });
});
