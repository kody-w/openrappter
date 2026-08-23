/**
 * The fourth endpoint with one root cause: `JSON.stringify` evaluated after
 * `res.writeHead` has already committed the reply.
 *
 * The authenticated `/agents/import` route now requires active Flight
 * provenance before it invokes an importer. Its end-to-end serialisation
 * coverage therefore lives with the provenance harness in
 * `agent-import-provenance.test.ts`; this file pins the response helper's
 * transport-level invariant without creating an evidence-free import path.
 *
 * #359 fixed `/readyz` (`setReadinessProvider`), #361 `/rpc` (`registerMethod`),
 * #362 the WebSocket frame writer. Each was found by looking for the previous
 * one's shape somewhere else, and this site was explicitly left alone in #361 as
 * "not proven reachable" -- so the value here is as much in the second half of
 * the file as the first: the catches can no longer double-write at all.
 */
import { describe, it, expect } from 'vitest';
import type { ServerResponse } from 'http';
import { writeJsonResponse } from '../../gateway/server.js';

describe('writeJsonResponse on an already-committed response', () => {
  /**
   * The property the three catches around the body handler now depend on.
   * Before this, the file contained zero `res.headersSent` checks, so a catch
   * reached after its route had already answered wrote a second status line --
   * which is the actual mechanism that ended the process, rather than the
   * serialisation failure that led there.
   */
  function fakeResponse(headersSent: boolean): {
    calls: string[];
    res: ServerResponse;
  } {
    const calls: string[] = [];
    const res = {
      headersSent,
      writeHead(): unknown { calls.push('writeHead'); return res; },
      end(payload?: unknown): unknown {
        calls.push(payload === undefined ? 'end()' : 'end(body)');
        return res;
      },
    };
    return { calls, res: res as unknown as ServerResponse };
  }

  it('writes head and body when nothing has been sent', () => {
    const { calls, res } = fakeResponse(false);

    writeJsonResponse(res, 200, { ok: true });

    expect(calls).toEqual(['writeHead', 'end(body)']);
  });

  it('closes the response without a second head once headers are sent', () => {
    const { calls, res } = fakeResponse(true);

    writeJsonResponse(res, 500, { error: 'too late' });

    // No second status line: that is ERR_HTTP_HEADERS_SENT, and in an async
    // handler node 20 exits on it. The response is ended so the socket is not
    // left open instead.
    expect(calls).toEqual(['end()']);
  });
});
