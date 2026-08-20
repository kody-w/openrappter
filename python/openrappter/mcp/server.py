"""
McpServer - Minimal MCP server exposing agents as tools via JSON-RPC 2.0.

Supports initialize, tools/list, tools/call, and ping over a dict-based
request/response interface (stdio transport is handled externally).

Mirrors TypeScript mcp/server.ts
"""

import json

from openrappter import __version__
from openrappter.result_status import agent_result_is_error

PROTOCOL_VERSION = '2024-11-05'


class McpServer:
    """Minimal MCP server exposing agents as tools via JSON-RPC 2.0."""

    def __init__(self, options=None):
        options = options or {}
        self._server_info = {
            'name': options.get('name', 'openrappter'),
            'version': options.get('version', __version__),
        }
        self._agents = {}  # name -> agent

    def register_agent(self, agent):
        """Register a single agent as an MCP tool."""
        self._agents[agent.name] = agent

    def has_tool(self, name):
        """Check whether a tool with the given name is registered."""
        return name in self._agents

    @property
    def tool_count(self):
        """Number of registered tools."""
        return len(self._agents)

    def handle_request(self, request):
        """Handle a JSON-RPC 2.0 request dict.

        Returns a JSON-RPC 2.0 response dict.
        """
        method = request.get('method', '')
        request_id = request.get('id')
        params = request.get('params', {})

        if method == 'initialize':
            return self._json_rpc_result(request_id, {
                'protocolVersion': PROTOCOL_VERSION,
                'capabilities': {'tools': {}},
                'serverInfo': self._server_info,
            })

        if method == 'tools/list':
            tools = [
                self._agent_to_tool(name, agent)
                for name, agent in self._agents.items()
            ]
            return self._json_rpc_result(request_id, {'tools': tools})

        if method == 'tools/call':
            tool_name = params.get('name', '')
            tool_args = params.get('arguments', {})
            agent = self._agents.get(tool_name)
            if not agent:
                return self._json_rpc_error(
                    request_id, -32602, f'Unknown tool: {tool_name}'
                )

            try:
                result_str = agent.execute(**tool_args)
                # An agent that *resolves* with {"status": "error"} has still
                # failed. Every composition layer routes through the shared
                # classifier so the two runtimes cannot drift apart.
                contract_error = agent_result_is_error(result_str)
                result = {
                    'content': [
                        {'type': 'text', 'text': self._render(result_str)}
                    ],
                }
                if contract_error:
                    result['isError'] = True
                return self._json_rpc_result(request_id, result)
            except Exception as e:
                return self._json_rpc_result(request_id, {
                    'isError': True,
                    'content': [{'type': 'text', 'text': f'Error: {str(e)}'}],
                })

        if method == 'ping':
            return self._json_rpc_result(request_id, {})

        return self._json_rpc_error(
            request_id, -32601, f'Method not found: {method}'
        )

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _agent_to_tool(self, name, agent):
        """Convert agent metadata to an MCP tool definition."""
        meta = getattr(agent, 'metadata', None) or {}
        parameters = meta.get('parameters') or {}
        schema = {
            'type': 'object',
            'properties': parameters.get('properties', {}),
        }
        # Emit `required` only when non-empty: an empty list is not equivalent
        # to omission for strict schema validators.
        required = parameters.get('required') or []
        if required:
            schema['required'] = required
        return {
            'name': meta.get('name', name),
            'description': meta.get('description', ''),
            'inputSchema': schema,
        }

    def _render(self, result):
        """Render an agent result as MCP text content.

        JSON results are re-serialised with a stable indent so identical agent
        output produces identical text in both runtimes; anything that is not
        JSON passes through untouched.
        """
        content = result
        if isinstance(result, str):
            try:
                content = json.loads(result)
            except ValueError:
                return result
        if isinstance(content, str):
            return content
        return json.dumps(content, indent=2)

    def _json_rpc_result(self, request_id, result):
        return {'jsonrpc': '2.0', 'id': request_id, 'result': result}

    def _json_rpc_error(self, request_id, code, message):
        return {
            'jsonrpc': '2.0',
            'id': request_id,
            'error': {'code': code, 'message': message},
        }
