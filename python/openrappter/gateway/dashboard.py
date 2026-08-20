"""
DashboardHandler - in-memory trace store and agent executor.

Holds registered agents plus a bounded (circular) trace buffer, and executes
an agent by name while recording a trace for the call.

Partial port of TypeScript gateway/dashboard.ts. That module is an HTTP
handler -- it owns `handle(req, res)`, `sendJson()` and a `prefix` used to
route requests under `/api` -- and none of that HTTP surface is ported here.
This class is the storage and execution half only; callers wire it up to a
transport themselves. The limitation is recorded in the gateway/dashboard
note in .claude/skills/ts-python-parity-check/SKILL.md and pinned by
TestDashboardHttpSurfaceIsNotPorted in
python/tests/test_showcase_living_dashboard.py.
"""

import time
import json


class DashboardHandler:
    """Dashboard handler for agent management and trace storage."""

    def __init__(self, options=None):
        options = options or {}
        self._agents = {}  # name -> agent
        self._traces = []  # list of trace entry dicts
        self._max_traces = options.get('max_traces', 500)

    def register_agent(self, agent):
        """Register a single agent."""
        self._agents[agent.name] = agent

    def register_agents(self, agents):
        """Register a list of agents."""
        for agent in agents:
            self.register_agent(agent)

    @property
    def agent_count(self):
        """Number of registered agents."""
        return len(self._agents)

    def has_agent(self, name):
        """Check whether an agent with the given name is registered."""
        return name in self._agents

    def add_trace(self, entry):
        """Add a trace entry dict. Assigns an id if not present."""
        if 'id' not in entry:
            entry['id'] = f'trace_{int(time.time() * 1000)}'
        self._traces.append(entry)
        if len(self._traces) > self._max_traces:
            self._traces = self._traces[-self._max_traces:]

    def get_traces(self, limit=None):
        """Return stored traces, optionally limited to the most recent N."""
        if limit:
            return self._traces[-limit:]
        return list(self._traces)

    def clear_traces(self):
        """Remove all stored traces."""
        self._traces.clear()

    def get_status(self):
        """Return a status summary dict."""
        return {
            'agent_count': len(self._agents),
            'trace_count': len(self._traces),
            'agent_names': list(self._agents.keys()),
        }

    def execute_agent(self, agent_name, kwargs=None):
        """Execute a registered agent by name and record a trace.

        Returns a dict with status, result, and duration_ms.
        """
        agent = self._agents.get(agent_name)
        if not agent:
            return {'status': 'error', 'error': f'Agent not found: {agent_name}'}

        start = time.time()
        try:
            result_str = agent.execute(**(kwargs or {}))
            duration_ms = int((time.time() - start) * 1000)
            try:
                result = json.loads(result_str) if isinstance(result_str, str) else result_str
            except (json.JSONDecodeError, TypeError):
                # Mirrors dashboard.ts:398 -- a non-JSON agent result is
                # wrapped so that result['status'] is present either way.
                result = {'status': 'success', 'raw': result_str}

            self.add_trace({
                'agent_name': agent_name,
                'operation': 'execute',
                'status': 'success',
                'duration_ms': duration_ms,
                'start_time': start,
            })
            return {'status': 'success', 'result': result, 'duration_ms': duration_ms}
        except Exception as e:
            duration_ms = int((time.time() - start) * 1000)
            self.add_trace({
                'agent_name': agent_name,
                'operation': 'execute',
                'status': 'error',
                'duration_ms': duration_ms,
                'error': str(e),
            })
            return {'status': 'error', 'error': str(e), 'duration_ms': duration_ms}
