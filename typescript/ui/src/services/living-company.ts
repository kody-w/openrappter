import { gateway, type GatewayClient } from './gateway.js';
import {
  FixtureReleaseRingAdapter,
  type ReleaseRing,
  type ReleaseRingAdapter,
  type StorageLike,
  xpeditionStorage,
} from './xpedition.js';
import {
  COMPANY_APP_IDS,
  companyAppRegistration,
  type CompanyAppId,
} from './company-app-registry.js';

export const LIVING_COMPANY_DRAFTS_KEY =
  'openrappter.living-company.private-drafts.v1';

export type ExternalAction =
  | 'external.send'
  | 'external.publish'
  | 'expense.submit'
  | 'release.apply'
  | 'release.promote'
  | 'automation.promote'
  | 'credential.change'
  | 'shell.command'
  | 'irreversible.action';

export const APPROVAL_REQUIRED_ACTIONS: readonly ExternalAction[] = [
  'external.send',
  'external.publish',
  'expense.submit',
  'release.apply',
  'release.promote',
  'automation.promote',
  'credential.change',
  'shell.command',
  'irreversible.action',
] as const;

export interface PrivateMemoDraft {
  id: string;
  scenarioId?: string;
  private: true;
  status: 'draft';
  title: string;
  body: string;
  createdAt: string;
}

export interface PrivateMemeDraft {
  id: string;
  scenarioId?: string;
  private: true;
  status: 'draft';
  caption: string;
  altText: string;
  createdAt: string;
}

export interface ExpenseDraft {
  id: string;
  scenarioId?: string;
  private: true;
  status: 'review-ready';
  submissionStatus: 'not-submitted';
  userMustSubmit: true;
  merchant: string;
  amount: number;
  currency: string;
  category: string;
  note: string;
  createdAt: string;
}

export interface DecisionDraft {
  id: string;
  scenarioId?: string;
  status: 'draft' | 'approved-fixture';
  title: string;
  evidence: string;
  createdAt: string;
}

export interface CompanyReceipt {
  id: string;
  scenarioId?: string;
  kind: 'automation-promotion' | 'release-ring';
  fixture: boolean;
  externalSideEffect: false;
  summary: string;
  createdAt: string;
}

export interface DocumentationDraft {
  id: string;
  scenarioId?: string;
  private: true;
  status: 'draft';
  title: string;
  path: string;
  copyCode: string;
  copyPrompt: string;
  createdAt: string;
}

export interface EvidenceLedgerEntry {
  sequence: number;
  scenarioId: string;
  day: LivingCompanyDay;
  event: string;
  status: 'observed' | 'blocked' | 'approved' | 'completed' | 'offline' | 'recovered';
  timestamp: string;
  evidence: Record<string, unknown>;
}

export interface LivingCompanyDraftState {
  schema: 'openrappter-living-company-drafts/1.0';
  memos: PrivateMemoDraft[];
  memes: PrivateMemeDraft[];
  expenses: ExpenseDraft[];
  decisions: DecisionDraft[];
  receipts: CompanyReceipt[];
  documentation: DocumentationDraft[];
  evidence: EvidenceLedgerEntry[];
}

const EMPTY_DRAFT_STATE: LivingCompanyDraftState = {
  schema: 'openrappter-living-company-drafts/1.0',
  memos: [],
  memes: [],
  expenses: [],
  decisions: [],
  receipts: [],
  documentation: [],
  evidence: [],
};

function bounded(value: unknown, max = 800): string {
  return typeof value === 'string'
    ? Array.from(value).slice(0, max).join('')
    : '';
}

function redactedEvidence(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 30)) {
    if (/(?:token|secret|password|credential|authorization|cookie|message|content|prompt)/i.test(key)) {
      output[key] = '[redacted]';
    } else if (typeof item === 'string') {
      output[key] = bounded(item, 240);
    } else if (
      item === null ||
      typeof item === 'boolean' ||
      typeof item === 'number'
    ) {
      output[key] = item;
    } else if (Array.isArray(item)) {
      output[key] = item.slice(0, 20).map((entry) => {
        if (typeof entry === 'string') return bounded(entry, 120);
        if (
          entry === null ||
          typeof entry === 'boolean' ||
          typeof entry === 'number'
        ) {
          return entry;
        }
        return '[bounded-item]';
      });
    } else {
      output[key] = '[bounded-object]';
    }
  }
  return output;
}

export class LivingCompanyDraftStore {
  private state: LivingCompanyDraftState;

