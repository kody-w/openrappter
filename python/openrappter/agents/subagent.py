"""
SubAgentManager - Allows agents to invoke other agents as tools.

Features:
  - Depth limiting (default max_depth=5)
  - Loop detection (same agent called >=3 times in last 10 calls)
  - Auto-slush threading (data_slush forwarded as upstream_slush)
  - Timeout support
  - Tool spec generation for OpenAI function-calling format

Mirrors TypeScript agents/subagent.ts
"""

import asyncio
import re
import time
import random
from datetime import datetime


class SubAgentManager:
    """Manages sub-agent invocations with depth/loop guards."""

    def __init__(self, config=None):
        config = config or {}
        self._config = {
            'id': config.get('id', 'subagent-manager'),
            'name': config.get('name', 'Sub-agent Manager'),
            'description': config.get('description', 'Manages sub-agent invocations'),
            'maxDepth': config.get('maxDepth', 5),
            'timeout': config.get('timeout', 30000),
            'allowedAgents': config.get('allowedAgents'),
            'blockedAgents': config.get('blockedAgents', []),
        }
        self._active_calls = {}
        self._call_history = []
        self._executor = None

    def set_executor(self, executor):
        """Set the agent executor.

        Args:
            executor: async callable(agent_id, message, context, upstream_slush=None) -> AgentResult
        """
        self._executor = executor

    def can_invoke(self, agent_id, depth):
        """Check if an agent can be invoked at the given depth."""
        max_depth = self._config.get('maxDepth', 5)

        # Check depth limit
        if depth >= max_depth:
            return False

        # Check blocked list
        if agent_id in (self._config.get('blockedAgents') or []):
            return False

        # Check allowed list (if specified)
        allowed = self._config.get('allowedAgents')
        if allowed is not None and agent_id not in allowed:
            return False

        return True

    async def invoke(self, target_agent_id, message, context):
        """Invoke a sub-agent.

        Args:
            target_agent_id: ID of the agent to invoke
            message: Message to send
            context: SubAgentContext dict with keys: callId, parentAgentId, depth, history, lastSlush

        Returns:
            AgentResult dict
        """
        if not self._executor:
            raise RuntimeError('No agent executor configured')

        # Check if invocation is allowed
        if not self.can_invoke(target_agent_id, context.get('depth', 0)):
            raise RuntimeError(
                f"Cannot invoke agent {target_agent_id}: "
                f"depth={context.get('depth', 0)}, maxDepth={self._config.get('maxDepth', 5)}"
            )

        # Prevent recursive loops
        recent_calls = context.get('history', [])[-10:]
        call_count = sum(1 for c in recent_calls if c.get('targetAgentId') == target_agent_id)
        if call_count >= 3:
            raise RuntimeError(f"Recursive loop detected: agent {target_agent_id} called too many times")

        # Create call record
        call_id = f"call_{int(time.time())}_{random.randint(0, 999999)}"
        call = {
            'id': call_id,
            'parentAgentId': context.get('parentAgentId', ''),
            'targetAgentId': target_agent_id,
            'message': message,
            'depth': context.get('depth', 0),
            'startedAt': datetime.now().isoformat(),
            'status': 'running',
        }

        self._active_calls[call_id] = call

        # Create child context
        child_context = {
            'callId': call_id,
            'parentAgentId': target_agent_id,
            'depth': context.get('depth', 0) + 1,
            'history': context.get('history', []) + [call],
        }

        try:
            # Execute with timeout, passing upstream slush for chaining
            timeout_ms = self._config.get('timeout')
            upstream_slush = context.get('lastSlush')

            coro = self._executor(target_agent_id, message, child_context, upstream_slush)
            if timeout_ms:
                result = await asyncio.wait_for(coro, timeout=timeout_ms / 1000)
            else:
                result = await coro

            # Update call record
            call['status'] = 'success'
            call['completedAt'] = datetime.now().isoformat()
            call['result'] = result

            # Extract data_slush from result for downstream chaining
            if isinstance(result, dict) and 'data_slush' in result:
                context['lastSlush'] = result['data_slush']

            del self._active_calls[call_id]
            self._call_history.append(call)

            return result

        except Exception as e:
            # Update call record
            call['status'] = 'error'
            call['completedAt'] = datetime.now().isoformat()
            call['error'] = str(e)

            self._active_calls.pop(call_id, None)
            self._call_history.append(call)

            raise

    def create_tool(self, agent_id, name, description):
        """Create a tool definition for sub-agent invocation (OpenAI format)."""
        return {
            'type': 'function',
            'function': {
                'name': f'invoke_{agent_id}',
                'description': f'Invoke the {name} agent: {description}',
                'parameters': {
                    'type': 'object',
                    'properties': {
                        'message': {
                            'type': 'string',
                            'description': 'The message/task to send to the agent',
                        },
                    },
                    'required': ['message'],
                },
            },
        }

    async def handle_tool_call(self, tool_name, args, context):
        """Handle a tool call for sub-agent invocation.

        Args:
            tool_name: Tool name in format 'invoke_<agentId>'
            args: dict with 'message' key
            context: SubAgentContext dict

        Returns:
            AgentResult dict
        """
        match = re.match(r'^invoke_(.+)$', tool_name)
        if not match:
            raise ValueError(f"Invalid sub-agent tool name: {tool_name}")

        agent_id = match.group(1)
        return await self.invoke(agent_id, args['message'], context)

    def get_active_calls(self):
        """Get active calls."""
        return list(self._active_calls.values())

    def get_call_history(self, limit=100):
        """Get call history."""
        return self._call_history[-limit:]

    def create_context(self, parent_agent_id):
        """Create initial context for a top-level call."""
        return {
            'callId': f'root_{int(time.time())}',
            'parentAgentId': parent_agent_id,
            'depth': 0,
            'history': [],
        }


def create_sub_agent_manager(config=None):
    """Factory function to create a SubAgentManager."""
    return SubAgentManager(config)
