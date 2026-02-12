/**
 * Shared types for the agent system.
 * These types mirror the Python agent metadata format (OpenAI tools format).
 *
 * Single File Agent Pattern:
 *   One file = one agent. Metadata, docs, and code all in a single .ts file.
 *   Use the native constructor: super('Name', { name, description, parameters })
 */

export interface AgentParameter {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: string[];
}

export interface AgentParameters {
  type: 'object';
  properties: Record<string, AgentParameter>;
  required: string[];
}

export interface AgentMetadata {
  name: string;
  description: string;
  parameters: AgentParameters;
}

export interface AgentContext {
  timestamp: string;
  temporal: TemporalContext;
  query_signals: QuerySignals;
  memory_echoes: MemoryEcho[];
  behavioral: BehavioralHints;
  priors: Record<string, Prior>;
  orientation: Orientation;
  upstream_slush?: Record<string, unknown>;
}

export interface TemporalContext {
  time_of_day: string;
  day_of_week: string;
  is_weekend: boolean;
  quarter: string;
  fiscal: string;
  likely_activity: string;
  is_urgent_period: boolean;
}

export interface QuerySignals {
  specificity: 'low' | 'medium' | 'high';
  hints: string[];
  word_count: number;
  is_question: boolean;
  has_id_pattern: boolean;
}

export interface MemoryEcho {
  message: string;
  theme: string;
  relevance: number;
}

export interface BehavioralHints {
  prefers_brief: boolean;
  technical_level: 'standard' | 'intermediate' | 'advanced';
  frequent_entities: string[];
}

export interface Prior {
  preferred: string;
  confidence: number;
}

export interface Orientation {
  confidence: 'low' | 'medium' | 'high';
  approach: 'direct' | 'use_preference' | 'contextual' | 'clarify';
  hints: string[];
  response_style: 'concise' | 'standard';
}

export interface AgentResult {
  status: 'success' | 'error' | 'info';
  message?: string;
  result?: unknown;
  [key: string]: unknown;
}

export interface AgentInfo {
  name: string;
  description: string;
  parameters: AgentParameters;
  module: string;
  file: string;
}
