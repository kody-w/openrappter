import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../components/show-and-tell.js';
import {
  handleDesktopUiCommand,
  snapshotDesktopUi,
} from '../services/desktop-control.js';

describe('desktop UI command handler', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <button style="display:block">Run task</button>
      <input style="display:block" aria-label="Task input" value="unsent private draft" />
      <textarea style="display:block" aria-label="Chat composer">private textarea draft</textarea>
      <div style="display:block" contenteditable="true" aria-label="Editable note">private editable draft</div>
      <input style="display:block" type="password" aria-label="API token" value="super-secret" />
      <button style="display:block" data-desktop-sensitive="microphone">Start narration</button>
    `;
    document.body.append(host);
    for (const element of shadow.querySelectorAll<HTMLElement>('*')) {
      element.getClientRects = () => [{ width: 10, height: 10 }] as DOMRectList;
    }
  });

  it('snapshots open shadow-root controls and drives them by ref', async () => {
    const snapshot = snapshotDesktopUi();
    expect(snapshot.elements.map((element) => element.text)).toContain('Run task');
    const input = snapshot.elements.find((element) => element.ariaLabel === 'Task input');
    expect(input).toBeDefined();
    expect(input?.valueState).toBe('set');
    expect(JSON.stringify(snapshot)).not.toContain('unsent private draft');
    expect(JSON.stringify(snapshot)).not.toContain('private textarea draft');
    expect(JSON.stringify(snapshot)).not.toContain('private editable draft');

    const changed = await handleDesktopUiCommand({
      action: 'input',
      args: { ref: input!.ref, value: 'ship it' },
    });
    expect((changed as { valueState: string }).valueState).toBe('set');
    expect(JSON.stringify(changed)).not.toContain('ship it');
    const secret = snapshot.elements.find((element) => element.ariaLabel === 'API token');
    expect(secret?.valueState).toBe('set');
    await expect(handleDesktopUiCommand({
      action: 'input',
      args: { ref: secret!.ref, value: 'replacement' },
    })).rejects.toThrow(/sensitive/);

    const microphone = snapshot.elements.find((element) => element.text === 'Start narration');
    await expect(handleDesktopUiCommand({
      action: 'click',
      args: { ref: microphone!.ref },
    })).rejects.toThrow(/sensitive/);
  });

  it('rejects expired or invented refs', async () => {
    const snapshot = snapshotDesktopUi();
    const previous = snapshot.elements[0].ref;
    snapshotDesktopUi();
    await expect(handleDesktopUiCommand({
      action: 'click',
      args: { ref: previous },
    })).rejects.toThrow(/older snapshot/);
    await expect(handleDesktopUiCommand({
      action: 'click',
      args: { ref: 'ui-999' },
    })).rejects.toThrow(/older snapshot|expired/);
  });

  it('excludes private Show-and-Tell subtrees from model-visible snapshots', () => {
    const privateSurface = document.createElement('section');
    privateSurface.dataset.desktopPrivate = '';
    privateSurface.innerHTML = `
      <p>private narration transcript</p>
      <button style="display:block">Approve private analysis</button>
    `;
    document.body.append(privateSurface);
    for (const element of privateSurface.querySelectorAll<HTMLElement>('*')) {
      element.getClientRects = () => [{ width: 10, height: 10 }] as DOMRectList;
    }

    const snapshot = snapshotDesktopUi();
    expect(JSON.stringify(snapshot)).not.toContain('private narration transcript');
    expect(JSON.stringify(snapshot)).not.toContain('Approve private analysis');
  });
});

// The privacy test above builds its own `data-desktop-private` section, so it
// proves the snapshot honours the attribute but never proves the shipped
// Show-and-Tell markup still carries it. That matters more than it looks:
// a single wrapper div is the only thing keeping recordings, narration
// transcripts and their controls out of a model-visible snapshot, and the
// panel promises the user "frames never go to Copilot". Narrow or move that
// div and the promise breaks silently. These tests pin it against the real
// component.
describe('the real Show-and-Tell surface stays private from desktop automation', () => {
  afterEach(() => {
    delete window.openrappterDesktop;
    vi.restoreAllMocks();
  });

  async function renderRecordingSession(): Promise<HTMLElement> {
    // The fixture from the suite above is still attached, and it contains a
    // decoy "Start narration" button, so start from a clean document.
    document.body.innerHTML = '';
    window.openrappterDesktop = {
      platform: 'darwin',
      gatewayUrl: 'ws://127.0.0.1:18791',
      gatewayToken: 'test',
      showAndTell: vi.fn(),
      desktopControl: vi.fn(),
      narration: vi.fn().mockResolvedValue({ model: 'missing', phase: 'idle' }),
      buddyEvidence: vi.fn(),
      onNarrationStatus: vi.fn().mockReturnValue(() => {}),
      voice: vi.fn(),
      onVoiceStatus: vi.fn().mockReturnValue(() => {}),
      getInfo: vi.fn(),
    } as unknown as typeof window.openrappterDesktop;

    const element = document.createElement('openrappter-show-and-tell') as HTMLElement & {
      session: { id: string; state: string } | null;
      narrationState: string;
      narrationPhase: string;
      narrationText: string;
      updateComplete: Promise<boolean>;
    };
    element.session = { id: 'session-1', state: 'recording' };
    element.narrationState = 'missing';
    element.narrationPhase = 'idle';
    element.narrationText = 'transcribed-desk-audio-do-not-leak';
    document.body.append(element);
    await element.updateComplete;

    // jsdom lays nothing out, and the snapshot drops elements with no client
    // rects, so without this the surface would look empty for the wrong reason.
    for (const node of element.shadowRoot!.querySelectorAll<HTMLElement>('*')) {
      node.getClientRects = () => [{ width: 10, height: 10 }] as unknown as DOMRectList;
    }
    return element;
  }

  it('keeps the recording controls and narration transcript out of the snapshot', async () => {
    const element = await renderRecordingSession();
    const rendered = element.shadowRoot!.textContent ?? '';

    // Anti-vacuity: a surface that failed to render would pass every
    // "not.toContain" assertion below without proving anything.
    expect(rendered).toContain('transcribed-desk-audio-do-not-leak');
    expect(rendered).toContain('Download Whisper');
    expect(element.shadowRoot!.querySelectorAll('button').length).toBeGreaterThan(0);

    const snapshot = JSON.stringify(snapshotDesktopUi());
    expect(snapshot).not.toContain('transcribed-desk-audio-do-not-leak');
    expect(snapshot).not.toContain('Download Whisper');
    expect(snapshot).not.toContain('Start narration');
    expect(snapshot).not.toContain('Capture window');
  });

  it('marks the controls that reach consent-gated work, in case the surface stops being private', async () => {
    const element = await renderRecordingSession();
    const marked = Array.from(
      element.shadowRoot!.querySelectorAll<HTMLElement>('[data-desktop-sensitive]'),
    ).map((node) => ({
      marker: node.dataset.desktopSensitive,
      label: (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
    }));

    const download = marked.find((entry) => entry.label.startsWith('Download Whisper'));
    const narration = marked.find((entry) => entry.label === 'Start narration');
    expect(download?.marker).toBe('model-download');
    expect(narration?.marker).toBe('microphone');
  });
});
