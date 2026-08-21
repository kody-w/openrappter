/**
 * Deterministic evaluation of the recorder pipeline.
 *
 * The scenarios live in `contracts/show-and-tell-scenarios-v1.json` because
 * Python replays exactly the same ones in `python/tests/test_show_and_tell_skill.py`.
 * A number that only one runtime produces is drift, and the shared file is
 * what makes that visible instead of leaving each suite to agree with itself.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ShowAndTellAgent } from '../agents/ShowAndTellAgent.js';
import { buildDeterministicAnalysis } from './analyzer.js';
import { buildSessionBundle } from './bundle.js';
import { buildSkillPlan, revisePlan } from './plan.js';
import {
  maskSensitivePayload,
  maskSensitiveText,
  privacyReducedPath,
  scanSensitivePayload,
  SENSITIVE_MASK,
} from './privacy.js';
import {
  MARKETPLACE_ATTRIBUTION,
  renderMarketplaceExport,
  validateMarketplaceExport,
  writeMarketplaceExport,
} from './marketplace.js';
import { resetSessionClock, sessionElapsedMs } from './clock.js';
import { ShowAndTellStore } from './store.js';
import {
  SHOW_AND_TELL_PLAN_SCHEMA,
  SHOW_AND_TELL_SCHEMA,
  type ShowAndTellAnalysis,
  type ShowAndTellEvent,
  type ShowAndTellSession,
  type ShowAndTellSessionBundle,
  type ShowAndTellSkillPlan,
} from './types.js';

interface ScenarioEvent {
  type: string;
  source: string;
  elapsedMs: number;
  data: Record<string, unknown>;
}

interface Scenario {
  id: string;
  title: string;
  intentHint: string;
  events: ScenarioEvent[];
  expect: {
    analysisStepIds: string[];
    bundle: Record<string, unknown>;
    plan: Record<string, unknown>;
  };
}

interface ScenarioContract {
  schema: string;
  session: {
    id: string;
    startedAt: number;
    maxDurationMs: number;
    pollIntervalMs: number;
  };
  scenarios: Scenario[];
  marketplace: {
    files: string[];
    descriptionMarkers: string[];
    forbiddenClaims: string[];
  };
}

const contract = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, '../../../contracts/show-and-tell-scenarios-v1.json'),
    'utf8',
  ),
) as ScenarioContract;

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'openrappter-skill-recorder-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

async function seedConsent(
  store: ShowAndTellStore,
  purpose: 'start' | 'approve',
): Promise<string> {
  await store.initialize();
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  (
    store as unknown as {
      database(): {
        prepare(sql: string): { run(...params: unknown[]): unknown };
      };
    }
  )
    .database()
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

function scenarioSession(scenario: Scenario): ShowAndTellSession {
  const base = contract.session;
  return {
    schema: SHOW_AND_TELL_SCHEMA,
    id: base.id,
    state: 'stopped',
    title: '',
    intentHint: scenario.intentHint,
    captureMode: 'context',
    createdAt: base.startedAt,
    startedAt: base.startedAt,
    stoppedAt: base.startedAt + 60_000,
    updatedAt: base.startedAt + 60_000,
    collectorRuntime: null,
    collectorPid: null,
    collectorNonce: null,
    collectorStartedAt: null,
    collectorHeartbeatAt: null,
    stopRequestedAt: null,
    maxDurationMs: base.maxDurationMs,
    pollIntervalMs: base.pollIntervalMs,
    lastError: null,
  };
}

function scenarioEvents(scenario: Scenario): ShowAndTellEvent[] {
  return scenario.events.map((event, index) => ({
    id: `e${index}`,
    sessionId: contract.session.id,
    sequence: index,
    timestamp: contract.session.startedAt + event.elapsedMs,
    elapsedMs: event.elapsedMs,
    type: event.type,
    source: event.source,
    data: event.data,
  }));
}

function replay(scenario: Scenario): {
  analysis: ShowAndTellAnalysis;
  bundle: ShowAndTellSessionBundle;
  plan: ShowAndTellSkillPlan;
} {
  const session = scenarioSession(scenario);
  const events = scenarioEvents(scenario);
  const analysis = buildDeterministicAnalysis(session, events);
  const bundle = buildSessionBundle(session, events);
  const plan = buildSkillPlan(analysis, bundle, { now: 1_700_000_100_000 });
  return { analysis, bundle, plan };
}

function approvedPlan(scenario: Scenario): ShowAndTellSkillPlan {
  const { plan } = replay(scenario);
  return revisePlan(plan, { approve: true }, 1_700_000_200_000);
}

describe('Show-and-Tell monotonic event timing', () => {
  it('keeps elapsed time moving forward when the wall clock jumps back', () => {
    resetSessionClock('clock-test');
    const startedAt = 1_000_000;
    const first = sessionElapsedMs('clock-test', startedAt, startedAt + 5_000, 100);
    const second = sessionElapsedMs('clock-test', startedAt, startedAt - 60_000, 900);
    expect(first).toBe(5_000);
    expect(second).toBe(5_800);
    expect(second).toBeGreaterThan(first);
    resetSessionClock('clock-test');
  });

  it('records sequence, epoch time, and monotonic elapsed time on every event', async () => {
    const store = new ShowAndTellStore(tempRoot());
    const session = await store.createSession({ intentHint: 'timing' });
    const first = await store.appendEvent(session.id, 'session.note', 'test', {
      note: 'one',
    });
    const second = await store.appendEvent(session.id, 'session.note', 'test', {
      note: 'two',
    });
    expect([first.sequence, second.sequence]).toEqual([0, 1]);
    expect(first.timestamp).toBeGreaterThan(0);
    expect(typeof first.elapsedMs).toBe('number');
    expect(second.elapsedMs).toBeGreaterThanOrEqual(first.elapsedMs as number);
    const stored = await store.events(session.id);
    expect(stored.map((event) => event.elapsedMs)).toEqual([
      first.elapsedMs,
      second.elapsedMs,
    ]);
    store.close();
  });

  it('adds elapsed timing to a database written before the column existed', async () => {
    const root = tempRoot();
    const store = new ShowAndTellStore(root);
    await store.initialize();
    const database = (
      store as unknown as {
        database(): { exec(sql: string): void; prepare(sql: string): {
          all(...params: unknown[]): unknown[];
        } };
      }
    ).database();
    database.exec('DROP TABLE show_events');
    database.exec(`
      CREATE TABLE show_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES show_sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        data_json TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      )
    `);
    store.close();

    const reopened = new ShowAndTellStore(root);
    const session = await reopened.createSession({ intentHint: 'migration' });
    const event = await reopened.appendEvent(session.id, 'session.note', 'test', {
      note: 'after migration',
    });
    expect(typeof event.elapsedMs).toBe('number');
    reopened.close();
  });
});

describe.each(contract.scenarios)('Show-and-Tell scenario: $id', (scenario) => {
  it('segments the recording and counts what it could not explain', () => {
    const { analysis, bundle } = replay(scenario);
    expect(analysis.steps.map((step) => step.id)).toEqual(
      scenario.expect.analysisStepIds,
    );
    const expected = scenario.expect.bundle;
    for (const key of [
      'meaningfulEventCount',
      'segmentCount',
      'narratedSegments',
      'silentSegments',
      'detourSegments',
      'silentEvents',
      'unexplainedFrames',
      'longestGapMs',
      'explainedRatioMilli',
    ] as const) {
      expect(
        bundle.stats[key],
        `${scenario.id} bundle.stats.${key}`,
      ).toBe(expected[key]);
    }
    expect(bundle.segments.map((segment) => segment.kind)).toEqual(
      expected.segmentKinds,
    );
    for (const substring of (expected.warningSubstrings as string[] | undefined) ?? []) {
      expect(bundle.warnings.join('\n')).toContain(substring);
    }
  });

  it('proposes a plan whose values, risks, and privacy match the contract', () => {
    const { plan } = replay(scenario);
    const expected = scenario.expect.plan;
    expect(plan.schema).toBe(SHOW_AND_TELL_PLAN_SCHEMA);
    expect(plan.approved).toBe(false);
    expect(plan.steps.map((step) => step.id)).toEqual(expected.stepIds);
    expect(plan.values.map((value) => value.id)).toEqual(expected.valueIds);
    expect(
      plan.steps.filter((step) => step.requiresConfirmation).map((step) => step.id),
    ).toEqual(expected.confirmationStepIds);
    expect([...new Set(plan.privacy.findings.map((finding) => finding.kind))].sort()).toEqual(
      expected.privacyKinds,
    );

    for (const [id, detail] of Object.entries(
      (expected.stepDetails as Record<string, string> | undefined) ?? {},
    )) {
      expect(plan.steps.find((step) => step.id === id)?.detail).toBe(detail);
    }
    for (const [id, url] of Object.entries(
      (expected.stepUrls as Record<string, string> | undefined) ?? {},
    )) {
      expect(plan.steps.find((step) => step.id === id)?.url).toBe(url);
    }
    for (const [id, example] of Object.entries(
      (expected.valueExamples as Record<string, string> | undefined) ?? {},
    )) {
      expect(plan.values.find((value) => value.id === id)?.example).toBe(example);
    }
    for (const [id, categories] of Object.entries(
      (expected.stepRiskCategories as Record<string, string[]> | undefined) ?? {},
    )) {
      expect(plan.steps.find((step) => step.id === id)?.riskCategories).toEqual(
        categories,
      );
    }
    const serialized = JSON.stringify(plan);
    for (const forbidden of (expected.forbiddenSubstrings as string[] | undefined) ?? []) {
      expect(serialized).not.toContain(forbidden);
    }
    for (const substring of (expected.openQuestionSubstrings as string[] | undefined) ?? []) {
      expect(plan.openQuestions.join('\n')).toContain(substring);
    }
    for (const substring of (expected.doNotUseWhenSubstrings as string[] | undefined) ?? []) {
      expect(plan.doNotUseWhen.join('\n')).toContain(substring);
    }
    if (expected.privacyMasked === true) expect(plan.privacy.masked).toBe(true);
    expect(plan.privacy.rawFramesShared).toBe(false);
  });

  it('produces the same plan twice from the same events', () => {
    const first = replay(scenario).plan;
    const second = replay(scenario).plan;
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe('Show-and-Tell sensitive scanning', () => {
  it('masks at a fixed width so the hidden length cannot be read off', () => {
    const prefix = `${'gh'}${'p_'}`;
    const short = maskSensitiveText(
      `token ${prefix}${'ABCDEFGHIJKLMNOPQRSTUV'}${'0123'} done`,
    );
    const long = maskSensitiveText(
      `token ${prefix}${'ABCDEFGHIJKLMNOPQRSTUV'}${'0123456789'}${'ABCDEFGHIJ'} done`,
    );
    expect(short).toBe(`token ${SENSITIVE_MASK} done`);
    expect(long).toBe(short);
  });

  it('walks a whole nested payload and reports each finding by path', () => {
    const findings = scanSensitivePayload({
      steps: [
        { detail: 'wrote to dana.reed@example.com' },
        { nested: { deeper: ['member 123-45-6789'] } },
      ],
    });
    expect(findings).toEqual([
      { path: '$.steps[0].detail', kind: 'email', count: 1 },
      { path: '$.steps[1].nested.deeper[0]', kind: 'government-id', count: 1 },
    ]);
  });

  it('reports an unscanned subtree instead of skipping it silently', () => {
    let payload: Record<string, unknown> = { leaf: 'ok' };
    for (let depth = 0; depth < 20; depth += 1) payload = { nested: payload };
    const findings = scanSensitivePayload(payload);
    expect(findings.some((finding) => finding.kind === 'unscanned')).toBe(true);
  });

  it('masks the payload it scans without altering its shape', () => {
    const { value, findings } = maskSensitivePayload({
      contact: { email: 'dana.reed@example.com' },
      count: 3,
    });
    expect(value).toEqual({ contact: { email: SENSITIVE_MASK }, count: 3 });
    expect(findings).toEqual([
      { path: '$.contact.email', kind: 'email', count: 1 },
    ]);
  });
});

describe('Show-and-Tell plan review', () => {
  const scenario = contract.scenarios.find((entry) => entry.id === 'hardcoded-values');

  it('never privacy-masks a structural session id that happens to pass Luhn', () => {
    const { analysis, bundle } = replay(scenario as Scenario);
    const sessionId = '20260820-194831-62519e1f';
    expect(
      maskSensitivePayload({ sessionId }).value.sessionId,
      'the control must remain a scanner collision so this test can catch the old bug',
    ).not.toBe(sessionId);

    const plan = buildSkillPlan(
      { ...analysis, sessionId },
      { ...bundle, sessionId },
      { now: 1_700_000_100_000 },
    );
    expect(plan.sessionId).toBe(sessionId);
    expect(plan.privacy.findings.some((finding) => finding.path === '$.sessionId'))
      .toBe(false);
  });

  it('never privacy-masks a structural session id that happens to pass Luhn', () => {
    const { analysis, bundle } = replay(scenario as Scenario);
    const sessionId = '20260820-194831-62519e1f';
    const plan = buildSkillPlan(
      { ...analysis, sessionId },
      { ...bundle, sessionId },
      { now: 1_700_000_100_000 },
    );
    expect(plan.sessionId).toBe(sessionId);
    expect(plan.privacy.findings.some((finding) => finding.path === '$.sessionId'))
      .toBe(false);
  });

  it('refuses to edit and approve in the same turn', () => {
    const { plan } = replay(scenario as Scenario);
    expect(() =>
      revisePlan(plan, {
        approve: true,
        stepsJson: JSON.stringify([
          { id: 's1', title: 'Open the invoice', detail: 'Edited detail.' },
        ]),
      }),
    ).toThrow(/separate turns/);
  });

  it('refuses to rewrite the trigger contract while approving it', () => {
    const { plan } = replay(scenario as Scenario);
    expect(() =>
      revisePlan(plan, {
        approve: true,
        title: 'A title the reviewer did not read',
      }),
    ).toThrow(/separate turns/);
    expect(() =>
      revisePlan(plan, {
        approve: true,
        intent: 'Run for a different class of request',
      }),
    ).toThrow(/separate turns/);
  });

  it('keeps an edited plan unapproved until it is approved on its own', () => {
    const { plan } = replay(scenario as Scenario);
    const edited = revisePlan(plan, {
      stepsJson: JSON.stringify([
        {
          id: 's1',
          title: 'Open the invoice',
          detail: 'Open invoice {{identifier_1}} and delete the draft.',
        },
      ]),
      feedback: 'Only one step is needed.',
    });
    expect(edited.approved).toBe(false);
    expect(edited.steps).toHaveLength(1);
    expect(edited.steps[0].values).toEqual(['identifier_1']);
    expect(edited.steps[0].requiresConfirmation).toBe(true);
    expect(edited.steps[0].riskCategories).toContain('destructive');
    expect(edited.feedbackLog.at(-1)?.feedback).toBe('Only one step is needed.');

    const approved = revisePlan(edited, { approve: true }, 1_700_000_300_000);
    expect(approved.approved).toBe(true);
    expect(approved.approvedAt).toBe(1_700_000_300_000);
    expect(approved.revision).toBe(edited.revision + 1);
  });

  it('masks personal data a reviewer types into an edit', () => {
    const { plan } = replay(scenario as Scenario);
    const edited = revisePlan(plan, {
      stepsJson: JSON.stringify([
        {
          id: 's1',
          title: 'Open the invoice',
          detail: 'Mail the invoice to dana.reed@example.com every month.',
        },
      ]),
    });
    expect(edited.steps[0].detail).toBe(
      `Mail the invoice to ${SENSITIVE_MASK} every month.`,
    );
    expect(edited.privacy.findings.some((finding) => finding.kind === 'email')).toBe(
      true,
    );
  });

  it('rejects an edited value that names an id the plan never had', () => {
    const { plan } = replay(scenario as Scenario);
    expect(() =>
      revisePlan(plan, {
        valuesJson: JSON.stringify([{ id: 'not_a_value', example: 'x' }]),
      }),
    ).toThrow(/Unknown Show-and-Tell value id/);
  });

  it('reduces local path examples before a generated skill can publish them', () => {
    expect(privacyReducedPath(path.join(os.homedir(), 'Private', 'invoice.pdf')))
      .toBe('~/Private/invoice.pdf');
    expect(privacyReducedPath('/Volumes/Secret/customer/invoice.pdf'))
      .toBe('<absolute>/invoice.pdf');
  });
});

describe('Show-and-Tell marketplace export', () => {
  const scenario = contract.scenarios.find(
    (entry) => entry.id === 'hardcoded-values',
  ) as Scenario;

  it('refuses to render an export from a plan nobody approved', () => {
    const { plan } = replay(scenario);
    expect(() => renderMarketplaceExport({ plan, root: tempRoot() })).toThrow(
      /Approve the Show-and-Tell plan/,
    );
  });

  it('writes the marketplace layout the contract describes', () => {
    const root = tempRoot();
    const exported = writeMarketplaceExport(
      { plan: approvedPlan(scenario), root, pluginName: 'file-the-monthly-invoice' },
      (file, content) => writeFileSync(file, content, { mode: 0o600 }),
    );
    const relative = exported.files.map((file) =>
      path.relative(exported.root, file).split(path.sep).join('/'),
    );
    expect(relative).toEqual(
      contract.marketplace.files.map((entry) =>
        entry
          .replace('{plugin}', exported.pluginName)
          .replace('{skill}', exported.skillName),
      ),
    );

    const marketplace = JSON.parse(readFileSync(exported.marketplacePath, 'utf8')) as {
      plugins: Array<{ name: string; source: string }>;
    };
    expect(marketplace.plugins[0].source).toBe(`./plugins/${exported.pluginName}`);

    const skill = readFileSync(exported.skillPath, 'utf8');
    for (const marker of contract.marketplace.descriptionMarkers) {
      expect(skill).toContain(marker);
    }
    for (const claim of contract.marketplace.forbiddenClaims) {
      expect(skill).not.toContain(claim);
    }
    expect(skill).toContain(MARKETPLACE_ATTRIBUTION);
    expect(skill).toContain('{{identifier_1}}');

    const validation = validateMarketplaceExport(exported.root);
    expect(
      validation.checks.filter((check) => !check.ok),
      'every marketplace check should pass',
    ).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it('keeps a traversal-shaped plugin name inside the export root', () => {
    const root = tempRoot();
    const rendered = renderMarketplaceExport({
      plan: approvedPlan(scenario),
      root,
      pluginName: '../../escape',
    });
    expect(rendered.pluginName).not.toContain('..');
    for (const file of rendered.files) {
      const relative = path.relative(root, file.path);
      expect(relative.startsWith('..')).toBe(false);
      expect(path.isAbsolute(relative)).toBe(false);
    }
  });

  it('fails validation when a skill loses its trigger metadata', () => {
    const root = tempRoot();
    const exported = writeMarketplaceExport(
      { plan: approvedPlan(scenario), root },
      (file, content) => writeFileSync(file, content, { mode: 0o600 }),
    );
    const skill = readFileSync(exported.skillPath, 'utf8').replace(
      /USE WHEN:/,
      'WHEN:',
    );
    writeFileSync(exported.skillPath, skill, { mode: 0o600 });
    const validation = validateMarketplaceExport(exported.root);
    expect(validation.ok).toBe(false);
    expect(
      validation.checks.some(
        (check) => check.name.startsWith('skill-triggers') && !check.ok,
      ),
    ).toBe(true);
  });

  it('refuses to write an export that claims someone else endorsed it', () => {
    const plan = approvedPlan(scenario);
    const claiming: ShowAndTellSkillPlan = {
      ...plan,
      intent: 'File the monthly invoice, official Microsoft workflow',
    };
    expect(() =>
      writeMarketplaceExport(
        { plan: claiming, root: tempRoot() },
        (file, content) => writeFileSync(file, content, { mode: 0o600 }),
      ),
    ).toThrow(/third-party ownership or endorsement/);
  });
});

describe('Show-and-Tell two-phase agent flow', () => {
  async function recordedSession(): Promise<{
    agent: ShowAndTellAgent;
    store: ShowAndTellStore;
    sessionId: string;
    root: string;
  }> {
    const root = tempRoot();
    const store = new ShowAndTellStore(root);
    const startToken = await seedConsent(store, 'start');
    const agent = new ShowAndTellAgent({
      root,
      store,
      spawnCollector: () => ({ pid: 42, nonce: 'collector-nonce', verify: false }),
    });
    const started = JSON.parse(
      await agent.perform({
        action: 'start',
        intent: 'File the monthly invoice',
        consent_token: startToken,
      }),
    ) as { session: { id: string } };
    const sessionId = started.session.id;
    await agent.perform({
      action: 'observe',
      session_id: sessionId,
      title: 'Open the invoice',
      detail: 'Opened invoice INV-10428 for 4,820.00 USD and paid it.',
      app: 'Finance',
    });
    await agent.perform({
      action: 'note',
      session_id: sessionId,
      note: 'The invoice number changes every month.',
    });
    await store.finishSession(sessionId, 'stopped');
    await agent.perform({ action: 'analyze', session_id: sessionId });
    const approvalToken = await seedConsent(store, 'approve');
    await agent.perform({
      action: 'review',
      session_id: sessionId,
      approve: true,
      consent_token: approvalToken,
    });
    return { agent, store, sessionId, root };
  }

  it('returns the session bundle with its honesty stats', async () => {
    const { agent, store, sessionId } = await recordedSession();
    const result = JSON.parse(
      await agent.perform({ action: 'bundle', session_id: sessionId }),
    );
    expect(result.status).toBe('success');
    expect(result.bundle.stats.meaningfulEventCount).toBeGreaterThan(0);
    expect(result.bundle.segments.length).toBeGreaterThan(0);
    store.close();
  });

  it('proposes exactly one plan and builds nothing in that turn', async () => {
    const { agent, store, sessionId } = await recordedSession();
    const proposed = JSON.parse(
      await agent.perform({ action: 'propose', session_id: sessionId }),
    );
    expect(proposed.status).toBe('success');
    expect(proposed.proposal_only).toBe(true);
    expect(proposed.built).toBe(false);
    expect(proposed.artifacts).toBeUndefined();
    expect(proposed.plan.approved).toBe(false);
    expect(proposed.plan.values.map((value: { id: string }) => value.id)).toContain(
      'identifier_1',
    );
    expect(await store.artifacts(sessionId)).toEqual([]);
    store.close();
  });

  it('refuses to build while the proposed plan is unapproved', async () => {
    const { agent, store, sessionId } = await recordedSession();
    await agent.perform({ action: 'propose', session_id: sessionId });
    const built = JSON.parse(
      await agent.perform({ action: 'build', session_id: sessionId, target: 'skill' }),
    );
    expect(built.status).toBe('error');
    expect(built.code).toBe('plan_not_approved');
    expect(await store.artifacts(sessionId)).toEqual([]);
    store.close();
  });

  it('requires a local consent token to approve the plan', async () => {
    const { agent, store, sessionId } = await recordedSession();
    await agent.perform({ action: 'propose', session_id: sessionId });
    const denied = JSON.parse(
      await agent.perform({
        action: 'revise_plan',
        session_id: sessionId,
        approve: true,
      }),
    );
    expect(denied.status).toBe('error');
    expect(denied.code).toBe('local_approval_required');
    expect((await store.getPlan(sessionId))?.approved).toBe(false);
    store.close();
  });

  it('builds a templated skill and offers it as a RAPPID dimension without attaching it', async () => {
    const { agent, store, sessionId } = await recordedSession();
    await agent.perform({ action: 'propose', session_id: sessionId });
    const planToken = await seedConsent(store, 'approve');
    const approved = JSON.parse(
      await agent.perform({
        action: 'revise_plan',
        session_id: sessionId,
        approve: true,
        consent_token: planToken,
      }),
    );
    expect(approved.plan.approved).toBe(true);

    const built = JSON.parse(
      await agent.perform({
        action: 'build',
        session_id: sessionId,
        target: 'rappid',
      }),
    );
    expect(built.status).toBe('success');
    expect(built.rappid_dimension).toMatchObject({
      kind: 'skill',
      sessionId,
      attached: false,
      privacyScanned: true,
    });
    expect(built.rappid_dimension.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(built.rappid_dimension.artifactPath)).toBe(true);

    const skill = readFileSync(built.rappid_dimension.artifactPath, 'utf8');
    expect(skill).toContain('USE WHEN:');
    expect(skill).toContain('{{identifier_1}}');
    expect(skill).not.toContain('INV-10428 for 4,820.00 USD');
    expect(skill).toContain('Ask for confirmation first');

    const tested = JSON.parse(
      await agent.perform({ action: 'test', session_id: sessionId }),
    );
    expect(
      tested.checks.filter((check: { ok: boolean }) => !check.ok),
      'every artifact check should pass',
    ).toEqual([]);
    store.close();
  });

  it('exports an approved plan to a validated marketplace and publishes nothing', async () => {
    const { agent, store, sessionId } = await recordedSession();
    await agent.perform({ action: 'propose', session_id: sessionId });
    const blocked = JSON.parse(
      await agent.perform({ action: 'export', session_id: sessionId }),
    );
    expect(blocked.code).toBe('plan_not_approved');

    const planToken = await seedConsent(store, 'approve');
    await agent.perform({
      action: 'revise_plan',
      session_id: sessionId,
      approve: true,
      consent_token: planToken,
    });
    const exported = JSON.parse(
      await agent.perform({
        action: 'export',
        session_id: sessionId,
        plugin_name: 'invoice-plugin',
        skill_name: 'invoice-skill',
      }),
    );
    expect(exported.status).toBe('success');
    expect(exported.published).toBe(false);
    expect(exported.marketplace.files).toHaveLength(3);
    for (const file of exported.marketplace.files as string[]) {
      expect(existsSync(file)).toBe(true);
    }
    expect(validateMarketplaceExport(exported.marketplace.root).ok).toBe(true);
    expect(exported.artifact.kind).toBe('marketplace');
    expect(exported.artifact.contentHash).toMatch(/^[0-9a-f]{64}$/);

    await agent.perform({
      action: 'revise_plan',
      session_id: sessionId,
      title: 'File and archive the monthly invoice',
    });
    const tested = JSON.parse(
      await agent.perform({ action: 'test', session_id: sessionId }),
    );
    expect(
      tested.checks.find(
        (check: { name: string; ok: boolean }) =>
          check.name === 'marketplace-integrity',
      )?.ok,
    ).toBe(true);
    expect(
      tested.checks.some(
        (check: { name: string; ok: boolean }) =>
          check.name === 'plan-approved' && !check.ok,
      ),
      'revising after export should mark the plan stale without invalidating the frozen export',
    ).toBe(true);
    store.close();
  });

  it('will not build against an analysis revised after the plan was approved', async () => {
    const { agent, store, sessionId } = await recordedSession();
    await agent.perform({ action: 'propose', session_id: sessionId });
    const planToken = await seedConsent(store, 'approve');
    await agent.perform({
      action: 'revise_plan',
      session_id: sessionId,
      approve: true,
      consent_token: planToken,
    });
    const analysisToken = await seedConsent(store, 'approve');
    await agent.perform({
      action: 'review',
      session_id: sessionId,
      approve: true,
      consent_token: analysisToken,
      intent: 'File the monthly invoice and archive it',
    });
    const built = JSON.parse(
      await agent.perform({ action: 'build', session_id: sessionId, target: 'skill' }),
    );
    expect(built.status).toBe('error');
    expect(built.message).toMatch(/Propose the plan again/);
    store.close();
  });
});
