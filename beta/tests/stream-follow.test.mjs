import assert from "node:assert/strict";
import test from "node:test";

await import("../ui/stream-follow.js");

const { createTailFollower } = globalThis.RappStreamFollow;

test("tail follower unpins on user scroll up and resumes at the bottom", () => {
  let distance = 0;
  const pins = [];
  const follower = createTailFollower({
    distanceFromBottom: () => distance,
    pinToBottom: (reason) => pins.push(reason),
  });

  assert.equal(follower.start().following, true);
  follower.contentChanged();
  distance = 160;
  assert.equal(
    follower.handleScroll({ userInitiated: true }).following,
    false,
  );
  follower.contentChanged();
  assert.deepEqual(pins, ["start", "content"]);

  distance = 20;
  assert.equal(
    follower.handleScroll({ userInitiated: true }).following,
    true,
  );
  follower.contentChanged();
  assert.deepEqual(pins, ["start", "content", "resume", "content"]);
});

test("tail follower ignores programmatic scroll notifications", () => {
  let distance = 500;
  const pins = [];
  const follower = createTailFollower({
    distanceFromBottom: () => distance,
    pinToBottom: (reason) => pins.push(reason),
  });

  follower.start();
  const state = follower.handleScroll({ userInitiated: false });
  assert.equal(state.following, true);
  follower.contentChanged();
  assert.deepEqual(pins, ["start", "content"]);
});

test("completion pins exactly once even after the user unpins", () => {
  let distance = 200;
  const pins = [];
  const follower = createTailFollower({
    distanceFromBottom: () => distance,
    pinToBottom: (reason) => pins.push(reason),
  });

  follower.start();
  follower.handleScroll({ userInitiated: true });
  assert.equal(follower.state().following, false);
  follower.complete();
  follower.complete();

  assert.deepEqual(pins, ["start", "complete"]);
  assert.equal(follower.state().active, false);
  assert.equal(follower.state().completionPinned, true);
});

test("a new reply always resumes tail following", () => {
  let distance = 200;
  const pins = [];
  const follower = createTailFollower({
    distanceFromBottom: () => distance,
    pinToBottom: (reason) => pins.push(reason),
  });

  follower.start();
  follower.handleScroll({ userInitiated: true });
  follower.complete();
  distance = 300;
  follower.start();

  assert.equal(follower.state().following, true);
  assert.deepEqual(pins, ["start", "complete", "start"]);
});