  constructor(private readonly storage: StorageLike = xpeditionStorage()) {
    this.state = this.load();
  }

  snapshot(): LivingCompanyDraftState {
    return structuredClone(this.state);
  }

  addMemo(draft: PrivateMemoDraft): void {
    this.state.memos.push({ ...draft, private: true, status: 'draft' });
    this.save();
  }

  addMeme(draft: PrivateMemeDraft): void {
    this.state.memes.push({ ...draft, private: true, status: 'draft' });
    this.save();
  }

  addExpense(draft: ExpenseDraft): void {
    this.state.expenses.push({
      ...draft,
      private: true,
      status: 'review-ready',
      submissionStatus: 'not-submitted',
      userMustSubmit: true,
    });
    this.save();
  }

  addDecision(draft: DecisionDraft): void {
    this.state.decisions.push({ ...draft });
    this.save();
  }

  addReceipt(receipt: CompanyReceipt): void {
    this.state.receipts.push({
      ...receipt,
      externalSideEffect: false,
    });
    this.save();
  }

  addDocumentation(draft: DocumentationDraft): void {
    this.state.documentation.push({
      ...draft,
      private: true,
      status: 'draft',
    });
    this.save();
  }

  addEvidence(entry: EvidenceLedgerEntry): void {
    this.state.evidence.push({
      ...entry,
      evidence: redactedEvidence(entry.evidence),
    });
    this.save();
  }

  clearScenario(scenarioId: string): void {
    this.state.memos = this.state.memos.filter((item) => item.scenarioId !== scenarioId);
    this.state.memes = this.state.memes.filter((item) => item.scenarioId !== scenarioId);
    this.state.expenses = this.state.expenses.filter((item) => item.scenarioId !== scenarioId);
    this.state.decisions = this.state.decisions.filter((item) => item.scenarioId !== scenarioId);
    this.state.receipts = this.state.receipts.filter((item) => item.scenarioId !== scenarioId);
    this.state.documentation = this.state.documentation.filter((item) => item.scenarioId !== scenarioId);
    this.state.evidence = this.state.evidence.filter((item) => item.scenarioId !== scenarioId);
    this.save();
  }

  private load(): LivingCompanyDraftState {
    try {
      const parsed = JSON.parse(
        this.storage.getItem(LIVING_COMPANY_DRAFTS_KEY) ?? '',
      ) as Partial<LivingCompanyDraftState>;
      if (parsed.schema !== EMPTY_DRAFT_STATE.schema) {
        return structuredClone(EMPTY_DRAFT_STATE);
      }
      return {
        schema: EMPTY_DRAFT_STATE.schema,
        memos: Array.isArray(parsed.memos) ? parsed.memos : [],
        memes: Array.isArray(parsed.memes) ? parsed.memes : [],
        expenses: Array.isArray(parsed.expenses) ? parsed.expenses : [],
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
        receipts: Array.isArray(parsed.receipts) ? parsed.receipts : [],
        documentation: Array.isArray(parsed.documentation)
          ? parsed.documentation
          : [],
        evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
      };
    } catch {
      return structuredClone(EMPTY_DRAFT_STATE);
    }
  }

  private save(): void {
    this.storage.setItem(
      LIVING_COMPANY_DRAFTS_KEY,
      JSON.stringify(this.state),
    );
  }
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'consumed';

export interface CompanyApprovalRequest {
  id: string;
  action: ExternalAction;
  summary: string;
  status: ApprovalStatus;
  actionFingerprint: string;
}

export class ActionBoundApprovalGate {
  private requests = new Map<string, CompanyApprovalRequest>();
  private nextId = 1;

  request(action: ExternalAction, summary: string): CompanyApprovalRequest {
    if (!APPROVAL_REQUIRED_ACTIONS.includes(action)) {
      throw new Error(`Action does not have an approval policy: ${action}`);
    }
    const existing = [...this.requests.values()].find(
      (request) =>
        request.action === action &&
        request.summary === summary &&
        request.status === 'pending',
    );
    if (existing) return { ...existing };
    const request: CompanyApprovalRequest = {
      id: `company-approval-${this.nextId++}`,
      action,
      summary: bounded(summary, 240),
      status: 'pending',
      actionFingerprint: `${action}:${bounded(summary, 120)}`,
    };
    this.requests.set(request.id, request);
    return { ...request };
  }

