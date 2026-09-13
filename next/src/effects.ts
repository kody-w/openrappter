import { type JsonObject } from './canonical.js';
import { Bots, findRoot } from './bots.js';
import { workEvent } from './contract.js';
import { Refusal, requireThat } from './errors.js';
import { projectBot } from './projection.js';
import { foldState } from './state.js';

export interface ExternalEffectPort {
  readonly available: boolean;
  execute(input: { root: string; operation: 'send-message'; target: string; content: string; idempotencyKey: string }): Promise<{ receipt: string }>;
}
export class UnavailableExternalEffects implements ExternalEffectPort {
  readonly available = false;
  async execute(): Promise<{ receipt: string }> { throw new Refusal('external-unavailable', 'No external-effect adapter is authorized.'); }
}

export class ExternalActions {
  constructor(readonly bots: Bots, readonly port: ExternalEffectPort = new UnavailableExternalEffects()) {}

  async approve(root: string, effectId: string, requestHash: string, target: string, operationId: string): Promise<JsonObject> {
    const prepared = await this.bots.repository.transaction(async transaction => {
      const snapshot = findRoot(transaction, root);
      requireThat(!projectBot(snapshot).hidden, 'bot-hidden', 'Restore this root before approving an external action.');
      const effect = foldState(snapshot).effects.get(effectId);
      requireThat(effect && effect.requestHash === requestHash && effect.target === target,
        'approval-binding', 'Approval must name the exact reviewed effect hash, target and root.');
      const existing = snapshot.streams.memory.find(f => f.payload.event === 'effect.approved' && workEvent(f.payload).data.effectId === effectId);
      if (existing) {
        requireThat(existing.payload.operationId === operationId, 'approval-used', 'This effect already has an approval; an uncertain action is never retried automatically.');
        return { approval: existing, effect, started: false };
      }
      const approval = await this.bots.appendEvent(transaction, snapshot, 'effect.approved',
        { effectId, requestHash, target, actor: 'local-operator' }, operationId, String(effect.scope));
      return { approval, effect, started: true };
    });
    if (!prepared.started) return { status: 'already-recorded-or-uncertain', approval: prepared.approval.frame_hash, replayed: false };
    let status = 'unavailable';
    let receipt: string | null = null;
    if (this.port.available) {
      try {
        const current = await this.bots.repository.root(root);
        requireThat(!projectBot(current).hidden && foldState(current).effects.get(effectId)?.requestHash === requestHash,
          'approval-binding', 'The approved effect is no longer current.');
        const result = await this.port.execute({ root, operation: 'send-message', target,
          content: String(prepared.effect.content), idempotencyKey: prepared.approval.frame_hash });
        requireThat(typeof result.receipt === 'string' && /^[A-Za-z0-9._:-]{1,200}$/u.test(result.receipt),
          'receipt', 'Only a bounded opaque delivery receipt may be persisted.');
        receipt = result.receipt;
        status = 'completed';
      } catch { status = 'uncertain'; }
    }
    await this.bots.repository.transaction(async transaction => {
      const snapshot = findRoot(transaction, root);
      await this.bots.appendEvent(transaction, snapshot, 'effect.outcome',
        { effectId, approval: prepared.approval.frame_hash, status, receipt },
        `effect-${prepared.approval.frame_hash}`, String(prepared.effect.scope));
    });
    return { status, receipt, approval: prepared.approval.frame_hash, replayed: false };
  }
}
