import assert from 'node:assert/strict';
import { contentHash } from '../dist/canonical.js';

// Test-only passive fast-forward reducer. A digest pin comes from the trusted
// caller, not from a self-authenticating imported replay document.
export class CatchUpPlayer {
  constructor(root, scope) { this.root = root; this.scope = scope; this.cursor = null; this.state = null; this.stateDigest = null; this.grades = []; }
  load(page, trustedDigest) {
    assert.equal(page.schema, 'rapp-work.catch-up/1');
    assert.equal(page.root, this.root);
    assert.equal(page.scope, this.scope);
    const { timelineDigest, ...payload } = page;
    assert.equal(timelineDigest, trustedDigest);
    assert.equal(contentHash(payload), trustedDigest);
    this.steps = page.steps;
    this.position = 0;
    this.cursor = page.baseline.cursor;
    this.state = page.baseline.state;
    this.stateDigest = page.baseline.stateDigest;
    if (this.state !== null) assert.equal(contentHash(this.state), this.stateDigest);
  }
  forward(count = 1) {
    assert(Number.isInteger(count) && count >= 0);
    while (count-- > 0 && this.position < this.steps.length) {
      const step = this.steps[this.position++];
      assert.deepEqual(step.previousCursor, this.cursor);
      if (step.state !== null) assert.equal(contentHash(step.state), step.stateDigest);
      else assert.equal(step.stateDigest, null);
      this.cursor = step.cursor;
      this.state = step.state;
      this.stateDigest = step.stateDigest;
      this.grades.push(step.grade);
    }
    return this.state;
  }
}