  resolve(
    id: string,
    action: ExternalAction,
    approved: boolean,
    humanConfirmed: boolean,
  ): CompanyApprovalRequest {
    if (!humanConfirmed) {
      throw new Error('Living Company approval requires an explicit human confirmation.');
    }
    const request = this.requests.get(id);
    if (!request || request.status !== 'pending') {
      throw new Error(`Unknown or already-resolved company approval: ${id}`);
    }
    if (request.action !== action) {
      throw new Error('Approval is bound to a different action.');
    }
    request.status = approved ? 'approved' : 'rejected';
    return { ...request };
  }

  consume(id: string, action: ExternalAction): void {
    const request = this.requests.get(id);
    if (!request || request.status !== 'approved' || request.action !== action) {
      throw new Error(`No approved action-bound confirmation for ${action}.`);
    }
    request.status = 'consumed';
  }

  invalidate(id: string, action: ExternalAction): void {
    const request = this.requests.get(id);
    if (!request || request.status !== 'pending' || request.action !== action) {
      throw new Error(`Cannot invalidate stale company approval: ${id}`);
    }
    request.status = 'rejected';
  }

  snapshot(): CompanyApprovalRequest[] {
    return [...this.requests.values()].map((request) => ({ ...request }));
  }

  reset(): void {
    this.requests.clear();
    this.nextId = 1;
  }
}

export interface RepeatedWorkCandidate {
  id: string;
  label: string;
  occurrences: number;
  evidenceIds: string[];
}

export interface RepeatedWorkDetectorAdapter {
  source: 'fixture-v3-seam' | 'v3-detector' | 'unavailable';
  detect(signals: readonly SafeFixtureSignal[]): Promise<RepeatedWorkCandidate[]>;
}

export class PendingV3DetectorAdapter implements RepeatedWorkDetectorAdapter {
  readonly source = 'unavailable' as const;

  async detect(): Promise<RepeatedWorkCandidate[]> {
    throw new Error(
      'Clever Girl detector v3 adapter is unavailable until its dependency PR lands. No detector was reimplemented.',
    );
  }
}

export class FixtureRepeatedWorkDetectorAdapter implements RepeatedWorkDetectorAdapter {
  readonly source = 'fixture-v3-seam' as const;

  async detect(signals: readonly SafeFixtureSignal[]): Promise<RepeatedWorkCandidate[]> {
    const counts = new Map<string, string[]>();
    for (const signal of signals) {
      const ids = counts.get(signal.kind) ?? [];
      ids.push(signal.id);
      counts.set(signal.kind, ids);
    }
    return [...counts.entries()]
      .filter(([, ids]) => ids.length >= 3)
      .map(([kind, ids]) => ({
        id: `candidate-${kind}`,
        label: kind.replaceAll('-', ' '),
        occurrences: ids.length,
        evidenceIds: [...ids],
      }));
  }
}

export interface SafeFixtureSignal {
  id: string;
  kind: string;
  source: 'fixture-channel' | 'fixture-ci' | 'fixture-docs';
  safeSummary: string;
}

export const LIVING_COMPANY_FIXTURE_SIGNALS: readonly SafeFixtureSignal[] = [
  {
    id: 'signal-1',
    kind: 'refresh-release-evidence',
    source: 'fixture-ci',
    safeSummary: 'Release evidence refresh repeated after a fixture CI run.',
  },
  {
    id: 'signal-2',
    kind: 'refresh-release-evidence',
    source: 'fixture-docs',
    safeSummary: 'Docs status required the same fixture release evidence.',
  },
  {
    id: 'signal-3',
    kind: 'refresh-release-evidence',
    source: 'fixture-channel',
    safeSummary: 'A safe fixture channel signal requested release evidence.',
  },
  {
    id: 'signal-4',
    kind: 'review-expense',
    source: 'fixture-channel',
    safeSummary: 'A fixture receipt is ready for draft review.',
  },
] as const;

export type LivingCompanyDay =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday';

const COMPANY_DAYS: readonly LivingCompanyDay[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
] as const;

export interface LivingCompanyScenarioState {
  schema: 'openrappter-living-company-week/1.0';
  scenarioId: 'living-company-week-fixture';
  mode: 'fixture' | 'dogfood';
  status: 'idle' | 'running' | 'blocked' | 'completed' | 'error';
  nextDay: LivingCompanyDay | null;
  completedDays: LivingCompanyDay[];
  pendingApproval: CompanyApprovalRequest | null;
  detectorSource: RepeatedWorkDetectorAdapter['source'];
  externalSideEffects: 0;
  sends: 0;
  publishes: 0;
  submissions: 0;
  stateVersion: number;
  error?: string;
}

export interface LivingCompanyScenarioOptions {
  mode?: 'fixture' | 'dogfood';
  allowDogfood?: boolean;
  detector?: RepeatedWorkDetectorAdapter;
  ringAdapter?: ReleaseRingAdapter;
  store?: LivingCompanyDraftStore;
  approvalGate?: ActionBoundApprovalGate;
}

export class ScenarioReleaseRingAdapter implements ReleaseRingAdapter {
  private ring: ReleaseRing = 'stable';

