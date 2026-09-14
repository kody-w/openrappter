import { canonicalJson, contentHash, type JsonObject, type RappFrame } from './canonical.js';
import { Bots, findRoot } from './bots.js';
import { label, object, text, workEvent } from './contract.js';
import { requireThat } from './errors.js';
import { validateDraft } from './intent.js';
import { orient, projectBot, reference, type BotProjection } from './projection.js';
import type { RootSnapshot } from './repository.js';
import { applyScopedActions, foldState, permittedScopes, validateEvidence, validateResolutions } from './state.js';
import type { ModelProvider } from './spine.js';
import { publicationData } from './ai-contract.js';
import { catchUpTimeline } from './catch-up.js';
import { CanonicalComputerReplay } from './computer-replay.js';
import { memoryFrames, memoryCursor, sourceChain, sourceReference } from './source-memory.js';

export function canonicalContext(root: RootSnapshot, scope = 'root'): JsonObject {
  const state = foldState(root);
  const permitted = permittedScopes(state.scopes, scope);
  const turns = memoryFrames(root).filter(frame => {
    const e = workEvent(frame.payload);
    return permitted.has(e.scope) && ['turn.user', 'turn.assistant', 'client.conversation'].includes(e.event);
  }).slice(-20).map(frame => {
    const data = workEvent(frame.payload).data;
    const client = frame.payload.event === 'client.conversation' ? publicationData('conversation', data) : null;
    return { role: frame.payload.event === 'turn.user' ? 'user' : 'assistant',
      text: client ? `[${client.actor.name} / ${client.actor.provider}] ${String(client.content.text)}` : String(data.text),
      source: reference(frame), origin: sourceReference(frame) };
  });
  const discovery = memoryFrames(root).filter(f => f.payload.event === 'discovery.recorded' && permitted.has(String(f.payload.scope)))
    .slice(-4).map(f => {
      const data = workEvent(f.payload).data;
      return { source: reference(f), pointers: data.pointers!, ...(data.observations === undefined ? {} : { observations: data.observations }) };
    });
  return {
    root: root.definition.root, scope,
    head: sourceChain(root, scope).at(-1)?.frame_hash ?? root.streams.body[0]!.frame_hash,
    sourceCursor: memoryCursor(root),
    scopes: state.scopes.filter(s => permitted.has(s.id)),
    turns, discovery,
    artifacts: [...state.artifacts.values()].filter(a => permitted.has(String(a.scope))),
    pointers: [...state.pointers.values()].filter(p => permitted.has(String(p.scope))),
    progress: state.progress.filter(p => permitted.has(String(p.scope))).slice(-10),
    pendingQuestions: [...state.proposals].filter(([, p]) => p.status === 'review' && p.draft.questions.length
      && permitted.has(String(p.frame.payload.scope))).map(([wave, p]) => ({ wave, questions: p.draft.questions })),
    authority: 'canonical-integrity-only; evidence is not factual truth',
  };
}

function contextWitness(root: RootSnapshot, scope: string, exclude?: string): { revision: string; parents: string[] } {
  const scopes = foldState(root).scopes;
  const permitted = permittedScopes(scopes, scope);
  const frames = memoryFrames(root).filter(f => f.frame_hash !== exclude && permitted.has(String(f.payload.scope)));
  return { revision: contentHash({ root: root.definition.root, scope, scopes: scopes.filter(s => permitted.has(s.id)),
    occurrences: frames.map(f => f.frame_hash).sort() }),
  parents: [...new Map(frames.map(f => [f.stream_id, f.frame_hash])).values()] };
}

export interface ConversationResult {
  readonly status: 'review' | 'complete' | 'unavailable' | 'incomplete' | 'orientation';
  readonly projection: BotProjection;
  readonly proposalWave: string | null;
  readonly text: string;
  readonly catchUp?: JsonObject;
}

