/**
 * Exec Safety
 * Shell command safety checks with injection detection,
 * approval workflow, and audit logging.
 */

import path from 'path';

export interface SafetyCheckResult {
  safe: boolean;
  binary: string;
  reason?: string;
  /** Set when injection patterns are detected */
  injectionType?: string;
  /**
   * True for binaries that can fetch, install, or execute arbitrary code, or
   * change file permissions/ownership (curl, wget, pip, npm, node, chmod, …).
   * They may still be `safe` under the default policy, but an approval layer
   * should gate them — a benign-looking `curl … | sh` is arbitrary RCE.
   */
  dualUse?: boolean;
  /**
   * True when the caller should require explicit human approval before running
   * this command: any dual-use binary, or (in strict mode) one not on the
   * safe list. Distinct from `safe: false`, which means "blocked outright".
   */
  requiresApproval?: boolean;
}

export interface AuditEntry {
  id: string;
  cmd: string;
  binary: string;
  safe: boolean;
  reason?: string;
  status: 'allowed' | 'blocked' | 'pending' | 'approved' | 'rejected' | 'used' | 'expired';
  timestamp: string;
}

export interface PendingApproval {
  id: string;
  cmd: string;
  binary: string;
  reason: string;
  createdAt: string;
  resolve: (approved: boolean) => void;
}

/**
 * A non-blocking, single-use approval token bound to one exact normalized
 * command. Used by callers (e.g. ShellAgent) that need to fail closed
 * immediately and let approval happen out-of-band, rather than awaiting
 * an in-process Promise (see requestApproval/approve/reject below).
 */
export interface ApprovalToken {
  id: string;
  /** The exact normalized command this token is valid for. */
  cmd: string;
  status: 'pending' | 'approved' | 'rejected' | 'used' | 'expired';
  createdAt: string;
  expiresAt: number;
}

export interface ApprovalConsumeResult {
  ok: boolean;
  reason?: string;
}

// Broad compatibility allowlist. Risky members are also classified as
// dual-use below, so callers can preserve the historical `safe` result while
// still requiring explicit approval before execution.
const DEFAULT_SAFE_BINS = new Set([
  'ls', 'cat', 'grep', 'git', 'npm', 'node', 'python', 'python3',
  'pip', 'pip3', 'echo', 'printf', 'pwd', 'whoami', 'date', 'which',
  'curl', 'wget', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'awk',
  'sed', 'find', 'mkdir', 'cp', 'mv', 'touch', 'chmod', 'chown',
  'env', 'export', 'set', 'test', 'true', 'false', 'sleep', 'seq',
  'tar', 'gzip', 'gunzip', 'zip', 'unzip', 'jq', 'diff',
  'yarn', 'pnpm', 'npx', 'tsc', 'tsx', 'vitest',
]);

/**
 * Dual-use binaries: on the safe list, but each can fetch, install, or execute
 * arbitrary code, or alter permissions/ownership. Under the default policy they
 * are `safe: true` (backward-compatible) but flagged `requiresApproval` so an
 * approval layer can gate them. Under `strictDefaults`, any dual-use binary not
 * explicitly added to the safe list is treated as needing approval, not auto-run.
 */
export const DUAL_USE_BINS = new Set([
  // Network fetch (arbitrary download → execute)
  'curl', 'wget',
  // Package install (supply-chain + arbitrary install scripts)
  'pip', 'pip3', 'npm', 'npx', 'yarn', 'pnpm',
  // Arbitrary code execution
  'node', 'python', 'python3', 'tsx', 'tsc', 'vitest',
  // Privilege / permission changes
  'chmod', 'chown',
  // Utilities with built-in command execution or shell escapes
  'find', 'awk', 'sed', 'tar', 'env',
  // Filesystem-mutating utilities
  'mkdir', 'cp', 'mv', 'touch', 'gzip', 'gunzip', 'zip', 'unzip',
  // Commands with output-file or system-mutation modes
  'date', 'sort', 'uniq',
]);

