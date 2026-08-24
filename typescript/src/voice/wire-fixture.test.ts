import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ElevenLabs desktop wire fixture', () => {
  it('is TypeScript desktop owned and has no credential read operation', () => {
    const fixture = JSON.parse(readFileSync(
      join(process.cwd(), '..', 'tests', 'elevenlabs-voice-wire.json'),
      'utf8',
    )) as {
      ownership: string;
      requests: Array<{ action: string }>;
      forbiddenResponseFields: string[];
    };
    expect(fixture.ownership).toBe('typescript-desktop');
    expect(fixture.requests.map((request) => request.action)).not.toContain('credential.get');
    expect(fixture.forbiddenResponseFields).toContain('apiKey');
  });
});
