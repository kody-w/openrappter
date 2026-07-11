"""Tests for ExecSafety — injection detection, safe binaries, and single-use
approval tokens — and its wiring into ShellAgent's real bash execution path."""

import json

import pytest

from openrappter.security.exec_safety import ExecSafety, create_exec_safety
from openrappter.agents.shell_agent import ShellAgent


@pytest.fixture
def safety():
    return create_exec_safety()


# --- Safe command checks ---

class TestSafeCommandChecks:
    def test_safe_binary_allowed(self, safety):
        result = safety.check_command('ls -la')
        assert result.safe is True
        assert result.binary == 'ls'

    def test_unknown_binary_blocked(self, safety):
        result = safety.check_command('rm -rf /')
        assert result.safe is False
        assert "not in the safe list" in result.reason

    def test_path_prefixed_binary_resolves_basename(self, safety):
        result = safety.check_command('/usr/bin/ls -la')
        assert result.binary == 'ls'
        assert result.safe is True

    def test_custom_safe_bins(self):
        custom = create_exec_safety(['myapp'])
        assert custom.check_command('myapp --start').safe is True
        assert custom.check_command('ls').safe is False

    @pytest.mark.parametrize("cmd", [
        'find /tmp -name x -exec cat /etc/passwd {} +',
        'awk \'BEGIN{system("id")}\'',
        'tar xf archive.tar --to-command=id',
        'sed \'1e id\' file',
        'npx arbitrary-package',
        'python -c \'import os; os.system("id")\'',
    ])
    def test_default_allowlist_excludes_shell_escape_tools(self, safety, cmd):
        result = safety.check_command(cmd)
        if result.injection_type:
            assert result.safe is False
        else:
            assert result.safe is True
            assert result.dual_use is True
            assert result.requires_approval is True


# --- Injection / chaining / substitution detection ---

class TestInjectionDetection:
    @pytest.mark.parametrize("cmd", [
        'ls | grep foo',
        'ls; rm -rf /',
        'echo $(whoami)',
        'echo `whoami`',
        'ls && cat /etc/passwd',
        'ls || rm -rf /',
        'cat file > /etc/passwd',
        'echo pwned > ~/.ssh/authorized_keys',
        'echo pwned >> ~/.bashrc',
        'cat /etc/passwd > stolen.txt',
        'cat /etc/passwd >> ../outside/leak.txt',
        'ls\nrm -rf /',
        'echo ${HOME}',
        'ls -la && ls -la',  # chaining even with two safe binaries
    ])
    def test_blocks_chaining_and_substitution(self, safety, cmd):
        result = safety.check_command(cmd)
        assert result.safe is False
        assert result.reason is not None


# --- Single-use approval tokens ---

class TestApprovalTokens:
    def test_issue_and_consume_after_approval(self, safety):
        token = safety.issue_approval_token('rm -rf /tmp/scratch')
        assert token.status == 'pending'

        assert safety.resolve_approval_token(token.id, True) is True

        result = safety.consume_approval_token(token.id, 'rm -rf /tmp/scratch')
        assert result.ok is True

    def test_consume_without_resolution_fails(self, safety):
        token = safety.issue_approval_token('rm -rf /tmp/scratch')
        result = safety.consume_approval_token(token.id, 'rm -rf /tmp/scratch')
        assert result.ok is False
        assert 'not been approved' in result.reason

    def test_consume_after_rejection_fails(self, safety):
        token = safety.issue_approval_token('rm -rf /tmp/scratch')
        safety.resolve_approval_token(token.id, False)
        result = safety.consume_approval_token(token.id, 'rm -rf /tmp/scratch')
        assert result.ok is False
        assert 'rejected' in result.reason

    def test_mismatched_command_rejected(self, safety):
        token = safety.issue_approval_token('rm -rf /tmp/scratch')
        safety.resolve_approval_token(token.id, True)

        result = safety.consume_approval_token(token.id, 'rm -rf /etc')
        assert result.ok is False
        assert 'does not match' in result.reason

    def test_replay_after_use_rejected(self, safety):
        token = safety.issue_approval_token('rm -rf /tmp/scratch')
        safety.resolve_approval_token(token.id, True)

        first = safety.consume_approval_token(token.id, 'rm -rf /tmp/scratch')
        assert first.ok is True

        replay = safety.consume_approval_token(token.id, 'rm -rf /tmp/scratch')
        assert replay.ok is False
        assert 'already used' in replay.reason

    def test_unknown_token_rejected(self, safety):
        result = safety.consume_approval_token('nonexistent', 'echo hi')
        assert result.ok is False

    def test_pending_tokens_listed(self, safety):
        token = safety.issue_approval_token('rm -rf /tmp/scratch')
        pending = safety.get_pending_approval_tokens()
        assert any(t.id == token.id for t in pending)

        safety.resolve_approval_token(token.id, True)
        pending_after = safety.get_pending_approval_tokens()
        assert not any(t.id == token.id for t in pending_after)


