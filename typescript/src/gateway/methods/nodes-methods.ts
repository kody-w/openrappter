/**
 * Distributed nodes RPC methods
 */

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
}

interface NodeProtocol {
  listNodes(): Array<{
    id: string;
    address: string;
    status: 'connected' | 'disconnected';
    capabilities: string[];
  }>;
  describeNode(nodeId: string): Promise<{
    id: string;
    metadata: Record<string, unknown>;
    agents: string[];
  }>;
  invoke(nodeId: string, agentName: string, params: unknown): Promise<unknown>;
  requestPairing(address: string): Promise<{ pairingCode: string }>;
  confirmPairing(pairingCode: string): Promise<{ nodeId: string }>;
}

interface NodesMethodsDeps {
  nodeProtocol?: NodeProtocol;
}

export function registerNodesMethods(
  server: MethodRegistrar,
  deps?: NodesMethodsDeps
): void {
  server.registerMethod('nodes.list', async () => {
    const protocol = deps?.nodeProtocol;
    if (!protocol) return { nodes: [] };
    return { nodes: protocol.listNodes() };
  });

  server.registerMethod<{ nodeId: string }, unknown>(
    'nodes.describe',
    async (params) => {
      const protocol = deps?.nodeProtocol;
      if (!protocol) throw new Error('Node protocol not available');
      return protocol.describeNode(params.nodeId);
    }
  );

  server.registerMethod<
    { nodeId: string; agentName: string; params: unknown },
    { result: unknown }
  >('nodes.invoke', async (params) => {
    const protocol = deps?.nodeProtocol;
    if (!protocol) throw new Error('Node protocol not available');
    const result = await protocol.invoke(
      params.nodeId,
      params.agentName,
      params.params
    );
    return { result };
  });

  server.registerMethod<{ address: string }, { pairingCode: string }>(
    'nodes.pair.request',
    async (params) => {
      const protocol = deps?.nodeProtocol;
      if (!protocol) throw new Error('Node protocol not available');
      return protocol.requestPairing(params.address);
    }
  );

  server.registerMethod<{ pairingCode: string }, { nodeId: string }>(
    'nodes.pair.confirm',
    async (params) => {
      const protocol = deps?.nodeProtocol;
      if (!protocol) throw new Error('Node protocol not available');
      return protocol.confirmPairing(params.pairingCode);
    }
  );
}
