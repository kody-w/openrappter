import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import {
  GATEWAY_READY_SCHEMA,
  GATEWAY_READY_TIMEOUT_ENV,
  GATEWAY_READY_TIMEOUT_MS,
  resolveGatewayReadyTimeout,
  waitForGatewayReady,
} from '../dist/gateway-ready.js';

/**
 * The gateway readiness handshake, driven rather than described.
 *
 * Desktop startup hangs on this one promise: the app either sees its gateway
 * report ready, or it does not launch. Until now it lived inside
 * `ensureGateway` in `main.ts`, which imports `electron` and so cannot be
 * loaded by `node --test` — which is why the desktop suite asserts that file as
 * text. The security property ("accept readiness only from our own child") was
 * pinned by a regex over the source and never once executed.
 *
 * These tests supply a fake child and check what the handshake actually does.
 */

/** A child process as this handshake sees it: an emitter with a pid and kill. */
class FakeChild extends EventEmitter {
  constructor(pid = 4242) {
    super();
    this.pid = pid;
    this.killed = [];
  }

  kill(signal) {
    this.killed.push(signal);
  }
}

const ready = (child, port) => ({
  schema: GATEWAY_READY_SCHEMA,
  pid: child.pid,
  port,
});

test('resolves when the child reports the expected schema, pid and port', async () => {
  const child = new FakeChild();
  const waiting = waitForGatewayReady(child, { port: 18790, timeoutMs: 1000 });

  child.emit('message', ready(child, 18790));

  await waiting; // rejects the test if it does not resolve
  assert.deepEqual(child.killed, [], 'a ready gateway must not be killed');
});

test('ignores a readiness message describing a different process', async () => {
  // Another gateway on this machine announcing itself is not evidence that
  // *ours* is up. This is the property the source-text test asserted by regex.
  const child = new FakeChild(4242);
  const waiting = waitForGatewayReady(child, { port: 18790, timeoutMs: 120 });

  child.emit('message', { ...ready(child, 18790), pid: 9999 });

  await assert.rejects(waiting, /did not become ready/);
});

test('ignores a readiness message for a different port', async () => {
  const child = new FakeChild();
  const waiting = waitForGatewayReady(child, { port: 18790, timeoutMs: 120 });

  child.emit('message', { ...ready(child, 18790), port: 9999 });

  await assert.rejects(waiting, /did not become ready/);
});

test('ignores a message with the wrong schema', async () => {
  const child = new FakeChild();
  const waiting = waitForGatewayReady(child, { port: 18790, timeoutMs: 120 });

  child.emit('message', { ...ready(child, 18790), schema: 'something-else/1.0' });

  await assert.rejects(waiting, /did not become ready/);
});

test('ignores malformed messages without throwing', async () => {
  const child = new FakeChild();
  const waiting = waitForGatewayReady(child, { port: 18790, timeoutMs: 120 });

  for (const message of [null, undefined, 'ready', 42, {}, { schema: null }]) {
    child.emit('message', message);
  }

  await assert.rejects(waiting, /did not become ready/);
});

test('rejects immediately when the gateway exits, naming the code', async () => {
  const child = new FakeChild();
  const waiting = waitForGatewayReady(child, { port: 18790, timeoutMs: 60_000 });

  child.emit('exit', 3, null);

  // The timeout is a minute; if exit were not handled this would hang the suite.
  await assert.rejects(waiting, /exited during desktop startup \(3\)/);
  assert.deepEqual(child.killed, [], 'an already-exited child must not be killed');
});

test('rejects when the child emits an error', async () => {
  const child = new FakeChild();
  const waiting = waitForGatewayReady(child, { port: 18790, timeoutMs: 60_000 });

  child.emit('error', new Error('spawn ENOENT'));

  await assert.rejects(waiting, /spawn ENOENT/);
});

test('kills the child and reports the budget when it never reports ready', async () => {
  const child = new FakeChild();

  await assert.rejects(
    waitForGatewayReady(child, { port: 18790, timeoutMs: 50 }),
    /did not become ready in 0 seconds/,
  );
  assert.deepEqual(child.killed, ['SIGTERM']);
});

test('a gateway that is merely slow still starts the desktop', async () => {
  // The case the budget exists to get wrong or right. `onExit` already reports
  // a gateway that dies, and `error` reports one that never spawns, so this
  // timer only ever fires on a process that is alive and has not finished
  // starting -- a cold first run, an antivirus scan, a loaded machine. Killing
  // it there turns a slow start into a failed one.
  const child = new FakeChild();
  const waiting = waitForGatewayReady(child, { port: 18790, timeoutMs: 200 });

  setTimeout(() => {
    child.emit('message', {
      schema: GATEWAY_READY_SCHEMA,
      pid: child.pid,
      port: 18790,
    });
  }, 120);

  await waiting;
  assert.deepEqual(child.killed, [], 'a slow but healthy gateway must not be killed');
});

