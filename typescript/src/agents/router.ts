/**
 * Agent Router
 * Routes messages to appropriate agents based on sender, channel, or group
 */

export interface RoutingRule {
  id: string;
  priority: number;
  conditions: RoutingCondition[];
  agentId: string;
  metadata?: Record<string, unknown>;
}

export interface RoutingCondition {
  type: 'sender' | 'channel' | 'group' | 'pattern' | 'always';
  value?: string;
  pattern?: RegExp;
}

export interface RouteContext {
  senderId: string;
  channelId: string;
  conversationId: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface RouteResult {
  agentId: string;
  sessionKey: string;
  rule?: RoutingRule;
}

export class AgentRouter {
  private rules: RoutingRule[] = [];
  private defaultAgentId = 'default';
  private sessionKeyFormat: 'sender' | 'conversation' | 'channel' | 'custom' = 'conversation';
  private customSessionKey?: (ctx: RouteContext) => string;

  /**
   * Add a routing rule
   */
  addRule(rule: RoutingRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Remove a routing rule
   */
  removeRule(ruleId: string): boolean {
    const index = this.rules.findIndex((r) => r.id === ruleId);
    if (index !== -1) {
      this.rules.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Set default agent
   */
  setDefaultAgent(agentId: string): void {
    this.defaultAgentId = agentId;
  }

  /**
   * Set session key format
   */
  setSessionKeyFormat(
    format: 'sender' | 'conversation' | 'channel' | 'custom',
    customFn?: (ctx: RouteContext) => string
  ): void {
    this.sessionKeyFormat = format;
    this.customSessionKey = customFn;
  }

  /**
   * Route a message to an agent
   */
  route(context: RouteContext): RouteResult {
    const sessionKey = this.getSessionKey(context);

    // Find matching rule
    for (const rule of this.rules) {
      if (this.matchesRule(context, rule)) {
        return {
          agentId: rule.agentId,
          sessionKey,
          rule,
        };
      }
    }

    // Return default agent
    return {
      agentId: this.defaultAgentId,
      sessionKey,
    };
  }

  /**
   * Check if context matches a rule
   */
  private matchesRule(context: RouteContext, rule: RoutingRule): boolean {
    return rule.conditions.every((condition) => this.matchesCondition(context, condition));
  }

  /**
   * Check if context matches a condition
   */
  private matchesCondition(context: RouteContext, condition: RoutingCondition): boolean {
    switch (condition.type) {
      case 'always':
        return true;

      case 'sender':
        return context.senderId === condition.value;

      case 'channel':
        return context.channelId === condition.value;

      case 'group':
        return context.conversationId === condition.value;

      case 'pattern':
        if (condition.pattern) {
          return condition.pattern.test(context.message);
        }
        if (condition.value) {
          return new RegExp(condition.value, 'i').test(context.message);
        }
        return false;

      default:
        return false;
    }
  }

  /**
   * Get session key for context
   */
  private getSessionKey(context: RouteContext): string {
    switch (this.sessionKeyFormat) {
      case 'sender':
        return `${context.channelId}:${context.senderId}`;

      case 'conversation':
        return `${context.channelId}:${context.conversationId}`;

      case 'channel':
        return context.channelId;

      case 'custom':
        if (this.customSessionKey) {
          return this.customSessionKey(context);
        }
        return `${context.channelId}:${context.conversationId}`;

      default:
        return `${context.channelId}:${context.conversationId}`;
    }
  }

  /**
   * Get all rules
   */
  getRules(): RoutingRule[] {
    return [...this.rules];
  }

  /**
   * Create rules from config
   */
  loadRules(
    config: Array<{
      id?: string;
      priority?: number;
      sender?: string;
      channel?: string;
      group?: string;
      pattern?: string;
      agent: string;
    }>
  ): void {
    for (const item of config) {
      const conditions: RoutingCondition[] = [];

      if (item.sender) {
        conditions.push({ type: 'sender', value: item.sender });
      }
      if (item.channel) {
        conditions.push({ type: 'channel', value: item.channel });
      }
      if (item.group) {
        conditions.push({ type: 'group', value: item.group });
      }
      if (item.pattern) {
        conditions.push({ type: 'pattern', value: item.pattern });
      }

      if (conditions.length === 0) {
        conditions.push({ type: 'always' });
      }

      this.addRule({
        id: item.id ?? `rule_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        priority: item.priority ?? 0,
        conditions,
        agentId: item.agent,
      });
    }
  }
}

export function createAgentRouter(): AgentRouter {
  return new AgentRouter();
}
