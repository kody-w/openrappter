import assert from 'node:assert/strict';
import { canonicalJson, contentHash } from '../dist/canonical.js';
import { atCursor, cursorFor } from '../dist/ai-projector.js';
import { foldState, permittedScopes } from '../dist/state.js';
import {
  memoryAdvance, memoryFrames, memoryHeadHashes, memoryPending, memoryPrefix, sourceReference,
} from '../dist/source-memory.js';

const SCHEMA = 'rapp-work.catch-up-verification-input/1';
const LIMIT = 16;
const same = (actual, expected) => assert.equal(canonicalJson(actual), canonicalJson(expected));

function branchCatalogue(root) {
  return new Map((root.sources ?? []).map(source => [source.scope, new Set(source.branches.map(branch => branch.head))]));
}

function branchDelta(end, from) {
  const previous = branchCatalogue(from);
  return (end.sources ?? []).flatMap(source => source.branches
    .filter(branch => !previous.get(source.scope)?.has(branch.head))
    .map(branch => ({ scope: source.scope, head: branch.head })))
    .sort((a, b) => a.scope.localeCompare(b.scope) || a.head.localeCompare(b.head))
    .map(branch => branch.head);
}

function expectedProvenance(frame) {
  const event = String(frame.payload.event);
  const data = frame.payload.data ?? {};
  if (event.startsWith('client.')) {
    const kind = event.slice('client.'.length);
    const references = kind === 'activity' ? data.content?.evidence
      : kind === 'evidence' || kind === 'attention' ? data.content?.references : [];
    return [...new Set([
      frame.frame_hash, ...(data.causes ?? []), ...(data.viewParents ?? []),
      ...(Array.isArray(references) ? references : []),
    ])];
  }
  const evidence = Array.isArray(data.evidence)
    ? data.evidence.filter(value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)) : [];
  const collaboration = ['collaboration.perspective', 'collaboration.synthesized'].includes(event)
    ? [data.requestWave, data.responseWave].filter(value =>
      typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)) : [];
  return [...new Set([frame.frame_hash, ...evidence, ...collaboration])];
}

function verifyState(point, root, scope, cursor) {
  if (point.state === null) {
    assert.equal(point.stateDigest, null);
    return;
  }
  assert.equal(contentHash(point.state), point.stateDigest);
  assert.equal(point.state.root, root);
  assert.equal(point.state.scope, scope);
  same(point.state.cursor, cursor);
}

// Test-only passive fast-forward reducer. It requires canonical frames plus an
// out-of-band request/digest pin; the imported replay document never vouches
// for its own selection, cursor chain, origins or timeline digest.
export class CatchUpPlayer {
  constructor(root, scope) {
    assert(root && typeof root === 'object' && root.definition);
    this.canonicalRoot = root;
    this.root = root.definition.root;
    this.scope = scope;
    this.cursor = null;
    this.state = null;
    this.stateDigest = null;
    this.grades = [];
  }

  load(page, trusted) {
    assert.equal(trusted?.schema, SCHEMA);
    assert.equal(trusted.root, this.root);
    assert.equal(trusted.scope, this.scope);
    assert.match(trusted.trustedTimelineDigest, /^[0-9a-f]{64}$/u);
    const request = trusted.request ?? {};
    const limit = request.limit === undefined ? LIMIT : request.limit;
    assert(Number.isInteger(limit) && limit >= 1 && limit <= LIMIT);
    const end = request.to === undefined ? this.canonicalRoot : atCursor(this.canonicalRoot, request.to);
    const endFrames = memoryFrames(end);
    const from = request.from === undefined
      ? memoryPrefix(end, Math.max(0, endFrames.length - limit))
      : atCursor(this.canonicalRoot, request.from);
    const pending = memoryPending(end, from);
    const expectedFrom = cursorFor(from);
    const expectedTo = cursorFor(end);
    const guestPolicy = request.guest === undefined ? null : request.guest;
    const selection = {
      root: this.root, scope: this.scope, from: expectedFrom, to: expectedTo,
      sourceFrameHashes: pending.map(frame => frame.frame_hash),
      guestPolicy, guestEvidenceDigest: guestPolicy === null ? null : trusted.guestEvidenceDigest ?? null,
    };

    assert.equal(page.schema, 'rapp-work.catch-up/1');
    assert.equal(page.root, this.root);
    assert.equal(page.scope, this.scope);
    same(page.from, expectedFrom);
    same(page.to, expectedTo);
    assert.equal(page.selectionDigest, contentHash(selection));
    const { timelineDigest, ...payload } = page;
    assert.equal(timelineDigest, trusted.trustedTimelineDigest);
    assert.equal(contentHash(payload), trusted.trustedTimelineDigest);
    same(page.baseline.cursor, expectedFrom);
    assert.deepEqual(page.baseline.sourceFrameHashes,
      [this.canonicalRoot.streams.body[0].frame_hash, ...memoryHeadHashes(from)]);
    verifyState(page.baseline, this.root, this.scope, expectedFrom);
    assert(page.steps.length <= limit);

    const allowed = permittedScopes(foldState(this.canonicalRoot).scopes, this.scope);
    let occurrence = 0;
    let cursor = expectedFrom;
    let stateOnly = false;
    for (const step of page.steps) {
      same(step.previousCursor, cursor);
      if (step.stepKind === 'occurrence') {
        assert(!stateOnly);
        const frame = pending[occurrence];
        assert(frame, 'Replay page advanced beyond the canonical selection.');
        const after = memoryAdvance(end, from, ++occurrence);
        cursor = cursorFor(after);
        const visible = allowed.has(String(frame.payload.scope));
        same(step.cursor, cursor);
        assert.equal(step.event, visible ? frame.payload.event : 'scoped-record-unavailable');
        same(step.origin, visible ? sourceReference(frame) : null);
        if (step.guest === null) assert.deepEqual(step.sourceFrameHashes, visible ? expectedProvenance(frame) : [frame.frame_hash]);
        else assert(step.sourceFrameHashes.includes(frame.frame_hash));
      } else {
        assert.equal(step.stepKind, 'state-only');
        assert(!stateOnly);
        assert.equal(occurrence, pending.length);
        assert.notEqual(canonicalJson(cursor), canonicalJson(expectedTo));
        assert.equal(step.event, 'retained-source-branches-changed');
        assert.equal(step.workGrade, 'unavailable');
        assert.equal(step.origin, null);
        assert.deepEqual(step.sourceFrameHashes, branchDelta(end, from));
        cursor = expectedTo;
        same(step.cursor, cursor);
        stateOnly = true;
      }
      verifyState(step, this.root, this.scope, cursor);
      if (step.guest !== null) assert.equal(contentHash(step.guest), step.guestDigest);
      else assert.equal(step.guestDigest, null);
    }
    same(page.next, cursor);
    assert.equal(page.more, occurrence < pending.length || canonicalJson(cursor) !== canonicalJson(expectedTo));
    if (!page.more) same(page.next, page.to);

    this.steps = page.steps;
    this.position = 0;
    this.cursor = page.baseline.cursor;
    this.state = page.baseline.state;
    this.stateDigest = page.baseline.stateDigest;
  }

  forward(count = 1) {
    assert(Number.isInteger(count) && count >= 0);
    while (count-- > 0 && this.position < this.steps.length) {
      const step = this.steps[this.position++];
      same(step.previousCursor, this.cursor);
      verifyState(step, this.root, this.scope, step.cursor);
      this.cursor = step.cursor;
      this.state = step.state;
      this.stateDigest = step.stateDigest;
      this.grades.push(step.grade);
    }
    return this.state;
  }
}