// Injection detection patterns
// ORDER MATTERS: more specific patterns must come before general ones
// (e.g. || before |, && checked separately)
const INJECTION_PATTERNS: Array<{ pattern: RegExp; type: string }> = [
  // Command substitution
  { pattern: /\$\(.*\)/, type: 'command-substitution' },
  { pattern: /`[^`]+`/, type: 'backtick-substitution' },
  // Process substitution
  { pattern: /<\(.*\)/, type: 'process-substitution' },
  // Command chaining (must come before pipe-chain to avoid || matching as pipe)
  { pattern: /\|\|/, type: 'or-chain' },
  { pattern: /&&/, type: 'and-chain' },
  { pattern: /;/, type: 'semicolon-chain' },
  // Pipe chains (single | only, after || is already handled)
  { pattern: /(?<!\|)\|(?!\|)/, type: 'pipe-chain' },
  // Any output redirection can mutate files through absolute, relative, or
  // home-expanded paths. Require exact-command approval for all forms.
  { pattern: />/, type: 'output-redirect' },
  // Variable expansion with side effects
  { pattern: /\$\{[^}]*\}/, type: 'brace-expansion' },
  // Newline injection
  { pattern: /[\r\n]/, type: 'newline-injection' },
];

export interface ExecSafetyOptions {
  /**
   * When true, dual-use binaries are not auto-safe unless explicitly added to
   * the safe list: they return `safe: false, requiresApproval: true` so they
   * route to approval instead of running. Default false (backward-compatible).
   */
  strictDefaults?: boolean;
}

export class ExecSafety {
  private safeBins: Set<string>;
  private strictDefaults: boolean;
  private auditLog: AuditEntry[] = [];
  private pendingApprovals = new Map<string, PendingApproval>();
  private approvalTokens = new Map<string, ApprovalToken>();

  constructor(safeBins?: Iterable<string>, options?: ExecSafetyOptions) {
    this.strictDefaults = options?.strictDefaults ?? false;
    if (safeBins) {
      this.safeBins = new Set(safeBins);
    } else if (this.strictDefaults) {
      // Strict defaults start from the safe set MINUS the dual-use binaries,
      // so curl/npm/chmod/… must be re-added explicitly to auto-run.
      this.safeBins = new Set([...DEFAULT_SAFE_BINS].filter((b) => !DUAL_USE_BINS.has(b)));
    } else {
      this.safeBins = new Set(DEFAULT_SAFE_BINS);
    }
  }

  /**
   * Normalize a command string for consistent safety checks and approval
   * matching: trims outer whitespace and collapses internal whitespace runs
   * to a single space. Does NOT alter casing or content otherwise, since
   * shell commands are case-sensitive.
   */
  normalizeCommand(cmd: string): string {
    return cmd.trim().replace(/\s+/g, ' ');
  }

  /**
   * Check a shell command string for safety.
   * Parses the binary name and checks injection patterns.
   */
  checkCommand(cmd: string): SafetyCheckResult {
    const binary = this.parseBinary(cmd);

    // Check injection patterns first (regardless of binary)
    for (const { pattern, type } of INJECTION_PATTERNS) {
      if (pattern.test(cmd)) {
        const result: SafetyCheckResult = {
          safe: false,
          binary,
          reason: `Injection pattern detected: ${type}`,
          injectionType: type,
        };
        this.recordAudit(cmd, binary, result, 'blocked');
        return result;
      }
    }

    const dualUse = DUAL_USE_BINS.has(binary);

    // Check if binary is in safe list
    if (!this.safeBins.has(binary)) {
      // In strict mode a dual-use binary not explicitly whitelisted routes to
      // approval rather than an outright block — it's known, just gated.
      if (dualUse && this.strictDefaults) {
        const result: SafetyCheckResult = {
          safe: false,
          binary,
          dualUse: true,
          requiresApproval: true,
          reason: `Dual-use binary '${binary}' requires explicit approval (strict defaults)`,
        };
        this.recordAudit(cmd, binary, result, 'pending');
        return result;
      }
      const result: SafetyCheckResult = {
        safe: false,
        binary,
        reason: `Binary '${binary}' is not in the safe list`,
      };
      this.recordAudit(cmd, binary, result, 'blocked');
      return result;
    }

    // On the safe list. Dual-use binaries stay `safe` for backward compatibility
    // but are flagged so an approval layer can gate them.
    const result: SafetyCheckResult = dualUse
      ? { safe: true, binary, dualUse: true, requiresApproval: true }
      : { safe: true, binary };
    this.recordAudit(cmd, binary, result, 'allowed');
    return result;
  }

  /** True if the binary can fetch, install, or execute arbitrary code, or change permissions. */
  isDualUse(bin: string): boolean {
    return DUAL_USE_BINS.has(bin);
  }

  /**
   * Add a binary to the safe list.
   */
  addSafeBin(bin: string): void {
    this.safeBins.add(bin);
  }

  /**
   * Remove a binary from the safe list.
   */
  removeSafeBin(bin: string): void {
    this.safeBins.delete(bin);
  }

  /**
   * List all safe binaries.
   */
  listSafeBins(): string[] {
    return Array.from(this.safeBins).sort();
  }

  /**
   * Check if a binary is safe.
   */
  isSafeBin(bin: string): boolean {
    return this.safeBins.has(bin);
  }

  /**
   * Queue an unsafe command for user approval.
   * Returns a promise that resolves true if approved, false if rejected/timed-out.
   */
  requestApproval(cmd: string, timeoutMs = 300_000): Promise<boolean> {
    const id = `exec_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const binary = this.parseBinary(cmd);

    return new Promise<boolean>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingApprovals.delete(id);
        const entry = this.auditLog.find((e) => e.id === id);
        if (entry) entry.status = 'rejected';
        resolve(false);
      }, timeoutMs);

      const approval: PendingApproval = {
        id,
        cmd,
        binary,
        reason: `Command requires approval: ${cmd}`,
        createdAt: new Date().toISOString(),
        resolve: (approved: boolean) => {
          clearTimeout(timeoutHandle);
          this.pendingApprovals.delete(id);
          resolve(approved);
        },
      };

      this.pendingApprovals.set(id, approval);

      // Record in audit log with pending status
      this.auditLog.push({
        id,
        cmd,
        binary,
        safe: false,
        reason: approval.reason,
        status: 'pending',
        timestamp: approval.createdAt,
      });
    });
  }

  /**
   * Approve a pending command.
   */
  approve(approvalId: string): boolean {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return false;

    const entry = this.auditLog.find((e) => e.id === approvalId);
    if (entry) entry.status = 'approved';

    pending.resolve(true);
    return true;
  }

  /**
   * Reject a pending command.
   */
  reject(approvalId: string): boolean {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return false;

    const entry = this.auditLog.find((e) => e.id === approvalId);
    if (entry) entry.status = 'rejected';

    pending.resolve(false);
    return true;
  }

  /**
   * Get all pending approvals.
   */
  getPendingApprovals(): Omit<PendingApproval, 'resolve'>[] {
    return Array.from(this.pendingApprovals.values()).map(({ resolve: _r, ...rest }) => rest);
  }

  // ── Single-use approval tokens ───────────────────────────────────────────
  //
  // These provide a non-blocking contract for callers (e.g. ShellAgent) that
  // must fail closed immediately: a blocked command yields a token id, which
  // an out-of-band reviewer resolves (approve/reject), and which can then be
  // consumed exactly once for the exact same normalized command it was
  // issued for. This is intentionally separate from requestApproval/approve/
  // reject above, which block on an in-process Promise for interactive
  // callers that can afford to wait.

  /**
   * Issue a single-use approval token scoped to the exact normalized command.
   * Does not block; the token starts out 'pending' until resolved.
   */
  issueApprovalToken(cmd: string, ttlMs = 300_000): ApprovalToken {
    const id = `token_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const normalized = this.normalizeCommand(cmd);
    const token: ApprovalToken = {
      id,
      cmd: normalized,
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + ttlMs,
    };
    this.approvalTokens.set(id, token);

    this.auditLog.push({
      id,
      cmd: normalized,
      binary: this.parseBinary(normalized),
      safe: false,
      reason: `Approval token issued for: ${normalized}`,
      status: 'pending',
      timestamp: token.createdAt,
    });

    return { ...token };
  }

  /**
   * Approve or reject a pending approval token. Returns false if the token
   * does not exist or is no longer pending (already resolved/used/expired).
   */
  resolveApprovalToken(tokenId: string, approved: boolean): boolean {
    const token = this.approvalTokens.get(tokenId);
    if (!token || token.status !== 'pending') return false;
    if (Date.now() > token.expiresAt) {
      token.status = 'expired';
      return false;
    }

    token.status = approved ? 'approved' : 'rejected';

    const entry = this.auditLog.find((e) => e.id === tokenId);
    if (entry) entry.status = token.status;

    return true;
  }

  /**
   * Verify and consume a single-use approval token for the exact given
   * command. Fails closed with an actionable reason on any mismatch:
   * unknown id, expired, already used, not yet approved, rejected, or a
   * command that doesn't match exactly what the token was issued for.
   */
  consumeApprovalToken(tokenId: string, cmd: string): ApprovalConsumeResult {
    const token = this.approvalTokens.get(tokenId);
    if (!token) {
      return { ok: false, reason: 'Unknown or expired approval token' };
    }

    if (token.status !== 'expired' && Date.now() > token.expiresAt) {
      token.status = 'expired';
    }

    if (token.status === 'expired') {
      return { ok: false, reason: 'Approval token has expired' };
    }
    if (token.status === 'used') {
      return { ok: false, reason: 'Approval token was already used (replay attempt)' };
    }
    if (token.status === 'rejected') {
      return { ok: false, reason: 'Approval token was rejected' };
    }
    if (token.status === 'pending') {
      return { ok: false, reason: 'Approval token has not been approved yet' };
    }

    // status === 'approved' at this point
    const normalized = this.normalizeCommand(cmd);
    if (token.cmd !== normalized) {
      return { ok: false, reason: 'Approval token does not match this exact command' };
    }

    token.status = 'used';
    const entry = this.auditLog.find((e) => e.id === tokenId);
    if (entry) entry.status = 'used';

    return { ok: true };
  }

  /**
   * List all approval tokens that are still awaiting resolution.
   */
  getPendingApprovalTokens(): ApprovalToken[] {
    return Array.from(this.approvalTokens.values()).filter((t) => t.status === 'pending');
  }

  /**
   * Look up an approval token by id (any status).
   */
  getApprovalToken(tokenId: string): ApprovalToken | undefined {
    const token = this.approvalTokens.get(tokenId);
    return token ? { ...token } : undefined;
  }

  /**
   * Get the full audit log.
   */
  getAuditLog(): AuditEntry[] {
    return [...this.auditLog];
  }

  /**
   * Clear the audit log.
   */
  clearAuditLog(): void {
    this.auditLog = [];
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private parseBinary(cmd: string): string {
    // Strip leading whitespace and extract the binary name
    const trimmed = cmd.trim();
    // Handle env var prefixes like VAR=value binary ...
    const parts = trimmed.split(/\s+/);
    for (const part of parts) {
      if (!part.includes('=')) {
        // Return just the base name (no path components)
        return path.basename(part);
      }
    }
    return parts[0] ?? '';
  }

  private recordAudit(
    cmd: string,
    binary: string,
    result: SafetyCheckResult,
    status: AuditEntry['status']
  ): void {
    this.auditLog.push({
      id: `audit_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      cmd,
      binary,
      safe: result.safe,
      reason: result.reason,
      status,
      timestamp: new Date().toISOString(),
    });
  }
}

export function createExecSafety(safeBins?: Iterable<string>, options?: ExecSafetyOptions): ExecSafety {
  return new ExecSafety(safeBins, options);
}