  async current(): Promise<ReleaseRing> {
    return this.ring;
  }

  async available(): Promise<readonly ReleaseRing[]> {
    return ['stable', 'beta', 'canary', 'alpha', 'nightly'];
  }

  async apply(ring: ReleaseRing) {
    this.ring = ring;
    return {
      status: 'applied' as const,
      ring,
      message: `Fixture ring ${ring} applied locally; no manifest, package, tag, or external release changed.`,
    };
  }

  reset(): void {
    this.ring = 'stable';
  }
}

export class LivingCompanyWeekScenario {
  readonly scenarioId = 'living-company-week-fixture' as const;
  readonly store: LivingCompanyDraftStore;
  readonly approvals: ActionBoundApprovalGate;
  private readonly detector: RepeatedWorkDetectorAdapter;
  private readonly ringAdapter: ReleaseRingAdapter;
  private state: LivingCompanyScenarioState;
  private sequence = 0;
  private pendingAutomationApproval: string | null = null;
  private pendingReleaseApproval: string | null = null;

  constructor(options: LivingCompanyScenarioOptions = {}) {
    const mode = options.mode ?? 'fixture';
    if (mode === 'dogfood' && options.allowDogfood !== true) {
      throw new Error(
        'Real Living Company dogfood is opt-in and remains disabled until detector and release dependencies are injected.',
      );
    }
    if (
      mode === 'dogfood' &&
      (!options.detector || !options.ringAdapter)
    ) {
      throw new Error(
        'Real Living Company dogfood requires injected detector and release-ring adapters.',
      );
    }
    this.store = options.store ?? new LivingCompanyDraftStore();
    this.approvals = options.approvalGate ?? new ActionBoundApprovalGate();
    this.detector = options.detector ??
      (mode === 'fixture'
        ? new FixtureRepeatedWorkDetectorAdapter()
        : new PendingV3DetectorAdapter());
    this.ringAdapter = options.ringAdapter ??
      (mode === 'fixture'
        ? new ScenarioReleaseRingAdapter()
        : new FixtureReleaseRingAdapter());
    this.state = this.initialState(mode);
  }

  snapshot(): LivingCompanyScenarioState & {
    approvals: CompanyApprovalRequest[];
    ledger: EvidenceLedgerEntry[];
    drafts: {
      memos: number;
      memes: number;
      expenses: number;
      decisions: number;
      documentation: number;
      receipts: number;
    };
  } {
    const drafts = this.store.snapshot();
    return {
      ...structuredClone(this.state),
      approvals: this.approvals.snapshot(),
      ledger: drafts.evidence.filter((entry) => entry.scenarioId === this.scenarioId),
      drafts: {
        memos: drafts.memos.filter((entry) => entry.scenarioId === this.scenarioId).length,
        memes: drafts.memes.filter((entry) => entry.scenarioId === this.scenarioId).length,
        expenses: drafts.expenses.filter((entry) => entry.scenarioId === this.scenarioId).length,
        decisions: drafts.decisions.filter((entry) => entry.scenarioId === this.scenarioId).length,
        documentation: drafts.documentation.filter((entry) => entry.scenarioId === this.scenarioId).length,
        receipts: drafts.receipts.filter((entry) => entry.scenarioId === this.scenarioId).length,
      },
    };
  }

  start(): ReturnType<LivingCompanyWeekScenario['snapshot']> {
    this.reset();
    this.state.status = 'running';
    this.state.stateVersion++;
    return this.snapshot();
  }

  reset(): ReturnType<LivingCompanyWeekScenario['snapshot']> {
    const mode = this.state.mode;
    this.store.clearScenario(this.scenarioId);
    this.approvals.reset();
    if (this.ringAdapter instanceof ScenarioReleaseRingAdapter) {
      this.ringAdapter.reset();
    }
    this.sequence = 0;
    this.pendingAutomationApproval = null;
    this.pendingReleaseApproval = null;
    this.state = this.initialState(mode);
    return this.snapshot();
  }

