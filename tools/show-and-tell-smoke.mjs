#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TS = path.join(ROOT, 'typescript');
const PY = path.join(ROOT, 'python');
const python = process.platform === 'win32' ? 'python' : 'python3';
process.env.OPENRAPPTER_SHOW_TEST_MODE = '1';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'openrappter-show-smoke-'));
try {
  const { ShowAndTellStore } = await import(
    new URL('../typescript/dist/show-and-tell/store.js', import.meta.url)
  );
  const { ShowAndTellAgent } = await import(
    new URL('../typescript/dist/agents/ShowAndTellAgent.js', import.meta.url)
  );

  const store = new ShowAndTellStore(tempRoot);
  await store.initialize();
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  store.database()
    .prepare(
      'INSERT INTO show_consents(token_hash, purpose, issued_at, expires_at) VALUES (?, ?, ?, ?)',
    )
    .run(createHash('sha256').update(token).digest('hex'), 'start', now, now + 60_000);
  const agent = new ShowAndTellAgent({ root: tempRoot });
  const started = JSON.parse(
    await agent.perform({
      action: 'start',
      intent: 'Verify the packaged detached collector',
      poll_interval_ms: 60_000,
      max_duration_ms: 60_000,
      consent_token: token,
    }),
  );
  assert(started.status === 'success', `TypeScript collector failed: ${JSON.stringify(started)}`);
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const live = JSON.parse(
    await agent.perform({
      action: 'status',
      session_id: started.session.id,
    }),
  );
  assert(live.collector_healthy === true, 'TypeScript collector heartbeat is not healthy.');
  const stopped = JSON.parse(
    await agent.perform({
      action: 'stop',
      session_id: started.session.id,
    }),
  );
  assert(stopped.session?.state === 'stopped', 'TypeScript collector did not stop cleanly.');
  store.close();

  const pythonScript = `
import json, sys, time
import hashlib, secrets
from pathlib import Path
from openrappter.agents.show_and_tell_agent import ShowAndTellAgent
from openrappter.show_and_tell import ShowAndTellStore
root = Path(sys.argv[1])
store = ShowAndTellStore(root)
store.initialize()
token = secrets.token_hex(32)
now = int(time.time() * 1000)
store.connection.execute(
    "INSERT INTO show_consents(token_hash, purpose, issued_at, expires_at) VALUES (?, ?, ?, ?)",
    (hashlib.sha256(token.encode()).hexdigest(), "start", now, now + 60000),
)
agent = ShowAndTellAgent(root=root)
started = json.loads(agent.perform(
    action="start",
    intent="Verify the packaged Python collector",
    poll_interval_ms=60000,
    max_duration_ms=60000,
    consent_token=token,
))
time.sleep(1.2)
live = json.loads(agent.perform(action="status", session_id=started["session"]["id"]))
stopped = json.loads(agent.perform(action="stop", session_id=started["session"]["id"]))
print(json.dumps({
    "started": started["status"],
    "healthy": live["collector_healthy"],
    "stopped": stopped["session"]["state"],
}))
store.close()
`;
  const pythonRoot = path.join(tempRoot, 'python');
  const result = spawnSync(python, ['-c', pythonScript, pythonRoot], {
    cwd: PY,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, PYTHONPATH: PY },
  });
  assert(result.status === 0, `Python collector failed: ${result.stderr}`);
  const pythonResult = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert(
    pythonResult.started === 'success' &&
      pythonResult.healthy === true &&
      pythonResult.stopped === 'stopped',
    `Python collector lifecycle failed: ${JSON.stringify(pythonResult)}`,
  );

  process.stdout.write(
    'Show-and-Tell smoke passed: TypeScript worker, Python worker, heartbeats, and clean stop.\n',
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
