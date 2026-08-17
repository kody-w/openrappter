/**
 * Node Protocol Parity Tests
 *
 * The previous version of this file imported only `vitest` and asserted on
 * hand-built literals — e.g. it constructed a `{ params: { publicKey: '...' } }`
 * object and then asserted `expect(request.params.publicKey).toBeDefined()`,
 * or built a one-element array and asserted `length > 0`. Those assertions can
 * never fail: they touch no product code, so the "Node Pairing", "Method
 * Invocation", "Event Streaming" and "Node Capabilities" sections protected
 * nothing. They were replaced with tests against the two real modules that
 * actually implement this surface, both of which were entirely untested:
 *
 *   - DevicePairingManager (src/auth/pairing.ts) — device trust + token
 *     issuance/validation/revocation. This is credential-bearing code, so it
 *     is exercised first and most thoroughly.
 *   - MobileNodeProtocol (src/nodes/protocol.ts) — node registration, request/
 *     response correlation, capability gating, and event streaming.
 *
 * Per the "assert per path" rule, the success and failure branches of pairing
 * approval, token validation, and request/response are each asserted
 * separately rather than only through a combined happy-path total.
 */

import { describe, it, expect } from 'vitest';
import { DevicePairingManager } from '../../auth/pairing.js';
import { MobileNodeProtocol, type NodeMessage, type NodeRequest } from '../../nodes/protocol.js';

function msg(partial: Partial<NodeMessage> & Pick<NodeMessage, 'type' | 'nodeId' | 'payload'>): NodeMessage {
  return {
    id: partial.id ?? `msg_${Math.random().toString(36).slice(2)}`,
    timestamp: partial.timestamp ?? new Date().toISOString(),
    ...partial,
  };
}

