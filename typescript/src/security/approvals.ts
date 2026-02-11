/**
 * Exec Approvals System
 * Manages tool/command execution policies
 */

export type ApprovalPolicy = 'deny' | 'allowlist' | 'full';

export interface ApprovalRule {
  id: string;
  name: string;
  description?: string;
  policy: ApprovalPolicy;

  // Scope
  tools?: string[];
  channels?: string[];
  senders?: string[];
  agents?: string[];

  // Allowlist (only for 'allowlist' policy)
  allowedTools?: string[];
  allowedCommands?: string[];
  allowedPatterns?: string[];

  // Blocklist (applies to all policies)
  blockedTools?: string[];
  blockedCommands?: string[];
  blockedPatterns?: string[];

  // Approval settings
  requireApproval?: boolean;
  approvalTimeout?: number;

  priority: number;
  enabled: boolean;
}

export interface ApprovalRequest {
  id: string;
  ruleId?: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  sessionId?: string;
  senderId?: string;
  channelId?: string;
  agentId?: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  reason?: string;
}

export interface ApprovalContext {
  toolName: string;
  toolArgs: Record<string, unknown>;
  sessionId?: string;
  senderId?: string;
  channelId?: string;
  agentId?: string;
}

export interface ApprovalResult {
  allowed: boolean;
  requiresApproval: boolean;
  rule?: ApprovalRule;
  requestId?: string;
  reason?: string;
}

const DEFAULT_APPROVAL_TIMEOUT = 300000; // 5 minutes

export class ApprovalManager {
  private rules = new Map<string, ApprovalRule>();
  private requests = new Map<string, ApprovalRequest>();
  private defaultPolicy: ApprovalPolicy = 'allowlist';
  private approvalCallbacks = new Map<
    string,
    { resolve: (approved: boolean) => void; timeout: NodeJS.Timeout }
  >();

  /**
   * Set default policy
   */
  setDefaultPolicy(policy: ApprovalPolicy): void {
    this.defaultPolicy = policy;
  }

  /**
   * Add an approval rule
   */
  addRule(rule: ApprovalRule): void {
    this.rules.set(rule.id, rule);
  }

  /**
   * Remove an approval rule
   */
  removeRule(ruleId: string): boolean {
    return this.rules.delete(ruleId);
  }

  /**
   * Get a rule
   */
  getRule(ruleId: string): ApprovalRule | undefined {
    return this.rules.get(ruleId);
  }

  /**
   * Get all rules
   */
  getRules(): ApprovalRule[] {
    return Array.from(this.rules.values()).sort((a, b) => b.priority - a.priority);
  }

  /**
   * Enable/disable a rule
   */
  setRuleEnabled(ruleId: string, enabled: boolean): boolean {
    const rule = this.rules.get(ruleId);
    if (!rule) return false;

    rule.enabled = enabled;
    return true;
  }

  /**
   * Check if a tool call is allowed
   */
  checkApproval(context: ApprovalContext): ApprovalResult {
    // Find matching rule
    const rule = this.findMatchingRule(context);

    // If no rule, use default policy
    const policy = rule?.policy ?? this.defaultPolicy;

    // Check blocked list first (applies to all policies)
    if (this.isBlocked(context, rule)) {
      return {
        allowed: false,
        requiresApproval: false,
        rule,
        reason: 'Tool is blocked by policy',
      };
    }

    switch (policy) {
      case 'deny':
        return {
          allowed: false,
          requiresApproval: false,
          rule,
          reason: 'Tool execution denied by policy',
        };

      case 'allowlist':
        if (this.isAllowed(context, rule)) {
          // Check if still requires explicit approval
          if (rule?.requireApproval) {
            return {
              allowed: false,
              requiresApproval: true,
              rule,
              reason: 'Tool requires explicit approval',
            };
          }
          return { allowed: true, requiresApproval: false, rule };
        }
        return {
          allowed: false,
          requiresApproval: true,
          rule,
          reason: 'Tool not in allowlist',
        };

      case 'full':
        return { allowed: true, requiresApproval: false, rule };

      default:
        return {
          allowed: false,
          requiresApproval: true,
          reason: 'Unknown policy',
        };
    }
  }