test('a gateway that dies is reported long before the budget expires', async () => {
  // The other half of the argument: widening the budget must not slow down a
  // genuine failure, because exit is what reports those.
  const child = new FakeChild();
  const started = Date.now();
  const waiting = waitForGatewayReady(child, { port: 18790, timeoutMs: 60_000 });

  setTimeout(() => child.emit('exit', 1, null), 20);

  await assert.rejects(waiting, /exited during desktop startup \(1\)/);
  assert.ok(
    Date.now() - started < 5_000,
    'a crashed gateway must fail fast regardless of the readiness budget',
  );
});

test('a late ready message cannot resolve a already-rejected wait', async () => {
  const child = new FakeChild();
  const waiting = waitForGatewayReady(child, { port: 18790, timeoutMs: 40 });
  await assert.rejects(waiting, /did not become ready/);

  // Settling twice would resolve a promise that already rejected, or throw an
  // unhandled error inside a listener that should have been removed.
  child.emit('message', ready(child, 18790));
  child.emit('exit', 0, null);
  assert.deepEqual(child.killed, ['SIGTERM'], 'the child is killed once, not per event');
});

test('stops listening once settled', async () => {
  const child = new FakeChild();
  const waiting = waitForGatewayReady(child, { port: 18790, timeoutMs: 1000 });
  child.emit('message', ready(child, 18790));
  await waiting;

  // A retained listener on a long-lived child process is a leak, and this
  // handshake runs on every desktop start.
  assert.equal(child.listenerCount('message'), 0);
  assert.equal(child.listenerCount('exit'), 0);
});

test('the default budget is the one the error message promises', () => {
  // The message states a number of seconds; if the constant and the text ever
  // disagree the error would misreport how long the app actually waited.
  assert.equal(GATEWAY_READY_TIMEOUT_MS, 120_000);
});

test('the default budget is generous enough to survive a cold start', () => {
  // Raised from 30s in #223. Pinned as a floor rather than an exact value so a
  // future increase does not need to touch this test, but a quiet return to a
  // budget that kills healthy gateways does.
  assert.ok(
    GATEWAY_READY_TIMEOUT_MS >= 60_000,
    'a budget under a minute kills gateways that are merely slow to start',
  );
});

/**
 * The readiness budget is reachable without editing source.
 *
 * `waitForGatewayReady` has always accepted a `timeoutMs`, and until now no
 * caller passed one and nothing read an environment variable — so the escape
 * hatch the module documents existed only for its own tests. The person who
 * actually hits a 30s cold start had no remedy at all.
 *
 * These drive `resolveGatewayReadyTimeout` against an injected environment
 * rather than mutating `process.env`, so they cannot leak into another test.
 */
test('readiness budget falls back to the default when unset', () => {
  assert.equal(resolveGatewayReadyTimeout({}), GATEWAY_READY_TIMEOUT_MS);
});

test('readiness budget honours a valid override', () => {
  assert.equal(
    resolveGatewayReadyTimeout({ [GATEWAY_READY_TIMEOUT_ENV]: '90000' }),
    90_000,
  );
  assert.equal(
    resolveGatewayReadyTimeout({ [GATEWAY_READY_TIMEOUT_ENV]: '  45000  ' }),
    45_000,
  );
});

test('readiness budget ignores anything that is not a positive integer', () => {
  // Refusing to launch because someone exported a malformed number would be a
  // worse failure than the slow start this setting exists to relieve.
  for (const bad of ['', 'soon', '30s', '-1', '0', '1.5', '1e5', '0x30', 'NaN']) {
    assert.equal(
      resolveGatewayReadyTimeout({ [GATEWAY_READY_TIMEOUT_ENV]: bad }),
      GATEWAY_READY_TIMEOUT_MS,
      `expected ${JSON.stringify(bad)} to be ignored`,
    );
  }
});

test('readiness budget is capped so a typo cannot hang startup forever', () => {
  assert.equal(
    resolveGatewayReadyTimeout({ [GATEWAY_READY_TIMEOUT_ENV]: '999999999' }),
    10 * 60_000,
  );
});

test('an explicit caller option still wins over the environment', async () => {
  // The option is the mechanism; the variable is only the default for it.
  const child = new FakeChild();
  const started = Date.now();
  await assert.rejects(
    waitForGatewayReady(child, { port: 18790, timeoutMs: 20 }),
    /did not become ready in 0 seconds\./,
  );
  assert.ok(Date.now() - started < 5_000);
});
