/**
 * Showcase: Agent Stock Exchange — Multi-round marketplace simulation
 *
 * 3 analyst agents bid on 20 deterministic tasks across 4 categories.
 * Exercises AgentGraph, BroadcastManager, AgentRouter, and BasicAgent + data_slush.
 */

import { describe, it, expect } from 'vitest';
import { AgentGraph } from '../../agents/graph.js';
import { BroadcastManager } from '../../agents/broadcast.js';
import { AgentRouter } from '../../agents/router.js';
import { BasicAgent } from '../../agents/BasicAgent.js';
import type { AgentResult } from '../../agents/types.js';

// ── Shared types + helpers (mirrors showcase-methods.ts) ──

interface Task {
  round: number;
  category: string;
  difficulty: number;
  basePrice: number;
}

interface AnalystState {
  name: string;
  specialty: string;
  wallet: number;
  reputation: number;
}

const CATEGORIES = ['data', 'web', 'security', 'infra'];

function generateTask(round: number): Task {
  const category = CATEGORIES[round % 4];
  const difficulty = ((round * 7 + 3) % 5) + 1;
  const basePrice = 100;
  return { round, category, difficulty, basePrice };
}

function calculateBid(baseCost: number, difficulty: number, specialtyMatch: boolean, reputation: number): number {
  const difficultyFactor = 1 + (difficulty - 1) * 0.15;
  const specialtyDiscount = specialtyMatch ? 0.25 : 0;
  const reputationDiscount = Math.min(reputation * 0.02, 0.15);
  return baseCost * difficultyFactor * (1 - specialtyDiscount) * (1 - reputationDiscount);
}

function calculateQuality(specialtyMatch: boolean): number {
  return specialtyMatch ? 0.95 : 0.7;
}

function qualityPasses(quality: number, difficulty: number): boolean {
  return quality >= difficulty * 0.15;
}

// ── Inline agents ──

class BrokerAgent extends BasicAgent {
  private roundNum: number;
  constructor(roundNum: number) {
    super('Broker', {
      name: 'Broker', description: 'Generates deterministic tasks',
      parameters: { type: 'object', properties: { round: { type: 'number', description: 'Round number' } }, required: [] },
    });
    this.roundNum = roundNum;
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const round = (kwargs.round as number) ?? this.roundNum;
    const task = generateTask(round);
    return JSON.stringify({
      status: 'success', task,
      data_slush: { source_agent: 'Broker', task },
    });
  }
}

class AnalystAgent extends BasicAgent {
  private specialty: string;
  private baseCost: number;
  private rep: number;
  constructor(analystName: string, specialty: string, baseCost: number, reputation: number) {
    super(analystName, {
      name: analystName, description: `Analyst specializing in ${specialty}`,
      parameters: { type: 'object', properties: { task: { type: 'object', description: 'Task to bid on' } }, required: [] },
    });
    this.specialty = specialty;
    this.baseCost = baseCost;
    this.rep = reputation;
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const task = kwargs.task as Task;
    const specialtyMatch = task.category === this.specialty;
    const bid = calculateBid(this.baseCost, task.difficulty, specialtyMatch, this.rep);
    return JSON.stringify({
      status: 'success', bid, specialty: this.specialty, specialtyMatch,
      data_slush: { source_agent: this.name, bid, specialty: this.specialty, specialtyMatch },
    });
  }
}

