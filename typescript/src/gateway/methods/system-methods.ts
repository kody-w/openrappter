/**
 * System status and health RPC methods
 */

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
}

interface SystemStatus {
  running: boolean;
  port: number;
  connections: number;
  uptime: number;
  version: string;
  startedAt: string;
}

interface HealthResponse {
  status: string;
  version: string;
  uptime: number;
  timestamp: number;
  checks: Record<string, string>;
}

interface SystemMethodsDeps {
  getStatus?: () => SystemStatus;
  getHealth?: () => HealthResponse;
}

const startedAt = new Date().toISOString();

export function registerSystemMethods(
  server: MethodRegistrar,
  deps?: SystemMethodsDeps
): void {
  // UI calls 'status' (no dot prefix)
  server.registerMethod<void, SystemStatus>(
    'status',
    async () => {
      if (deps?.getStatus) {
        return deps.getStatus();
      }
      return {
        running: true,
        port: 0,
        connections: 0,
        uptime: Math.floor(process.uptime() * 1000),
        version: '1.9.0',
        startedAt,
      };
    }
  );

  // UI calls 'health' (no dot prefix)
  server.registerMethod<void, HealthResponse>(
    'health',
    async () => {
      if (deps?.getHealth) {
        return deps.getHealth();
      }
      return {
        status: 'ok',
        version: '1.9.0',
        uptime: Math.floor(process.uptime() * 1000),
        timestamp: Date.now(),
        checks: {},
      };
    }
  );
}
