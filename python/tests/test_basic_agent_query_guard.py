"""Regression tests for kody-w/openrappter#41.

``execute()`` used to hand ``kwargs['query']`` straight to ``slosh()``, so any
non-string query raised ``AttributeError: 'int' object has no attribute 'lower'``
inside the framework — before ``perform()`` ran. An agent could not validate its
own inputs. Mirrors ``typescript/src/__tests__/parity/basic-agent-query-guard.test.ts``.
"""

import json

import pytest

from openrappter.agents.basic_agent import BasicAgent


class EchoAgent(BasicAgent):
    def __init__(self):
        self.name = 'Echo'
        self.metadata = {
            "name": self.name,
            "description": "Echoes the received query type",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "User input"}
                },
                "required": [],
            },
        }
        self.seen = None
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        self.seen = kwargs
        return json.dumps({"status": "success", "received": repr(kwargs.get('query'))})


NON_STRING_QUERIES = [
    pytest.param(42, id="int"),
    pytest.param(True, id="bool"),
    pytest.param(['a', 'b'], id="list"),
    pytest.param({'a': 1}, id="dict"),
    pytest.param(3.5, id="float"),
]


@pytest.mark.parametrize("value", NON_STRING_QUERIES)
def test_executes_instead_of_raising(value):
    agent = EchoAgent()
    assert json.loads(agent.execute(query=value))["status"] == "success"


@pytest.mark.parametrize("value", NON_STRING_QUERIES)
def test_untouched_value_reaches_perform(value):
    agent = EchoAgent()
    agent.execute(query=value)
    assert agent.seen['query'] == value


def test_context_is_still_sloshed_for_non_string_query():
    agent = EchoAgent()
    agent.execute(query=42)

    assert agent.context is not None
    assert 'temporal' in agent.context
    assert 'query_signals' in agent.context
    assert 'orientation' in agent.context


def test_non_string_query_sloshes_as_empty_text():
    non_string = EchoAgent()
    non_string.execute(query=['ignored', 'tokens'])

    empty = EchoAgent()
    empty.execute(query='')

    assert non_string.context['query_signals'] == empty.context['query_signals']


def test_string_query_still_sloshes_real_text():
    agent = EchoAgent()
    agent.execute(query='deploy the staging cluster now')

    assert agent.context['query_signals'] != EchoAgent().slosh('')['query_signals']


def test_nullish_keys_fall_through():
    via_request = EchoAgent()
    via_request.execute(query=None, request='from request')

    via_user_input = EchoAgent()
    via_user_input.execute(query=None, request=None, user_input='from user_input')

    direct = EchoAgent()

    assert via_request.context['query_signals'] == direct.slosh('from request')['query_signals']
    assert (
        via_user_input.context['query_signals']
        == direct.slosh('from user_input')['query_signals']
    )


def test_present_non_string_query_does_not_fall_through_to_request():
    agent = EchoAgent()
    agent.execute(query=42, request='should not be used')

    empty = EchoAgent()
    empty.execute(query='')

    assert agent.context['query_signals'] == empty.context['query_signals']


@pytest.mark.parametrize("value", NON_STRING_QUERIES)
def test_direct_slosh_does_not_raise(value):
    assert EchoAgent().slosh(value) is not None
