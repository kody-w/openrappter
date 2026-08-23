import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../components/company-app.js';
import '../components/xpedition-onboarding.js';
import '../components/xpedition-shell.js';
import {
  COMPANY_APP_IDS,
  COMPANY_APP_REGISTRATIONS,
  companyAppRegistration,
} from '../services/company-app-registry.js';
import {
  ActionBoundApprovalGate,
  FixtureRepeatedWorkDetectorAdapter,
  GatewayCompanyDataAdapter,
  LIVING_COMPANY_DRAFTS_KEY,
  LIVING_COMPANY_FIXTURE_SIGNALS,
  LivingCompanyDraftStore,
  LivingCompanyWeekScenario,
  PendingV3DetectorAdapter,
  ScenarioReleaseRingAdapter,
  livingCompanyScenario,
  type ExternalAction,
} from '../services/living-company.js';
import {
  handleDesktopUiCommand,
  snapshotDesktopUi,
} from '../services/desktop-control.js';
import {
  DEFAULT_XPEDITION_PREFERENCES,
  saveXpeditionPreferences,
  type StorageLike,
} from '../services/xpedition.js';
import type { OpenRappterCompanyApp } from '../components/company-app.js';
import type { OpenRappterXpeditionShell } from '../components/xpedition-shell.js';
import type { OpenRappterXpeditionOnboarding } from '../components/xpedition-onboarding.js';
import { gateway } from '../services/gateway.js';

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function fixtureScenario() {
  const storage = new MemoryStorage();
  const store = new LivingCompanyDraftStore(storage);
  return {
    storage,
    store,
    scenario: new LivingCompanyWeekScenario({
      store,
      detector: new FixtureRepeatedWorkDetectorAdapter(),
      ringAdapter: new ScenarioReleaseRingAdapter(),
      approvalGate: new ActionBoundApprovalGate(),
    }),
  };
}

async function completeFixtureWeek(scenario: LivingCompanyWeekScenario) {
  scenario.start();
  let state = await scenario.runUntilBlocked();
  expect(state.pendingApproval?.action).toBe('automation.promote');
  scenario.approve(
    state.pendingApproval!.id,
    'automation.promote',
    true,
    true,
  );
  state = await scenario.runUntilBlocked();
  expect(state.pendingApproval?.action).toBe('release.apply');
  scenario.approve(
    state.pendingApproval!.id,
    'release.apply',
    true,
    true,
  );
  return scenario.runUntilBlocked();
}

describe('durable Living Company app registry', () => {
  it('registers every required company surface exactly once with real seams', () => {
    expect(COMPANY_APP_IDS).toEqual([
      'engineering',
      'release-operations',
      'customer-signals',
      'documentation',
      'expenses',
      'decisions',
      'rapp-estate-health',
    ]);
    expect(new Set(COMPANY_APP_IDS).size).toBe(COMPANY_APP_IDS.length);
    for (const id of COMPANY_APP_IDS) {
      const app = companyAppRegistration(id);
      expect(app.dataSeams.length).toBeGreaterThan(0);
      expect(app.title).not.toBe('');
    }
  });

  it('declares approval policies for every external action category', () => {
    const actions = new Set(
      COMPANY_APP_REGISTRATIONS.flatMap((app) => app.approvalActions),
    );
    for (const action of [
      'external.send',
      'external.publish',
      'expense.submit',
      'release.apply',
      'release.promote',
      'credential.change',
      'shell.command',
      'irreversible.action',
    ]) {
      expect(actions.has(action)).toBe(true);
    }
  });
});

