"""
McpServer - Minimal MCP server exposing agents as tools via JSON-RPC 2.0.

Supports initialize, tools/list, tools/call, and ping over a dict-based
request/response interface (stdio transport is handled externally).

Mirrors TypeScript mcp/server.ts
"""

import json


class McpServer:
    """Minimal MCP server exposing agents as tools via JSON-RPC 2.0."""

    def __init__(self, options=None):
        options = options or {}
        self._server_info = {
            'name': options.get('name', 'openrappter'),
            'version': options.get('version', '1.9.1'),
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
                'serverInfo': self._server_info,
                'capabilities': {'tools': {}},
            })

        if method == 'tools/list':
            tools = []
            for name, agent in self._agents.items():
                meta = agent.metadata if hasattr(agent, 'metadata') else {}
                tools.append({
                    'name': name,
                    'description': meta.get('description', ''),
                    'inputSchema': meta.get(
                        'parameters',
                        {'type': 'object', 'properties': {}},
                    ),
                })
            return self._json_rpc_result(request_id, {'tools': tools})

        if method == 'tools/call':
            tool_name = params.get('name', '')
            tool_args = params.get('arguments', {})
            agent = self._agents.get(tool_name)
            if not agent:
                return self._json_rpc_error(
                    request_id, -32602, f'Tool not found: {tool_name}'
                )

            try:
                result_str = agent.execute(**tool_args)
                text = (
                    result_str
                    if isinstance(result_str, str)
                    else json.dumps(result_str)
                )
                return self._json_rpc_result(request_id, {
                    'content': [{'type': 'text', 'text': text}],
                })
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

    def _json_rpc_result(self, request_id, result):
        return {'jsonrpc': '2.0', 'id': request_id, 'result': result}

    def _json_rpc_error(self, request_id, code, message):
        return {
            'jsonrpc': '2.0',
            'id': request_id,
            'error': {'code': code, 'message': message},
        }
