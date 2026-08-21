import assert from "node:assert/strict";
import test from "node:test";

await import("../ui/typing-delivery.js");

const { createDelivery } = globalThis.RappTypingDelivery;

test("delivery buffers deltas across tool events and preserves callback ordering", () => {
  const events = [];
  const delivery = createDelivery({
    onTyping: () => events.push(["typing"]),
    onDeliver: (text) => events.push(["deliver", text]),
    onError: (error) => events.push(["error", error]),
  });

  assert.equal(delivery.push("one"), true);
  assert.equal(delivery.tool({ name: "inspect" }), true);
  assert.equal(delivery.push(" two"), true);
  assert.equal(delivery.finish(), true);

  assert.deepEqual(events, [
    ["typing"],
    ["deliver", "one two"],
  ]);
});

test("delivery finishes an empty reply without starting typing", () => {
  const events = [];
  const delivery = createDelivery({
    onTyping: () => events.push(["typing"]),
    onDeliver: (text) => events.push(["deliver", text]),
  });

  assert.equal(delivery.finish(), true);
  assert.deepEqual(events, [["deliver", ""]]);
});

test("delivery surfaces an error after partial text without delivering the buffer", () => {
  const events = [];
  const failure = new Error("stream failed");
  const delivery = createDelivery({
    onTyping: () => events.push(["typing"]),
    onDeliver: (text) => events.push(["deliver", text]),
    onError: (error) => events.push(["error", error]),
  });

  delivery.push("partial");
  assert.equal(delivery.fail(failure), true);
  assert.equal(delivery.finish(), false);

  assert.deepEqual(events, [
    ["typing"],
    ["error", failure],
  ]);
});

test("delivery accepts only the first finish and treats final text as authoritative", () => {
  const delivered = [];
  const delivery = createDelivery({
    onDeliver: (text) => delivered.push(text),
  });

  delivery.push("draft");
  assert.equal(delivery.finish("final"), true);
  assert.equal(delivery.finish("duplicate"), false);
  assert.equal(delivery.push("late"), false);
  assert.equal(delivery.fail(new Error("late")), false);

  assert.deepEqual(delivered, ["final"]);
});

test("delivery abort drops buffered text without terminal callbacks", () => {
  const events = [];
  const delivery = createDelivery({
    onTyping: () => events.push(["typing"]),
    onDeliver: (text) => events.push(["deliver", text]),
    onError: (error) => events.push(["error", error]),
  });

  delivery.push("discard me");
  assert.equal(delivery.abort(), true);
  assert.equal(delivery.finish(), false);
  assert.equal(delivery.fail(new Error("late")), false);
  assert.equal(delivery.abort(), false);

  assert.deepEqual(events, [["typing"]]);
});