describe('company data adapters', () => {
  function adapter(responses: Record<string, unknown>, connected = true) {
    const call = vi.fn(async (method: string) => {
      if (!(method in responses)) throw new Error(`No fixture for ${method}`);
      return responses[method];
    });
    const store = new LivingCompanyDraftStore(new MemoryStorage());
    return {
      call,
      adapter: new GatewayCompanyDataAdapter(
        { isConnected: connected, call } as never,
        store,
        new ScenarioReleaseRingAdapter(),
      ),
    };
  }

  it('uses status and execution receipts for Engineering without inventing repo/PR/CI metrics', async () => {
    const { adapter: data, call } = adapter({
      status: { version: '1.13.0' },
      'exec.pending': [{ id: 'p1' }],
      'exec.history': [{ id: 'h1' }],
    });
    const result = await data.load('engineering');
    expect(result.status).toBe('partial');
    expect(result.facts.map((fact) => fact.source)).toEqual([
      'status',
      'exec.pending',
      'exec.history',
    ]);
    expect(result.unavailable[0]).toMatch(/Repository, pull-request, and CI/);
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('reads only existing channel/session counts for Customer Signals', async () => {
    const { adapter: data, call } = adapter({
      'channels.list': [{ id: 'teams' }],
      'chat.list': [
        { id: 'session-1', messageCount: 4 },
        { id: 'session-2', messageCount: 2 },
      ],
    });
    const result = await data.load('customer-signals');
    expect(result.facts.map((fact) => fact.value)).toEqual([1, 2, 6]);
    expect(result.unavailable[0]).toMatch(/No bounded feedback RPC/);
    expect(call).not.toHaveBeenCalledWith('chat.messages');
    expect(call).not.toHaveBeenCalledWith('channels.send');
  });

  it('reports release and docs dependency seams honestly', async () => {
    const { adapter: release } = adapter({
      methods: ['status', 'channels.list'],
      'exec.history': [],
    });
    const releaseState = await release.load('release-operations');
    expect(releaseState.facts.find((fact) => fact.label === 'Release RPCs')?.value).toBe(0);
    expect(releaseState.unavailable[0]).toMatch(/dependency PR/);

    const { adapter: docs } = adapter({
      status: { running: true },
      methods: ['status'],
    });
    const docsState = await docs.load('documentation');
    expect(docsState.facts.find((fact) => fact.label === 'Publishing health RPC')?.value)
      .toBe('unavailable');
    expect(docsState.unavailable[0]).toMatch(/no registered RPC/);
  });

  it('uses local draft storage for Expenses and Decisions even while offline', async () => {
    const storage = new MemoryStorage();
    const store = new LivingCompanyDraftStore(storage);
    store.addExpense({
      id: 'draft-1',
      private: true,
      status: 'review-ready',
      submissionStatus: 'not-submitted',
      userMustSubmit: true,
      merchant: 'Fixture',
      amount: 12,
      currency: 'USD',
      category: 'Travel',
      note: 'review',
      createdAt: '2026-08-28T00:00:00Z',
    });
    const data = new GatewayCompanyDataAdapter(
      { isConnected: false, call: vi.fn() } as never,
      store,
    );
    expect((await data.load('expenses')).status).toBe('ready');
    expect((await data.load('decisions')).status).toBe('ready');
  });

  it('never turns an offline gateway into a success-shaped company snapshot', async () => {
    const { adapter: data, call } = adapter({}, false);
    const result = await data.load('engineering');
    expect(result.status).toBe('offline');
    expect(result.facts).toEqual([]);
    expect(result.unavailable[0]).toMatch(/offline/);
    expect(call).not.toHaveBeenCalled();
  });

  it('reports authenticated estate-audit availability without fabricating drift', async () => {
    const { adapter: data } = adapter({
      status: { running: true },
      'skills.list': [{ id: 'ecosystem-audit', name: 'Ecosystem Audit' }],
    });
    const result = await data.load('rapp-estate-health');
    expect(result.status).toBe('partial');
    expect(result.facts).toEqual([
      {
        label: 'Authenticated gateway',
        value: 'connected',
        source: 'status',
      },
      {
        label: 'Ecosystem audit skill',
        value: 'installed',
        source: 'skills.list',
      },
    ]);
    expect(result.unavailable[0]).toMatch(/authenticated ecosystem-audit adapter/);
    expect(JSON.stringify(result)).not.toContain('driftCount');
  });
});

describe('action-bound approval safety', () => {
  it('requires explicit human confirmation and exact action binding', () => {
    const gate = new ActionBoundApprovalGate();
    const request = gate.request('release.apply', 'Apply fixture beta');
    expect(() =>
      gate.resolve(request.id, 'release.apply', true, false),
    ).toThrow(/human confirmation/);
    expect(() =>
      gate.resolve(request.id, 'release.promote', true, true),
    ).toThrow(/different action/);
    gate.resolve(request.id, 'release.apply', true, true);
    expect(() => gate.consume(request.id, 'release.promote')).toThrow();
    expect(() => gate.consume(request.id, 'release.apply')).not.toThrow();
    expect(() => gate.consume(request.id, 'release.apply')).toThrow();
  });

  it('cannot execute a blocked scenario step by guessing an approval id', async () => {
    const { scenario } = fixtureScenario();
    scenario.start();
    const blocked = await scenario.runUntilBlocked();
    expect(blocked.status).toBe('blocked');
    expect(() =>
      scenario.approvals.consume(
        'company-approval-guessed',
        'automation.promote',
      ),
    ).toThrow(/No approved/);
    expect(scenario.snapshot().receipts).toBeUndefined();
  });
});

describe('Living Company Week fixture harness', () => {
  it('runs Monday through Friday with two action-bound approvals and zero external effects', async () => {
    const { scenario } = fixtureScenario();
    const final = await completeFixtureWeek(scenario);
    expect(final.status).toBe('completed');
    expect(final.completedDays).toEqual([
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
    ]);
    expect(final.externalSideEffects).toBe(0);
    expect(final.sends).toBe(0);
    expect(final.publishes).toBe(0);
    expect(final.submissions).toBe(0);
    expect(final.drafts).toEqual({
      memos: 4,
      memes: 1,
      expenses: 1,
      decisions: 1,
      documentation: 1,
      receipts: 2,
    });
  });

  it('keeps memos, meme, docs, and expense as private drafts only', async () => {
    const { scenario, store } = fixtureScenario();
    await completeFixtureWeek(scenario);
    const drafts = store.snapshot();
    expect(drafts.memos.every((draft) => draft.private && draft.status === 'draft')).toBe(true);
    expect(drafts.memes).toHaveLength(1);
    expect(drafts.memes[0]).toMatchObject({ private: true, status: 'draft' });
    expect(drafts.memes[0].altText.length).toBeGreaterThan(30);
    expect(drafts.documentation[0]).toMatchObject({ private: true, status: 'draft' });
    expect(drafts.expenses[0]).toMatchObject({
      private: true,
      status: 'review-ready',
      submissionStatus: 'not-submitted',
      userMustSubmit: true,
    });
    expect(drafts.receipts.every((receipt) => receipt.externalSideEffect === false)).toBe(true);
  });

  it('records a redacted deterministic evidence ledger and truthful outage recovery', async () => {
    const first = fixtureScenario();
    const firstFinal = await completeFixtureWeek(first.scenario);
    const firstLedger = firstFinal.ledger;
    expect(firstLedger.some((entry) => entry.status === 'offline')).toBe(true);
    expect(firstLedger.some((entry) => entry.status === 'recovered')).toBe(true);
    expect(JSON.stringify(firstLedger)).not.toMatch(/token|password|credential-value|raw message/i);

    first.scenario.reset();
    const replay = await completeFixtureWeek(first.scenario);
    expect(replay.ledger).toEqual(firstLedger);
  });

  it('uses the v3 detector seam and refuses unconfigured dogfood mode', async () => {
    const detector = new FixtureRepeatedWorkDetectorAdapter();
    const candidates = await detector.detect(LIVING_COMPANY_FIXTURE_SIGNALS);
    expect(candidates[0]).toMatchObject({
      id: 'candidate-refresh-release-evidence',
      occurrences: 3,
    });
    await expect(new PendingV3DetectorAdapter().detect([])).rejects.toThrow(/dependency PR/);
    expect(() => new LivingCompanyWeekScenario({ mode: 'dogfood' }))
      .toThrow(/opt-in/);
    expect(() => new LivingCompanyWeekScenario({
      mode: 'dogfood',
      allowDogfood: true,
    })).toThrow(/injected detector and release-ring/);
  });
});

describe('semantic-only week control harness', () => {
  let scenario: LivingCompanyWeekScenario;

  beforeEach(() => {
    document.body.innerHTML = '';
    scenario = fixtureScenario().scenario;
    const app = document.createElement('openrappter-app') as HTMLElement &
      Record<string, unknown>;
    Object.assign(app, {
      companyState: () => scenario.snapshot(),
      runCompanyScenario: async (operation: string) => {
        if (operation === 'start') scenario.start();
        if (operation === 'step') await scenario.step();
        if (operation === 'run') await scenario.runUntilBlocked();
        if (operation === 'reset') scenario.reset();
        if (operation === 'replay') {
          scenario.reset();
          scenario.start();
          await scenario.runUntilBlocked();
        }
        return scenario.snapshot();
      },
      approveCompanyAction: (
        id: string,
        action: ExternalAction,
        approved: boolean,
        humanConfirmed: boolean,
      ) => scenario.approve(id, action, approved, humanConfirmed),
    });
    document.body.append(app);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('completes the fixture week only through bounded semantic commands', async () => {
    const gatewayCall = vi.spyOn(gateway, 'call');
    await handleDesktopUiCommand({
      action: 'company_scenario',
      args: { operation: 'start' },
    });
    let state = await handleDesktopUiCommand({
      action: 'company_scenario',
      args: { operation: 'run' },
    }) as ReturnType<LivingCompanyWeekScenario['snapshot']>;
    expect(state.pendingApproval?.action).toBe('automation.promote');
    await handleDesktopUiCommand({
      action: 'company_approve',
      args: {
        requestId: state.pendingApproval!.id,
        companyAction: 'automation.promote',
        approved: true,
        humanConfirmed: true,
      },
    });
    state = await handleDesktopUiCommand({
      action: 'company_scenario',
      args: { operation: 'run' },
    }) as ReturnType<LivingCompanyWeekScenario['snapshot']>;
    expect(state.pendingApproval?.action).toBe('release.apply');
    await handleDesktopUiCommand({
      action: 'company_approve',
      args: {
        requestId: state.pendingApproval!.id,
        companyAction: 'release.apply',
        approved: true,
        humanConfirmed: true,
      },
    });
    state = await handleDesktopUiCommand({
      action: 'company_scenario',
      args: { operation: 'run' },
    }) as ReturnType<LivingCompanyWeekScenario['snapshot']>;
    expect(state.status).toBe('completed');
    expect(state.externalSideEffects).toBe(0);
    expect(gatewayCall).not.toHaveBeenCalled();
  });

  it('rejects arbitrary operations and approval without human confirmation', async () => {
    await expect(handleDesktopUiCommand({
      action: 'company_scenario',
      args: { operation: 'publish-everything' },
    })).rejects.toThrow(/Unknown Living Company scenario operation/);
    scenario.start();
    const blocked = await scenario.runUntilBlocked();
    await expect(handleDesktopUiCommand({
      action: 'company_approve',
      args: {
        requestId: blocked.pendingApproval!.id,
        companyAction: 'automation.promote',
        approved: true,
        humanConfirmed: false,
      },
    })).rejects.toThrow(/human confirmation/);
  });
});

describe('Living Company windows', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('opens every company registration as the same generic real component', async () => {
    const storage = new MemoryStorage();
    saveXpeditionPreferences(storage, {
      ...DEFAULT_XPEDITION_PREFERENCES,
      onboardingCompleted: true,
    });
    const shell = document.createElement(
      'openrappter-xpedition-shell',
    ) as OpenRappterXpeditionShell;
    shell.storage = storage;
    shell.connected = false;
    document.body.append(shell);
    await shell.updateComplete;
    for (const id of COMPANY_APP_IDS) shell.openApp(id);
    await shell.updateComplete;
    const apps = shell.shadowRoot!.querySelectorAll('openrappter-company-app');
    expect(apps).toHaveLength(COMPANY_APP_IDS.length);
    expect(Array.from(apps).map((app) => (app as OpenRappterCompanyApp).appId))
      .toEqual(COMPANY_APP_IDS);
  });

  it('marks private drafts and human approval controls as automation-sensitive', async () => {
    livingCompanyScenario.start();
    await livingCompanyScenario.runUntilBlocked();
    const component = document.createElement(
      'openrappter-company-app',
    ) as OpenRappterCompanyApp;
    component.appId = 'decisions';
    component.dataAdapter = {
      load: vi.fn().mockResolvedValue({
        appId: 'decisions',
        status: 'ready',
        facts: [],
        unavailable: [],
        dataSeams: ['LivingCompanyDraftStore'],
        loadedAt: '2026-08-28T00:00:00Z',
      }),
    } as never;
    document.body.append(component);
    await component.refresh();
    await component.updateComplete;
    expect(component.shadowRoot!.querySelector('[data-desktop-private]')).not.toBeNull();
    expect(component.shadowRoot!.querySelector(
      '[data-desktop-sensitive="company-approval"]',
    )).not.toBeNull();
    const source = component.shadowRoot!.innerHTML;
    expect(source).not.toContain('channels.send');
    expect(source).not.toContain('expense.submit');
    livingCompanyScenario.reset();
  });

  it('stores only the versioned draft schema', () => {
    const storage = new MemoryStorage();
    const store = new LivingCompanyDraftStore(storage);
    expect(store.snapshot().schema).toBe('openrappter-living-company-drafts/1.0');
    expect(JSON.parse(storage.getItem(LIVING_COMPANY_DRAFTS_KEY) ?? 'null')).toBeNull();
  });

  it('redacts sensitive and nested evidence before persistence', () => {
    const storage = new MemoryStorage();
    const store = new LivingCompanyDraftStore(storage);
    const sensitiveFixture = ['redaction', 'fixture', 'value'].join('-');
    store.addEvidence({
      sequence: 1,
      scenarioId: 'living-company-week-fixture',
      day: 'monday',
      event: 'redaction-test',
      status: 'observed',
      timestamp: '2026-08-24T00:00:00Z',
      evidence: {
        token: sensitiveFixture,
        nested: { password: sensitiveFixture },
        array: [{ credential: sensitiveFixture }],
      },
    });
    const persisted = storage.getItem(LIVING_COMPANY_DRAFTS_KEY)!;
    expect(persisted).not.toContain(sensitiveFixture);
    expect(persisted).toContain('[redacted]');
    expect(persisted).toContain('[bounded-object]');
    expect(persisted).toContain('[bounded-item]');
  });

  it('requires a human-only second confirmation before release-ring Apply', async () => {
    const apply = vi.fn().mockResolvedValue({
      status: 'applied',
      ring: 'beta',
      message: 'fixture applied',
    });
    const onboarding = document.createElement(
      'openrappter-xpedition-onboarding',
    ) as OpenRappterXpeditionOnboarding;
    onboarding.connected = true;
    onboarding.ringAdapter = {
      current: vi.fn().mockResolvedValue('stable'),
      available: vi.fn().mockResolvedValue(['stable', 'beta']),
      apply,
    };
    document.body.append(onboarding);
    onboarding.selectStep('release');
    await onboarding.updateComplete;
    const select = onboarding.shadowRoot!.querySelector('select')!;
    select.value = 'beta';
    select.dispatchEvent(new Event('change'));
    await onboarding.updateComplete;
    const request = Array.from(
      onboarding.shadowRoot!.querySelectorAll('button'),
    ).find((button) => button.textContent?.includes('Request Apply'))!;
    request.click();
    await onboarding.updateComplete;
    expect(apply).not.toHaveBeenCalled();

    const snapshot = snapshotDesktopUi();
    const confirm = snapshot.elements.find((element) =>
      element.text.includes('Confirm Apply'));
    expect(confirm).toBeDefined();
    await expect(handleDesktopUiCommand({
      action: 'click',
      args: { ref: confirm!.ref },
    })).rejects.toThrow(/sensitive/);
    expect(apply).not.toHaveBeenCalled();

    expect(select.disabled).toBe(true);
    select.value = 'alpha';
    select.dispatchEvent(new Event('change'));
    const humanConfirm = onboarding.shadowRoot!.querySelector<HTMLButtonElement>(
      '[data-desktop-sensitive="company-approval"]',
    )!;
    humanConfirm.click();
    await onboarding.updateComplete;
    expect(apply).toHaveBeenCalledWith('beta');
  });
});
