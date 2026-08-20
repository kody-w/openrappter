"""Parity tests for the Python MCP server.

Mirrors `typescript/src/__tests__/parity/mcp-server.test.ts`. Until this file
existed, `python/openrappter/mcp/server.py` had no behavioral test at all --
`test_module_exports.py` only asserted that the module imports. The parity map
compounded that by listing `mcp` as having no Python counterpart, so audits
skipped it entirely and five wire-visible divergences accumulated unnoticed.

MCP is a wire protocol: its consumers are external clients, not this codebase.
Nothing here constructs `McpServer`, so an internal-callers search finds no
users and proves nothing about reachability. These tests assert the bytes an
external client actually receives.

Deliberately NOT checked:
  * The stdio transport. TypeScript ships `serve()`/`stdio.ts`; the Python
    module docstring says transport is handled externally. That is a
    documented scope boundary, not a defect, so it is not asserted here.
  * `recordInvocation` journalling. TypeScript-only observability with no
    Python counterpart; a feature gap rather than a protocol divergence.
"""

import json

import pytest

from openrappter.agents.basic_agent import BasicAgent
from openrappter.mcp import McpServer
from openrappter.result_status import agent_result_is_error

PROTOCOL_VERSION = '2024-11-05'


def _meta(name, required=None, properties=None):
    return {
        'name': name,
        'description': f'{name} description',
        'parameters': {
            'type': 'object',
            'properties': properties if properties is not None else {},
            'required': required if required is not None else [],
        },
    }


class EchoAgent(BasicAgent):
    def __init__(self):
        super().__init__(
            name='Echo',
            metadata=_meta('Echo', properties={'text': {'type': 'string'}}),
        )

    def perform(self, **kwargs):
        return json.dumps({'status': 'success', 'echo': kwargs.get('text', '')})


class RequiredArgAgent(BasicAgent):
    def __init__(self):
        super().__init__(
            name='NeedsArg',
            metadata=_meta(
                'NeedsArg',
                required=['target'],
                properties={'target': {'type': 'string'}},
            ),
        )

    def perform(self, **kwargs):
        return 'done'


class ThrowingAgent(BasicAgent):
    def __init__(self):
        super().__init__(name='Thrower', metadata=_meta('Thrower'))

    def perform(self, **kwargs):
        raise RuntimeError('Intentional failure')


class ContractFailAgent(BasicAgent):
    """Resolves successfully but reports failure in the envelope."""

    def __init__(self):
        super().__init__(name='ContractFail', metadata=_meta('ContractFail'))

    def perform(self, **kwargs):
        return json.dumps({'status': 'error', 'message': 'Contract failure'})


class PlainTextAgent(BasicAgent):
    def __init__(self):
        super().__init__(name='Plain', metadata=_meta('Plain'))

    def perform(self, **kwargs):
        return 'not json at all'


def _server(*agents):
    server = McpServer()
    for agent in agents:
        server.register_agent(agent)
    return server


def _call(server, method, params=None, request_id=1):
    request = {'jsonrpc': '2.0', 'id': request_id, 'method': method}
    if params is not None:
        request['params'] = params
    return server.handle_request(request)


# ---------------------------------------------------------------- initialize


def test_initialize_reports_protocol_version():
    """The MCP spec requires protocolVersion in the initialize result.

    TypeScript pins '2024-11-05' at parity/mcp-server.test.ts:229. Omitting it
    is invisible to any caller that does not validate, which is why it lasted.
    """
    result = _call(_server(), 'initialize', {})['result']
    assert result['protocolVersion'] == PROTOCOL_VERSION


def test_initialize_reports_capabilities_and_server_info():
    result = _call(_server(), 'initialize', {})['result']
    assert result['capabilities'] == {'tools': {}}
    assert result['serverInfo']['name'] == 'openrappter'
    assert result['serverInfo']['version']


def test_server_info_honours_options():
    server = McpServer({'name': 'custom', 'version': '9.9.9'})
    result = _call(server, 'initialize', {})['result']
    assert result['serverInfo'] == {'name': 'custom', 'version': '9.9.9'}


# ----------------------------------------------------------------- registry


def test_registration_tracks_tools():
    server = _server(EchoAgent())
    assert server.tool_count == 1
    assert server.has_tool('Echo')
    assert not server.has_tool('Missing')


# --------------------------------------------------------------- tools/list


def test_tools_list_exposes_registered_agents():
    tools = _call(_server(EchoAgent()), 'tools/list')['result']['tools']
    assert len(tools) == 1
    assert tools[0]['name'] == 'Echo'
    assert tools[0]['description'] == 'Echo description'
    assert tools[0]['inputSchema']['type'] == 'object'
    assert tools[0]['inputSchema']['properties'] == {'text': {'type': 'string'}}


