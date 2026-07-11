"""
ExecSafety — shell command safety checks with injection detection,
single-use approval tokens, and audit logging.

Mirrors typescript/src/security/exec-safety.ts. This is intentionally a
separate concern from ApprovalManager (tool/policy scoping): ExecSafety
parses and validates the raw command string itself (binary allowlisting,
shell injection/chaining detection) and issues non-replayable approval
tokens scoped to the exact normalized command.
"""

import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional

# Broad compatibility allowlist. Risky members are classified as dual-use,
# preserving the historical safe result while requiring caller approval.
DEFAULT_SAFE_BINS = {
    'ls', 'cat', 'grep', 'git', 'npm', 'node', 'python', 'python3',
    'pip', 'pip3', 'echo', 'printf', 'pwd', 'whoami', 'date', 'which',
    'curl', 'wget', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'awk',
    'sed', 'find', 'mkdir', 'cp', 'mv', 'touch', 'chmod', 'chown',
    'env', 'export', 'set', 'test', 'true', 'false', 'sleep', 'seq',
    'tar', 'gzip', 'gunzip', 'zip', 'unzip', 'jq', 'diff',
    'yarn', 'pnpm', 'npx', 'tsc', 'tsx', 'vitest',
}

DUAL_USE_BINS = {
    'curl', 'wget',
    'pip', 'pip3', 'npm', 'npx', 'yarn', 'pnpm',
    'node', 'python', 'python3', 'tsx', 'tsc', 'vitest',
    'chmod', 'chown',
    'find', 'awk', 'sed', 'tar', 'env',
    'mkdir', 'cp', 'mv', 'touch', 'gzip', 'gunzip', 'zip', 'unzip',
    'date', 'sort', 'uniq',
}

# Injection detection patterns.
# ORDER MATTERS: more specific patterns must come before general ones
# (e.g. || before |, && checked separately).
INJECTION_PATTERNS = [
    (re.compile(r'\$\(.*\)'), 'command-substitution'),
    (re.compile(r'`[^`]+`'), 'backtick-substitution'),
    (re.compile(r'<\(.*\)'), 'process-substitution'),
    (re.compile(r'\|\|'), 'or-chain'),
    (re.compile(r'&&'), 'and-chain'),
    (re.compile(r';'), 'semicolon-chain'),
    (re.compile(r'(?<!\|)\|(?!\|)'), 'pipe-chain'),
    # Any output redirection can mutate absolute, relative, or home paths.
    (re.compile(r'>'), 'output-redirect'),
    (re.compile(r'\$\{[^}]*\}'), 'brace-expansion'),
    (re.compile(r'[\r\n]'), 'newline-injection'),
]


@dataclass
class SafetyCheckResult:
    safe: bool
    binary: str
    reason: Optional[str] = None
    injection_type: Optional[str] = None
    dual_use: Optional[bool] = None
    requires_approval: Optional[bool] = None


@dataclass
class AuditEntry:
    id: str
    cmd: str
    binary: str
    safe: bool
    # allowed | blocked | pending | approved | rejected | used | expired
    status: str
    reason: Optional[str] = None
    timestamp: float = field(default_factory=time.time)


@dataclass
class ApprovalToken:
    id: str
    cmd: str  # exact normalized command this token is valid for
    status: str  # pending | approved | rejected | used | expired
    created_at: float
    expires_at: float


@dataclass
class ApprovalConsumeResult:
    ok: bool
    reason: Optional[str] = None