export class Conversation {
  constructor(readonly bots: Bots, readonly provider: ModelProvider, readonly computerReplay?: CanonicalComputerReplay) {}

  async catchUp(root: string, options: unknown = {}, scope = 'root'): Promise<JsonObject> {
    return catchUpTimeline(await this.bots.repository.root(root), scope, options, this.computerReplay);
  }

  async converse(root: string, thought: string, operationId: string, scope = 'root'): Promise<ConversationResult> {
    text(thought);
    label(operationId);
    label(scope);
    if (/^\s*catch me up[?.!]*\s*$/iu.test(thought)) {
      const snapshot = await this.bots.repository.root(root);
      const timeline = catchUpTimeline(snapshot, scope);
      const grades = object(timeline.grades);
      return { status: 'orientation', projection: projectBot(snapshot), proposalWave: null, catchUp: timeline,
        text: `Catch me up: a deterministic canonical replay with ${String(grades.recorded)} recorded, ${String(grades.reconstructed)} reconstructed and ${String(grades.unavailable)} unavailable presentation steps. No model, tool or mutation was replayed.` };
    }
    if (/^\s*(?:where were we|where are we|resume orientation)[?.!]*\s*$/iu.test(thought)) {
      const projection = await this.bots.project(root);
      return { status: 'orientation', projection, proposalWave: null, text: orient(projection).text };
    }
    if (/^\s*(?:clear(?: this bot)?|hide this bot|restore this bot)[.!]*\s*$/iu.test(thought)) {
      requireThat(scope === 'root', 'scope-isolation', 'Clear/restore applies only to an explicitly selected root bot, never a guessed internal scope.');
      const hidden = !/^\s*restore/iu.test(thought);
      const projection = await this.bots.visibility(root, hidden, operationId);
      return { status: 'complete', projection, proposalWave: null,
        text: `${hidden ? 'Hidden' : 'Restored'} ${projection.name}. The same root GUID, history and branches remain intact; nothing was deleted.` };
    }
    const confirmation = /^\s*(?:yes(?:,? (?:do that|do it))?|go ahead|confirm(?: ([0-9a-f]{64}))?)[.!]*\s*$/iu.exec(thought);
    if (confirmation) {
      const snapshot = await this.bots.repository.root(root);
      const state = foldState(snapshot);
      const previous = memoryFrames(snapshot).find(f => f.payload.operationId === operationId);
      if (previous) requireThat(previous.payload.event === 'organization.applied', 'idempotency-conflict', 'This command ID already belongs to different work.');
      const target = confirmation[1] ?? (previous ? String(workEvent(previous.payload).data.proposalWave) : sourceChain(snapshot, scope).at(-1)?.frame_hash);
      const proposal = target ? state.proposals.get(target) : undefined;
      requireThat(proposal && permittedScopes(state.scopes, scope).has(String(proposal.frame.payload.scope)),
        'confirmation-context', 'There is no exact current proposal in this permitted scope to confirm. No model or effect was run.');
      const projection = await this.confirm(root, target!, operationId);
      return { status: 'complete', projection, proposalWave: target!,
        text: `Confirmed the exact reviewed plan: ${proposal.draft.summary} External effects still require their own exact approval.` };
    }
    const input = await this.bots.repository.transaction(async transaction => {
      const snapshot = findRoot(transaction, root);
      const projection = projectBot(snapshot);
      requireThat(!projection.hidden, 'bot-hidden', 'Restore this bot before asking it to work.');
      permittedScopes(projection.scopes, scope);
      const duplicate = memoryFrames(snapshot).find(f => f.payload.operationId === operationId);
      if (duplicate) {
        requireThat(duplicate.payload.event === 'turn.user' && workEvent(duplicate.payload).data.text === thought
          && duplicate.payload.scope === scope, 'idempotency-conflict', 'This request ID already records a different thought.');
        return { frame: duplicate, started: false };
      }
      const frame = await this.bots.appendEvent(transaction, snapshot, 'turn.user', { text: thought }, operationId, scope);
      return { frame, started: true };
    });
    if (!input.started) return this.#result(root, input.frame);
    const handle = this.bots.spine.observe(root);
    try {
      const snapshot = await this.bots.repository.root(root);
      const basis = contextWitness(snapshot, scope);
      const raw = await this.bots.spine.compute(handle, snapshot.definition.capability, {
        root, scope, thought, context: canonicalContext(snapshot, scope), purpose: 'organization',
      }, this.provider);
      const draft = validateDraft(raw, this.bots.now());
      await this.bots.repository.transaction(async transaction => {
        const current = findRoot(transaction, root);
        requireThat(!projectBot(current).hidden, 'bot-hidden', 'A hidden bot cannot finish an unobserved proposal.');
        requireThat(sourceChain(current, scope).at(-1)?.frame_hash === input.frame.frame_hash && contextWitness(current, scope).revision === basis.revision, 'stale-head',
          'The canonical context changed during inference. A fresh review is required, not stale work.');
        const preview = foldState(current);
        validateResolutions(preview, draft, scope);
        applyScopedActions(preview, draft.actions, current, input.frame.frame_hash, scope);
        const summary = [
          draft.summary,
          ...draft.tradeoffs.map(t => `Tradeoff: ${t}`),
          ...draft.questions.map(q => `Human decision: ${q.question}`),
          ...draft.resolves.map(hash => `Confirmation also supersedes the human question at ${hash} with this reviewed answer.`),
          ...draft.actions.filter(a => a.type === 'routine.create').map(a =>
            `Recurring intent: ${a.instruction}; every Monday at 09:00 UTC, first ${a.firstDueUtc}.`),
          ...(draft.actions.length || draft.resolves.length ? ['Nothing has been applied. Confirm this exact proposal to create bounded internal successors. External effects require a separate exact approval.'] : []),
        ].join('\n');
        return this.bots.appendEvent(transaction, current, 'turn.assistant',
          { text: summary, replyTo: input.frame.frame_hash, draft, draftHash: contentHash(draft), contextRevision: basis.revision },
          `reply-${input.frame.frame_hash}`, scope, undefined, basis.parents);
      });
    } catch {
      await this.bots.repository.transaction(async transaction => {
        const current = findRoot(transaction, root);
        if (memoryFrames(current).some(f => workEvent(f.payload).data.replyTo === input.frame.frame_hash)) return;
        await this.bots.appendEvent(transaction, current, 'provider.unavailable', {
          replyTo: input.frame.frame_hash,
          summary: 'The selected provider, verified interpreter or current context was unavailable. Your thought is recorded. No fallback, tool execution or automatic replay occurred.',
        }, `unavailable-${input.frame.frame_hash}`, scope);
      });
    } finally { await this.bots.spine.unobserve(handle); }
    return this.#result(root, input.frame);
  }

