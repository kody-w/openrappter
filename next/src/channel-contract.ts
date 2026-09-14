import { isUtc, type JsonObject, type RappFrame } from './canonical.js';
import { label, list, object, text, workEvent } from './contract.js';
import { requireThat } from './errors.js';
import type { RootSnapshot } from './repository.js';
import { memoryFrames } from './source-memory.js';
import { foldState } from './state.js';

export interface ChannelPolicy extends JsonObject {
  automaticQuestions: boolean;
  timezone: string;
  quietHours: { startMinute: number; endMinute: number } | null;
  maxPerHour: number;
  minIntervalSeconds: number;
  maxBatch: number;
  maxPending: number;
  ttlSeconds: number;
  retrySeconds: number;
  preflightSeconds: number;
}
export const DEFAULT_CHANNEL_POLICY: ChannelPolicy = Object.freeze({
  automaticQuestions: false, timezone: 'UTC', quietHours: null,
  maxPerHour: 2, minIntervalSeconds: 0, maxBatch: 3, maxPending: 16,
  ttlSeconds: 86_400, retrySeconds: 0, preflightSeconds: 30,
});
export function channelPolicy(value: unknown): ChannelPolicy {
  const p = object(value, Object.keys(DEFAULT_CHANNEL_POLICY));
  requireThat(typeof p.automaticQuestions === 'boolean', 'channel-policy', 'Automatic question queueing requires explicit owner policy.');
  text(p.timezone, 80);
  try { new Intl.DateTimeFormat('en-US', { timeZone: String(p.timezone) }).format(0); }
  catch { requireThat(false, 'channel-policy', 'Choose an existing IANA timezone.'); }
  const integer = (value: unknown, min: number, max: number): void =>
    requireThat(typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max,
      'channel-policy', 'Channel policy exceeds its bounded integer range.');
  integer(p.maxPerHour, 1, 8); integer(p.minIntervalSeconds, 0, 3_600);
  integer(p.maxBatch, 1, 4); integer(p.maxPending, 1, 32);
  integer(p.ttlSeconds, 60, 86_400); integer(p.retrySeconds, 0, 3_600); integer(p.preflightSeconds, 1, 30);
  if (p.quietHours !== null) {
    const q = object(p.quietHours, ['startMinute', 'endMinute']);
    integer(q.startMinute, 0, 1_439); integer(q.endMinute, 0, 1_439);
    requireThat(q.startMinute !== q.endMinute, 'channel-policy', 'Quiet hours must be a nonempty partial-day interval.');
  }
  return p as ChannelPolicy;
}
export function isQuiet(policy: ChannelPolicy, utc: string): boolean {
  requireThat(isUtc(utc), 'clock', 'Channel decisions require an exact UTC observation.');
  if (!policy.quietHours) return false;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: policy.timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(utc));
  const minute = Number(parts.find(p => p.type === 'hour')!.value) * 60 + Number(parts.find(p => p.type === 'minute')!.value);
  const { startMinute: start, endMinute: end } = policy.quietHours;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export interface ClarifyMarker extends JsonObject {
  schema: 'rapp-work.clarify/1';
  kind: 'human-question' | 'gauntlet';
  turnId: string;
  requires: 'copilot-cli';
  questions: { id: string; reason: 'human-authority' | 'irreducible-ambiguity'; text: string }[];
}
export function clarifyMarker(value: unknown, turnId: string): ClarifyMarker {
  const m = object(value, ['schema', 'kind', 'turnId', 'requires', 'questions']);
  requireThat(m.schema === 'rapp-work.clarify/1' && typeof m.kind === 'string' && ['human-question', 'gauntlet'].includes(m.kind)
    && m.turnId === turnId && m.requires === 'copilot-cli', 'clarify-binding',
  'A canonical clarification must bind its own assistant publication and genuine CLI answer authority.');
  label(m.turnId);
  const questions = list(m.questions, 3).map(value => {
    const q = object(value, ['id', 'reason', 'text']);
    label(q.id); text(q.text, 700);
    requireThat(q.reason === 'human-authority' || q.reason === 'irreducible-ambiguity', 'clarify-binding', 'Only an irreducible human dependency can interrupt.');
    return q;
  });
  requireThat(questions.length > 0 && new Set(questions.map(q => q.id)).size === questions.length,
    'clarify-binding', 'A clarification has one to three distinct bounded questions.');
  return m as ClarifyMarker;
}
export function canonicalClarification(frame: RappFrame): ClarifyMarker | null {
  if (frame.payload.event !== 'turn.assistant') return null;
  const e = workEvent(frame.payload);
  if (e.data.clarify === undefined) return null;
  requireThat(e.data.origin === 'copilot-cli' || e.data.origin === 'canonical-core', 'clarify-binding', 'A channel or untrusted client cannot fabricate a CLI clarification producer.');
  text(e.data.text);
  return clarifyMarker(e.data.clarify, e.operationId);
}
export function questionPending(root: RootSnapshot, source: string): boolean {
  const frames = memoryFrames(root);
  const question = frames.find(f => f.frame_hash === source);
  if (!question || !canonicalClarification(question)) return false;
  if (foldState(root).proposals.get(source)?.status === 'superseded') return false;
  return !frames.some(f => f.payload.event === 'turn.user' && f.payload.scope === question.payload.scope
    && workEvent(f.payload).data.origin === 'copilot-cli' && workEvent(f.payload).data.answerTo === source);
}
export function turnAttribution(frame: RappFrame): JsonObject {
  const e = workEvent(frame.payload);
  if (e.data.origin === 'external-imessage') {
    requireThat(e.event === 'turn.user' && e.data.role === 'user' && e.data.proposalId === null
      && e.data.replyTo === undefined && e.data.answerTo === undefined, 'external-attribution', 'External inbox data has no reply/answer/confirmation authority.');
    return { origin: 'external', channel: 'imessage', approvalAuthority: false };
  }
  if (e.event === 'client.conversation') return { origin: 'ai-client', approvalAuthority: false };
  if (e.data.origin === 'canonical-core') return { origin: 'canonical-core', approvalAuthority: false };
  return { origin: e.data.origin === 'copilot-cli' ? 'copilot-cli' : 'canonical-history',
    approvalAuthority: e.event === 'turn.user' && e.data.origin === 'copilot-cli' };
}