class ExecSafety:
    """Shell command safety checks with injection detection and single-use
    approval tokens scoped to the exact normalized command."""

    def __init__(self, safe_bins: Optional[List[str]] = None) -> None:
        self._safe_bins = set(safe_bins) if safe_bins is not None else set(DEFAULT_SAFE_BINS)
        self._audit_log: List[AuditEntry] = []
        self._tokens: Dict[str, ApprovalToken] = {}

    # ------------------------------------------------------------------
    # Normalization & checking
    # ------------------------------------------------------------------

    @staticmethod
    def normalize_command(cmd: str) -> str:
        """Trim outer whitespace and collapse internal whitespace runs to a
        single space. Case is preserved since shell commands are
        case-sensitive."""
        return re.sub(r'\s+', ' ', cmd.strip())

    def _parse_binary(self, cmd: str) -> str:
        trimmed = cmd.strip()
        parts = trimmed.split()
        for part in parts:
            if '=' not in part:
                return part.rsplit('/', 1)[-1]
        return parts[0] if parts else ''

    def check_command(self, cmd: str) -> SafetyCheckResult:
        """Check a shell command string for safety: injection patterns are
        checked first (regardless of binary), then binary allowlisting."""
        binary = self._parse_binary(cmd)

        for pattern, injection_type in INJECTION_PATTERNS:
            if pattern.search(cmd):
                result = SafetyCheckResult(
                    safe=False,
                    binary=binary,
                    reason=f'Injection pattern detected: {injection_type}',
                    injection_type=injection_type,
                )
                self._record_audit(cmd, binary, result, 'blocked')
                return result

        if binary not in self._safe_bins:
            result = SafetyCheckResult(
                safe=False,
                binary=binary,
                reason=f"Binary '{binary}' is not in the safe list",
            )
            self._record_audit(cmd, binary, result, 'blocked')
            return result

        result = (
            SafetyCheckResult(
                safe=True,
                binary=binary,
                dual_use=True,
                requires_approval=True,
            )
            if binary in DUAL_USE_BINS
            else SafetyCheckResult(safe=True, binary=binary)
        )
        self._record_audit(cmd, binary, result, 'allowed')
        return result

    def add_safe_bin(self, binary: str) -> None:
        self._safe_bins.add(binary)

    def remove_safe_bin(self, binary: str) -> None:
        self._safe_bins.discard(binary)

    def list_safe_bins(self) -> List[str]:
        return sorted(self._safe_bins)

    def is_safe_bin(self, binary: str) -> bool:
        return binary in self._safe_bins

    # ------------------------------------------------------------------
    # Single-use approval tokens
    # ------------------------------------------------------------------
    #
    # Non-blocking contract: a blocked command yields a token id, which an
    # out-of-band reviewer resolves (approve/reject), and which can then be
    # consumed exactly once for the exact same normalized command it was
    # issued for.

    def issue_approval_token(self, cmd: str, ttl_seconds: float = 300.0) -> ApprovalToken:
        token_id = f'token_{uuid.uuid4().hex}'
        normalized = self.normalize_command(cmd)
        token = ApprovalToken(
            id=token_id,
            cmd=normalized,
            status='pending',
            created_at=time.time(),
            expires_at=time.time() + ttl_seconds,
        )
        self._tokens[token_id] = token

        self._audit_log.append(AuditEntry(
            id=token_id,
            cmd=normalized,
            binary=self._parse_binary(normalized),
            safe=False,
            reason=f'Approval token issued for: {normalized}',
            status='pending',
        ))

        return token

    def resolve_approval_token(self, token_id: str, approved: bool) -> bool:
        token = self._tokens.get(token_id)
        if token is None or token.status != 'pending':
            return False
        if time.time() > token.expires_at:
            token.status = 'expired'
            return False

        token.status = 'approved' if approved else 'rejected'

        for entry in self._audit_log:
            if entry.id == token_id:
                entry.status = token.status
                break

        return True

    def consume_approval_token(self, token_id: str, cmd: str) -> ApprovalConsumeResult:
        token = self._tokens.get(token_id)
        if token is None:
            return ApprovalConsumeResult(ok=False, reason='Unknown or expired approval token')

        if token.status != 'expired' and time.time() > token.expires_at:
            token.status = 'expired'

        if token.status == 'expired':
            return ApprovalConsumeResult(ok=False, reason='Approval token has expired')
        if token.status == 'used':
            return ApprovalConsumeResult(ok=False, reason='Approval token was already used (replay attempt)')
        if token.status == 'rejected':
            return ApprovalConsumeResult(ok=False, reason='Approval token was rejected')
        if token.status == 'pending':
            return ApprovalConsumeResult(ok=False, reason='Approval token has not been approved yet')

        # status == 'approved'
        normalized = self.normalize_command(cmd)
        if token.cmd != normalized:
            return ApprovalConsumeResult(ok=False, reason='Approval token does not match this exact command')

        token.status = 'used'
        for entry in self._audit_log:
            if entry.id == token_id:
                entry.status = 'used'
                break

        return ApprovalConsumeResult(ok=True)

    def get_pending_approval_tokens(self) -> List[ApprovalToken]:
        return [t for t in self._tokens.values() if t.status == 'pending']

    def get_approval_token(self, token_id: str) -> Optional[ApprovalToken]:
        return self._tokens.get(token_id)

    # ------------------------------------------------------------------
    # Audit log
    # ------------------------------------------------------------------

    def _record_audit(self, cmd: str, binary: str, result: SafetyCheckResult, status: str) -> None:
        self._audit_log.append(AuditEntry(
            id=f'audit_{uuid.uuid4().hex}',
            cmd=cmd,
            binary=binary,
            safe=result.safe,
            reason=result.reason,
            status=status,
        ))

    def get_audit_log(self) -> List[AuditEntry]:
        return list(self._audit_log)

    def clear_audit_log(self) -> None:
        self._audit_log = []


def create_exec_safety(safe_bins: Optional[List[str]] = None) -> ExecSafety:
    return ExecSafety(safe_bins)
