/**
 * Agent system exports
 */

export { BasicAgent } from './BasicAgent.js';
export { AgentRegistry } from './AgentRegistry.js';
export { ShellAgent } from './ShellAgent.js';
export { MemoryAgent } from './MemoryAgent.js';
export { Assistant } from './Assistant.js';
export type { AssistantConfig, AssistantResponse } from './Assistant.js';
export * from './workspace.js';
export * from './types.js';

// Tool agents
export { BrowserAgent } from './BrowserAgent.js';
export { WebAgent } from './WebAgent.js';
export { MessageAgent } from './MessageAgent.js';
export { TTSAgent } from './TTSAgent.js';
export { SessionsAgent } from './SessionsAgent.js';
export { CronAgent } from './CronAgent.js';
export { ImageAgent } from './ImageAgent.js';
export { HackerNewsAgent } from './HackerNewsAgent.js';
export { OuroborosAgent, EVOLUTION_CATALOG, assessEvolution, loadLineageLog, saveLineageLog, computeTrends } from './OuroborosAgent.js';
export type { EvolutionEntry, EvolutionReport, EvolutionLineage, LineageRunSummary, RunDelta, CapabilityTrend, CapabilityScore, Check } from './OuroborosAgent.js';
export { SelfHealingCronAgent } from './SelfHealingCronAgent.js';
export type { JobConfig, CheckResult } from './SelfHealingCronAgent.js';
export { WatchmakerAgent } from './WatchmakerAgent.js';
export type { AgentVersion, AgentSlot, TestCase, EvaluationCheck, EvaluationResult, ComparisonResult, PromotionRecord, CycleResult } from './WatchmakerAgent.js';
export { LearnNewAgent } from './LearnNewAgent.js';