describe('Node Protocol Parity', () => {
  describe('Device pairing (credentials)', () => {
    it('approves a pairing request, trusts the device, and issues a token that validates', () => {
      const mgr = new DevicePairingManager();
      const req = mgr.createPairingRequest('device_1', 'My iPhone', 'mobile');

      expect(req.status).toBe('pending');
      expect(req.challenge).toHaveLength(64); // 32 random bytes, hex-encoded

      const res = mgr.approvePairingRequest(req.id, 'admin');
      expect(res.success).toBe(true);
      expect(res.token).toBeTruthy();
      expect(mgr.getDevice('device_1')?.trusted).toBe(true);

      const check = mgr.validateToken(res.token!);
      expect(check.valid).toBe(true);
      expect(check.device?.id).toBe('device_1');
    });

    it('refuses to mint a token for an untrusted device', () => {
      const mgr = new DevicePairingManager();
      mgr.registerDevice('device_2', 'Rogue Laptop', 'cli', false); // NOT trusted

      expect(() => mgr.generateToken('device_2')).toThrow(/not trusted/);
    });

    it('revokes a device\u2019s tokens when it is untrusted', () => {
      const mgr = new DevicePairingManager();
      mgr.registerDevice('device_3', 'Tablet', 'mobile', true);
      const token = mgr.generateToken('device_3');
      expect(mgr.validateToken(token.token).valid).toBe(true);

      expect(mgr.untrustDevice('device_3')).toBe(true);

      const after = mgr.validateToken(token.token);
      expect(after.valid).toBe(false);
      // Must be gone from the token store, not merely rejected for being untrusted.
      expect(after.error).toBe('Token not found');
    });

    it('cannot approve a pairing request that was already rejected', () => {
      const mgr = new DevicePairingManager();
      const req = mgr.createPairingRequest('device_4', 'Unknown device', 'mobile');

      expect(mgr.rejectPairingRequest(req.id)).toBe(true);

      const res = mgr.approvePairingRequest(req.id, 'admin');
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/already rejected/);
      expect(mgr.getDevice('device_4')).toBeUndefined(); // never registered/trusted
    });

    it('cannot approve the same pairing request twice', () => {
      const mgr = new DevicePairingManager();
      const req = mgr.createPairingRequest('device_5', 'Phone', 'mobile');

      const first = mgr.approvePairingRequest(req.id, 'admin');
      expect(first.success).toBe(true);

      const second = mgr.approvePairingRequest(req.id, 'admin');
      expect(second.success).toBe(false);
      expect(second.error).toMatch(/already approved/);
    });

    it('lists only pending requests, excluding approved and rejected ones', () => {
      const mgr = new DevicePairingManager();
      const a = mgr.createPairingRequest('d_a', 'A', 'mobile');
      const b = mgr.createPairingRequest('d_b', 'B', 'mobile');
      const c = mgr.createPairingRequest('d_c', 'C', 'mobile');

      mgr.approvePairingRequest(a.id, 'admin');
      mgr.rejectPairingRequest(b.id);

      const pending = mgr.getPendingRequests().map((r) => r.id);
      expect(pending).toEqual([c.id]);
    });

    it('rejects an unknown token', () => {
      const mgr = new DevicePairingManager();
      expect(mgr.validateToken('not-a-real-token')).toEqual({
        valid: false,
        error: 'Token not found',
      });
    });

    it('rotates a token: the old one stops working and the new one validates', () => {
      const mgr = new DevicePairingManager();
      mgr.registerDevice('device_6', 'Desktop', 'web', true);
      const original = mgr.generateToken('device_6');

      const rotated = mgr.rotateToken(original.token);
      expect(rotated).not.toBeNull();
      expect(rotated!.token).not.toBe(original.token);

      expect(mgr.validateToken(original.token).valid).toBe(false); // old revoked
      expect(mgr.validateToken(rotated!.token).valid).toBe(true); // new works
    });
  });

  describe('Mobile node protocol', () => {
    it('registers a node in pairing state and connects it on handshake', () => {
      const proto = new MobileNodeProtocol();
      const node = proto.registerNode('n1', 'iPhone', 'ios', '1.0.0');
      expect(node.status).toBe('pairing');
      expect(node.capabilities).toEqual([]);

      const connected: string[] = [];
      proto.on('node:connected', (n: { id: string }) => connected.push(n.id));

      proto.handleMessage(msg({ type: 'handshake', nodeId: 'n1', payload: {} }));

      expect(proto.getNode('n1')?.status).toBe('connected');
      expect(connected).toEqual(['n1']);
    });

    it('applies a capabilities update and gates hasCapability accordingly', () => {
      const proto = new MobileNodeProtocol();
      proto.registerNode('n1', 'iPhone', 'ios', '1.0.0');
      proto.handleMessage(msg({ type: 'handshake', nodeId: 'n1', payload: {} }));

      proto.handleMessage(msg({ type: 'capabilities', nodeId: 'n1', payload: ['camera', 'clipboard'] }));

      expect(proto.hasCapability('n1', 'camera')).toBe(true);
      expect(proto.hasCapability('n1', 'clipboard')).toBe(true);
      expect(proto.hasCapability('n1', 'screen')).toBe(false); // not granted
    });

    it('refuses to send a request to a node that is not connected', async () => {
      const proto = new MobileNodeProtocol();
      proto.registerNode('n2', 'Android', 'android', '2.0.0'); // still "pairing"

      await expect(proto.sendRequest('n2', 'camera.capture')).rejects.toThrow(/not connected/);
    });

    it('correlates a successful response back to the pending request', async () => {
      const proto = new MobileNodeProtocol();
      proto.registerNode('n1', 'iPhone', 'ios', '1.0.0');
      proto.handleMessage(msg({ type: 'handshake', nodeId: 'n1', payload: {} }));

      let sent: NodeMessage | undefined;
      proto.on('send', (m: NodeMessage) => { sent = m; });

      const pending = proto.sendRequest('n1', 'clipboard.read');
      const requestId = (sent!.payload as NodeRequest).id;

      proto.handleMessage(
        msg({ type: 'response', nodeId: 'n1', payload: { requestId, success: true, data: 'clip-contents' } })
      );

      await expect(pending).resolves.toBe('clip-contents');
    });

    it('rejects a request when the node reports failure (error path)', async () => {
      const proto = new MobileNodeProtocol();
      proto.registerNode('n1', 'iPhone', 'ios', '1.0.0');
      proto.handleMessage(msg({ type: 'handshake', nodeId: 'n1', payload: {} }));

      let sent: NodeMessage | undefined;
      proto.on('send', (m: NodeMessage) => { sent = m; });

      const pending = proto.sendRequest('n1', 'files.read');
      const requestId = (sent!.payload as NodeRequest).id;

      proto.handleMessage(
        msg({ type: 'response', nodeId: 'n1', payload: { requestId, success: false, error: 'permission denied' } })
      );

      await expect(pending).rejects.toThrow('permission denied');
    });

    it('emits node:event when the node streams an event', () => {
      const proto = new MobileNodeProtocol();
      proto.registerNode('n1', 'iPhone', 'ios', '1.0.0');

      const events: Array<{ nodeId: string; type: string; data: unknown }> = [];
      proto.on('node:event', (e: { nodeId: string; type: string; data: unknown }) => events.push(e));

      proto.handleMessage(
        msg({ type: 'event', nodeId: 'n1', payload: { type: 'battery', data: { level: 50 } } })
      );

      expect(events).toEqual([{ nodeId: 'n1', type: 'battery', data: { level: 50 } }]);
    });

    it('times out a request that never receives a response', async () => {
      const proto = new MobileNodeProtocol({ requestTimeout: 20 });
      proto.registerNode('n1', 'iPhone', 'ios', '1.0.0');
      proto.handleMessage(msg({ type: 'handshake', nodeId: 'n1', payload: {} }));

      await expect(proto.sendRequest('n1', 'sensors.read')).rejects.toThrow(/timeout/);
    });
  });
});