  approve(
    requestId: string,
    action: ExternalAction,
    approved: boolean,
    humanConfirmed: boolean,
  ): ReturnType<LivingCompanyWeekScenario['snapshot']> {
    const resolved = this.approvals.resolve(
      requestId,
      action,
      approved,
      humanConfirmed,
    );
    this.state.pendingApproval = null;
    this.state.status = approved ? 'running' : 'blocked';
    this.state.stateVersion++;
    this.ledger(
      this.state.nextDay ?? 'wednesday',
      'human-approval',
      approved ? 'approved' : 'blocked',
      { requestId: resolved.id, action: resolved.action, approved },
    );
    return this.snapshot();
  }

  async step(): Promise<ReturnType<LivingCompanyWeekScenario['snapshot']>> {
    if (this.state.status === 'idle') this.start();
    if (this.state.status === 'completed') return this.snapshot();
    if (this.state.status === 'blocked' && this.state.pendingApproval) {
      return this.snapshot();
    }
    const day = this.state.nextDay;
    if (!day) return this.snapshot();
    try {
      if (day === 'monday') await this.monday();
      if (day === 'tuesday') await this.tuesday();
      if (day === 'wednesday') await this.wednesday();
      if (day === 'thursday') await this.thursday();
      if (day === 'friday') await this.friday();
    } catch (error) {
      this.state.status = 'error';
      this.state.error = error instanceof Error ? error.message : String(error);
      this.state.stateVersion++;
    }
    return this.snapshot();
  }

  async runUntilBlocked(): Promise<ReturnType<LivingCompanyWeekScenario['snapshot']>> {
    if (this.state.status === 'idle') this.start();
    while (
      this.state.status === 'running' &&
      this.state.nextDay !== null
    ) {
      await this.step();
    }
    return this.snapshot();
  }

  private async monday(): Promise<void> {
    this.ledger('monday', 'safe-signals-ingested', 'observed', {
      count: LIVING_COMPANY_FIXTURE_SIGNALS.length,
      ids: LIVING_COMPANY_FIXTURE_SIGNALS.map((signal) => signal.id),
      sources: [...new Set(LIVING_COMPANY_FIXTURE_SIGNALS.map((signal) => signal.source))],
      externalSideEffects: 0,
    });
    this.completeDay('monday');
  }

  private async tuesday(): Promise<void> {
    const candidates = await this.detector.detect(LIVING_COMPANY_FIXTURE_SIGNALS);
    const candidate = candidates[0];
    if (!candidate) {
      throw new Error('The detector produced no repeated-work candidate.');
    }
    this.store.addDecision({
      id: 'decision-repeated-release-evidence',
      scenarioId: this.scenarioId,
      status: 'draft',
      title: 'Promote fixture release-evidence refresh',
      evidence: `${candidate.occurrences} safe fixture occurrences (${candidate.evidenceIds.join(', ')})`,
      createdAt: this.timestamp('tuesday'),
    });
    this.store.addMemo({
      id: 'memo-tuesday-repeated-work',
      scenarioId: this.scenarioId,
      private: true,
      status: 'draft',
      title: 'Tuesday: repeated release work',
      body:
        `Clever Girl found ${candidate.occurrences} safe fixture repetitions. ` +
        'A fixture-only automation is drafted for approval; nothing was promoted.',
      createdAt: this.timestamp('tuesday'),
    });
    this.ledger('tuesday', 'repeated-work-detected', 'observed', {
      detector: this.detector.source,
      candidateId: candidate.id,
      occurrences: candidate.occurrences,
      evidenceIds: candidate.evidenceIds,
    });
    this.completeDay('tuesday');
  }

  private async wednesday(): Promise<void> {
    const summary = 'Promote fixture release-evidence automation';
    if (!this.pendingAutomationApproval) {
      const request = this.approvals.request('automation.promote', summary);
      this.pendingAutomationApproval = request.id;
      this.state.pendingApproval = request;
      this.state.status = 'blocked';
      this.state.stateVersion++;
      this.store.addMemo({
        id: 'memo-wednesday-approval',
        scenarioId: this.scenarioId,
        private: true,
        status: 'draft',
        title: 'Wednesday: approval required',
        body:
          'Fixture automation promotion is blocked on an action-bound human approval. No automation ran.',
        createdAt: this.timestamp('wednesday'),
      });
      this.ledger('wednesday', 'automation-promotion', 'blocked', {
        requestId: request.id,
        action: request.action,
        externalSideEffects: 0,
      });
      return;
    }
    this.approvals.consume(
      this.pendingAutomationApproval,
      'automation.promote',
    );
    this.store.addReceipt({
      id: 'receipt-fixture-automation',
      scenarioId: this.scenarioId,
      kind: 'automation-promotion',
      fixture: true,
      externalSideEffect: false,
      summary: 'Fixture release-evidence automation promoted inside the local scenario only.',
      createdAt: this.timestamp('wednesday'),
    });
    this.ledger('wednesday', 'automation-promotion', 'completed', {
      fixture: true,
      externalSideEffects: 0,
      approvalId: this.pendingAutomationApproval,
    });
    this.completeDay('wednesday');
  }

