import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const chat = readFileSync(
  path.join(process.cwd(), 'src', 'components', 'chat.ts'),
  'utf8',
);
const showAndTell = readFileSync(
  path.join(process.cwd(), 'src', 'components', 'show-and-tell.ts'),
  'utf8',
);
const preload = readFileSync(
  path.join(process.cwd(), '..', 'desktop', 'src', 'preload.cts'),
  'utf8',
);

describe('large media UI contract', () => {
  it('keeps small direct attachments compatible and routes larger files away from FileReader', () => {
    expect(chat).toContain('file.size <= SMALL_DIRECT_UPLOAD_BYTES');
    expect(chat).toContain('file.size > SMALL_DIRECT_UPLOAD_BYTES');
    expect(chat).toContain('this.stageLargeAttachment(preview)');
    expect(chat).toContain('if (a.uploadPromise) await a.uploadPromise');
    expect(chat).toContain('assetId: a.asset.id');
    expect(preload).toContain('webUtils.getPathForFile(file)');
    expect(preload).not.toMatch(/readAsDataURL|arrayBuffer\(/);
  });

  it('exposes accessible progress, cancellation, resumability, and truthful locality', () => {
    expect(chat).toContain('aria-live="polite"');
    expect(chat).toContain('Cancel upload of');
    expect(chat).toContain('Stays on this OpenRappter installation');
    expect(chat).toContain('not uploaded externally');
    expect(chat).not.toMatch(/rename|compress your|hand-compress/i);
  });

  it('uses the same verified media adapter for Show-and-Tell without editing a shell', () => {
    expect(showAndTell).toContain('mediaUploads.upload(file');
    expect(showAndTell).toContain("action: 'media'");
    expect(showAndTell).toContain('asset_id: asset.id');
    expect(showAndTell).toContain('never uploaded externally');
    expect(showAndTell).toContain('aria-label=${`Cancel media ingest');
  });
});
