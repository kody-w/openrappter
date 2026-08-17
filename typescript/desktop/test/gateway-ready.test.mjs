import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import {
  GATEWAY_READY_SCHEMA,
  GATEWAY_READY_TIMEOUT_MS,
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
  assert.equal(GATEWAY_READY_TIMEOUT_MS, 30_000);
});