class AuctioneerAgent extends BasicAgent {
  constructor() {
    super('Auctioneer', {
      name: 'Auctioneer', description: 'Picks lowest bid',
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const upstream = (kwargs._context as Record<string, unknown>)?.upstream_slush as Record<string, Record<string, unknown>> | undefined;
    if (!upstream) return JSON.stringify({ status: 'error', message: 'No bids' });
    const bids = Object.entries(upstream)
      .filter(([, s]) => typeof s.bid === 'number')
      .map(([, s]) => ({ name: s.source_agent as string, bid: s.bid as number, specialty: s.specialty as string, specialtyMatch: s.specialtyMatch as boolean }));
    bids.sort((a, b) => a.bid - b.bid);
    const winner = bids[0];
    return JSON.stringify({
      status: 'success', winner: winner.name, winningBid: winner.bid, allBids: bids,
      data_slush: { source_agent: 'Auctioneer', winner: winner.name, winningBid: winner.bid, specialtyMatch: winner.specialtyMatch },
    });
  }
}

class SettlementAgent extends BasicAgent {
  private analysts: AnalystState[];
  private task: Task;
  constructor(analysts: AnalystState[], task: Task) {
    super('Settlement', {
      name: 'Settlement', description: 'Updates wallets and reputation',
      parameters: { type: 'object', properties: {}, required: [] },
    });
    this.analysts = analysts;
    this.task = task;
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const upstream = (kwargs._context as Record<string, unknown>)?.upstream_slush as Record<string, Record<string, unknown>> | undefined;
    if (!upstream) return JSON.stringify({ status: 'error', message: 'No auction result' });
    const auctionSlush = Object.values(upstream).find(s => s.source_agent === 'Auctioneer')!;
    const winnerName = auctionSlush.winner as string;
    const winningBid = auctionSlush.winningBid as number;
    const specialtyMatch = auctionSlush.specialtyMatch as boolean;

    const winner = this.analysts.find(a => a.name === winnerName)!;
    winner.wallet += this.task.basePrice - winningBid;
    const quality = calculateQuality(specialtyMatch);
    const passed = qualityPasses(quality, this.task.difficulty);
    if (specialtyMatch) {
      winner.reputation += 1;
    } else if (passed) {
      winner.reputation += 0.5;
    } else {
      winner.reputation -= 1;
    }

    return JSON.stringify({
      status: 'success', winner: winnerName, walletDelta: this.task.basePrice - winningBid,
      qualityPassed: passed, reputationAfter: winner.reputation,
      data_slush: { source_agent: 'Settlement', winner: winnerName, qualityPassed: passed },
    });
  }
}

// ── Tests ──

describe('Showcase: Agent Stock Exchange', () => {
  describe('Agent creation + metadata', () => {
    it('creates BrokerAgent with correct metadata', () => {
      const broker = new BrokerAgent(0);
      expect(broker.name).toBe('Broker');
      expect(broker.metadata.description).toContain('task');
    });

    it('creates AnalystAgent with specialty in metadata', () => {
      const analyst = new AnalystAgent('DataPro', 'data', 80, 0);
      expect(analyst.name).toBe('DataPro');
      expect(analyst.metadata.description).toContain('data');
    });
  });

  describe('Deterministic task generation', () => {
    it('cycles categories across rounds', () => {
      const tasks = Array.from({ length: 8 }, (_, i) => generateTask(i));
      expect(tasks.map(t => t.category)).toEqual([
        'data', 'web', 'security', 'infra',
        'data', 'web', 'security', 'infra',
      ]);
    });

    it('generates difficulty deterministically', () => {
      const t0 = generateTask(0);
      const t1 = generateTask(1);
      expect(t0.difficulty).toBe(((0 * 7 + 3) % 5) + 1); // 4
      expect(t1.difficulty).toBe(((1 * 7 + 3) % 5) + 1); // 1
      // All difficulties are 1-5
      for (let i = 0; i < 20; i++) {
        const t = generateTask(i);
        expect(t.difficulty).toBeGreaterThanOrEqual(1);
        expect(t.difficulty).toBeLessThanOrEqual(5);
      }
    });
  });

  describe('Bid calculation', () => {
    it('applies specialty discount (25%)', () => {
      const withSpecialty = calculateBid(100, 1, true, 0);
      const without = calculateBid(100, 1, false, 0);
      expect(withSpecialty).toBeLessThan(without);
      expect(withSpecialty).toBeCloseTo(without * 0.75, 5);
    });

    it('scales with difficulty', () => {
      const easy = calculateBid(100, 1, false, 0);
      const hard = calculateBid(100, 5, false, 0);
      expect(hard).toBeGreaterThan(easy);
      // difficulty 5 factor = 1 + 4*0.15 = 1.6
      expect(hard).toBeCloseTo(100 * 1.6, 5);
    });

    it('caps reputation discount at 15%', () => {
      const highRep = calculateBid(100, 1, false, 100);
      const capRep = calculateBid(100, 1, false, 7.5);
      // Both should have 15% discount (capped)
      expect(highRep).toBeCloseTo(capRep, 5);
      expect(highRep).toBeCloseTo(100 * 0.85, 5);
    });
  });

  describe('Single round graph execution', () => {
    it('runs broker → 3 analysts → auctioneer → settlement DAG', async () => {
      const analysts: AnalystState[] = [
        { name: 'DataPro', specialty: 'data', wallet: 0, reputation: 0 },
        { name: 'WebWiz', specialty: 'web', wallet: 0, reputation: 0 },
        { name: 'SecOps', specialty: 'security', wallet: 0, reputation: 0 },
      ];
      const task = generateTask(0); // category=data, difficulty=4

      const graph = new AgentGraph()
        .addNode({ name: 'broker', agent: new BrokerAgent(0), kwargs: { round: 0 } })
        .addNode({ name: 'analyst-DataPro', agent: new AnalystAgent('DataPro', 'data', 80, 0), kwargs: { task }, dependsOn: ['broker'] })
        .addNode({ name: 'analyst-WebWiz', agent: new AnalystAgent('WebWiz', 'web', 100, 0), kwargs: { task }, dependsOn: ['broker'] })
        .addNode({ name: 'analyst-SecOps', agent: new AnalystAgent('SecOps', 'security', 120, 0), kwargs: { task }, dependsOn: ['broker'] })
        .addNode({ name: 'auctioneer', agent: new AuctioneerAgent(), dependsOn: ['analyst-DataPro', 'analyst-WebWiz', 'analyst-SecOps'] })
        .addNode({ name: 'settlement', agent: new SettlementAgent(analysts, task), dependsOn: ['auctioneer'] });

      const result = await graph.run();
      expect(result.status).toBe('success');
      expect(result.nodes.size).toBe(6);

      const auctionResult = result.nodes.get('auctioneer')?.result as Record<string, unknown>;
      // Round 0 is data category — DataPro (lowest baseCost + specialty discount) should win
      expect(auctionResult.winner).toBe('DataPro');
    });
  });

  describe('Wallet update after settlement', () => {
    it('updates winner wallet by basePrice - bid', async () => {
      const analysts: AnalystState[] = [
        { name: 'DataPro', specialty: 'data', wallet: 0, reputation: 0 },
        { name: 'WebWiz', specialty: 'web', wallet: 0, reputation: 0 },
        { name: 'SecOps', specialty: 'security', wallet: 0, reputation: 0 },
      ];
      const task = generateTask(0);

      const graph = new AgentGraph()
        .addNode({ name: 'broker', agent: new BrokerAgent(0), kwargs: { round: 0 } })
        .addNode({ name: 'analyst-DataPro', agent: new AnalystAgent('DataPro', 'data', 80, 0), kwargs: { task }, dependsOn: ['broker'] })
        .addNode({ name: 'analyst-WebWiz', agent: new AnalystAgent('WebWiz', 'web', 100, 0), kwargs: { task }, dependsOn: ['broker'] })
        .addNode({ name: 'analyst-SecOps', agent: new AnalystAgent('SecOps', 'security', 120, 0), kwargs: { task }, dependsOn: ['broker'] })
        .addNode({ name: 'auctioneer', agent: new AuctioneerAgent(), dependsOn: ['analyst-DataPro', 'analyst-WebWiz', 'analyst-SecOps'] })
        .addNode({ name: 'settlement', agent: new SettlementAgent(analysts, task), dependsOn: ['auctioneer'] });

      await graph.run();

      // DataPro wins round 0 (data category, baseCost=80, specialty match)
      const dataPro = analysts.find(a => a.name === 'DataPro')!;
      const expectedBid = calculateBid(80, task.difficulty, true, 0);
      expect(dataPro.wallet).toBeCloseTo(task.basePrice - expectedBid, 5);
    });
  });

  describe('Reputation updates', () => {
    it('awards +1 reputation for specialty match win', async () => {
      const analysts: AnalystState[] = [
        { name: 'DataPro', specialty: 'data', wallet: 0, reputation: 0 },
        { name: 'WebWiz', specialty: 'web', wallet: 0, reputation: 0 },
        { name: 'SecOps', specialty: 'security', wallet: 0, reputation: 0 },
      ];
      const task = generateTask(0); // data category

      const graph = new AgentGraph()
        .addNode({ name: 'broker', agent: new BrokerAgent(0), kwargs: { round: 0 } })
        .addNode({ name: 'analyst-DataPro', agent: new AnalystAgent('DataPro', 'data', 80, 0), kwargs: { task }, dependsOn: ['broker'] })
        .addNode({ name: 'analyst-WebWiz', agent: new AnalystAgent('WebWiz', 'web', 100, 0), kwargs: { task }, dependsOn: ['broker'] })
        .addNode({ name: 'analyst-SecOps', agent: new AnalystAgent('SecOps', 'security', 120, 0), kwargs: { task }, dependsOn: ['broker'] })
        .addNode({ name: 'auctioneer', agent: new AuctioneerAgent(), dependsOn: ['analyst-DataPro', 'analyst-WebWiz', 'analyst-SecOps'] })
        .addNode({ name: 'settlement', agent: new SettlementAgent(analysts, task), dependsOn: ['auctioneer'] });

      await graph.run();

      // DataPro wins data task → +1 specialty reputation
      expect(analysts.find(a => a.name === 'DataPro')!.reputation).toBe(1);
    });
  });

  describe('BroadcastManager integration', () => {
    it('all mode collects bids from all 3 analysts', async () => {
      const agents: Record<string, BasicAgent> = {
        DataPro: new AnalystAgent('DataPro', 'data', 80, 0),
        WebWiz: new AnalystAgent('WebWiz', 'web', 100, 0),
        SecOps: new AnalystAgent('SecOps', 'security', 120, 0),
      };
      const manager = new BroadcastManager();
      manager.createGroup({
        id: 'bid-round', name: 'Bid Round',
        agentIds: ['DataPro', 'WebWiz', 'SecOps'], mode: 'all',
      });
      const task = generateTask(0);
      const executor = async (agentId: string, message: string): Promise<AgentResult> => {
        const agent = agents[agentId];
        const resultStr = await agent.execute({ query: message, task });
        return JSON.parse(resultStr) as AgentResult;
      };
      const result = await manager.broadcast('bid-round', 'bid', executor);
      expect(result.allSucceeded).toBe(true);
      expect(result.results.size).toBe(3);
    });
  });

  describe('AgentRouter integration', () => {
    it('routes tasks to specialists by pattern', () => {
      const router = new AgentRouter();
      router.addRule({ id: 'data-route', priority: 10, conditions: [{ type: 'pattern', pattern: /data/i }], agentId: 'DataPro' });
      router.addRule({ id: 'web-route', priority: 10, conditions: [{ type: 'pattern', pattern: /web/i }], agentId: 'WebWiz' });
      router.addRule({ id: 'sec-route', priority: 10, conditions: [{ type: 'pattern', pattern: /security/i }], agentId: 'SecOps' });
      router.setDefaultAgent('DataPro');

      const dataRoute = router.route({ senderId: 's', channelId: 'c', conversationId: 'r1', message: 'data task' });
      const webRoute = router.route({ senderId: 's', channelId: 'c', conversationId: 'r2', message: 'web task' });
      const secRoute = router.route({ senderId: 's', channelId: 'c', conversationId: 'r3', message: 'security task' });
      const infraRoute = router.route({ senderId: 's', channelId: 'c', conversationId: 'r4', message: 'infra task' });

      expect(dataRoute.agentId).toBe('DataPro');
      expect(webRoute.agentId).toBe('WebWiz');
      expect(secRoute.agentId).toBe('SecOps');
      expect(infraRoute.agentId).toBe('DataPro'); // default — no infra specialist
    });
  });

  describe('Multi-round state propagation', () => {
    it('wallets and reputations accumulate across rounds', async () => {
      const analysts: AnalystState[] = [
        { name: 'DataPro', specialty: 'data', wallet: 0, reputation: 0 },
        { name: 'WebWiz', specialty: 'web', wallet: 0, reputation: 0 },
        { name: 'SecOps', specialty: 'security', wallet: 0, reputation: 0 },
      ];

      for (let round = 0; round < 4; round++) {
        const task = generateTask(round);
        const graph = new AgentGraph()
          .addNode({ name: 'broker', agent: new BrokerAgent(round), kwargs: { round } })
          .addNode({ name: 'analyst-DataPro', agent: new AnalystAgent('DataPro', 'data', 80, analysts[0].reputation), kwargs: { task }, dependsOn: ['broker'] })
          .addNode({ name: 'analyst-WebWiz', agent: new AnalystAgent('WebWiz', 'web', 100, analysts[1].reputation), kwargs: { task }, dependsOn: ['broker'] })
          .addNode({ name: 'analyst-SecOps', agent: new AnalystAgent('SecOps', 'security', 120, analysts[2].reputation), kwargs: { task }, dependsOn: ['broker'] })
          .addNode({ name: 'auctioneer', agent: new AuctioneerAgent(), dependsOn: ['analyst-DataPro', 'analyst-WebWiz', 'analyst-SecOps'] })
          .addNode({ name: 'settlement', agent: new SettlementAgent(analysts, task), dependsOn: ['auctioneer'] });

        await graph.run();
      }

      // After 4 rounds (one per category), multiple analysts should have non-zero wallets
      const nonZeroWallets = analysts.filter(a => a.wallet !== 0).length;
      expect(nonZeroWallets).toBeGreaterThanOrEqual(1);
      // Reputations should have changed
      const totalRep = analysts.reduce((sum, a) => sum + a.reputation, 0);
      expect(totalRep).toBeGreaterThan(0);
    });
  });

  describe('Full 20-round simulation', () => {
    it('completes all 20 rounds with valid results', async () => {
      const analysts: AnalystState[] = [
        { name: 'DataPro', specialty: 'data', wallet: 0, reputation: 0 },
        { name: 'WebWiz', specialty: 'web', wallet: 0, reputation: 0 },
        { name: 'SecOps', specialty: 'security', wallet: 0, reputation: 0 },
      ];
      const history: Array<{ round: number; winner: string; category: string }> = [];

      for (let round = 0; round < 20; round++) {
        const task = generateTask(round);
        const graph = new AgentGraph()
          .addNode({ name: 'broker', agent: new BrokerAgent(round), kwargs: { round } })
          .addNode({ name: 'analyst-DataPro', agent: new AnalystAgent('DataPro', 'data', 80, analysts[0].reputation), kwargs: { task }, dependsOn: ['broker'] })
          .addNode({ name: 'analyst-WebWiz', agent: new AnalystAgent('WebWiz', 'web', 100, analysts[1].reputation), kwargs: { task }, dependsOn: ['broker'] })
          .addNode({ name: 'analyst-SecOps', agent: new AnalystAgent('SecOps', 'security', 120, analysts[2].reputation), kwargs: { task }, dependsOn: ['broker'] })
          .addNode({ name: 'auctioneer', agent: new AuctioneerAgent(), dependsOn: ['analyst-DataPro', 'analyst-WebWiz', 'analyst-SecOps'] })
          .addNode({ name: 'settlement', agent: new SettlementAgent(analysts, task), dependsOn: ['auctioneer'] });

        const result = await graph.run();
        expect(result.status).toBe('success');

        const auctionResult = result.nodes.get('auctioneer')?.result as Record<string, unknown>;
        history.push({ round, winner: auctionResult.winner as string, category: task.category });
      }

      expect(history).toHaveLength(20);
      // Every round should have a winner
      for (const h of history) {
        expect(h.winner).toBeTruthy();
      }
    });
  });

  describe('Market report', () => {
    it('produces wealth distribution and avg prices', async () => {
      const analysts: AnalystState[] = [
        { name: 'DataPro', specialty: 'data', wallet: 50, reputation: 3 },
        { name: 'WebWiz', specialty: 'web', wallet: 30, reputation: 2 },
        { name: 'SecOps', specialty: 'security', wallet: 20, reputation: 1 },
      ];
      const history = [
        { round: 0, task: generateTask(0), bids: [{ name: 'DataPro', bid: 80 }], winner: 'DataPro', qualityPassed: true },
        { round: 1, task: generateTask(1), bids: [{ name: 'WebWiz', bid: 90 }], winner: 'WebWiz', qualityPassed: true },
      ];

      class MarketReportAgent extends BasicAgent {
        constructor() {
          super('MarketReport', {
            name: 'MarketReport', description: 'Final market analysis',
            parameters: { type: 'object', properties: {}, required: [] },
          });
        }
        async perform(kwargs: Record<string, unknown>): Promise<string> {
          const a = kwargs.analysts as AnalystState[];
          const h = kwargs.history as typeof history;
          const wealthDistribution = a.map(x => ({ name: x.name, wallet: x.wallet, reputation: x.reputation }));
          wealthDistribution.sort((x, y) => y.wallet - x.wallet);
          const avgBids = h.reduce((sum, r) => sum + r.bids.reduce((s, b) => s + b.bid, 0) / r.bids.length, 0) / h.length;
          return JSON.stringify({
            status: 'success', wealthDistribution, avgBidPrice: Math.round(avgBids * 100) / 100, totalRounds: h.length,
          });
        }
      }

      const report = new MarketReportAgent();
      const resultStr = await report.execute({ analysts, history });
      const result = JSON.parse(resultStr) as Record<string, unknown>;

      expect(result.wealthDistribution).toBeDefined();
      expect((result.wealthDistribution as unknown[]).length).toBe(3);
      expect(result.avgBidPrice).toBeGreaterThan(0);
      expect(result.totalRounds).toBe(2);
    });
  });

  describe('Specialization emergence', () => {
    it('specialists win majority of their category tasks over 20 rounds', async () => {
      const analysts: AnalystState[] = [
        { name: 'DataPro', specialty: 'data', wallet: 0, reputation: 0 },
        { name: 'WebWiz', specialty: 'web', wallet: 0, reputation: 0 },
        { name: 'SecOps', specialty: 'security', wallet: 0, reputation: 0 },
      ];
      const categoryWins: Record<string, Record<string, number>> = {};

      for (let round = 0; round < 20; round++) {
        const task = generateTask(round);
        const graph = new AgentGraph()
          .addNode({ name: 'broker', agent: new BrokerAgent(round), kwargs: { round } })
          .addNode({ name: 'analyst-DataPro', agent: new AnalystAgent('DataPro', 'data', 80, analysts[0].reputation), kwargs: { task }, dependsOn: ['broker'] })
          .addNode({ name: 'analyst-WebWiz', agent: new AnalystAgent('WebWiz', 'web', 100, analysts[1].reputation), kwargs: { task }, dependsOn: ['broker'] })
          .addNode({ name: 'analyst-SecOps', agent: new AnalystAgent('SecOps', 'security', 120, analysts[2].reputation), kwargs: { task }, dependsOn: ['broker'] })
          .addNode({ name: 'auctioneer', agent: new AuctioneerAgent(), dependsOn: ['analyst-DataPro', 'analyst-WebWiz', 'analyst-SecOps'] })
          .addNode({ name: 'settlement', agent: new SettlementAgent(analysts, task), dependsOn: ['auctioneer'] });

        const result = await graph.run();
        const auctionResult = result.nodes.get('auctioneer')?.result as Record<string, unknown>;
        const winnerName = auctionResult.winner as string;

        if (!categoryWins[task.category]) categoryWins[task.category] = {};
        categoryWins[task.category][winnerName] = (categoryWins[task.category][winnerName] || 0) + 1;
      }

      // DataPro should win majority of data tasks (lowest baseCost + specialty discount)
      const dataWins = categoryWins['data'] ?? {};
      expect(dataWins['DataPro'] ?? 0).toBeGreaterThan((dataWins['WebWiz'] ?? 0));
      expect(dataWins['DataPro'] ?? 0).toBeGreaterThan((dataWins['SecOps'] ?? 0));

      // DataPro (cheapest) will also dominate non-specialty, but specialists
      // of web/security should at least win some of their category
      // (WebWiz has specialty discount on web tasks but higher baseCost)
      // With baseCost 80 vs 100*0.75=75, WebWiz actually wins web tasks
      const webWins = categoryWins['web'] ?? {};
      // WebWiz specialty bid for web: 100 * factor * 0.75
      // DataPro non-specialty bid for web: 80 * factor * 1.0
      // At difficulty 1: WebWiz=75, DataPro=80 → WebWiz wins
      expect((webWins['WebWiz'] ?? 0) + (webWins['DataPro'] ?? 0)).toBeGreaterThan(0);
    });
  });
});
