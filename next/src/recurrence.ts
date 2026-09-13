import { contentHash, isUtc, type JsonObject } from './canonical.js';
import { Bots, findRoot } from './bots.js';
import { requireThat } from './errors.js';
import { projectBot } from './projection.js';
import { foldState, permittedScopes } from './state.js';

const WEEK = 7 * 24 * 60 * 60 * 1_000;
export class RecurringWork {
  constructor(readonly bots: Bots) {}

  async due(root: string, now = this.bots.now()): Promise<JsonObject[]> {
    requireThat(isUtc(now), 'clock', 'A fixed UTC observation time is required.');
    const snapshot = await this.bots.repository.root(root);
    if (projectBot(snapshot).hidden) return [];
    const state = foldState(snapshot);
    const due: JsonObject[] = [];
    for (const routine of state.routines.values()) {
      let scanned = 0;
      for (let ms = Date.parse(routine.firstDueUtc); ms <= Date.parse(now); ms += WEEK) {
        requireThat(due.length < 128 && ++scanned <= 520, 'recurrence-bound', 'The retained backlog exceeds the bounded review window; explicit reconciliation is required.');
        const occurrence = new Date(ms).toISOString();
        if (!state.ticked.has(`${routine.id}:${occurrence}`)) {
          due.push({ routineId: routine.id, occurrence, instruction: routine.instruction, scope: routine.scope });
        }
      }
    }
    return due;
  }

  async tick(root: string, routineId: string, occurrence: string): Promise<JsonObject> {
    const operationId = `tick-${contentHash({ root, routineId, occurrence })}`;
    const prior = (await this.bots.repository.root(root)).streams.memory.find(f => f.payload.operationId === operationId);
    if (prior) return { source: prior.frame_hash, duplicate: true };
    requireThat((await this.due(root)).some(d => d.routineId === routineId && d.occurrence === occurrence),
      'routine-not-due', 'Only a due occurrence of a complete reviewed recurring intent may run.');
    return this.bots.repository.transaction(async transaction => {
      const snapshot = findRoot(transaction, root);
      requireThat(!projectBot(snapshot).hidden, 'bot-hidden', 'A hidden root has no active scheduled work.');
      const state = foldState(snapshot);
      const routine = state.routines.get(routineId);
      requireThat(routine, 'routine', 'The reviewed routine is unavailable.');
      const id = operationId;
      const duplicate = snapshot.streams.memory.find(f => f.payload.operationId === id);
      if (duplicate) return { source: duplicate.frame_hash, duplicate: true };
      requireThat(!state.ticked.has(`${routineId}:${occurrence}`), 'routine-not-due', 'This occurrence already has a canonical outcome.');
      const permitted = permittedScopes(state.scopes, routine.scope);
      const context = snapshot.streams.memory.filter(f => permitted.has(String(f.payload.scope))).slice(-8);
      const progress = state.progress.filter(p => permitted.has(String(p.scope))).at(-1);
      const summary = `Canonical recap for ${routine.instruction}: ${context.length} recent scoped public records read first. `
        + (progress ? `Latest internal progress: ${String(progress.summary).slice(0, 900)}. ` : 'No prior internal progress is recorded. ')
        + 'Reversible internal recap completed; no model, native-store write, delivery or external effect was run.';
      const frame = await this.bots.appendEvent(transaction, snapshot, 'routine.tick',
        { routineId, occurrence, summary, evidence: context.map(f => f.frame_hash) }, id, routine.scope);
      return { source: frame.frame_hash, summary, observation: 'deterministic-authorized-internal-work', aiCalls: 0 };
    });
  }
}
