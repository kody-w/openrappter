import { strict as assert } from 'node:assert';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';

import { extractBuddyEvidence } from '../dist/buddy-evidence.js';

test('extracts a plain-text transcript without external tools', async () => {
  const result = await extractBuddyEvidence({
    filename: 'walkthrough.txt',
    mimeType: 'text/plain',
    data: Buffer.from('Open the invoice, verify the total, then request approval.'),
  });

  assert.equal(result.kind, 'document');
  assert.match(result.text, /request approval/);
  assert.equal(result.truncated, false);
});

test('transcribes walkthrough media with timestamped local evidence', async () => {
  const commands = [];
  const result = await extractBuddyEvidence(
    {
      filename: 'walkthrough.mp4',
      mimeType: 'video/mp4',
      data: Buffer.from('synthetic-video'),
    },
    {
      runCommand: async (binary, args) => {
        commands.push({ binary, args });
        if (binary === 'ffprobe') return '12.5\n';
        await writeFile(args.at(-1), Buffer.from(new Float32Array([0.1, 0.2]).buffer));
        return '';
      },
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
      transcribe: async () => ({
        text: 'Open the app. Save the result.',
        segments: [
          { atMs: 0, endMs: 4_000, text: 'Open the app.' },
          { atMs: 4_000, endMs: 9_000, text: 'Save the result.' },
        ],
      }),
    },
  );

  assert.equal(result.kind, 'video');
  assert.match(result.text, /\[0s-4s\] Open the app/);
  assert.deepEqual(commands.map((command) => command.binary), [
    'ffprobe',
    'ffmpeg',
  ]);
});

test('rejects unsupported binary documents explicitly', async () => {
  await assert.rejects(
    extractBuddyEvidence({
      filename: 'archive.zip',
      mimeType: 'application/zip',
      data: Buffer.from('zip'),
    }),
    /Unsupported evidence type/,
  );
});
