/**
 * Agent Stock Exchange — Multi-round marketplace simulation
 *
 * 3 analyst agents bid on 20 deterministic tasks across 4 categories.
 * An economy emerges from simple bidding rules: specialization,
 * reputation effects, wealth distribution.
 *
 * Run: npx tsx examples/agent-stock-exchange.ts
 */

import { AgentGraph } from '../src/agents/graph.js';
import { BasicAgent } from '../src/agents/BasicAgent.js';

// ── Types ──

interface Task { round: number; category: string; difficulty: number; basePrice: number }
interface AnalystState { name: string; specialty: string; wallet: number; reputation: number }

const CATEGORIES = ['data', 'web', 'security', 'infra'];

function generateTask(round: number): Task {
  return {
    round,
    category: CATEGORIES[round % 4],
    difficulty: ((round * 7 + 3) % 5) + 1,
    basePrice: 100,
  };
}

function calculateBid(baseCost: number, difficulty: number, specialtyMatch: boolean, reputation: number): number {
  const difficultyFactor = 1 + (difficulty - 1) * 0.15;
  const specialtyDiscount = specialtyMatch ? 0.25 : 0;
  const reputationDiscount = Math.min(reputation * 0.02, 0.15);
  return baseCost * difficultyFactor * (1 - specialtyDiscount) * (1 - reputationDiscount);
}

function calculateQuality(specialtyMatch: boolean): number { return specialtyMatch ? 0.95 : 0.7; }
function qualityPasses(quality: number, difficulty: number): boolean { return quality >= difficulty * 0.15; }

// ── Agents ──

class BrokerAgent extends BasicAgent {
  constructor() {
    super('Broker', { name: 'Broker', description: 'Generates tasks', parameters: { type: 'object', properties: {}, required: [] } });
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const task = generateTask(kwargs.round as number);
    return JSON.stringify({ status: 'success', task, data_slush: { source_agent: 'Broker', task } });
  }
}

class AnalystAgent extends BasicAgent {
  private specialty: string;
  private baseCost: number;
  private rep: number;
  constructor(name: string, specialty: string, baseCost: number, reputation: number) {
    super(name, { name, description: `Analyst: ${specialty}`, parameters: { type: 'object', properties: {}, required: [] } });
    this.specialty = specialty;
    this.baseCost = baseCost;
    this.rep = reputation;
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const task = kwargs.task as Task;
    const match = task.category === this.specialty;
    const bid = calculateBid(this.baseCost, task.difficulty, match, this.rep);
    return JSON.stringify({ status: 'success', bid, data_slush: { source_agent: this.name, bid, specialtyMatch: match } });
  }
}

class AuctioneerAgent extends BasicAgent {
  constructor() {
    super('Auctioneer', { name: 'Auctioneer', description: 'Picks lowest bid', parameters: { type: 'object', properties: {}, required: [] } });
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const upstream = (kwargs._context as Record<string, unknown>)?.upstream_slush as Record<string, Record<string, unknown>>;
    const bids = Object.entries(upstream)
      .filter(([, s]) => typeof s.bid === 'number')
      .map(([, s]) => ({ name: s.source_agent as string, bid: s.bid as number, specialtyMatch: s.specialtyMatch as boolean }))
      .sort((a, b) => a.bid - b.bid);
    const w = bids[0];
    return JSON.stringify({ status: 'success', winner: w.name, winningBid: w.bid, data_slush: { source_agent: 'Auctioneer', winner: w.name, winningBid: w.bid, specialtyMatch: w.specialtyMatch } });
  }
}

class SettlementAgent extends BasicAgent {
  private analysts: AnalystState[];
  private task: Task;
  constructor(analysts: AnalystState[], task: Task) {
    super('Settlement', { name: 'Settlement', description: 'Settles round', parameters: { type: 'object', properties: {}, required: [] } });
    this.analysts = analysts;
    this.task = task;
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const upstream = (kwargs._context as Record<string, unknown>)?.upstream_slush as Record<string, Record<string, unknown>>;
    const s = Object.values(upstream).find(v => v.source_agent === 'Auctioneer')!;
    const winner = this.analysts.find(a => a.name === (s.winner as string))!;
    winner.wallet += this.task.basePrice - (s.winningBid as number);
    const q = calculateQuality(s.specialtyMatch as boolean);
    const passed = qualityPasses(q, this.task.difficulty);
    if (s.specialtyMatch) winner.reputation += 1;
    else if (passed) winner.reputation += 0.5;
    else winner.reputation -= 1;
    return JSON.stringify({ status: 'success', winner: winner.name, qualityPassed: passed });
  }
}

// ── Main ──

async function main() {
  console.log('=== Agent Stock Exchange: 20-Round Marketplace ===\n');

  const analysts: AnalystState[] = [
    { name: 'DataPro', specialty: 'data', wallet: 0, reputation: 0 },
    { name: 'WebWiz', specialty: 'web', wallet: 0, reputation: 0 },
    { name: 'SecOps', specialty: 'security', wallet: 0, reputation: 0 },
  ];

  for (let round = 0; round < 20; round++) {
    const task = generateTask(round);
    const graph = new AgentGraph()
      .addNode({ name: 'broker', agent: new BrokerAgent(), kwargs: { round } })
      .addNode({ name: 'analyst-DataPro', agent: new AnalystAgent('DataPro', 'data', 80, analysts[0].reputation), kwargs: { task }, dependsOn: ['broker'] })
      .addNode({ name: 'analyst-WebWiz', agent: new AnalystAgent('WebWiz', 'web', 100, analysts[1].reputation), kwargs: { task }, dependsOn: ['broker'] })
      .addNode({ name: 'analyst-SecOps', agent: new AnalystAgent('SecOps', 'security', 120, analysts[2].reputation), kwargs: { task }, dependsOn: ['broker'] })
      .addNode({ name: 'auctioneer', agent: new AuctioneerAgent(), dependsOn: ['analyst-DataPro', 'analyst-WebWiz', 'analyst-SecOps'] })
      .addNode({ name: 'settlement', agent: new SettlementAgent(analysts, task), dependsOn: ['auctioneer'] });

    const result = await graph.run();
    const auc = result.nodes.get('auctioneer')?.result as Record<string, unknown>;
    console.log(`  Round ${round.toString().padStart(2)}: ${task.category.padEnd(8)} d=${task.difficulty}  winner=${(auc.winner as string).padEnd(6)}  bid=${(auc.winningBid as number).toFixed(1)}`);
  }

  console.log('\n--- Final Standings ---');
  for (const a of analysts) {
    console.log(`  ${a.name.padEnd(8)} wallet=${a.wallet.toFixed(1).padStart(7)}  rep=${a.reputation.toFixed(1)}`);
  }
}

main().catch(console.error);
