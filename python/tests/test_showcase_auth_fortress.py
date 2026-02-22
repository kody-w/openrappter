"""
Auth Fortress showcase tests — ApprovalManager policies, rules, and workflows.

Mirrors typescript/src/__tests__/parity/showcase-auth-fortress.test.ts (9 tests).
"""

import pytest
import re
import uuid
import time

from openrappter.security.approvals import (
    ApprovalContext,
    ApprovalManager,
    ApprovalRule,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_manager(default_policy='deny') -> ApprovalManager:
    return ApprovalManager(default_policy=default_policy)


def ctx(tool_name='bash', tool_args=None, channel_id=None, agent_id=None) -> ApprovalContext:
    return ApprovalContext(
        tool_name=tool_name,
        tool_args=tool_args or {},
        channel_id=channel_id,
        agent_id=agent_id,
    )


# ---------------------------------------------------------------------------
# 1. Default deny policy blocks all tool calls
# ---------------------------------------------------------------------------

def test_default_deny_blocks_all():
    manager = make_manager(default_policy='deny')

    result_bash = manager.check_approval(ctx('bash'))
    result_read = manager.check_approval(ctx('read_file'))

    assert result_bash['allowed'] is False
    assert result_read['allowed'] is False
    assert 'denied' in result_bash['reason'].lower() or 'deny' in result_bash['reason'].lower()


# ---------------------------------------------------------------------------
# 2. Full policy allows all tool calls
# ---------------------------------------------------------------------------

def test_full_policy_allows_all():
    manager = make_manager(default_policy='full')

    result_bash = manager.check_approval(ctx('bash'))
    result_write = manager.check_approval(ctx('write_file'))

    assert result_bash['allowed'] is True
    assert result_write['allowed'] is True


# ---------------------------------------------------------------------------
# 3. Allowlist policy: only allowed_tools pass
# ---------------------------------------------------------------------------

def test_allowlist_policy_filters_tools():
    manager = make_manager(default_policy='deny')
    manager.add_rule(ApprovalRule(
        id='rule-allowlist',
        name='Safe tools only',
        policy='allowlist',
        allowed_tools=['read_file', 'list_dir'],
        priority=10,
    ))

    result_read = manager.check_approval(ctx('read_file'))
    result_list = manager.check_approval(ctx('list_dir'))
    result_bash = manager.check_approval(ctx('bash'))
    result_write = manager.check_approval(ctx('write_file'))

    assert result_read['allowed'] is True
    assert result_list['allowed'] is True
    assert result_bash['allowed'] is False
    assert result_write['allowed'] is False


# ---------------------------------------------------------------------------
# 4. Priority ordering: higher priority rule wins
# ---------------------------------------------------------------------------

def test_priority_ordering_higher_wins():
    manager = make_manager(default_policy='deny')

    # Lower priority: deny everything
    manager.add_rule(ApprovalRule(
        id='rule-deny-all',
        name='Deny all',
        policy='deny',
        priority=1,
    ))

    # Higher priority: allow everything
    manager.add_rule(ApprovalRule(
        id='rule-allow-all',
        name='Allow all',
        policy='full',
        priority=100,
    ))

    result = manager.check_approval(ctx('bash'))
    assert result['allowed'] is True, (
        "Higher priority 'full' rule should win over lower priority 'deny' rule"
    )

    # Now reverse: higher priority deny beats lower priority full
    manager2 = make_manager(default_policy='deny')
    manager2.add_rule(ApprovalRule(
        id='rule-full-low',
        name='Full low priority',
        policy='full',
        priority=1,
    ))
    manager2.add_rule(ApprovalRule(
        id='rule-deny-high',
        name='Deny high priority',
        policy='deny',
        priority=100,
    ))

    result2 = manager2.check_approval(ctx('bash'))
    assert result2['allowed'] is False, (
        "Higher priority 'deny' rule should win over lower priority 'full' rule"
    )


# ---------------------------------------------------------------------------
# 5. Scoped rules by channel
# ---------------------------------------------------------------------------

def test_scoped_rules_by_channel():
    manager = make_manager(default_policy='deny')

    # Rule applies only to the 'admin' channel
    manager.add_rule(ApprovalRule(
        id='rule-admin-channel',
        name='Admin channel full access',
        policy='full',
        channels=['admin-channel'],
        priority=10,
    ))

    # Admin channel gets access
    result_admin = manager.check_approval(ctx('bash', channel_id='admin-channel'))
    assert result_admin['allowed'] is True

    # Other channels fall through to default deny
    result_other = manager.check_approval(ctx('bash', channel_id='public-channel'))
    assert result_other['allowed'] is False

    result_no_channel = manager.check_approval(ctx('bash'))
    assert result_no_channel['allowed'] is False


# ---------------------------------------------------------------------------
# 6. Scoped rules by agent
# ---------------------------------------------------------------------------

def test_scoped_rules_by_agent():
    manager = make_manager(default_policy='deny')

    manager.add_rule(ApprovalRule(
        id='rule-trusted-agent',
        name='Trusted agent access',
        policy='full',
        agents=['trusted-agent'],
        priority=10,
    ))

    result_trusted = manager.check_approval(ctx('bash', agent_id='trusted-agent'))
    assert result_trusted['allowed'] is True

    result_untrusted = manager.check_approval(ctx('bash', agent_id='unknown-agent'))
    assert result_untrusted['allowed'] is False

    result_no_agent = manager.check_approval(ctx('bash'))
    assert result_no_agent['allowed'] is False


# ---------------------------------------------------------------------------
# 7. Blocked patterns via regex matching
# ---------------------------------------------------------------------------

def test_blocked_patterns_via_regex():
    manager = make_manager(default_policy='full')  # default allows, but pattern should block

    manager.add_rule(ApprovalRule(
        id='rule-block-rm',
        name='Block dangerous commands',
        policy='full',
        blocked_patterns=[r'rm\s+-rf', r'DROP\s+TABLE'],
        priority=10,
    ))

    # Dangerous args should be blocked
    result_rm = manager.check_approval(ctx('bash', tool_args={'command': 'rm -rf /'}))
    assert result_rm['allowed'] is False
    assert 'pattern' in result_rm['reason'].lower() or 'blocked' in result_rm['reason'].lower()

    result_sql = manager.check_approval(ctx('execute_sql', tool_args={'query': 'DROP TABLE users'}))
    assert result_sql['allowed'] is False

    # Safe args should pass
    result_safe = manager.check_approval(ctx('bash', tool_args={'command': 'ls -la'}))
    assert result_safe['allowed'] is True


# ---------------------------------------------------------------------------
# 8. Request/approve flow
# ---------------------------------------------------------------------------

def test_request_approve_flow():
    manager = make_manager()

    approval_ctx = ApprovalContext(
        tool_name='deploy',
        tool_args={'environment': 'production'},
        channel_id='ops-channel',
        agent_id='deploy-agent',
    )

    # Create a pending request
    request = manager.request_approval(approval_ctx)

    assert request.id is not None
    assert request.tool_name == 'deploy'
    assert request.tool_args == {'environment': 'production'}
    assert request.channel_id == 'ops-channel'
    assert request.agent_id == 'deploy-agent'
    assert request.status == 'pending'
    assert request.created_at > 0

    # Verify it shows up in pending list
    pending = manager.get_pending_requests()
    assert any(r.id == request.id for r in pending)

    # Approve it
    manager.approve_request(request.id)

    # Status should now be approved
    updated = manager.get_request(request.id)
    assert updated is not None
    assert updated.status == 'approved'

    # No longer in pending list
    pending_after = manager.get_pending_requests()
    assert all(r.id != request.id for r in pending_after)


# ---------------------------------------------------------------------------
# 9. Request/reject flow
# ---------------------------------------------------------------------------

def test_request_reject_flow():
    manager = make_manager()

    approval_ctx = ApprovalContext(
        tool_name='delete_database',
        tool_args={'db': 'prod_db'},
    )

    request = manager.request_approval(approval_ctx)
    assert request.status == 'pending'

    # Reject with a reason
    rejection_reason = 'Insufficient privileges for production database deletion'
    manager.reject_request(request.id, reason=rejection_reason)

    updated = manager.get_request(request.id)
    assert updated is not None
    assert updated.status == 'rejected'
    assert updated.reason == rejection_reason

    # Not in pending list
    pending = manager.get_pending_requests()
    assert all(r.id != request.id for r in pending)
