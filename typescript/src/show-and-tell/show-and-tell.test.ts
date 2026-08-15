import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ShowAndTellAgent } from '../agents/ShowAndTellAgent.js';
import type { LLMProvider, Message } from '../providers/types.js';
import {
  buildDeterministicAnalysis,
  artifactContainsSensitiveText,
  isPrivateContext,
  safeComputerActionData,
  privacyReducedUrl,
  ShowAndTellStore,
  SHOW_AND_TELL_ANALYSIS_SCHEMA,
  SHOW_AND_TELL_SCHEMA,
  reviseAnalysis,
  runShowAndTellCollector,
  spawnShowAndTellCollector,
} from './index.js';

const roots: string[] = [];
const originalSkills = process.env.OPENRAPPTER_SKILLS_DIR;
const originalAutomations = process.env.OPENRAPPTER_AUTOMATIONS_DIR;

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'openrappter-show-'));
  roots.push(root);
  return root;
}

async function seedConsent(
  store: ShowAndTellStore,
  purpose: 'start' | 'capture' | 'analyze' | 'approve' | 'delete',
): Promise<string> {
  await store.initialize();
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  const database = (
    store as unknown as {
      database(): {
        prepare(sql: string): {
          run(...params: unknown[]): unknown;
        };
      };
    }
  ).database();
  database
    .prepare(
      'INSERT INTO show_consents(token_hash, purpose, issued_at, expires_at) VALUES (?, ?, ?, ?)',
    )
    .run(
      createHash('sha256').update(token).digest('hex'),
      purpose,
      now,
      now + 60_000,
    );
  return token;
}

afterEach(() => {
  if (originalSkills === undefined) delete process.env.OPENRAPPTER_SKILLS_DIR;
  else process.env.OPENRAPPTER_SKILLS_DIR = originalSkills;
  if (originalAutomations === undefined) {
    delete process.env.OPENRAPPTER_AUTOMATIONS_DIR;
  } else {
    process.env.OPENRAPPTER_AUTOMATIONS_DIR = originalAutomations;
  }
});

