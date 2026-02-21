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
 * Single File Agent Pattern:
 *   One file = one agent. The metadata contract, documentation, and
 *   deterministic code all live in a single .ts file. No config files,
 *   no YAML, no separate manifests. Just native TypeScript:
 *
 *     export class MyAgent extends BasicAgent {
 *       constructor() {
 *         super('MyAgent', { name: 'MyAgent', description: '...', parameters: {...} });
 *       }
 *       async perform(kwargs) { ... }
 *     }
 *
 * This mirrors the Python BasicAgent in agents/basic_agent.py
 */

import { createHash } from 'crypto';
import type {
  AgentMetadata,
  AgentContext,
  TemporalContext,
  QuerySignals,
  MemoryEcho,
  BehavioralHints,
  Prior,
  Orientation,
  Breadcrumb,
  SloshFilter,
  SloshPreferences,
  SloshFeedback,
  SloshPrivacy,
  SloshDebugEvent,
  SloshDebugHandler,
  SignalCategory,
} from './types.js';

export abstract class BasicAgent {
  name: string;
  metadata: AgentMetadata;
  context: AgentContext | null = null;

  /**
   * The data_slush output from the most recent execute() call.
   * Feed this into the next agent's upstream_slush for chaining.
   */
  lastDataSlush: Record<string, unknown> | null = null;

  sloshFilter: SloshFilter | null = null;
  sloshPreferences: SloshPreferences | null = null;
  breadcrumbs: Breadcrumb[] = [];
  maxBreadcrumbs: number = 5;
  signalUtility: Map<string, number> = new Map();
  sloshPrivacy: SloshPrivacy | null = null;
  sloshDebug: boolean = false;
  onSloshDebug: SloshDebugHandler | null = null;
  autoSuppressThreshold: number = -3;
  signalDecay: number = 0.9;

  constructor(name: string, metadata: AgentMetadata) {
    this.name = name;
    this.metadata = metadata;
  }

  /**
   * Main entry point - sloshes context then calls perform().
   * Called by the orchestrator instead of perform() directly.
   *
   * Accepts optional 'upstream_slush' kwarg — a dict of signals from
   * a previous agent's data_slush output. These get merged into context
   * so downstream agents are aware of upstream results without an LLM
   * interpreting between calls.
   */
  async execute(kwargs: Record<string, unknown> = {}): Promise<string> {
    const query = (kwargs.query ?? kwargs.request ?? kwargs.user_input ?? '') as string;

    // Extract per-call overrides
    const callFilter = kwargs._sloshFilter as SloshFilter | undefined;
    const callPrefs = kwargs._sloshPreferences as SloshPreferences | undefined;
    delete kwargs._sloshFilter;
    delete kwargs._sloshPreferences;

    // Decay signal utility scores toward zero
    this.decaySignalUtility();

    const effectivePrivacy = this.sloshPrivacy;

    if (effectivePrivacy?.disabled) {
      this.context = this.buildMinimalContext();
    } else {
      this.context = this.slosh(query);
      this.emitDebug('post-slosh', this.context);

      const effectiveFilter = callFilter ?? this.sloshFilter;
      if (effectiveFilter) {
        this.applyFilter(this.context, effectiveFilter);
      }

      const effectivePrefs = callPrefs ?? this.sloshPreferences;
      if (effectivePrefs) {
        this.applyPreferences(this.context, effectivePrefs);
      }

      // Auto-suppress categories with utility scores at/below threshold
      const autoSuppressed = this.computeAutoSuppress();
      if (autoSuppressed.length > 0) {
        const protectedCategories = effectiveFilter?.include;
        const toSuppress = protectedCategories
          ? autoSuppressed.filter(c => !protectedCategories.includes(c))
          : autoSuppressed;
        if (toSuppress.length > 0) {
          this.applyFilter(this.context, { exclude: toSuppress });
        }
      }

      this.emitDebug('post-filter', this.context);

      if (effectivePrivacy) {
        this.applyPrivacy(this.context, effectivePrivacy);
      }
      this.emitDebug('post-privacy', this.context);
    }

    // Attach breadcrumbs to context
    this.context.breadcrumbs = [...this.breadcrumbs];

    // Merge upstream data_slush into context if provided
    const upstream = kwargs.upstream_slush as Record<string, unknown> | undefined;
    if (upstream && typeof upstream === 'object') {
      this.context.upstream_slush = upstream;
      delete kwargs.upstream_slush;
    }

    kwargs._context = this.context;

    const result = await this.perform(kwargs);

    // Extract data_slush from result for downstream chaining
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(result);
      this.lastDataSlush = parsed?.data_slush as Record<string, unknown> ?? null;
    } catch {
      this.lastDataSlush = null;
    }

