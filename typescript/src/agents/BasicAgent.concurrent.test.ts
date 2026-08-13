import { describe, expect, it } from "vitest";
import { BasicAgent } from "./BasicAgent.js";

class ConcurrentContextAgent extends BasicAgent {
  private arrivals = 0;
  private release!: () => void;
  private readonly ready = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  constructor() {
    super("ConcurrentContext", {
      name: "ConcurrentContext",
      description: "Verifies invocation-local context",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    });
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const captured = this.context;
    this.arrivals += 1;
    if (this.arrivals === 2) this.release();
    await this.ready;
    return `${String(kwargs.query)}:${captured === this.context}`;
  }
}

describe("BasicAgent concurrent context", () => {
  it("keeps context invocation-local across awaits", async () => {
    const agent = new ConcurrentContextAgent();

    const results = await Promise.all([
      agent.execute({ query: "alpha" }),
      agent.execute({ query: "beta" }),
    ]);

    expect(results.sort()).toEqual(["alpha:true", "beta:true"]);
  });
});
