import { beforeEach, describe, expect, it } from 'vitest';

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
