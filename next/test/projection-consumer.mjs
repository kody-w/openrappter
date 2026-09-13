import assert from 'node:assert/strict';

// A test render-model reducer: no DOM, renderer, UI code, persistence or authority.
export class TestProjectionConsumer {
  constructor(root) { this.root = root; this.cursor = null; this.state = null; this.resync = null; }
  accept(event) {
    assert.equal(event.schema, 'rapp-work.projection-event/1');
    if (event.type === 'resync-required') { this.resync = event.reason; return; }
    assert.equal(event.snapshot.root, this.root);
    if (event.type === 'update') assert.deepEqual(event.previous, this.cursor);
    this.cursor = event.cursor;
    const view = event.snapshot.view;
    this.state = {
      root: this.root,
      layout: view.effective?.emphasis ?? 'conversation',
      focus: view.effective?.focus ?? null,
      visibleCards: view.effective?.cards ?? [],
      screenArtifact: view.effective?.screenArtifact ?? null,
      progress: view.progress,
      conflicts: view.conflicts,
      turns: event.snapshot.turns.map(t => ({ actor: t.actor.id, text: t.text })),
      activity: event.snapshot.activity,
    };
  }
}