  private async thursday(): Promise<void> {
    this.ledger('thursday', 'gateway-status', 'offline', {
      simulated: true,
      reason: 'fixture-connection-loss',
      externalSideEffects: 0,
    });
    this.store.addMemo({
      id: 'memo-thursday-recovery',
      scenarioId: this.scenarioId,
      private: true,
      status: 'draft',
      title: 'Thursday: truthful outage recovery',
      body:
        'The fixture gateway reported offline, preserved the error, then recovered on an explicit retry. No success fallback was emitted.',
      createdAt: this.timestamp('thursday'),
    });
    this.ledger('thursday', 'gateway-status', 'recovered', {
      simulated: true,
      retry: 1,
      health: 'ok',
      externalSideEffects: 0,
    });
    this.completeDay('thursday');
  }

  private async friday(): Promise<void> {
    const summary = 'Apply fixture beta release ring';
    if (!this.pendingReleaseApproval) {
      const request = this.approvals.request('release.apply', summary);
      this.pendingReleaseApproval = request.id;
      this.state.pendingApproval = request;
      this.state.status = 'blocked';
      this.state.stateVersion++;
      this.ledger('friday', 'fixture-ring-preview', 'blocked', {
        requestId: request.id,
        from: 'stable',
        to: 'beta',
        externalSideEffects: 0,
      });
      return;
    }
    this.approvals.consume(this.pendingReleaseApproval, 'release.apply');
    const ring = await this.ringAdapter.apply('beta');
    if (ring.status !== 'applied') {
      throw new Error(ring.message);
    }
    this.store.addReceipt({
      id: 'receipt-fixture-beta-ring',
      scenarioId: this.scenarioId,
      kind: 'release-ring',
      fixture: true,
      externalSideEffect: false,
      summary: ring.message,
      createdAt: this.timestamp('friday'),
    });
    this.store.addDocumentation({
      id: 'docs-friday-week-receipt',
      scenarioId: this.scenarioId,
      private: true,
      status: 'draft',
      title: 'Living Company Week evidence update',
      path: 'docs/living-company-desktop.md',
      copyCode: 'npm test --prefix typescript/ui',
      copyPrompt:
        'Review the redacted Living Company Week ledger and draft a truthful documentation update.',
      createdAt: this.timestamp('friday'),
    });
    this.store.addExpense({
      id: 'expense-friday-fixture',
      scenarioId: this.scenarioId,
      private: true,
      status: 'review-ready',
      submissionStatus: 'not-submitted',
      userMustSubmit: true,
      merchant: 'Fixture Transit',
      amount: 24.5,
      currency: 'USD',
      category: 'Travel',
      note: 'Fixture only. Review-ready draft; user must submit.',
      createdAt: this.timestamp('friday'),
    });
    this.store.addMemo({
      id: 'memo-friday-week-summary',
      scenarioId: this.scenarioId,
      private: true,
      status: 'draft',
      title: 'Friday: Living Company Week',
      body:
        'The fixture week produced two approval-bound receipts, a docs draft, and a review-ready expense draft. Sends, publishes, submissions, and external side effects remain zero.',
      createdAt: this.timestamp('friday'),
    });
    this.store.addMeme({
      id: 'meme-friday-receipts',
      scenarioId: this.scenarioId,
      private: true,
      status: 'draft',
      caption: 'Friday shipped the receipts, not the vibes.',
      altText:
        'An original text-only draft: a small green receipt folder calmly closes while a bright “zero external side effects” counter remains at zero.',
      createdAt: this.timestamp('friday'),
    });
    this.ledger('friday', 'week-completed', 'completed', {
      fixtureRing: 'beta',
      docsDrafts: 1,
      expenseDrafts: 1,
      memoDrafts: 4,
      memeDrafts: 1,
      sends: 0,
      publishes: 0,
      submissions: 0,
      externalSideEffects: 0,
    });
    this.completeDay('friday');
    this.state.status = 'completed';
    this.state.nextDay = null;
  }