describe('ShowAndTellStore', () => {
  it.skipIf(process.platform === 'win32')(
    'rejects a symlinked database before SQLite can follow it',
    async () => {
      const root = tempRoot();
      const target = path.join(root, 'outside.db');
      writeFileSync(target, 'do not overwrite');
      symlinkSync(target, path.join(root, 'show-and-tell.db'));
      const store = new ShowAndTellStore(root);
      await expect(store.initialize()).rejects.toThrow(/regular file/);
      expect(readFileSync(target, 'utf8')).toBe('do not overwrite');
    },
  );

  it('uses one versioned cross-runtime session contract', async () => {
    const root = tempRoot();
    const store = new ShowAndTellStore(root);
    const session = await store.createSession({ intentHint: 'Submit an expense report' });
    expect(session.schema).toBe(SHOW_AND_TELL_SCHEMA);
    expect(session.state).toBe('recording');
    expect(session.captureMode).toBe('context');
    store.close();

    const contract = JSON.parse(
      readFileSync(
        path.resolve(import.meta.dirname, '../../../contracts/show-and-tell-v1.json'),
        'utf8',
      ),
    ) as { session: { schema: string } };
    expect(contract.session.schema).toBe(SHOW_AND_TELL_SCHEMA);
  });

  describe('Show-and-Tell collector ownership', () => {
    it('does not let a second collector replace the attached owner', async () => {
      const store = new ShowAndTellStore(tempRoot());
      const session = await store.createSession();
      expect(
        await store.attachCollector(session.id, 'typescript', 101, 'first'),
      ).toBe(true);
      expect(
        await store.attachCollector(session.id, 'python', 202, 'second'),
      ).toBe(false);
      expect(await store.getSession(session.id)).toMatchObject({
        collectorRuntime: 'typescript',
        collectorPid: 101,
        collectorNonce: 'first',
      });
      store.close();
    });

    it('reports an executable launch failure without crashing the host', async () => {
      const priorPath = process.env.PATH;
      process.env.PATH = '';
      try {
        await expect(
          spawnShowAndTellCollector(tempRoot(), 'missing-session'),
        ).rejects.toThrow(/could not start/);
      } finally {
        if (priorPath === undefined) delete process.env.PATH;
        else process.env.PATH = priorPath;
      }
    });

    it('stops when its owning desktop process is gone', async () => {
      const root = tempRoot();
      const store = new ShowAndTellStore(root);
      const session = await store.createSession({ pollIntervalMs: 60_000 });
      const prior = process.env.OPENRAPPTER_SHOW_TEST_MODE;
      process.env.OPENRAPPTER_SHOW_TEST_MODE = '1';
      try {
        await runShowAndTellCollector(
          root,
          session.id,
          'owner-test',
          2_147_483_647,
        );
        expect((await store.getSession(session.id))?.state).toBe('stopped');
      } finally {
        if (prior === undefined) delete process.env.OPENRAPPTER_SHOW_TEST_MODE;
        else process.env.OPENRAPPTER_SHOW_TEST_MODE = prior;
        store.close();
      }
    });

    it('finalizes even when the terminal telemetry event cannot be written', async () => {
      const root = tempRoot();
      const store = new ShowAndTellStore(root);
      const session = await store.createSession({ pollIntervalMs: 60_000 });
      const original = ShowAndTellStore.prototype.appendEvent;
      const append = vi
        .spyOn(ShowAndTellStore.prototype, 'appendEvent')
        .mockImplementation(async function (
          this: ShowAndTellStore,
          ...args: Parameters<typeof original>
        ) {
          if (args[1] === 'collector.stopped') {
            throw new Error('simulated terminal event contention');
          }
          return original.apply(this, args);
        });
      try {
        await runShowAndTellCollector(
          root,
          session.id,
          'finalization-test',
          2_147_483_647,
        );
        expect((await store.getSession(session.id))?.state).toBe('stopped');
      } finally {
        append.mockRestore();
        store.close();
      }
    });

    it('recovers a session whose collector process has died', async () => {
      const store = new ShowAndTellStore(tempRoot());
      const session = await store.createSession();
      await store.attachCollector(
        session.id,
        'typescript',
        2_147_483_647,
        'dead-collector',
      );
      const agent = new ShowAndTellAgent({ store, localSurface: true });
      const status = JSON.parse(await agent.perform({
        action: 'status',
        session_id: session.id,
      }));
      expect(status.session.state).toBe('failed');
      expect(status.collector_healthy).toBe(true);
      expect(status.session.lastError).toMatch(/process exited/);
      store.close();
    });
  });

  it('consumes local consent exactly once', async () => {
    const store = new ShowAndTellStore(tempRoot());
    const token = await seedConsent(store, 'start');
    expect(await store.consumeConsent(token, 'start')).toBe(true);
    expect(await store.consumeConsent(token, 'start')).toBe(false);
    store.close();
  });

  it('allocates unique ordered events across independent store instances', async () => {
    const root = tempRoot();
    const first = new ShowAndTellStore(root);
    const second = new ShowAndTellStore(root);
    const session = await first.createSession();
    const events = await Promise.all([
      first.appendEvent(session.id, 'session.note', 'test', { note: 'one' }),
      second.appendEvent(session.id, 'session.note', 'test', { note: 'two' }),
    ]);
    expect(new Set(events.map((event) => event.sequence)).size).toBe(2);
    expect((await first.events(session.id)).map((event) => event.sequence)).toEqual([0, 1]);
    first.close();
    second.close();
  });

  it('marks an abandoned collector session failed instead of starting a duplicate', async () => {
    const store = new ShowAndTellStore(tempRoot());
    const session = await store.createSession();
    (
      store as unknown as {
        database(): {
          prepare(sql: string): { run(...params: unknown[]): unknown };
        };
      }
    ).database()
      .prepare('UPDATE show_sessions SET started_at = 0 WHERE id = ?')
      .run(session.id);
    expect(await store.recoverStaleSessions(1)).toBe(1);
    expect((await store.getSession(session.id))?.state).toBe('failed');
    const replacement = await store.createSession();
    expect(replacement.id).not.toBe(session.id);
    store.close();
  });

  it('does not recover a healthy 60-second polling session as stale', async () => {
    const store = new ShowAndTellStore(tempRoot());
    const session = await store.createSession({ pollIntervalMs: 60_000 });
    await store.attachCollector(session.id, 'typescript', 42, 'nonce');
    expect(await store.recoverStaleSessions()).toBe(0);
    expect((await store.getSession(session.id))?.state).toBe('recording');
    store.close();
  });

  it('allows only one active session across concurrent store instances', async () => {
    const root = tempRoot();
    const first = new ShowAndTellStore(root);
    const second = new ShowAndTellStore(root);
    const results = await Promise.allSettled([
      first.createSession({ intentHint: 'first' }),
      second.createSession({ intentHint: 'second' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await first.listSessions()).filter((session) =>
      session.state === 'recording' || session.state === 'stopping')).toHaveLength(1);
    first.close();
    second.close();
  });
});

describe('ShowAndTellAgent', () => {
  it('keeps private recording details off the model-callable surface', async () => {
    const store = new ShowAndTellStore(tempRoot());
    const session = await store.createSession({
      title: 'Confidential launch',
      intentHint: 'Do not send this private workflow to a model',
    });
    await store.finishSession(session.id, 'stopped');
    const agent = new ShowAndTellAgent({
      store,
      localSurface: false,
      spawnCollector: () => ({ pid: 42, nonce: 'nonce', verify: false }),
    });
    const status = JSON.parse(
      await agent.perform({ action: 'status', session_id: session.id }),
    );
    expect(JSON.stringify(status)).not.toContain('Confidential launch');
    expect(JSON.stringify(status)).not.toContain('private workflow');
    const denied = JSON.parse(
      await agent.perform({ action: 'analyze', session_id: session.id }),
    );
    expect(denied.code).toBe('local_surface_required');
    store.close();
  });

  it('cannot start recording without interactive local consent', async () => {
    const agent = new ShowAndTellAgent({
      root: tempRoot(),
      spawnCollector: () => ({ pid: 42, nonce: 'nonce', verify: false }),
    });
    const result = JSON.parse(await agent.perform({ action: 'start' }));
    expect(result.status).toBe('error');
    expect(result.code).toBe('local_consent_required');
  });

  it('records notes, analyzes, locally approves, and builds both portable artifacts', async () => {
    const root = tempRoot();
    const skillRoot = path.join(root, 'skills');
    const automationRoot = path.join(root, 'automations');
    process.env.OPENRAPPTER_SKILLS_DIR = skillRoot;
    process.env.OPENRAPPTER_AUTOMATIONS_DIR = automationRoot;

    const store = new ShowAndTellStore(root);
    const startToken = await seedConsent(store, 'start');
    const agent = new ShowAndTellAgent({
      root,
      spawnCollector: () => ({
        pid: 42,
        nonce: 'collector-nonce',
        verify: false,
      }),
    });
    const started = JSON.parse(
      await agent.perform({
        action: 'start',
        intent: 'Create a weekly project status report',
        consent_token: startToken,
      }),
    );
    const sessionId = started.session.id as string;

    await agent.perform({
      action: 'observe',
      session_id: sessionId,
      title: 'Collect project updates',
      detail: 'Gathered the completed work, blockers, and next steps.',
      app: 'Terminal',
    });
    await agent.perform({
      action: 'note',
      session_id: sessionId,
      note: 'The report should be concise and ready to send to the team.',
    });
    await store.finishSession(sessionId, 'stopped');

    const analyzed = JSON.parse(
      await agent.perform({ action: 'analyze', session_id: sessionId }),
    );
    expect(analyzed.analysis.schema).toBe(SHOW_AND_TELL_ANALYSIS_SCHEMA);
    expect(analyzed.analysis.steps).toHaveLength(1);
    expect(analyzed.analysis.approved).toBe(false);

    const denied = JSON.parse(
      await agent.perform({
        action: 'review',
        session_id: sessionId,
        approve: true,
      }),
    );
    expect(denied.code).toBe('local_approval_required');

    const approvalToken = await seedConsent(store, 'approve');
    const approved = JSON.parse(
      await agent.perform({
        action: 'review',
        session_id: sessionId,
        approve: true,
        consent_token: approvalToken,
      }),
    );
    expect(approved.analysis.approved).toBe(true);

    const built = JSON.parse(
      await agent.perform({
        action: 'build',
        session_id: sessionId,
        target: 'all',
      }),
    );
    expect(built.artifacts.map((artifact: { kind: string }) => artifact.kind)).toEqual([
      'skill',
      'automation',
    ]);
    expect(readFileSync(built.artifacts[0].path, 'utf8')).toContain(
      'Prefer a native API, CLI, filesystem, or browser tool',
    );
    const automation = JSON.parse(readFileSync(built.artifacts[1].path, 'utf8'));
    expect(automation.enabled).toBe(false);

    const tested = JSON.parse(
      await agent.perform({ action: 'test', session_id: sessionId }),
    );
    expect(tested.status).toBe('success');
    expect(tested.ok).toBe(true);
    const secondApprovalToken = await seedConsent(store, 'approve');
    const revised = JSON.parse(
      await agent.perform({
        action: 'review',
        session_id: sessionId,
        intent: 'Create a revised weekly project status report',
        approve: true,
        consent_token: secondApprovalToken,
      }),
    );
    expect(revised.analysis.revision).toBeGreaterThan(
      analyzed.analysis.revision,
    );
    const stale = JSON.parse(
      await agent.perform({ action: 'test', session_id: sessionId }),
    );
    expect(stale.status).toBe('error');
    expect(
      stale.checks.some(
        (check: { name: string; ok: boolean }) =>
          check.name.endsWith('-analysis-revision') && check.ok === false,
      ),
    ).toBe(true);
    const rebuilt = JSON.parse(
      await agent.perform({
        action: 'build',
        session_id: sessionId,
        target: 'all',
      }),
    );
    expect(rebuilt.status).toBe('success');
    expect((await store.artifacts(sessionId)).filter(
      (artifact) => artifact.kind === 'skill')).toHaveLength(1);

    writeFileSync(
      path.join(path.dirname(built.artifacts[0].path), 'manifest.json'),
      JSON.stringify({ sourceSessionId: 'other-session', name: 'tampered' }),
    );
    const tampered = JSON.parse(
      await agent.perform({ action: 'test', session_id: sessionId }),
    );
    expect(tampered.status).toBe('error');
    expect(
      tampered.checks.find((check: { name: string }) =>
        check.name === 'skill-manifest').ok,
    ).toBe(false);
    store.close();
  });

  it('refuses an explicit screenshot while a private window is active', async () => {
    const root = tempRoot();
    const store = new ShowAndTellStore(root);
    const session = await store.createSession();
    let captured = false;
    const agent = new ShowAndTellAgent({
      root,
      spawnCollector: () => ({
        pid: 42,
        nonce: 'collector-nonce',
        verify: false,
      }),
      readContext: async () => ({
        app: '1Password',
        window: 'Sign in',
        privateContext: true,
      }),
      captureFrame: async () => {
        captured = true;
      },
    });
    const captureToken = await seedConsent(store, 'capture');
    const result = JSON.parse(
      await agent.perform({
        action: 'capture',
        session_id: session.id,
        consent_token: captureToken,
      }),
    );
    expect(result.status).toBe('error');
    expect(result.code).toBe('private_context');
    expect(captured).toBe(false);
    store.close();
  });

  it('deletes a frame when the active window changes during capture', async () => {
    const root = tempRoot();
    const store = new ShowAndTellStore(root);
    const session = await store.createSession();
    const contexts = [
      {
        app: 'Browser',
        window: 'Expected window',
        windowId: 'one',
        x: 0,
        y: 0,
        width: 800,
        height: 600,
      },
      {
        app: 'Browser',
        window: 'Different window',
        windowId: 'two',
        x: 0,
        y: 0,
        width: 800,
        height: 600,
      },
    ];
    let frame = '';
    const agent = new ShowAndTellAgent({
      root,
      spawnCollector: () => ({ pid: 42, nonce: 'nonce', verify: false }),
      readContext: async () => contexts.shift()!,
      captureFrame: async (file) => {
        frame = file;
        writeFileSync(file, 'frame');
      },
    });
    const token = await seedConsent(store, 'capture');
    const result = JSON.parse(
      await agent.perform({
        action: 'capture',
        session_id: session.id,
        consent_token: token,
      }),
    );
    expect(result.code).toBe('window_changed');
    expect(existsSync(frame)).toBe(false);
    store.close();
  });

  it('deletes a frame when the page becomes sign-in-related during capture', async () => {
    const root = tempRoot();
    const store = new ShowAndTellStore(root);
    const session = await store.createSession();
    const contexts = [
      {
        app: 'Safari',
        window: 'Google Accounts',
        windowId: 'one',
        url: 'https://accounts.example.com/home',
      },
      {
        app: 'Safari',
        window: 'Google Accounts',
        windowId: 'one',
        url: 'https://accounts.example.com/signin/oauth',
      },
    ];
    let frame = '';
    const agent = new ShowAndTellAgent({
      root,
      spawnCollector: () => ({ pid: 42, nonce: 'nonce', verify: false }),
      readContext: async () => contexts.shift()!,
      captureFrame: async (file) => {
        frame = file;
        writeFileSync(file, 'frame');
      },
    });
    const token = await seedConsent(store, 'capture');
    const result = JSON.parse(await agent.perform({
      action: 'capture',
      session_id: session.id,
      consent_token: token,
    }));
    expect(result.code).toBe('private_context');
    expect(existsSync(frame)).toBe(false);
    store.close();
  });

  it('keeps successful frame paths out of model-visible results', async () => {
    const root = tempRoot();
    const store = new ShowAndTellStore(root);
    const session = await store.createSession();
    const context = {
      app: 'Browser',
      window: 'Public documentation',
      windowId: 'one',
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    };
    const agent = new ShowAndTellAgent({
      root,
      spawnCollector: () => ({ pid: 42, nonce: 'nonce', verify: false }),
      readContext: async () => context,
      captureFrame: async (file) => {
        writeFileSync(file, 'frame');
      },
    });
    const token = await seedConsent(store, 'capture');
    const result = JSON.parse(
      await agent.perform({
        action: 'capture',
        session_id: session.id,
        title: 'Public docs',
        consent_token: token,
      }),
    );
    expect(result).toEqual({
      status: 'success',
      action: 'capture',
      session_id: session.id,
      captured: true,
      label: 'Public docs',
    });
    expect(JSON.stringify(result)).not.toContain('frames/');
    store.close();
  });

  it('requires separate consent before Copilot sees the textual summary', async () => {
    const root = tempRoot();
    const store = new ShowAndTellStore(root);
    const session = await store.createSession({
      intentHint: 'Document a release workflow',
    });
    await store.appendEvent(session.id, 'session.note', 'test', {
      note: 'Tag the release after the checks pass.',
    });
    await store.appendEvent(session.id, 'frame.captured', 'test', {
      file: 'frames/private-local-frame.png',
      label: 'Release page',
    });
    await store.finishSession(session.id, 'stopped');

    let messages: Message[] = [];
    const provider: LLMProvider = {
      id: 'test',
      name: 'test',
      async isAvailable() {
        return true;
      },
      async chat(input) {
        messages = input;
        return {
          content: JSON.stringify({
            title: 'Publish a release',
            intent: 'Publish a verified release',
            intentRationale: 'The note says to tag only after checks pass.',
            intentConfidence: 'high',
            steps: [
              {
                id: 's1',
                title: 'Verify checks',
                detail: 'Confirm the release checks pass.',
                kind: 'calculation',
                tool: 'GitHub',
                app: '',
                url: '',
                evidence: ['event:1:session.note'],
                confidence: 'high',
              },
            ],
          }),
          tool_calls: null,
        };
      },
    };
    const agent = new ShowAndTellAgent({
      root,
      provider,
      spawnCollector: () => ({ pid: 42, nonce: 'nonce', verify: false }),
    });

    const denied = JSON.parse(
      await agent.perform({
        action: 'analyze',
        session_id: session.id,
        enhance: true,
      }),
    );
    expect(denied.code).toBe('local_analysis_consent_required');
    expect(messages).toEqual([]);

    const token = await seedConsent(store, 'analyze');
    const enhanced = JSON.parse(
      await agent.perform({
        action: 'analyze',
        session_id: session.id,
        enhance: true,
        consent_token: token,
      }),
    );
    expect(enhanced.enhanced).toBe(true);
    expect(messages[0].content).toContain('Raw\nscreenshots are intentionally not provided');
    expect(messages[0].content).not.toContain('private-local-frame.png');
    store.close();
  });
});

describe('show-and-tell privacy and analysis', () => {
  it('keeps only HTTP destinations and hides opaque path tokens', () => {
    expect(privacyReducedUrl('file:///Users/alice/SecretPlans.docx')).toBe('');
    expect(privacyReducedUrl('javascript:alert(1)')).toBe('');
    expect(
      privacyReducedUrl(
        'https://example.com/reset/dGVzdC11c2VyLWludml0ZS10b2tlbg?token=secret',
      ),
    ).toBe('https://example.com/reset/:id');
    const jwt = [
      'eyJhbGciOiJIUzI1NiJ9',
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    ].join('.');
    expect(
      privacyReducedUrl(`https://example.com/callback/${jwt}`),
    ).toBe('https://example.com/callback/:id');
    expect(
      privacyReducedUrl(
        `https://example.com/callback/${jwt.replaceAll('.', '%2E')}`,
      ),
    ).toBe('https://example.com/callback/:id');
    expect(artifactContainsSensitiveText(JSON.stringify({ url: jwt }))).toBe(true);
    expect(isPrivateContext('Safari', 'Google Accounts', '/signin/oauth')).toBe(true);
    expect(isPrivateContext('Google Chrome', 'New Incognito Tab')).toBe(true);
    expect(isPrivateContext('Microsoft Edge', 'InPrivate browsing')).toBe(true);
    expect(isPrivateContext('Safari', 'Private Browsing')).toBe(true);
  });

  it('never persists text typed through ComputerUse', () => {
    const data = safeComputerActionData('type', {
      text: 'ghp_this_would_be_a_secret_token',
    });
    expect(data).toEqual({
      action: 'type',
      textLength: 32,
      textStored: false,
    });
    expect(JSON.stringify(data)).not.toContain('ghp_');
    expect(
      safeComputerActionData('key', { text: 'private recovery phrase' }),
    ).toEqual({
      action: 'key',
      keyLength: 23,
      keyStored: false,
    });
    expect(safeComputerActionData('key', { text: 'cmd+c' })).toEqual({
      action: 'key',
      key: 'cmd+c',
    });
  });

  it('uses narration as procedural evidence instead of discarding it', () => {
    const now = Date.now();
    const analysis = buildDeterministicAnalysis(
      {
        schema: SHOW_AND_TELL_SCHEMA,
        id: 'narrated-session',
        state: 'stopped',
        title: '',
        intentHint: 'Prepare the weekly update',
        captureMode: 'context',
        createdAt: now,
        startedAt: now,
        stoppedAt: now,
        updatedAt: now,
        collectorRuntime: null,
        collectorPid: null,
        collectorNonce: null,
        collectorStartedAt: null,
        collectorHeartbeatAt: null,
        stopRequestedAt: now,
        maxDurationMs: 60_000,
        pollIntervalMs: 2_000,
        lastError: null,
      },
      [{
        id: 'note-1',
        sessionId: 'narrated-session',
        sequence: 0,
        timestamp: now,
        type: 'narration.transcribed',
        source: 'local-whisper',
        data: { text: 'Summarize blockers before listing next steps.' },
      }],
    );
    expect(analysis.steps[0].title).toBe('Follow the narrated instruction');
    expect(analysis.steps[0].detail).toContain('Summarize blockers');
    expect(analysis.steps[0].evidence).toContain(
      'event:0:narration.transcribed',
    );
  });

  it('privacy-reduces reviewed step URLs before persistence', () => {
    const now = Date.now();
    const revised = reviseAnalysis(
      {
        schema: SHOW_AND_TELL_ANALYSIS_SCHEMA,
        sessionId: 'session-1',
        revision: 1,
        title: 'Research',
        intent: 'Research safely',
        intentRationale: 'Test',
        intentConfidence: 'high',
        steps: [{
          id: 's1',
          title: 'Search',
          detail: 'Search for the report.',
          kind: 'action',
          tool: 'Browser or Web',
          app: 'Safari',
          url: 'https://example.com/start',
          evidence: [],
          confidence: 'high',
        }],
        feedbackLog: [],
        approved: false,
        approvedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        stepsJson: JSON.stringify([{
          id: 's1',
          title: 'Search',
          detail: 'Search for the report.',
          kind: 'action',
          tool: 'Browser or Web',
          app: 'Safari',
          url: 'https://example.com/search?q=confidential#private',
          evidence: [],
          confidence: 'high',
        }]),
      },
    );
    expect(revised.steps[0].url).toBe('https://example.com/search');
  });

  it('builds a useful deterministic baseline without sending frames to a model', () => {
    const now = Date.now();
    const analysis = buildDeterministicAnalysis(
      {
        schema: SHOW_AND_TELL_SCHEMA,
        id: 'session-1',
        state: 'stopped',
        title: '',
        intentHint: 'Research an article and save the useful link',
        captureMode: 'context',
        createdAt: now,
        startedAt: now,
        stoppedAt: now,
        updatedAt: now,
        collectorRuntime: null,
        collectorPid: null,
        collectorNonce: null,
        collectorStartedAt: null,
        collectorHeartbeatAt: null,
        stopRequestedAt: now,
        maxDurationMs: 60_000,
        pollIntervalMs: 2_000,
        lastError: null,
      },
      [
        {
          id: 'e1',
          sessionId: 'session-1',
          sequence: 0,
          timestamp: now,
          type: 'browser.url',
          source: 'test',
          data: { app: 'Safari', url: 'https://example.com/articles/:id' },
        },
        {
          id: 'e2',
          sessionId: 'session-1',
          sequence: 1,
          timestamp: now,
          type: 'frame.captured',
          source: 'test',
          data: { file: 'frames/frame.png' },
        },
        {
          id: 'e3',
          sessionId: 'session-1',
          sequence: 2,
          timestamp: now,
          type: 'computer.action',
          source: 'test',
          data: { action: 'click', status: 'error' },
        },
      ],
    );
    expect(analysis.intent).toContain('Research an article');
    expect(analysis.steps).toHaveLength(1);
    expect(analysis.steps[0].tool).toBe('Browser or Web');
  });
});
