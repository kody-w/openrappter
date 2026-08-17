"""Re-export of the shared agent-result classifier.

The implementation lives in ``openrappter.agents.result_status`` so that it sits
beside the composition layers that use it (chain, graph, broadcast, subagent,
pipeline). Those modules are dropped into a rapp brainstem *as a directory of
agent modules*, where no ``openrappter`` package exists and only co-dropped
siblings resolve — a module outside ``agents/`` is unreachable there.

This module keeps ``from openrappter.result_status import ...`` working for the
CLI, brainstem, and callers outside the agents package.

Mirrors typescript/src/agents/result-status.ts
"""

from openrappter.agents.result_status import (
    agent_result_error_message,
    agent_result_is_error,
)

__all__ = ['agent_result_is_error', 'agent_result_error_message']
