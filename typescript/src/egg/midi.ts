import { createHash } from 'node:crypto';

function variableLength(value: number): number[] {
  const bytes = [value & 0x7f];
  while ((value >>= 7) > 0) bytes.unshift((value & 0x7f) | 0x80);
  return bytes;
}

function chunk(name: string, bytes: number[]): Buffer {
  const header = Buffer.alloc(8);
  header.write(name, 0, 4, 'ascii');
  header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, Buffer.from(bytes)]);
}

/**
 * A deterministic, original eight-bar motif derived only from organism-safe
 * identity material. It contains no samples or copied musical phrases.
 */
export function generateOrganismTheme(
  rappid: string,
  traits: Record<string, unknown> = {},
): Uint8Array {
  const seed = createHash('sha256')
    .update('openrappter:organism-theme/1\n', 'ascii')
    .update(rappid, 'utf8')
    .update('\n', 'ascii')
    .update(JSON.stringify(traits, Object.keys(traits).sort()), 'utf8')
    .digest();
  const scale = [0, 2, 3, 5, 7, 9, 10];
  const track: number[] = [
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
    0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
    0x00, 0xc0, seed[0] % 8,
  ];
  for (let index = 0; index < 32; index += 1) {
    const note = 48 + scale[seed[index % seed.length] % scale.length]
      + (seed[(index + 7) % seed.length] % 2) * 12;
    const velocity = 58 + seed[(index + 13) % seed.length] % 34;
    track.push(...variableLength(index === 0 ? 0 : 24), 0x90, note, velocity);
    track.push(...variableLength(72), 0x80, note, 0);
  }
  track.push(0x00, 0xff, 0x2f, 0x00);

  const header = Buffer.from([
    0x4d, 0x54, 0x68, 0x64,
    0x00, 0x00, 0x00, 0x06,
    0x00, 0x00,
    0x00, 0x01,
    0x00, 0x60,
  ]);
  return Buffer.concat([header, chunk('MTrk', track)]);
}

export function validateMidi(bytes: Uint8Array): void {
  const value = Buffer.from(bytes);
  if (value.length < 22 || value.subarray(0, 4).toString('ascii') !== 'MThd') {
    throw new Error('MIDI is missing its MThd header');
  }
  if (value.readUInt32BE(4) !== 6) throw new Error('MIDI header length must be 6');
  const tracks = value.readUInt16BE(10);
  if (tracks < 1 || tracks > 64) throw new Error('MIDI track count is invalid');
  let offset = 14;
  for (let index = 0; index < tracks; index += 1) {
    if (offset + 8 > value.length || value.subarray(offset, offset + 4).toString('ascii') !== 'MTrk') {
      throw new Error(`MIDI track ${index} is missing`);
    }
    const length = value.readUInt32BE(offset + 4);
    offset += 8 + length;
    if (offset > value.length) throw new Error(`MIDI track ${index} is truncated`);
  }
  if (offset !== value.length) throw new Error('MIDI has trailing bytes');
}