  async #result(root: string, input: RappFrame): Promise<ConversationResult> {
    const snapshot = await this.bots.repository.root(root);
    const reply = memoryFrames(snapshot).find(f => workEvent(f.payload).data.replyTo === input.frame_hash);
    const projection = projectBot(snapshot);
    const draft = reply?.payload.event === 'turn.assistant' && workEvent(reply.payload).data.draft
      ? validateDraft(workEvent(reply.payload).data.draft) : null;
    return {
      status: !reply ? 'incomplete' : !draft ? 'unavailable' : draft.actions.length || draft.questions.length || draft.resolves.length ? 'review' : 'complete',
      projection, proposalWave: draft && reply ? reply.frame_hash : null,
      text: reply ? String(workEvent(reply.payload).data.text ?? workEvent(reply.payload).data.summary) : 'The recorded thought is incomplete; no model or tool was replayed. Rephrase with a new request ID only if you intend a new attempt.',
    };
  }

  async confirm(root: string, proposalWave: string, operationId: string): Promise<BotProjection> {
    await this.bots.repository.transaction(async transaction => {
      const snapshot = findRoot(transaction, root);
      requireThat(!projectBot(snapshot).hidden, 'bot-hidden', 'Restore this bot before confirming work.');
      const state = foldState(snapshot);
      const proposal = state.proposals.get(proposalWave);
      requireThat(proposal, 'proposal', 'Choose an exact canonical proposal wave from this root.');
      const data = { proposalWave, summary: proposal.draft.summary, actor: 'local-operator' };
      const duplicate = memoryFrames(snapshot).find(f => f.payload.operationId === operationId);
      if (duplicate) {
        await this.bots.appendEvent(transaction, snapshot, 'organization.applied', data, operationId, String(proposal.frame.payload.scope));
        return;
      }
      requireThat(proposal.status === 'review' && proposal.draft.questions.length === 0, 'human-question',
        'Only an unconfirmed proposal with no unresolved human questions can be applied.');
      requireThat(sourceChain(snapshot, String(proposal.frame.payload.scope)).at(-1)?.frame_hash === proposalWave, 'stale-head', 'The proposal is stale; review current canonical context before confirmation.');
      const basis = workEvent(proposal.frame.payload).data.contextRevision;
      requireThat(basis === undefined || basis === contextWitness(snapshot, String(proposal.frame.payload.scope), proposalWave).revision,
        'stale-head', 'A permitted source changed since this proposal read canonical context; a fresh review is required.');
      validateResolutions(state, proposal.draft, String(proposal.frame.payload.scope));
      applyScopedActions(state, proposal.draft.actions, snapshot, proposalWave, String(proposal.frame.payload.scope));
      await this.bots.appendEvent(transaction, snapshot, 'organization.applied', data, operationId, String(proposal.frame.payload.scope), proposalWave);
    });
    return this.bots.project(root);
  }

  async recordProgress(root: string, scope: string, summary: string, evidence: string[], operationId: string): Promise<BotProjection> {
    await this.bots.repository.transaction(async transaction => {
      const snapshot = findRoot(transaction, root);
      const projection = projectBot(snapshot);
      requireThat(!projection.hidden, 'bot-hidden', 'Hidden roots do not perform work.');
      permittedScopes(projection.scopes, scope);
      await this.bots.appendEvent(transaction, snapshot, 'work.progress',
        { summary: text(summary, 2_000), evidence: validateEvidence(evidence, snapshot) }, operationId, scope);
    });
    return this.bots.project(root);
  }

  async undo(root: string, targetWave: string, reason: string, operationId: string): Promise<BotProjection> {
    await this.bots.repository.transaction(async transaction => {
      const snapshot = findRoot(transaction, root);
      requireThat(!projectBot(snapshot).hidden, 'bot-hidden', 'Restore this root before correcting work.');
      const data = { targetWave, reason: text(reason, 1_000) };
      const duplicate = memoryFrames(snapshot).find(f => f.payload.operationId === operationId);
      if (duplicate) {
        requireThat(canonicalJson(workEvent(duplicate.payload).data) === canonicalJson(data), 'idempotency-conflict', 'Correction ID is already bound.');
        return;
      }
      const target = memoryFrames(snapshot).find(f => f.frame_hash === targetWave);
      requireThat(target && ['organization.applied', 'work.progress', 'routine.tick'].includes(String(target.payload.event)),
        'correction', 'Only this root’s reversible internal outcomes can be corrected, never external effects or history.');
      const state = foldState(snapshot);
      requireThat(!state.corrected.has(targetWave), 'correction', 'This outcome is already corrected.');
      foldState(snapshot, [targetWave]);
      await this.bots.appendEvent(transaction, snapshot, 'state.corrected', data, operationId, String(target.payload.scope));
    });
    return this.bots.project(root);
  }
}
