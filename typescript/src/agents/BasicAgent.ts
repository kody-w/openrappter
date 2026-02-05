/**
 * BasicAgent - Base class for all TypeScript agents with built-in data sloshing.
 *
 * Data sloshing is IMPLICIT - every agent automatically enriches context
 * before performing its action. This provides:
 * - Temporal awareness (time of day, fiscal period, urgency signals)
 * - Memory echoes (relevant past interactions)
 * - User behavioral hints (preferences, patterns)
 * - Entity relationship signals
 * - Disambiguation priors
 *
 * Subclasses just implement `perform()` - the context is already enriched.
 *
 * This mirrors the Python BasicAgent in agents/basic_agent.py
 */

import type {
  AgentMetadata,
  AgentContext,
  TemporalContext,
  QuerySignals,
  MemoryEcho,
  BehavioralHints,
  Prior,
  Orientation,
} from './types.js';

export abstract class BasicAgent {
  name: string;
  metadata: AgentMetadata;
  context: AgentContext | null = null;

  constructor(name: string, metadata: AgentMetadata) {
    this.name = name;
    this.metadata = metadata;
  }

  /**
   * Main entry point - sloshes context then calls perform().
   * Called by the orchestrator instead of perform() directly.
   */
  async execute(kwargs: Record<string, unknown> = {}): Promise<string> {
    const query = (kwargs.query ?? kwargs.request ?? kwargs.user_input ?? '') as string;
    
    this.context = this.slosh(query);
    kwargs._context = this.context;
    
    return this.perform(kwargs);
  }

  /**
   * Override this in subclasses. Context is available via this.context
   */
  abstract perform(kwargs: Record<string, unknown>): Promise<string>;

  /**
   * Data sloshing - gather contextual signals from multiple sources.
   * Returns enriched context frame.
   */
  slosh(query: string = ''): AgentContext {
    const context: AgentContext = {
      timestamp: new Date().toISOString(),
      temporal: this.sloshTemporal(),
      query_signals: this.sloshQuery(query),
      memory_echoes: this.sloshMemory(query),
      behavioral: this.sloshBehavioral(),
      priors: this.sloshPriors(query),
      orientation: {} as Orientation,
    };

    context.orientation = this.synthesizeOrientation(context);
    return context;
  }

  /**
   * Get a specific signal from the context using dot notation.
   */
  getSignal<T>(key: string, defaultValue?: T): T | undefined {
    if (!this.context) return defaultValue;

    if (key.includes('.')) {
      const parts = key.split('.');
      let value: unknown = this.context;
      for (const part of parts) {
        if (value && typeof value === 'object' && part in value) {
          value = (value as Record<string, unknown>)[part];
        } else {
          return defaultValue;
        }
      }
      return (value ?? defaultValue) as T;
    }
    return ((this.context as unknown as Record<string, unknown>)[key] ?? defaultValue) as T;
  }

  /**
   * Temporal context signals
   */
  private sloshTemporal(): TemporalContext {
    const now = new Date();
    const hour = now.getHours();
    const month = now.getMonth() + 1;
    const day = now.getDate();

    let time_of_day: string;
    let likely_activity: string;

    if (hour >= 5 && hour < 9) {
      time_of_day = 'early_morning';
      likely_activity = 'preparing_for_day';
    } else if (hour >= 9 && hour < 12) {
      time_of_day = 'morning';
      likely_activity = 'active_work';
    } else if (hour >= 12 && hour < 17) {
      time_of_day = 'afternoon';
      likely_activity = 'follow_ups';
    } else if (hour >= 17 && hour < 21) {
      time_of_day = 'evening';
      likely_activity = 'wrap_up';
    } else {
      time_of_day = 'night';
      likely_activity = 'after_hours';
    }

    let fiscal: string;
    if ([1, 4, 7, 10].includes(month) && day <= 15) {
      fiscal = 'quarter_start';
    } else if ([3, 6, 9, 12].includes(month) && day >= 15) {
      fiscal = 'quarter_end_push';
    } else if (month === 12) {
      fiscal = 'year_end';
    } else {
      fiscal = 'mid_quarter';
    }

    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    return {
      time_of_day,
      day_of_week: days[now.getDay()],
      is_weekend: now.getDay() === 0 || now.getDay() === 6,
      quarter: `Q${Math.floor((month - 1) / 3) + 1}`,
      fiscal,
      likely_activity,
      is_urgent_period: ['quarter_end_push', 'year_end'].includes(fiscal),
    };
  }

