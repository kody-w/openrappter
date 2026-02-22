/**
 * WatchmakerAgent - Self-evolving agent ecosystem manager.
 *
 * Evaluates agent capabilities, A/B tests competing versions, and promotes
 * winners. Natural selection for software: external processes produce
 * candidate mutations; the Watchmaker decides which survive.
 *
 * Actions: evaluate, compare, register, promote, cycle, status, history
 *
 * Flow (cycle action):
 *   1. Evaluate all active agents with test cases
 *   2. For each slot with candidates, compare active vs candidate
 *   3. Auto-promote candidates that beat active
 *   4. Return full CycleResult audit trail
 *
 * Mirrors Python agents/watchmaker_agent.py
 */

import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';

// ── Type Definitions ────────────────────────────────────────────────

export interface AgentVersion {
  agent: BasicAgent;
  version: string;
  registeredAt: string;
  source: 'manual' | 'learnNew' | 'mutation';
}

export interface AgentSlot {
  name: string;
  active: AgentVersion;
  candidates: AgentVersion[];
  history: PromotionRecord[];
}

export interface TestCase {
  input: Record<string, unknown>;
  expectedFields?: string[];
  expectedStatus?: string;
}

export interface EvaluationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface EvaluationResult {
  agentName: string;
  version: string;
  timestamp: string;
  checks: EvaluationCheck[];
  quality: number;
  status: 'strong' | 'developing' | 'weak';
  latencyMs: number;
}

export interface ComparisonResult {
  agentName: string;
  timestamp: string;
  versionA: string;
  versionB: string;
  resultA: EvaluationResult;
  resultB: EvaluationResult;
  winner: 'A' | 'B' | 'tie';
  qualityDelta: number;
  latencyDelta: number;
  reason: string;
}

export interface PromotionRecord {
  fromVersion: string;
  toVersion: string;
  timestamp: string;
  reason: string;
  quality: number;
}

export interface CycleResult {
  timestamp: string;
  evaluated: EvaluationResult[];
  comparisons: ComparisonResult[];
  promotions: PromotionRecord[];
  summary: string;
}

// ── WatchmakerAgent ─────────────────────────────────────────────────

export class WatchmakerAgent extends BasicAgent {
  private slots: Map<string, AgentSlot> = new Map();
  private evaluationHistory: Map<string, EvaluationResult[]> = new Map();
  private cycleHistory: CycleResult[] = [];
  private defaultTestCases: Map<string, TestCase[]> = new Map();

