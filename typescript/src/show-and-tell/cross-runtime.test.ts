import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ShowAndTellStore } from './store.js';

const python = process.platform === 'win32' ? 'python' : 'python3';
const pythonProbe = spawnSync(python, ['--version'], { encoding: 'utf8' });
const hasPython = pythonProbe.status === 0;

describe('Show-and-Tell cross-runtime contract', () => {
  it.skipIf(!hasPython)(
    'lets Python read and extend a TypeScript session without conversion',
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'show-cross-runtime-'));
      try {
        const store = new ShowAndTellStore(root);
        const session = await store.createSession({
          intentHint: 'Cross-runtime contract test',
        });
        await store.appendEvent(session.id, 'session.note', 'typescript', {
          note: 'created by TypeScript',
        });
        store.close();

        const pythonRoot = path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          '../../../python',
        );
        const script = [
          'import json, sys',
          'from openrappter.show_and_tell import ShowAndTellStore',
          'store = ShowAndTellStore(sys.argv[1])',
          'before = store.events(sys.argv[2])',
          'store.append_event(sys.argv[2], "manual.observation", "python",',
          '  {"title": "Python parity", "detail": "extended the same session"})',
          'print(json.dumps({"before": len(before), "state": store.get_session(sys.argv[2])["state"]}))',
          'store.close()',
        ].join('\n');
        const result = spawnSync(python, ['-c', script, root, session.id], {
          encoding: 'utf8',
          env: { ...process.env, PYTHONPATH: pythonRoot },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          before: 1,
          state: 'recording',
        });

        const reopened = new ShowAndTellStore(root);
        const events = await reopened.events(session.id);
        expect(events.map((event) => event.source)).toEqual([
          'typescript',
          'python',
        ]);
        expect(events.map((event) => event.sequence)).toEqual([0, 1]);
        reopened.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
