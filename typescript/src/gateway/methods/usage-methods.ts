/**
 * Usage tracking RPC methods
 */

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
}

interface UsageStats {
  totalRequests: number;
  totalTokens: number;
  totalCost: number;
  byProvider: Record<
    string,
    {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cost: number;
    }
  >;
  byModel: Record<
    string,
    {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cost: number;
    }
  >;
}

interface UsageTracker {
  getStats(since?: number): UsageStats;
  getCost(since?: number): {
    total: number;
    currency: string;
    breakdown: Array<{
      provider: string;
      model: string;
      cost: number;
    }>;
  };
}

interface UsageMethodsDeps {
  usageTracker?: UsageTracker;
}

export function registerUsageMethods(
  server: MethodRegistrar,
  deps?: UsageMethodsDeps
): void {
  server.registerMethod<{ since?: number }, UsageStats>(
    'usage.status',
    async (params) => {
      const tracker = deps?.usageTracker;
      if (!tracker) {
        return {
          totalRequests: 0,
          totalTokens: 0,
          totalCost: 0,
          byProvider: {},
          byModel: {},
        };
      }
      return tracker.getStats(params?.since);
    }
  );

  server.registerMethod<
    { since?: number },
    { total: number; currency: string; breakdown: unknown[] }
  >('usage.cost', async (params) => {
    const tracker = deps?.usageTracker;
    if (!tracker) {
      return {
        total: 0,
        currency: 'USD',
        breakdown: [],
      };
    }
    return tracker.getCost(params?.since);
  });
}
