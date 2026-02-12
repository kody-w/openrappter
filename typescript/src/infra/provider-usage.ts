export interface UsageEntry {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost?: number;
  timestamp: number;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  count: number;
}

export interface ProviderTotals {
  inputTokens: number;
  outputTokens: number;
  count: number;
}

export interface CostBreakdown {
  provider: string;
  cost: number;
  percentage: number;
}

export class UsageTracker {
  private entries: UsageEntry[] = [];

  record(entry: UsageEntry): void {
    this.entries.push(entry);
  }

  getTotal(since?: number): UsageTotals {
    const filtered = since
      ? this.entries.filter((e) => e.timestamp >= since)
      : this.entries;

    return filtered.reduce(
      (acc, entry) => ({
        inputTokens: acc.inputTokens + entry.inputTokens,
        outputTokens: acc.outputTokens + entry.outputTokens,
        totalCost: acc.totalCost + (entry.cost ?? 0),
        count: acc.count + 1,
      }),
      { inputTokens: 0, outputTokens: 0, totalCost: 0, count: 0 }
    );
  }

  getByProvider(): Record<string, ProviderTotals> {
    const byProvider: Record<string, ProviderTotals> = {};

    for (const entry of this.entries) {
      if (!byProvider[entry.provider]) {
        byProvider[entry.provider] = {
          inputTokens: 0,
          outputTokens: 0,
          count: 0,
        };
      }

      byProvider[entry.provider].inputTokens += entry.inputTokens;
      byProvider[entry.provider].outputTokens += entry.outputTokens;
      byProvider[entry.provider].count += 1;
    }

    return byProvider;
  }

  getCostBreakdown(): CostBreakdown[] {
    const costByProvider: Record<string, number> = {};
    let totalCost = 0;

    for (const entry of this.entries) {
      const cost = entry.cost ?? 0;
      costByProvider[entry.provider] =
        (costByProvider[entry.provider] ?? 0) + cost;
      totalCost += cost;
    }

    return Object.entries(costByProvider)
      .map(([provider, cost]) => ({
        provider,
        cost,
        percentage: totalCost > 0 ? (cost / totalCost) * 100 : 0,
      }))
      .sort((a, b) => b.cost - a.cost);
  }

  clear(): void {
    this.entries = [];
  }
}