# --- Real ShellAgent.perform() path ---

class TestShellAgentSafetyWiring:
    def test_safe_command_executes_normally(self):
        agent = ShellAgent()
        result = json.loads(agent.perform(action='bash', command='echo hello'))
        assert result['status'] == 'success'
        assert 'hello' in result['output']

    def test_dangerous_command_blocked_without_approval(self):
        agent = ShellAgent()
        result = json.loads(agent.perform(action='bash', command='rm -rf /'))
        assert result['status'] == 'error'
        assert result.get('blocked') is True
        assert result.get('approval_required') is True
        assert 'approval_id' in result

    def test_dual_use_binary_requires_approval(self):
        agent = ShellAgent()
        cmd = 'python3 --version'

        blocked = json.loads(agent.perform(action='bash', command=cmd))
        assert blocked['status'] == 'error'
        assert blocked['approval_required'] is True

        approval_id = blocked['approval_id']
        assert agent.get_exec_safety().resolve_approval_token(approval_id, True) is True
        allowed = json.loads(agent.perform(
            action='bash', command=cmd, approval_id=approval_id
        ))
        assert allowed['status'] == 'success'

    def test_chained_command_blocked_even_with_safe_binaries(self):
        agent = ShellAgent()
        result = json.loads(agent.perform(action='bash', command='echo hi && rm -rf /'))
        assert result['status'] == 'error'
        assert result.get('blocked') is True

    def test_substitution_bypass_blocked(self):
        agent = ShellAgent()
        result = json.loads(agent.perform(action='bash', command='echo $(rm -rf /)'))
        assert result['status'] == 'error'
        assert result.get('blocked') is True

    def test_approval_issuance_resolution_and_use(self):
        agent = ShellAgent()
        cmd = 'rm -rf /tmp/exec-safety-test-dir'

        blocked = json.loads(agent.perform(action='bash', command=cmd))
        assert blocked['status'] == 'error'
        approval_id = blocked['approval_id']

        # Not yet approved — using it should still fail closed.
        still_blocked = json.loads(agent.perform(action='bash', command=cmd, approval_id=approval_id))
        assert still_blocked['status'] == 'error'

        # Resolve out-of-band, then retry with the exact same command.
        assert agent.get_exec_safety().resolve_approval_token(approval_id, True) is True
        allowed = json.loads(agent.perform(action='bash', command=cmd, approval_id=approval_id))
        assert allowed['status'] == 'success'

    def test_mismatched_command_with_approval_id_fails(self):
        agent = ShellAgent()
        cmd = 'rm -rf /tmp/exec-safety-test-dir-2'
        blocked = json.loads(agent.perform(action='bash', command=cmd))
        approval_id = blocked['approval_id']
        agent.get_exec_safety().resolve_approval_token(approval_id, True)

        mismatched = json.loads(agent.perform(
            action='bash', command='rm -rf /tmp/other-dir', approval_id=approval_id
        ))
        assert mismatched['status'] == 'error'
        assert mismatched.get('blocked') is True

    def test_approval_token_is_single_use(self):
        agent = ShellAgent()
        cmd = 'rm -rf /tmp/exec-safety-test-dir-3'
        blocked = json.loads(agent.perform(action='bash', command=cmd))
        approval_id = blocked['approval_id']
        agent.get_exec_safety().resolve_approval_token(approval_id, True)

        first = json.loads(agent.perform(action='bash', command=cmd, approval_id=approval_id))
        assert first['status'] == 'success'

        replay = json.loads(agent.perform(action='bash', command=cmd, approval_id=approval_id))
        assert replay['status'] == 'error'
        assert replay.get('blocked') is True

    def test_bare_boolean_approval_is_not_accepted(self):
        """Passing approved=True (no real token) must not bypass safety."""
        agent = ShellAgent()
        result = json.loads(agent.perform(action='bash', command='rm -rf /', approved=True))
        assert result['status'] == 'error'
        assert result.get('blocked') is True

    def test_safety_enforced_via_query_inference_path(self):
        """Natural-language query inference must also funnel through safety checks."""
        agent = ShellAgent()
        result = json.loads(agent.perform(query='run rm -rf /'))
        assert result['status'] == 'error'
        assert result.get('blocked') is True