def test_tools_list_omits_empty_required():
    """TypeScript emits `required` only when non-empty (server.ts:105).

    An empty `required: []` is not equivalent for strict schema validators,
    which is why the two runtimes must agree on omission rather than shape.
    """
    tools = _call(_server(EchoAgent()), 'tools/list')['result']['tools']
    assert 'required' not in tools[0]['inputSchema']


def test_tools_list_keeps_non_empty_required():
    tools = _call(_server(RequiredArgAgent()), 'tools/list')['result']['tools']
    assert tools[0]['inputSchema']['required'] == ['target']


# --------------------------------------------------------------- tools/call


def test_tools_call_returns_text_content():
    response = _call(
        _server(EchoAgent()),
        'tools/call',
        {'name': 'Echo', 'arguments': {'text': 'hi'}},
    )
    content = response['result']['content']
    assert content[0]['type'] == 'text'
    assert json.loads(content[0]['text'])['echo'] == 'hi'


def test_tools_call_pretty_prints_json_results():
    """TypeScript re-serialises parsed JSON with 2-space indent (server.ts:180).

    The text field is what a client renders to a human, so identical agent
    output must produce identical text in both runtimes.
    """
    response = _call(
        _server(EchoAgent()),
        'tools/call',
        {'name': 'Echo', 'arguments': {'text': 'hi'}},
    )
    text = response['result']['content'][0]['text']
    assert text == json.dumps(
        {'status': 'success', 'echo': 'hi'}, indent=2
    )


def test_tools_call_passes_through_non_json_results():
    response = _call(
        _server(PlainTextAgent()), 'tools/call', {'name': 'Plain', 'arguments': {}}
    )
    assert response['result']['content'][0]['text'] == 'not json at all'


def test_tools_call_unknown_tool_is_invalid_params():
    response = _call(
        _server(), 'tools/call', {'name': 'NonExistent', 'arguments': {}}
    )
    assert response['error']['code'] == -32602
    assert 'NonExistent' in response['error']['message']


def test_tools_call_unknown_tool_message_matches_typescript():
    response = _call(
        _server(), 'tools/call', {'name': 'NonExistent', 'arguments': {}}
    )
    assert response['error']['message'] == 'Unknown tool: NonExistent'


def test_tools_call_reports_raised_exceptions_as_tool_errors():
    response = _call(
        _server(ThrowingAgent()), 'tools/call', {'name': 'Thrower', 'arguments': {}}
    )
    assert 'error' not in response
    assert response['result']['isError'] is True
    assert 'Intentional failure' in response['result']['content'][0]['text']


def test_tools_call_marks_structured_agent_errors_as_tool_errors():
    """An agent that *resolves* with {"status": "error"} has still failed.

    `result_status.agent_result_is_error` is the shared classifier and its
    TypeScript twin documents that every composition layer -- chain, graph,
    broadcast, MCP, chat -- must route through it so the runtimes cannot
    drift. The Python MCP server was the one layer that did not, so it
    reported a declared failure to the client as a success.
    """
    response = _call(
        _server(ContractFailAgent()),
        'tools/call',
        {'name': 'ContractFail', 'arguments': {}},
    )
    assert 'error' not in response
    assert response['result']['isError'] is True
    assert 'Contract failure' in response['result']['content'][0]['text']


def test_successful_call_does_not_set_is_error():
    response = _call(
        _server(EchoAgent()), 'tools/call', {'name': 'Echo', 'arguments': {'text': 'x'}}
    )
    assert 'isError' not in response['result']


def test_is_error_agrees_with_shared_classifier():
    """Pins the invariant itself rather than one hard-coded example."""
    for agent, name in ((EchoAgent(), 'Echo'), (ContractFailAgent(), 'ContractFail')):
        response = _call(
            _server(agent), 'tools/call', {'name': name, 'arguments': {}}
        )
        text = response['result']['content'][0]['text']
        assert response['result'].get('isError', False) is agent_result_is_error(text)


# ------------------------------------------------------- ping / unknown verb


def test_ping_returns_empty_result():
    assert _call(_server(), 'ping')['result'] == {}


def test_unknown_method_is_method_not_found():
    response = _call(_server(), 'nope/nope')
    assert response['error']['code'] == -32601
    assert 'nope/nope' in response['error']['message']


@pytest.mark.parametrize('method', ['initialize', 'tools/list', 'ping'])
def test_responses_echo_request_id_and_version(method):
    response = _call(_server(), method, {}, request_id='abc-123')
    assert response['jsonrpc'] == '2.0'
    assert response['id'] == 'abc-123'
