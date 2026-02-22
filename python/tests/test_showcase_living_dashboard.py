"""
Living Dashboard showcase test.

Tests the full self-monitoring loop:
    AgentChain → AgentTracer (onSpanComplete) → DashboardHandler → McpServer query

Mirrors TypeScript showcase-living-dashboard.test.ts (7 tests).
"""

import json
import pytest

from openrappter.agents.basic_agent import BasicAgent
from openrappter.agents.chain import AgentChain, ChainStep
from openrappter.agents.tracer import create_tracer
from openrappter.gateway.dashboard import DashboardHandler
from openrappter.mcp.server import McpServer


# ---------------------------------------------------------------------------
# Inline test agents
# ---------------------------------------------------------------------------

class HealthCheckAgent(BasicAgent):
    """Returns a JSON health report with data_slush."""

    def __init__(self):
        self.name = 'HealthCheck'
        self.metadata = {
            'name': self.name,
            'description': 'Checks system health and returns status.',
            'parameters': {
                'type': 'object',
                'properties': {},
                'required': [],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return json.dumps({
            'status': 'success',
            'healthy': True,
            'uptime_seconds': 42,
            'data_slush': self.slush_out(signals={'healthy': True, 'uptime': 42}),
        })


class MetricsAgent(BasicAgent):
    """Returns CPU and memory metrics with data_slush."""

    def __init__(self):
        self.name = 'Metrics'
        self.metadata = {
            'name': self.name,
            'description': 'Collects CPU and memory metrics.',
            'parameters': {
                'type': 'object',
                'properties': {},
                'required': [],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return json.dumps({
            'status': 'success',
            'cpu': 45.2,
            'memory': 62.1,
            'data_slush': self.slush_out(signals={'cpu': 45.2, 'memory': 62.1}),
        })


class ReportAgent(BasicAgent):
    """Reads upstream_slush from context and produces a summary report."""

    def __init__(self):
        self.name = 'Report'
        self.metadata = {
            'name': self.name,
            'description': 'Generates a report from upstream agent data.',
            'parameters': {
                'type': 'object',
                'properties': {},
                'required': [],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        upstream = self.context.get('upstream_slush', {})
        return json.dumps({
            'status': 'success',
            'report': 'System report generated',
            'upstream_received': upstream is not None,
            'data_slush': self.slush_out(signals={'report_generated': True}),
        })


class DashboardQueryAgent(BasicAgent):
    """Queries a DashboardHandler instance for trace summaries."""

    def __init__(self, dashboard):
        self.name = 'DashboardQuery'
        self._dashboard = dashboard
        self.metadata = {
            'name': self.name,
            'description': 'Queries the dashboard for execution traces.',
            'parameters': {
                'type': 'object',
                'properties': {},
                'required': [],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        traces = self._dashboard.get_traces()
        summaries = [
            {
                'agent_name': t.get('agent_name'),
                'status': t.get('status'),
                'operation': t.get('operation'),
            }
            for t in traces
        ]
        return json.dumps({
            'status': 'success',
            'trace_count': len(traces),
            'summaries': summaries,
        })


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _build_chain():
    """Build a three-step chain: health → metrics → report."""
    chain = AgentChain()
    chain.add_step('health', HealthCheckAgent())
    chain.add_step('metrics', MetricsAgent())
    chain.add_step('report', ReportAgent())
    return chain


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestTracerCapture:
    """Test 1 — Tracer captures spans and calls onSpanComplete."""

    def test_tracer_captures_span_via_callback(self):
        completed = []
        tracer = create_tracer({'on_span_complete': lambda span: completed.append(span)})

        span, ctx = tracer.start_span('HealthCheck', 'execute', inputs={'query': 'health?'})
        tracer.end_span(span.id, {'status': 'success', 'outputs': {'healthy': True}})

        assert len(completed) == 1
        s = completed[0]
        assert s.agent_name == 'HealthCheck'
        assert s.operation == 'execute'
        assert s.status == 'success'
        assert s.duration_ms is not None
        assert s.duration_ms >= 0


class TestChainExecution:
    """Test 2 — AgentChain produces execution results for each step."""

    def test_chain_runs_all_steps(self):
        chain = _build_chain()
        result = chain.run()

        assert result.status == 'success'
        assert len(result.steps) == 3
        step_names = [s.name for s in result.steps]
        assert step_names == ['health', 'metrics', 'report']

        for step in result.steps:
            assert step.result.get('status') == 'success'
            assert step.duration_ms >= 0


class TestDashboardTraceAccumulation:
    """Test 3 — Dashboard accumulates traces from tracer onSpanComplete callback."""

    def test_dashboard_receives_traces_from_tracer(self):
        dashboard = DashboardHandler()

        def on_span_complete(span):
            dashboard.add_trace({
                'agent_name': span.agent_name,
                'operation': span.operation,
                'status': span.status,
                'duration_ms': span.duration_ms,
            })

        tracer = create_tracer({'on_span_complete': on_span_complete})

        for agent_name in ('HealthCheck', 'Metrics', 'Report'):
            span, _ = tracer.start_span(agent_name, 'execute')
            tracer.end_span(span.id, {'status': 'success'})

        traces = dashboard.get_traces()
        assert len(traces) == 3
        agent_names = [t['agent_name'] for t in traces]
        assert 'HealthCheck' in agent_names
        assert 'Metrics' in agent_names
        assert 'Report' in agent_names


class TestMcpToolRegistration:
    """Test 4 — MCP server tool registration."""

    def test_register_agent_and_query_tools(self):
        mcp = McpServer({'name': 'living-dashboard', 'version': '1.8.0'})
        agent = DashboardQueryAgent(DashboardHandler())

        assert mcp.tool_count == 0
        mcp.register_agent(agent)

        assert mcp.tool_count == 1
        assert mcp.has_tool('DashboardQuery')


class TestMcpToolsList:
    """Test 5 — MCP tools/list returns tool definitions."""

    def test_tools_list_includes_registered_agent(self):
        mcp = McpServer()
        agent = DashboardQueryAgent(DashboardHandler())
        mcp.register_agent(agent)

        response = mcp.handle_request({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list', 'params': {}})

        assert response['id'] == 1
        tools = response['result']['tools']
        assert len(tools) == 1
        tool = tools[0]
        assert tool['name'] == 'DashboardQuery'
        assert 'description' in tool
        assert 'inputSchema' in tool


class TestMcpToolsCall:
    """Test 6 — MCP tools/call executes agent and returns content."""

    def test_tools_call_returns_text_content(self):
        dashboard = DashboardHandler()
        # Pre-populate a trace so the query agent has something to report
        dashboard.add_trace({'agent_name': 'HealthCheck', 'operation': 'execute', 'status': 'success', 'duration_ms': 5})

        mcp = McpServer()
        query_agent = DashboardQueryAgent(dashboard)
        mcp.register_agent(query_agent)

        response = mcp.handle_request({
            'jsonrpc': '2.0',
            'id': 2,
            'method': 'tools/call',
            'params': {'name': 'DashboardQuery', 'arguments': {}},
        })

        assert response['id'] == 2
        result = response['result']
        assert 'content' in result
        assert len(result['content']) >= 1
        content_text = result['content'][0]['text']
        parsed = json.loads(content_text)
        assert parsed['trace_count'] == 1
        assert parsed['status'] == 'success'


class TestFullSelfMonitoringLoop:
    """Test 7 — Full self-monitoring loop: chain → tracer → dashboard → MCP query."""

    def test_end_to_end_loop(self):
        # 1. Set up dashboard
        dashboard = DashboardHandler()

        # 2. Set up tracer that feeds completed spans into dashboard
        def on_span_complete(span):
            dashboard.add_trace({
                'agent_name': span.agent_name,
                'operation': span.operation,
                'status': span.status,
                'duration_ms': span.duration_ms,
            })

        tracer = create_tracer({'on_span_complete': on_span_complete, 'record_io': True})

        # 3. Run each chain step and instrument with tracer spans
        chain = _build_chain()
        chain_result = chain.run()
        assert chain_result.status == 'success'

        # Simulate tracer recording a span for each completed chain step
        for step in chain_result.steps:
            span, _ = tracer.start_span(step.agent_name, 'execute')
            tracer.end_span(span.id, {
                'status': step.result.get('status', 'success'),
                'outputs': step.result,
            })

        # 4. Register a DashboardQueryAgent on the MCP server
        mcp = McpServer({'name': 'self-monitor', 'version': '1.8.0'})
        query_agent = DashboardQueryAgent(dashboard)
        mcp.register_agent(query_agent)

        # 5. Query via MCP tools/call — the system queries itself
        response = mcp.handle_request({
            'jsonrpc': '2.0',
            'id': 99,
            'method': 'tools/call',
            'params': {'name': 'DashboardQuery', 'arguments': {}},
        })

        assert response['id'] == 99
        content_text = response['result']['content'][0]['text']
        result = json.loads(content_text)

        # Dashboard should have one trace per chain step
        assert result['trace_count'] == 3
        assert result['status'] == 'success'

        # Status summary from dashboard (traces only — no agents registered on dashboard itself)
        status = dashboard.get_status()
        assert status['trace_count'] == 3

        # The MCP server holds the DashboardQuery tool registration
        assert mcp.tool_count == 1
        assert mcp.has_tool('DashboardQuery')
