/**
 * Exec Safety
 * Shell command safety checks with injection detection,
 * approval workflow, and audit logging.
 */

export interface SafetyCheckResult {
  safe: boolean;
  binary: string;
  reason?: string;
  /** Set when injection patterns are detected */
  injectionType?: string;
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

export class ExecSafety {
  private safeBins: Set<string>;
  private auditLog: AuditEntry[] = [];
  private pendingApprovals = new Map<string, PendingApproval>();

  constructor(safeBins?: Iterable<string>) {
    this.safeBins = safeBins ? new Set(safeBins) : new Set(DEFAULT_SAFE_BINS);
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

    // Check if binary is in safe list
    if (!this.safeBins.has(binary)) {
      const result: SafetyCheckResult = {
        safe: false,
        binary,
        reason: `Binary '${binary}' is not in the safe list`,
      };
      this.recordAudit(cmd, binary, result, 'blocked');
      return result;
    }

    const result: SafetyCheckResult = { safe: true, binary };
    this.recordAudit(cmd, binary, result, 'allowed');
    return result;
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
        return part.split('/').pop() ?? part;
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

export function createExecSafety(safeBins?: Iterable<string>): ExecSafety {
  return new ExecSafety(safeBins);
}
