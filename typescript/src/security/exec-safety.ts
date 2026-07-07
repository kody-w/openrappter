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
  status: 'allowed' | 'blocked' | 'pending' | 'approved' | 'rejected';
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

// Default safe binaries
const DEFAULT_SAFE_BINS = new Set([
  'ls', 'cat', 'grep', 'git', 'npm', 'node', 'python', 'python3',
  'pip', 'pip3', 'echo', 'printf', 'pwd', 'whoami', 'date', 'which',
  'curl', 'wget', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'awk',
  'sed', 'find', 'mkdir', 'cp', 'mv', 'touch', 'chmod', 'chown',
  'env', 'export', 'set', 'test', 'true', 'false', 'sleep',
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
  'node', 'python', 'python3', 'tsx',
  // Privilege / permission changes
  'chmod', 'chown',
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
  // Redirection that could be abused
  { pattern: />\s*\/(?!tmp\/)/, type: 'dangerous-redirect' },
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