    // Extract and process slosh_feedback
    if (parsed && typeof parsed === 'object' && 'slosh_feedback' in parsed) {
      this.processSloshFeedback(parsed.slosh_feedback as SloshFeedback);
    }

    // Record breadcrumb (newest first)
    const breadcrumb: Breadcrumb = {
      query,
      timestamp: new Date().toISOString(),
      confidence: this.context.orientation.confidence,
    };
    this.breadcrumbs.unshift(breadcrumb);
    if (this.breadcrumbs.length > this.maxBreadcrumbs) {
      this.breadcrumbs = this.breadcrumbs.slice(0, this.maxBreadcrumbs);
    }

    this.emitDebug('post-perform', this.context, { result_length: result.length });

    return result;
  }

  /**
   * Build a data_slush dict for downstream chaining.
   * Convenience method so agents don't manually construct the dict.
   */
  slushOut(options: {
    agentName?: string;
    confidence?: string;
    signals?: Record<string, unknown>;
    [key: string]: unknown;
  } = {}): Record<string, unknown> {
    const { agentName, confidence, signals, ...extra } = options;
    const slush: Record<string, unknown> = {
      source_agent: agentName ?? this.name,
      timestamp: new Date().toISOString(),
    };
    if (this.context) {
      const orientation = this.context.orientation;
      if (orientation) {
        slush.orientation = {
          confidence: orientation.confidence,
          approach: orientation.approach,
        };
      }
      const temporal = this.context.temporal;
      if (temporal) {
        slush.temporal_snapshot = {
          time_of_day: temporal.time_of_day,
          fiscal: temporal.fiscal,
        };
      }
    }
    if (confidence !== undefined) slush.confidence = confidence;
    if (signals) slush.signals = signals;
    Object.assign(slush, extra);
    return slush;
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
   * Zero out excluded signal categories. include wins over exclude.
   */
  private applyFilter(context: AgentContext, filter: SloshFilter): void {
    const categories: SignalCategory[] = ['temporal', 'query_signals', 'memory_echoes', 'behavioral', 'priors'];
    let excluded: SignalCategory[];

    if (filter.include && filter.include.length > 0) {
      excluded = categories.filter(c => !filter.include!.includes(c));
    } else if (filter.exclude && filter.exclude.length > 0) {
      excluded = filter.exclude;
    } else {
      return;
    }

    for (const cat of excluded) {
      switch (cat) {
        case 'temporal':
          context.temporal = {} as TemporalContext;
          break;
        case 'query_signals':
          context.query_signals = { specificity: 'low', hints: [], word_count: 0, is_question: false, has_id_pattern: false };
          break;
        case 'memory_echoes':
          context.memory_echoes = [];
          break;
        case 'behavioral':
          context.behavioral = { prefers_brief: false, technical_level: 'standard', frequent_entities: [] };
          break;
        case 'priors':
          context.priors = {};
          break;
      }
    }
  }

  /**
   * Apply preference-based signal tuning.
   * suppress delegates to applyFilter. prioritize adds hint.
   */
  private applyPreferences(context: AgentContext, prefs: SloshPreferences): void {
    if (prefs.suppress && prefs.suppress.length > 0) {
      this.applyFilter(context, { exclude: prefs.suppress });
    }
    if (prefs.prioritize && prefs.prioritize.length > 0) {
      const hint = `Signal priority: ${prefs.prioritize.join(', ')}`;
      context.orientation.hints.unshift(hint);
    }
  }

  /**
   * Update signal utility scores from agent feedback.
   */
  private processSloshFeedback(feedback: SloshFeedback): void {
    if (feedback.useful_signals) {
      for (const path of feedback.useful_signals) {
        this.signalUtility.set(path, (this.signalUtility.get(path) ?? 0) + 1);
      }
    }
    if (feedback.useless_signals) {
      for (const path of feedback.useless_signals) {
        this.signalUtility.set(path, (this.signalUtility.get(path) ?? 0) - 1);
      }
    }
  }

  /**
   * Compute categories to auto-suppress based on accumulated feedback scores.
   * Groups signalUtility entries by top-level category and sums scores.
   * Returns categories whose aggregate score is at or below autoSuppressThreshold.
   */
  private computeAutoSuppress(): SignalCategory[] {
    if (this.signalUtility.size === 0) return [];

    const allCategories: SignalCategory[] = ['temporal', 'query_signals', 'memory_echoes', 'behavioral', 'priors'];
    const categoryScores = new Map<SignalCategory, number>();

    for (const [path, score] of this.signalUtility) {
      const root = path.split('.')[0] as SignalCategory;
      if (allCategories.includes(root)) {
        categoryScores.set(root, (categoryScores.get(root) ?? 0) + score);
      }
    }

    const suppressed: SignalCategory[] = [];
    for (const [cat, score] of categoryScores) {
      if (score <= this.autoSuppressThreshold) {
        suppressed.push(cat);
      }
    }
    return suppressed;
  }

  /**
   * Decay all signal utility scores toward zero by the signalDecay factor.
   * Prunes entries with negligible scores to keep the map clean.
   */
  private decaySignalUtility(): void {
    if (this.signalDecay >= 1 || this.signalUtility.size === 0) return;

    for (const [key, score] of this.signalUtility) {
      const decayed = score * this.signalDecay;
      if (Math.abs(decayed) < 0.01) {
        this.signalUtility.delete(key);
      } else {
        this.signalUtility.set(key, decayed);
      }
    }
  }

  /**
   * Build a minimal context when privacy.disabled is true.
   */
  private buildMinimalContext(): AgentContext {
    return {
      timestamp: new Date().toISOString(),
      temporal: {} as TemporalContext,
      query_signals: { specificity: 'low', hints: [], word_count: 0, is_question: false, has_id_pattern: false },
      memory_echoes: [],
      behavioral: { prefers_brief: false, technical_level: 'standard', frequent_entities: [] },
      priors: {},
      orientation: { confidence: 'low', approach: 'clarify', hints: [], response_style: 'standard' },
    };
  }

  /**
   * Apply privacy controls: redact deletes values, obfuscate replaces with hash.
   */
  private applyPrivacy(context: AgentContext, privacy: SloshPrivacy): void {
    if (privacy.redact) {
      for (const path of privacy.redact) {
        this.setNestedValue(context, path, undefined);
      }
    }
    if (privacy.obfuscate) {
      for (const path of privacy.obfuscate) {
        const val = this.getNestedValue(context, path);
        if (val !== undefined) {
          const hash = createHash('sha256').update(String(val)).digest('hex').slice(0, 8);
          this.setNestedValue(context, path, `[obfuscated:${hash}]`);
        }
      }
    }
  }

  /**
   * Walk a dot-separated path and return the value, or undefined.
   */
  private getNestedValue(obj: unknown, dotPath: string): unknown {
    const parts = dotPath.split('.');
    let current = obj;
    for (const part of parts) {
      if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
        current = (current as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }
    return current;
  }

  /**
   * Walk a dot-separated path and set or delete the value at the leaf.
   */
  private setNestedValue(obj: unknown, dotPath: string, value: unknown): void {
    const parts = dotPath.split('.');
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (current && typeof current === 'object' && parts[i] in (current as Record<string, unknown>)) {
        current = (current as Record<string, unknown>)[parts[i]];
      } else {
        return;
      }
    }
    if (current && typeof current === 'object') {
      const leaf = parts[parts.length - 1];
      if (value === undefined) {
        delete (current as Record<string, unknown>)[leaf];
      } else {
        (current as Record<string, unknown>)[leaf] = value;
      }
    }
  }

  /**
   * Emit a debug event if debugging is enabled.
   */
  private emitDebug(stage: SloshDebugEvent['stage'], context: AgentContext, meta?: Record<string, unknown>): void {
    if (this.sloshDebug && this.onSloshDebug) {
      this.onSloshDebug({
        stage,
        timestamp: new Date().toISOString(),
        context: structuredClone(context),
        meta,
      });
    }
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
