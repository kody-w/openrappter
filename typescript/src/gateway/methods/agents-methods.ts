/**
 * Agent introspection RPC methods
 */

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
}

interface AgentMetadata {
  name: string;
  description: string;
  version?: string;
  parameters?: unknown;
  capabilities?: string[];
}

interface AgentRegistry {
  getMetadata(name: string): Promise<AgentMetadata | null>;
  listAgentFiles(): Promise<
    Array<{
      name: string;
      path: string;
      type: 'builtin' | 'custom' | 'skill';
    }>
  >;
  getAgentFile(name: string): Promise<{
    name: string;
    content: string;
    language: string;
  }>;
  readAgentFile?(agentId: string, path: string): Promise<{ content: string }>;
  writeAgentFile?(agentId: string, path: string, content: string): Promise<{ written: true }>;
}

interface AgentsMethodsDeps {
  agentRegistry?: AgentRegistry;
  agentList?: () => Array<Record<string, unknown>>;
}

export function registerAgentsMethods(
  server: MethodRegistrar,
  deps?: AgentsMethodsDeps
): void {
  // List all agents (summary)
  server.registerMethod<void, Array<Record<string, unknown>>>(
    'agents.list',
    async () => {
      if (deps?.agentList) {
        return deps.agentList();
      }
      return [];
    }
  );

  server.registerMethod<{ name: string }, { metadata: AgentMetadata | null }>(
    'agents.identity.get',
    async (params) => {
      const registry = deps?.agentRegistry;

      if (!registry) {
        throw new Error('Agent registry not available');
      }

      const metadata = await registry.getMetadata(params.name);

      return { metadata };
    }
  );

  server.registerMethod<
    void,
    {
      files: Array<{
        name: string;
        path: string;
        type: 'builtin' | 'custom' | 'skill';
      }>;
    }
  >('agents.files.list', async () => {
    const registry = deps?.agentRegistry;

    if (!registry) {
      return { files: [] };
    }

    const files = await registry.listAgentFiles();

    return { files };
  });

  server.registerMethod<
    { name: string },
    { name: string; content: string; language: string }
  >('agents.files.get', async (params) => {
    const registry = deps?.agentRegistry;

    if (!registry) {
      throw new Error('Agent registry not available');
    }

    return registry.getAgentFile(params.name);
  });

  server.registerMethod<
    { agentId: string; path: string },
    { content: string }
  >('agents.files.read', async (params) => {
    const registry = deps?.agentRegistry;

    if (!registry) {
      throw new Error('Agent registry not available');
    }

    if (!registry.readAgentFile) {
      throw new Error('Agent registry does not support readAgentFile');
    }

    return registry.readAgentFile(params.agentId, params.path);
  });

  server.registerMethod<
    { agentId: string; path: string; content: string },
    { written: true }
  >('agents.files.write', async (params) => {
    const registry = deps?.agentRegistry;

    if (!registry) {
      throw new Error('Agent registry not available');
    }

    if (!registry.writeAgentFile) {
      throw new Error('Agent registry does not support writeAgentFile');
    }

    return registry.writeAgentFile(params.agentId, params.path, params.content);
  });
}