  /**
   * Extract signals from the query itself
   */
  private sloshQuery(query: string): QuerySignals {
    if (!query) {
      return { specificity: 'low', hints: [], word_count: 0, is_question: false, has_id_pattern: false };
    }

    const queryLower = query.toLowerCase();
    const hints: string[] = [];

    // Temporal hints
    if (['today', 'this morning', 'now'].some(w => queryLower.includes(w))) {
      hints.push('temporal:today');
    }
    if (['latest', 'recent', 'current', 'active'].some(w => queryLower.includes(w))) {
      hints.push('temporal:recency');
    }
    if (['yesterday', 'last week', 'previous'].some(w => queryLower.includes(w))) {
      hints.push('temporal:past');
    }
    if (/q[1-4]/i.test(queryLower)) {
      hints.push('temporal:quarterly');
    }

    // Ownership hints
    if (/\bmy\b|\bmine\b/.test(queryLower)) {
      hints.push('ownership:user');
    }
    if (/\bour\b|\bteam\b/.test(queryLower)) {
      hints.push('ownership:team');
    }

    const hasId = /[a-f0-9]{8}-/.test(queryLower);
    const hasNumber = /\b\d+\b/.test(queryLower);

    let specificity: 'low' | 'medium' | 'high';
    if (hasId) {
      specificity = 'high';
    } else if (hints.length >= 2 || hasNumber) {
      specificity = 'medium';
    } else {
      specificity = 'low';
    }

    return {
      specificity,
      hints,
      word_count: query.split(/\s+/).length,
      is_question: query.includes('?'),
      has_id_pattern: hasId,
    };
  }

  /**
   * Find relevant memory echoes (stub - override or extend with storage)
   */
  protected sloshMemory(_query: string): MemoryEcho[] {
    // Subclasses can override to integrate with storage
    return [];
  }

  /**
   * Infer behavioral patterns (stub - override or extend with storage)
   */
  protected sloshBehavioral(): BehavioralHints {
    return {
      prefers_brief: false,
      technical_level: 'standard',
      frequent_entities: [],
    };
  }

  /**
   * Get disambiguation priors (stub - override or extend with storage)
   */
  protected sloshPriors(_query: string): Record<string, Prior> {
    return {};
  }

  /**
   * Synthesize signals into actionable orientation
   */
  private synthesizeOrientation(context: AgentContext): Orientation {
    const querySignals = context.query_signals;
    const priors = context.priors;
    const temporal = context.temporal;

    let confidence: 'low' | 'medium' | 'high';
    let approach: 'direct' | 'use_preference' | 'contextual' | 'clarify';

    if (querySignals.specificity === 'high') {
      confidence = 'high';
      approach = 'direct';
    } else if (Object.keys(priors).length > 0) {
      confidence = 'high';
      approach = 'use_preference';
    } else if (querySignals.specificity === 'medium') {
      confidence = 'medium';
      approach = 'contextual';
    } else {
      confidence = 'low';
      approach = 'clarify';
    }

    const hints: string[] = [];
    for (const hint of querySignals.hints) {
      if (hint === 'temporal:recency') hints.push('Sort by most recent');
      else if (hint === 'ownership:user') hints.push('Filter by current user');
      else if (hint === 'temporal:today') hints.push("Focus on today's items");
    }

    if (temporal.is_urgent_period) {
      hints.push('Quarter/year end - prioritize closing activities');
    }

    return {
      confidence,
      approach,
      hints,
      response_style: context.behavioral.prefers_brief ? 'concise' : 'standard',
    };
  }
}