  private completeDay(day: LivingCompanyDay): void {
    if (!this.state.completedDays.includes(day)) {
      this.state.completedDays.push(day);
    }
    const nextIndex = COMPANY_DAYS.indexOf(day) + 1;
    this.state.nextDay = COMPANY_DAYS[nextIndex] ?? null;
    this.state.status = this.state.nextDay ? 'running' : 'completed';
    this.state.pendingApproval = null;
    this.state.stateVersion++;
  }

  private ledger(
    day: LivingCompanyDay,
    event: string,
    status: EvidenceLedgerEntry['status'],
    evidence: Record<string, unknown>,
  ): void {
    this.store.addEvidence({
      sequence: ++this.sequence,
      scenarioId: this.scenarioId,
      day,
      event,
      status,
      timestamp: this.timestamp(day),
      evidence,
    });
  }

  private timestamp(day: LivingCompanyDay): string {
    const offset = COMPANY_DAYS.indexOf(day);
    return `2026-08-${String(24 + offset).padStart(2, '0')}T14:${String(this.sequence).padStart(2, '0')}:00.000Z`;
  }

  private initialState(
    mode: 'fixture' | 'dogfood',
  ): LivingCompanyScenarioState {
    return {
      schema: 'openrappter-living-company-week/1.0',
      scenarioId: this.scenarioId,
      mode,
      status: 'idle',
      nextDay: 'monday',
      completedDays: [],
      pendingApproval: null,
      detectorSource: this.detector.source,
      externalSideEffects: 0,
      sends: 0,
      publishes: 0,
      submissions: 0,
      stateVersion: 0,
    };
  }
}

export interface CompanyFact {
  label: string;
  value: string | number;
  source: string;
}

export interface CompanyAppSnapshot {
  appId: CompanyAppId;
  status: 'ready' | 'partial' | 'offline' | 'unavailable';
  facts: CompanyFact[];
  unavailable: string[];
  dataSeams: readonly string[];
  loadedAt: string;
}

type CompanyGateway = Pick<GatewayClient, 'call' | 'isConnected'>;

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export class GatewayCompanyDataAdapter {
  constructor(
    private readonly client: CompanyGateway = gateway,
    private readonly store: LivingCompanyDraftStore =
      livingCompanyDraftStore,
    private readonly ringAdapter: ReleaseRingAdapter =
      new FixtureReleaseRingAdapter(),
  ) {}

  async load(appId: CompanyAppId): Promise<CompanyAppSnapshot> {
    const registration = companyAppRegistration(appId);
    if (
      !this.client.isConnected &&
      appId !== 'expenses' &&
      appId !== 'decisions'
    ) {
      return {
        appId,
        status: 'offline',
        facts: [],
        unavailable: [
          'The authenticated gateway is offline. No cached success or fabricated metric is shown.',
        ],
        dataSeams: registration.dataSeams,
        loadedAt: new Date().toISOString(),
      };
    }
    try {
      return await this.loadConnected(appId);
    } catch (error) {
      return {
        appId,
        status: this.client.isConnected ? 'unavailable' : 'offline',
        facts: [],
        unavailable: [
          error instanceof Error ? error.message : String(error),
        ],
        dataSeams: registration.dataSeams,
        loadedAt: new Date().toISOString(),
      };
    }
  }

  private async loadConnected(appId: CompanyAppId): Promise<CompanyAppSnapshot> {
    const registration = companyAppRegistration(appId);
    const facts: CompanyFact[] = [];
    const unavailable: string[] = [];
    if (appId === 'engineering') {
      const [status, pending, history] = await Promise.all([
        this.client.call<Record<string, unknown>>('status'),
        this.client.call<unknown[]>('exec.pending'),
        this.client.call<unknown[]>('exec.history'),
      ]);
      facts.push(
        { label: 'Gateway version', value: bounded(status.version, 60) || 'unknown', source: 'status' },
        { label: 'Pending bounded actions', value: countArray(pending), source: 'exec.pending' },
        { label: 'Execution receipts', value: countArray(history), source: 'exec.history' },
      );
      unavailable.push(
        'Repository, pull-request, and CI status require a bounded authenticated engineering adapter; this gateway exposes none.',
      );
    }
    if (appId === 'release-operations') {
      const [methods, history, ring] = await Promise.all([
        this.client.call<string[]>('methods'),
        this.client.call<unknown[]>('exec.history'),
        this.ringAdapter.current(),
      ]);
      const releaseMethods = Array.isArray(methods)
        ? methods.filter((method) => /^release[.-]/.test(method))
        : [];
      const receipts = this.store.snapshot().receipts.filter((receipt) =>
        receipt.kind === 'release-ring' ||
        receipt.kind === 'automation-promotion');
      facts.push(
        { label: 'Selected ring', value: ring, source: 'ReleaseRingAdapter' },
        { label: 'Fixture promotion receipts', value: receipts.length, source: 'LivingCompanyDraftStore' },
        { label: 'Approval audit entries', value: countArray(history), source: 'exec.history' },
        { label: 'Release RPCs', value: releaseMethods.length, source: 'methods' },
      );
      if (releaseMethods.length === 0) {
        unavailable.push(
          'Release-ring manifest resolution and promotion await the release-ring dependency PR. No resolver was duplicated.',
        );
      }
    }
    if (appId === 'customer-signals') {
      const [channels, sessions] = await Promise.all([
        this.client.call<unknown[]>('channels.list'),
        this.client.call<unknown[]>('chat.list'),
      ]);
      const messageRecords = Array.isArray(sessions)
        ? sessions.reduce<number>((total, session) => {
            if (!session || typeof session !== 'object') return total;
            const count = Number((session as Record<string, unknown>).messageCount);
            return total + (Number.isFinite(count) ? Math.max(0, count) : 0);
          }, 0)
        : 0;
      facts.push(
        { label: 'Configured channels', value: countArray(channels), source: 'channels.list' },
        { label: 'Existing sessions', value: countArray(sessions), source: 'chat.list' },
        { label: 'Existing message records', value: messageRecords, source: 'chat.list' },
      );
      unavailable.push(
        'No bounded feedback RPC is registered. Message bodies are not read or synthesized by this window.',
      );
    }
    if (appId === 'documentation') {
      const [status, methods] = await Promise.all([
        this.client.call<Record<string, unknown>>('status'),
        this.client.call<string[]>('methods'),
      ]);
      const publishing = Array.isArray(methods) &&
        methods.some((method) => /^docs[.-].*(?:publish|health)/.test(method));
      facts.push(
        { label: 'Gateway', value: status.running === false ? 'stopped' : 'running', source: 'status' },
        { label: 'Publishing health RPC', value: publishing ? 'available' : 'unavailable', source: 'methods' },
      );
      if (!publishing) {
        unavailable.push(
          'Blog/docs publishing health has no registered RPC. Copy actions remain local; publish requires approval and a future adapter.',
        );
      }
    }
    if (appId === 'expenses' || appId === 'decisions') {
      const drafts = this.store.snapshot();
      if (appId === 'expenses') {
        facts.push(
          { label: 'Review-ready drafts', value: drafts.expenses.length, source: 'LivingCompanyDraftStore' },
          { label: 'Submitted by OpenRappter', value: 0, source: 'LivingCompanyDraftStore' },
        );
      } else {
        facts.push(
          { label: 'Decision drafts', value: drafts.decisions.length, source: 'LivingCompanyDraftStore' },
          { label: 'Private CEO memo drafts', value: drafts.memos.length, source: 'LivingCompanyDraftStore' },
          { label: 'Private meme drafts', value: drafts.memes.length, source: 'LivingCompanyDraftStore' },
        );
      }
    }
    if (appId === 'rapp-estate-health') {
      const [status, skills] = await Promise.all([
        this.client.call<Record<string, unknown>>('status'),
        this.client.call<Array<Record<string, unknown>>>('skills.list'),
      ]);
      const audit = Array.isArray(skills) && skills.find((skill) =>
        /ecosystem.?audit/i.test(String(skill.id ?? skill.name ?? '')));
      facts.push(
        { label: 'Authenticated gateway', value: status.running === false ? 'stopped' : 'connected', source: 'status' },
        { label: 'Ecosystem audit skill', value: audit ? 'installed' : 'not discovered', source: 'skills.list' },
      );
      unavailable.push(
        'Live estate drift and declared-core evidence require an authenticated ecosystem-audit adapter and explicit GitHub access; no audit was inferred.',
      );
    }
    return {
      appId,
      status: unavailable.length > 0 ? 'partial' : 'ready',
      facts,
      unavailable,
      dataSeams: registration.dataSeams,
      loadedAt: new Date().toISOString(),
    };
  }
}

export const livingCompanyDraftStore = new LivingCompanyDraftStore();
export const livingCompanyScenario = new LivingCompanyWeekScenario({
  store: livingCompanyDraftStore,
});

export function assertCompanyRegistryComplete(): void {
  for (const id of COMPANY_APP_IDS) companyAppRegistration(id);
}