  /**
   * Request approval for a tool call
   */
  async requestApproval(context: ApprovalContext): Promise<ApprovalResult> {
    // Check immediate approval
    const immediate = this.checkApproval(context);
    if (immediate.allowed) {
      return immediate;
    }
    if (!immediate.requiresApproval) {
      return immediate;
    }

    // Create approval request
    const timeout = immediate.rule?.approvalTimeout ?? DEFAULT_APPROVAL_TIMEOUT;
    const request: ApprovalRequest = {
      id: `approval_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      ruleId: immediate.rule?.id,
      toolName: context.toolName,
      toolArgs: context.toolArgs,
      sessionId: context.sessionId,
      senderId: context.senderId,
      channelId: context.channelId,
      agentId: context.agentId,
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + timeout).toISOString(),
    };

    this.requests.set(request.id, request);

    // Wait for approval
    const approved = await this.waitForApproval(request.id, timeout);

    if (approved) {
      return {
        allowed: true,
        requiresApproval: true,
        rule: immediate.rule,
        requestId: request.id,
        reason: 'Approved by user',
      };
    }

    return {
      allowed: false,
      requiresApproval: true,
      rule: immediate.rule,
      requestId: request.id,
      reason: request.status === 'expired' ? 'Approval timed out' : 'Rejected by user',
    };
  }

  /**
   * Wait for approval response
   */
  private waitForApproval(requestId: string, timeout: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.approvalCallbacks.delete(requestId);
        const request = this.requests.get(requestId);
        if (request && request.status === 'pending') {
          request.status = 'expired';
        }
        resolve(false);
      }, timeout);

      this.approvalCallbacks.set(requestId, { resolve, timeout: timeoutId });
    });
  }

  /**
   * Approve a pending request
   */
  approveRequest(requestId: string, approvedBy?: string): boolean {
    const request = this.requests.get(requestId);
    if (!request || request.status !== 'pending') {
      return false;
    }

    request.status = 'approved';
    request.resolvedAt = new Date().toISOString();
    request.resolvedBy = approvedBy;

    const callback = this.approvalCallbacks.get(requestId);
    if (callback) {
      clearTimeout(callback.timeout);
      callback.resolve(true);
      this.approvalCallbacks.delete(requestId);
    }

    return true;
  }

  /**
   * Reject a pending request
   */
  rejectRequest(requestId: string, reason?: string, rejectedBy?: string): boolean {
    const request = this.requests.get(requestId);
    if (!request || request.status !== 'pending') {
      return false;
    }

    request.status = 'rejected';
    request.resolvedAt = new Date().toISOString();
    request.resolvedBy = rejectedBy;
    request.reason = reason;

    const callback = this.approvalCallbacks.get(requestId);
    if (callback) {
      clearTimeout(callback.timeout);
      callback.resolve(false);
      this.approvalCallbacks.delete(requestId);
    }

    return true;
  }

  /**
   * Get pending approval requests
   */
  getPendingRequests(): ApprovalRequest[] {
    const now = new Date().toISOString();
    return Array.from(this.requests.values()).filter(
      (r) => r.status === 'pending' && r.expiresAt > now
    );
  }

  /**
   * Get an approval request
   */
  getRequest(requestId: string): ApprovalRequest | undefined {
    return this.requests.get(requestId);
  }

  /**
   * Clean up expired requests
   */
  cleanup(): number {
    const now = new Date();
    let count = 0;

    for (const [id, request] of this.requests) {
      if (request.status === 'pending' && new Date(request.expiresAt) < now) {
        request.status = 'expired';
        const callback = this.approvalCallbacks.get(id);
        if (callback) {
          clearTimeout(callback.timeout);
          callback.resolve(false);
          this.approvalCallbacks.delete(id);
        }
        count++;
      }
    }

    return count;
  }

  // Private methods

  private findMatchingRule(context: ApprovalContext): ApprovalRule | undefined {
    const rules = this.getRules().filter((r) => r.enabled);

    for (const rule of rules) {
      if (this.ruleMatches(context, rule)) {
        return rule;
      }
    }

    return undefined;
  }

  private ruleMatches(context: ApprovalContext, rule: ApprovalRule): boolean {
    // Check tool scope
    if (rule.tools && rule.tools.length > 0) {
      if (!rule.tools.includes(context.toolName)) {
        return false;
      }
    }

    // Check channel scope
    if (rule.channels && rule.channels.length > 0) {
      if (!context.channelId || !rule.channels.includes(context.channelId)) {
        return false;
      }
    }

    // Check sender scope
    if (rule.senders && rule.senders.length > 0) {
      if (!context.senderId || !rule.senders.includes(context.senderId)) {
        return false;
      }
    }

    // Check agent scope
    if (rule.agents && rule.agents.length > 0) {
      if (!context.agentId || !rule.agents.includes(context.agentId)) {
        return false;
      }
    }

    return true;
  }

  private isBlocked(context: ApprovalContext, rule?: ApprovalRule): boolean {
    if (!rule) return false;

    // Check blocked tools
    if (rule.blockedTools?.includes(context.toolName)) {
      return true;
    }

    // Check blocked commands (in args)
    if (rule.blockedCommands && context.toolArgs.command) {
      const cmd = String(context.toolArgs.command);
      if (rule.blockedCommands.some((bc) => cmd.includes(bc))) {
        return true;
      }
    }

    // Check blocked patterns
    if (rule.blockedPatterns) {
      const argsStr = JSON.stringify(context.toolArgs);
      if (rule.blockedPatterns.some((p) => new RegExp(p).test(argsStr))) {
        return true;
      }
    }

    return false;
  }

  private isAllowed(context: ApprovalContext, rule?: ApprovalRule): boolean {
    if (!rule) return false;

    // Check allowed tools
    if (rule.allowedTools?.includes(context.toolName)) {
      return true;
    }

    // Check allowed commands
    if (rule.allowedCommands && context.toolArgs.command) {
      const cmd = String(context.toolArgs.command);
      if (rule.allowedCommands.some((ac) => cmd.startsWith(ac))) {
        return true;
      }
    }

    // Check allowed patterns
    if (rule.allowedPatterns) {
      const argsStr = JSON.stringify(context.toolArgs);
      if (rule.allowedPatterns.some((p) => new RegExp(p).test(argsStr))) {
        return true;
      }
    }

    return false;
  }
}

export function createApprovalManager(): ApprovalManager {
  return new ApprovalManager();
}
