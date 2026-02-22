"""
ApprovalManager — execution policy and approval request management.

Policies are evaluated in priority order (highest first). The first matching
enabled rule governs the outcome. If no rule matches, the default_policy applies.
"""

import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Literal, Optional

ApprovalPolicy = Literal['deny', 'allowlist', 'full']


@dataclass
class ApprovalRule:
    """A named policy rule with optional scope constraints."""
    id: str
    name: str
    policy: ApprovalPolicy
    allowed_tools: Optional[List[str]] = None
    tools: Optional[List[str]] = None          # scope: tool_name must be in this list
    channels: Optional[List[str]] = None       # scope: channel_id must be in this list
    agents: Optional[List[str]] = None         # scope: agent_id must be in this list
    blocked_patterns: Optional[List[str]] = None  # regex strings tested against str(tool_args)
    priority: int = 0
    enabled: bool = True


@dataclass
class ApprovalRequest:
    """A pending (or resolved) approval request for a tool invocation."""
    id: str
    tool_name: str
    tool_args: Dict
    channel_id: Optional[str]
    agent_id: Optional[str]
    status: Literal['pending', 'approved', 'rejected']
    reason: Optional[str]
    created_at: float


@dataclass
class ApprovalContext:
    """Contextual information about a tool call being evaluated."""
    tool_name: str
    tool_args: Dict = field(default_factory=dict)
    channel_id: Optional[str] = None
    agent_id: Optional[str] = None


class ApprovalManager:
    """
    Manages execution policies and approval workflows.

    Rules are matched in descending priority order. The first enabled rule
    whose scope conditions all match is applied. Scope conditions:
      - tools:    if present, tool_name must be in the list
      - channels: if present, channel_id must be in the list
      - agents:   if present, agent_id must be in the list

    Within a matching rule:
      - 'deny'      → always blocked
      - 'full'      → always allowed (unless a blocked_pattern fires)
      - 'allowlist' → allowed only if tool_name is in allowed_tools

    blocked_patterns are regex strings tested against str(tool_args). A match
    blocks the request regardless of policy.
    """

    def __init__(self, default_policy: ApprovalPolicy = 'deny') -> None:
        self._default_policy: ApprovalPolicy = default_policy
        self._rules: List[ApprovalRule] = []
        self._requests: Dict[str, ApprovalRequest] = {}

    # ------------------------------------------------------------------
    # Rule management
    # ------------------------------------------------------------------

    def add_rule(self, rule: ApprovalRule) -> None:
        """Append a rule to the manager."""
        self._rules.append(rule)

    def remove_rule(self, rule_id: str) -> None:
        """Remove the rule with the given id (no-op if not found)."""
        self._rules = [r for r in self._rules if r.id != rule_id]

    def get_rules(self) -> List[ApprovalRule]:
        """Return all registered rules."""
        return list(self._rules)

    # ------------------------------------------------------------------
    # Policy evaluation
    # ------------------------------------------------------------------

    def _rule_matches_scope(self, rule: ApprovalRule, ctx: ApprovalContext) -> bool:
        """Return True if all scope conditions on the rule are satisfied."""
        if rule.tools is not None and ctx.tool_name not in rule.tools:
            return False
        if rule.channels is not None and ctx.channel_id not in rule.channels:
            return False
        if rule.agents is not None and ctx.agent_id not in rule.agents:
            return False
        return True

    def _check_blocked_patterns(self, rule: ApprovalRule, ctx: ApprovalContext) -> Optional[str]:
        """
        Return a reason string if any blocked_pattern matches str(tool_args),
        otherwise None.
        """
        if not rule.blocked_patterns:
            return None
        args_str = str(ctx.tool_args)
        for pattern in rule.blocked_patterns:
            if re.search(pattern, args_str):
                return f"Blocked by pattern: {pattern}"
        return None

    def check_approval(self, context: ApprovalContext) -> Dict:
        """
        Evaluate policies against the given context.

        Returns a dict: { 'allowed': bool, 'reason': str }
        """
        # Sort by priority descending; stable sort preserves insertion order for ties
        sorted_rules = sorted(
            [r for r in self._rules if r.enabled],
            key=lambda r: r.priority,
            reverse=True,
        )

        for rule in sorted_rules:
            if not self._rule_matches_scope(rule, context):
                continue

            # Check blocked_patterns first — they override the policy
            blocked_reason = self._check_blocked_patterns(rule, context)
            if blocked_reason:
                return {'allowed': False, 'reason': blocked_reason}

            if rule.policy == 'deny':
                return {'allowed': False, 'reason': f"Denied by rule '{rule.name}'"}

            if rule.policy == 'full':
                return {'allowed': True, 'reason': f"Allowed by rule '{rule.name}'"}

            if rule.policy == 'allowlist':
                allowed_tools = rule.allowed_tools or []
                if context.tool_name in allowed_tools:
                    return {'allowed': True, 'reason': f"Allowed by rule '{rule.name}'"}
                return {
                    'allowed': False,
                    'reason': f"Tool '{context.tool_name}' not in allowlist for rule '{rule.name}'",
                }

        # No rule matched — apply default policy
        if self._default_policy == 'full':
            return {'allowed': True, 'reason': 'Allowed by default policy'}
        if self._default_policy == 'allowlist':
            return {'allowed': False, 'reason': 'Tool not in default allowlist'}
        return {'allowed': False, 'reason': 'Denied by default policy'}

    # ------------------------------------------------------------------
    # Approval request workflow
    # ------------------------------------------------------------------

    def request_approval(self, context: ApprovalContext) -> ApprovalRequest:
        """Create and store a new pending approval request."""
        request = ApprovalRequest(
            id=str(uuid.uuid4()),
            tool_name=context.tool_name,
            tool_args=context.tool_args,
            channel_id=context.channel_id,
            agent_id=context.agent_id,
            status='pending',
            reason=None,
            created_at=time.time(),
        )
        self._requests[request.id] = request
        return request

    def approve_request(self, request_id: str) -> None:
        """Mark the given request as approved."""
        request = self._requests.get(request_id)
        if request is not None:
            request.status = 'approved'

    def reject_request(self, request_id: str, reason: Optional[str] = None) -> None:
        """Mark the given request as rejected with an optional reason."""
        request = self._requests.get(request_id)
        if request is not None:
            request.status = 'rejected'
            request.reason = reason

    def get_pending_requests(self) -> List[ApprovalRequest]:
        """Return all requests with status='pending'."""
        return [r for r in self._requests.values() if r.status == 'pending']

    def get_request(self, request_id: str) -> Optional[ApprovalRequest]:
        """Return the request with the given id, or None."""
        return self._requests.get(request_id)
