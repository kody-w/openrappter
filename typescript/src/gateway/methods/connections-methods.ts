/**
 * Connection/device listing RPC methods
 */

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
}

interface ConnectionInfo {
  id: string;
  connectedAt: string;
  authenticated: boolean;
  subscriptions: string[];
  deviceId?: string;
  deviceType?: string;
}

interface ConnectionsMethodsDeps {
  connectionList?: () => ConnectionInfo[];
}

export function registerConnectionsMethods(
  server: MethodRegistrar,
  deps?: ConnectionsMethodsDeps
): void {
  server.registerMethod<void, ConnectionInfo[]>(
    'connections.list',
    async () => {
      if (deps?.connectionList) {
        return deps.connectionList();
      }
      return [];
    }
  );
}