  constructor() {
    const metadata: AgentMetadata = {
      name: 'Watchmaker',
      description:
        'Self-evolving agent ecosystem manager. Evaluates agent capabilities, A/B tests competing versions, and promotes winners.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'The action to perform.',
            enum: ['evaluate', 'compare', 'register', 'promote', 'cycle', 'status', 'history'],
          },
          agent: {
            type: 'string',
            description: 'Agent name (slot key).',
          },
          version: {
            type: 'string',
            description: 'Version identifier.',
          },
          versionA: {
            type: 'string',
            description: 'Version A for comparison.',
          },
          versionB: {
            type: 'string',
            description: 'Version B for comparison.',
          },
          testCases: {
            type: 'array',
            description: 'Test inputs for evaluation.',
            items: { type: 'object' },
          },
          reason: {
            type: 'string',
            description: 'Promotion reason.',
          },
        },
        required: [],
      },
    };
    super('Watchmaker', metadata);
  }

  /**
   * Inject agents for testing.
   */
  setAgents(agents: Array<{ agent: BasicAgent; version: string; source?: 'manual' | 'learnNew' | 'mutation' }>): void {
    for (const entry of agents) {
      const name = entry.agent.name;
      const agentVersion: AgentVersion = {
        agent: entry.agent,
        version: entry.version,
        registeredAt: new Date().toISOString(),
        source: entry.source ?? 'manual',
      };
      if (!this.slots.has(name)) {
        this.slots.set(name, {
          name,
          active: agentVersion,
          candidates: [],
          history: [],
        });
      } else {
        this.slots.get(name)!.candidates.push(agentVersion);
      }
      if (!this.evaluationHistory.has(name)) {
        this.evaluationHistory.set(name, []);
      }
    }
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const action = kwargs.action as string | undefined;

    if (!action) {
      return JSON.stringify({
        status: 'error',
        message: 'No action specified. Use: evaluate, compare, register, promote, cycle, status, or history',
      });
    }

    try {
      switch (action) {
        case 'register':
          return this.registerAgent(kwargs);
        case 'evaluate':
          return await this.evaluateAgent(kwargs);
        case 'compare':
          return await this.compareAgents(kwargs);
        case 'promote':
          return this.promoteAgent(kwargs);
        case 'cycle':
          return await this.runCycle(kwargs);
        case 'status':
          return this.getStatus(kwargs);
        case 'history':
          return this.getHistory(kwargs);
        default:
          return JSON.stringify({
            status: 'error',
            message: `Unknown action: ${action}`,
          });
      }
    } catch (error) {
      return JSON.stringify({
        status: 'error',
        action,
        message: (error as Error).message,
      });
    }
  }

  // ── register ────────────────────────────────────────────────────

  private registerAgent(kwargs: Record<string, unknown>): string {
    const agentName = kwargs.agent as string | undefined;
    const version = kwargs.version as string | undefined;
    const agentInstance = kwargs.agentInstance as BasicAgent | undefined;
    const source = (kwargs.source as 'manual' | 'learnNew' | 'mutation') ?? 'manual';

    if (!agentName || !version || !agentInstance) {
      return JSON.stringify({
        status: 'error',
        message: 'agent, version, and agentInstance are required for register',
      });
    }

    const agentVersion: AgentVersion = {
      agent: agentInstance,
      version,
      registeredAt: new Date().toISOString(),
      source,
    };

    if (!this.evaluationHistory.has(agentName)) {
      this.evaluationHistory.set(agentName, []);
    }

    const slot = this.slots.get(agentName);
    if (!slot) {
      // First version becomes active
      this.slots.set(agentName, {
        name: agentName,
        active: agentVersion,
        candidates: [],
        history: [],
      });

      const dataSlush = this.slushOut({
        signals: { agent_name: agentName, version, action: 'register' },
        registered: 'active',
      });

      return JSON.stringify({
        status: 'success',
        action: 'register',
        agent: agentName,
        version,
        role: 'active',
        message: `Registered ${agentName} v${version} as active`,
        data_slush: dataSlush,
      });
    }

    // Check for duplicate version
    const allVersions = [slot.active, ...slot.candidates];
    if (allVersions.some(v => v.version === version)) {
      return JSON.stringify({
        status: 'error',
        message: `Version ${version} already registered for ${agentName}`,
      });
    }

    slot.candidates.push(agentVersion);

    const dataSlush = this.slushOut({
      signals: { agent_name: agentName, version, action: 'register' },
      registered: 'candidate',
    });

    return JSON.stringify({
      status: 'success',
      action: 'register',
      agent: agentName,
      version,
      role: 'candidate',
      message: `Registered ${agentName} v${version} as candidate`,
      data_slush: dataSlush,
    });
  }

  // ── evaluate ────────────────────────────────────────────────────

  private async evaluateAgent(kwargs: Record<string, unknown>): Promise<string> {
    const agentName = kwargs.agent as string | undefined;
    if (!agentName) {
      return JSON.stringify({
        status: 'error',
        message: 'agent name is required for evaluate',
      });
    }

    const slot = this.slots.get(agentName);
    if (!slot) {
      return JSON.stringify({
        status: 'error',
        message: `Agent not found: ${agentName}`,
      });
    }

    const targetVersion = kwargs.version as string | undefined;
    let agentVersion: AgentVersion;

    if (targetVersion) {
      const found = [slot.active, ...slot.candidates].find(v => v.version === targetVersion);
      if (!found) {
        return JSON.stringify({
          status: 'error',
          message: `Version ${targetVersion} not found for ${agentName}`,
        });
      }
      agentVersion = found;
    } else {
      agentVersion = slot.active;
    }

    const testCases = (kwargs.testCases as TestCase[]) ??
      this.defaultTestCases.get(agentName) ??
      [{ input: { query: 'health check' } }];

    const evalResult = await this.runEvaluation(agentName, agentVersion, testCases);

    // Store in history
    this.evaluationHistory.get(agentName)!.push(evalResult);

    const dataSlush = this.slushOut({
      signals: {
        agent_name: agentName,
        version: agentVersion.version,
        quality: evalResult.quality,
        eval_status: evalResult.status,
      },
    });

    return JSON.stringify({
      status: 'success',
      action: 'evaluate',
      evaluation: evalResult,
      data_slush: dataSlush,
    });
  }

  // ── compare ─────────────────────────────────────────────────────

  private async compareAgents(kwargs: Record<string, unknown>): Promise<string> {
    const agentName = kwargs.agent as string | undefined;
    const versionA = kwargs.versionA as string | undefined;
    const versionB = kwargs.versionB as string | undefined;

    if (!agentName || !versionA || !versionB) {
      return JSON.stringify({
        status: 'error',
        message: 'agent, versionA, and versionB are required for compare',
      });
    }

    const slot = this.slots.get(agentName);
    if (!slot) {
      return JSON.stringify({
        status: 'error',
        message: `Agent not found: ${agentName}`,
      });
    }

    const allVersions = [slot.active, ...slot.candidates];
    const foundA = allVersions.find(v => v.version === versionA);
    const foundB = allVersions.find(v => v.version === versionB);

    if (!foundA || !foundB) {
      return JSON.stringify({
        status: 'error',
        message: `One or both versions not found: ${versionA}, ${versionB}`,
      });
    }

    const testCases = (kwargs.testCases as TestCase[]) ??
      this.defaultTestCases.get(agentName) ??
      [{ input: { query: 'health check' } }];

    const resultA = await this.runEvaluation(agentName, foundA, testCases);
    const resultB = await this.runEvaluation(agentName, foundB, testCases);

    const comparison = this.buildComparison(agentName, resultA, resultB);

    return JSON.stringify({
      status: 'success',
      action: 'compare',
      comparison,
    });
  }

  // ── promote ─────────────────────────────────────────────────────

  private promoteAgent(kwargs: Record<string, unknown>): string {
    const agentName = kwargs.agent as string | undefined;
    const version = kwargs.version as string | undefined;
    const reason = (kwargs.reason as string) ?? 'manual promotion';

    if (!agentName || !version) {
      return JSON.stringify({
        status: 'error',
        message: 'agent and version are required for promote',
      });
    }

    const slot = this.slots.get(agentName);
    if (!slot) {
      return JSON.stringify({
        status: 'error',
        message: `Agent not found: ${agentName}`,
      });
    }

    const candidateIndex = slot.candidates.findIndex(v => v.version === version);
    if (candidateIndex === -1) {
      return JSON.stringify({
        status: 'error',
        message: `Version ${version} not found in candidates for ${agentName}`,
      });
    }

    const candidate = slot.candidates[candidateIndex];
    const latestEval = this.evaluationHistory.get(agentName)?.filter(e => e.version === version).pop();

    this.doPromotion(slot, candidate, candidateIndex, reason, latestEval?.quality ?? 0);

    const dataSlush = this.slushOut({
      signals: { agent_name: agentName, promoted_version: version, reason },
    });

    return JSON.stringify({
      status: 'success',
      action: 'promote',
      agent: agentName,
      version,
      reason,
      message: `Promoted ${agentName} to v${version}`,
      data_slush: dataSlush,
    });
  }

  // ── cycle ───────────────────────────────────────────────────────

  private async runCycle(kwargs: Record<string, unknown>): Promise<string> {
    const testCasesOverride = kwargs.testCases as TestCase[] | undefined;
    const cycleResult: CycleResult = {
      timestamp: new Date().toISOString(),
      evaluated: [],
      comparisons: [],
      promotions: [],
      summary: '',
    };

    // Phase 1: Evaluate all active agents
    for (const [name, slot] of this.slots) {
      const testCases = testCasesOverride ??
        this.defaultTestCases.get(name) ??
        [{ input: { query: 'health check' } }];

      const evalResult = await this.runEvaluation(name, slot.active, testCases);
      this.evaluationHistory.get(name)!.push(evalResult);
      cycleResult.evaluated.push(evalResult);

      // Phase 2: Compare active vs each candidate
      for (let i = 0; i < slot.candidates.length; i++) {
        const candidate = slot.candidates[i];
        const candidateEval = await this.runEvaluation(name, candidate, testCases);
        this.evaluationHistory.get(name)!.push(candidateEval);
        cycleResult.evaluated.push(candidateEval);

        const comparison = this.buildComparison(name, evalResult, candidateEval);
        cycleResult.comparisons.push(comparison);

        // Phase 3: Auto-promote if candidate wins
        if (comparison.winner === 'B') {
          const record = this.doPromotion(
            slot,
            candidate,
            i,
            `Outperformed active: quality ${candidateEval.quality} vs ${evalResult.quality}`,
            candidateEval.quality,
          );
          cycleResult.promotions.push(record);
          // After promotion, the candidate is removed from the array,
          // so decrement i to account for the shift
          i--;
        }
      }
    }

    cycleResult.summary = `Evaluated ${cycleResult.evaluated.length} versions, ` +
      `${cycleResult.comparisons.length} comparisons, ` +
      `${cycleResult.promotions.length} promotions`;

    this.cycleHistory.push(cycleResult);

    const dataSlush = this.slushOut({
      signals: {
        evaluations_run: cycleResult.evaluated.length,
        comparisons_run: cycleResult.comparisons.length,
        promotions_made: cycleResult.promotions.length,
      },
    });

    return JSON.stringify({
      status: 'success',
      action: 'cycle',
      cycle: cycleResult,
      data_slush: dataSlush,
    });
  }

  // ── status ──────────────────────────────────────────────────────

  private getStatus(kwargs: Record<string, unknown>): string {
    const agentName = kwargs.agent as string | undefined;

    if (!agentName) {
      // Return all slots
      const allSlots: Record<string, unknown>[] = [];
      for (const [, slot] of this.slots) {
        allSlots.push(this.slotSummary(slot));
      }
      return JSON.stringify({
        status: 'success',
        action: 'status',
        slots: allSlots,
        count: allSlots.length,
      });
    }

    const slot = this.slots.get(agentName);
    if (!slot) {
      return JSON.stringify({
        status: 'error',
        message: `Agent not found: ${agentName}`,
      });
    }

    return JSON.stringify({
      status: 'success',
      action: 'status',
      slot: this.slotSummary(slot),
    });
  }

  // ── history ─────────────────────────────────────────────────────

  private getHistory(kwargs: Record<string, unknown>): string {
    const agentName = kwargs.agent as string | undefined;

    if (!agentName) {
      // Return cycle history
      return JSON.stringify({
        status: 'success',
        action: 'history',
        cycles: this.cycleHistory,
        count: this.cycleHistory.length,
      });
    }

    const slot = this.slots.get(agentName);
    if (!slot) {
      return JSON.stringify({
        status: 'error',
        message: `Agent not found: ${agentName}`,
      });
    }

    const evalHistory = this.evaluationHistory.get(agentName) ?? [];

    return JSON.stringify({
      status: 'success',
      action: 'history',
      agent: agentName,
      evaluations: evalHistory,
      promotions: slot.history,
      evaluationCount: evalHistory.length,
      promotionCount: slot.history.length,
    });
  }

  // ── Internal helpers ────────────────────────────────────────────

  private async runEvaluation(
    agentName: string,
    agentVersion: AgentVersion,
    testCases: TestCase[],
  ): Promise<EvaluationResult> {
    const checks: EvaluationCheck[] = [];
    const startTime = Date.now();

    for (const testCase of testCases) {
      let result: string | null = null;
      let parsed: Record<string, unknown> | null = null;
      let threw = false;

      try {
        result = await agentVersion.agent.execute(testCase.input);
      } catch {
        threw = true;
      }

      // Check: executes_without_error
      checks.push({
        name: 'executes_without_error',
        passed: !threw,
        detail: threw ? 'Agent threw an exception' : 'Agent executed successfully',
      });

      if (threw || result === null) continue;

      // Check: returns_valid_json
      let isValidJson = false;
      try {
        parsed = JSON.parse(result);
        isValidJson = parsed !== null && typeof parsed === 'object';
      } catch {
        isValidJson = false;
      }
      checks.push({
        name: 'returns_valid_json',
        passed: isValidJson,
        detail: isValidJson ? 'Valid JSON response' : 'Response is not valid JSON',
      });

      if (!isValidJson || !parsed) continue;

      // Check: status_matches
      if (testCase.expectedStatus) {
        const statusMatches = parsed.status === testCase.expectedStatus;
        checks.push({
          name: 'status_matches',
          passed: statusMatches,
          detail: statusMatches
            ? `Status matches: ${testCase.expectedStatus}`
            : `Expected status "${testCase.expectedStatus}", got "${parsed.status}"`,
        });
      }

      // Check: has_field_X
      if (testCase.expectedFields) {
        for (const field of testCase.expectedFields) {
          const hasField = field in parsed;
          checks.push({
            name: `has_field_${field}`,
            passed: hasField,
            detail: hasField ? `Field "${field}" present` : `Field "${field}" missing`,
          });
        }
      }

      // Check: has_data_slush
      const hasSlush = 'data_slush' in parsed;
      checks.push({
        name: 'has_data_slush',
        passed: hasSlush,
        detail: hasSlush ? 'data_slush present' : 'data_slush missing',
      });
    }

    const latencyMs = Date.now() - startTime;
    const passedCount = checks.filter(c => c.passed).length;
    const quality = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0;

    let evalStatus: 'strong' | 'developing' | 'weak';
    if (quality >= 80) {
      evalStatus = 'strong';
    } else if (quality >= 50) {
      evalStatus = 'developing';
    } else {
      evalStatus = 'weak';
    }

    return {
      agentName,
      version: agentVersion.version,
      timestamp: new Date().toISOString(),
      checks,
      quality,
      status: evalStatus,
      latencyMs,
    };
  }

  private buildComparison(
    agentName: string,
    resultA: EvaluationResult,
    resultB: EvaluationResult,
  ): ComparisonResult {
    const qualityDelta = resultB.quality - resultA.quality;
    const latencyDelta = resultB.latencyMs - resultA.latencyMs;

    let winner: 'A' | 'B' | 'tie';
    let reason: string;

    if (Math.abs(qualityDelta) > 5) {
      winner = qualityDelta > 0 ? 'B' : 'A';
      reason = `Quality difference: ${Math.abs(qualityDelta)} points`;
    } else {
      const avgLatency = (resultA.latencyMs + resultB.latencyMs) / 2;
      const latencyThreshold = avgLatency > 0 ? Math.abs(latencyDelta) / avgLatency : 0;
      if (latencyThreshold > 0.2 && Math.abs(latencyDelta) >= 5) {
        winner = latencyDelta < 0 ? 'B' : 'A';
        reason = `Latency tiebreaker: ${Math.abs(latencyDelta)}ms difference`;
      } else {
        winner = 'tie';
        reason = 'No significant difference in quality or latency';
      }
    }

    return {
      agentName,
      timestamp: new Date().toISOString(),
      versionA: resultA.version,
      versionB: resultB.version,
      resultA,
      resultB,
      winner,
      qualityDelta,
      latencyDelta,
      reason,
    };
  }

  private doPromotion(
    slot: AgentSlot,
    candidate: AgentVersion,
    candidateIndex: number,
    reason: string,
    quality: number,
  ): PromotionRecord {
    const record: PromotionRecord = {
      fromVersion: slot.active.version,
      toVersion: candidate.version,
      timestamp: new Date().toISOString(),
      reason,
      quality,
    };

    slot.active = candidate;
    slot.candidates.splice(candidateIndex, 1);
    slot.history.push(record);

    return record;
  }

  private slotSummary(slot: AgentSlot): Record<string, unknown> {
    const latestEval = this.evaluationHistory
      .get(slot.name)
      ?.filter(e => e.version === slot.active.version)
      .pop();

    return {
      name: slot.name,
      activeVersion: slot.active.version,
      candidateCount: slot.candidates.length,
      latestQuality: latestEval?.quality ?? null,
      latestStatus: latestEval?.status ?? null,
      promotionCount: slot.history.length,
    };
  }
}
