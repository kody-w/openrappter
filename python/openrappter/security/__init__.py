"""
openrappter Security Package

Approval-based authorization: policies, rules, and request/approve/reject flows.
ExecSafety adds command-string level checks: injection detection, safe-binary
allowlisting, and single-use approval tokens for real shell execution.
"""

from openrappter.security.approvals import ApprovalManager, ApprovalRule, ApprovalRequest, ApprovalContext
from openrappter.security.exec_safety import (
    ExecSafety,
    ApprovalToken,
    ApprovalConsumeResult,
    SafetyCheckResult,
    AuditEntry,
    create_exec_safety,
)

__all__ = [
    'ApprovalManager',
    'ApprovalRule',
    'ApprovalRequest',
    'ApprovalContext',
    'ExecSafety',
    'ApprovalToken',
    'ApprovalConsumeResult',
    'SafetyCheckResult',
    'AuditEntry',
    'create_exec_safety',
]
