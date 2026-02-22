"""Tests for WebAgent - HTTP fetch and web search with SSRF protection."""

import json
import socket
import pytest
from unittest.mock import patch, MagicMock
from urllib.error import URLError

from openrappter.agents.web_agent import WebAgent


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_response(content, status=200):
    """Build a mock urllib response object."""
    mock_resp = MagicMock()
    mock_resp.status = status
    mock_resp.read.return_value = content.encode("utf-8")
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)
    return mock_resp


# ---------------------------------------------------------------------------
# Tests: constructor and metadata
# ---------------------------------------------------------------------------

class TestWebAgentInit:
    def test_name_is_web(self):
        agent = WebAgent()
        assert agent.name == "Web"

    def test_metadata_has_correct_actions(self):
        agent = WebAgent()
        actions = agent.metadata["parameters"]["properties"]["action"]["enum"]
        assert set(actions) == {"fetch", "search"}

    def test_metadata_name_is_web(self):
        agent = WebAgent()
        assert agent.metadata["name"] == "Web"

    def test_metadata_description_mentions_ssrf(self):
        agent = WebAgent()
        assert "SSRF" in agent.metadata["description"]


# ---------------------------------------------------------------------------
# Tests: no action / unknown action
# ---------------------------------------------------------------------------

class TestActionValidation:
    def test_no_action_returns_error(self):
        agent = WebAgent()
        result = json.loads(agent.perform())
        assert result["status"] == "error"
        assert "action" in result["message"].lower()

    def test_unknown_action_returns_error(self):
        agent = WebAgent()
        result = json.loads(agent.perform(action="crawl"))
        assert result["status"] == "error"
        assert "Unknown action" in result["message"]


# ---------------------------------------------------------------------------
# Tests: fetch action – parameter validation
# ---------------------------------------------------------------------------

class TestFetchValidation:
    def test_fetch_requires_url(self):
        agent = WebAgent()
        result = json.loads(agent.perform(action="fetch"))
        assert result["status"] == "error"
        assert "URL" in result["message"] or "url" in result["message"].lower()


# ---------------------------------------------------------------------------
# Tests: SSRF protection / URL validation
# ---------------------------------------------------------------------------

class TestSsrfProtection:
    def test_blocks_localhost(self):
        agent = WebAgent()
        with pytest.raises(ValueError, match="localhost"):
            agent._validate_url("http://localhost/secret")

    def test_blocks_local_tld(self):
        agent = WebAgent()
        with pytest.raises(ValueError, match=r"localhost|\.local"):
            agent._validate_url("http://myapp.local/api")

    def test_blocks_private_ip_127(self):
        agent = WebAgent()
        with patch("socket.gethostbyname", return_value="127.0.0.1"):
            with pytest.raises(ValueError, match="private"):
                agent._validate_url("http://internal-host.example.com/")

    def test_blocks_private_ip_192_168(self):
        agent = WebAgent()
        with patch("socket.gethostbyname", return_value="192.168.1.100"):
            with pytest.raises(ValueError, match="private"):
                agent._validate_url("http://myrouter.example.com/")

    def test_blocks_private_ip_10_x(self):
        agent = WebAgent()
        with patch("socket.gethostbyname", return_value="10.0.0.5"):
            with pytest.raises(ValueError, match="private"):
                agent._validate_url("http://corp.example.com/api")

    def test_invalid_url_raises(self):
        agent = WebAgent()
        with pytest.raises((ValueError, Exception)):
            agent._validate_url("not-a-url")

    def test_public_ip_passes_validation(self):
        agent = WebAgent()
        # 8.8.8.8 is a public IP — validation should not raise
        with patch("socket.gethostbyname", return_value="8.8.8.8"):
            agent._validate_url("http://example.com/page")  # should not raise


# ---------------------------------------------------------------------------
# Tests: fetch action – network success
# ---------------------------------------------------------------------------

class TestFetchSuccess:
    def test_fetch_returns_success_status(self):
        agent = WebAgent()
        html = "<html><body><p>Hello world</p></body></html>"
        with patch("socket.gethostbyname", return_value="1.2.3.4"), \
             patch("urllib.request.urlopen", return_value=make_response(html)):
            result = json.loads(agent.perform(action="fetch", url="http://example.com/"))
        assert result["status"] == "success"
        assert result["action"] == "fetch"

    def test_fetch_returns_text_content(self):
        agent = WebAgent()
        html = "<html><body><p>Hello world</p></body></html>"
        with patch("socket.gethostbyname", return_value="1.2.3.4"), \
             patch("urllib.request.urlopen", return_value=make_response(html)):
            result = json.loads(agent.perform(action="fetch", url="http://example.com/"))
        assert "Hello world" in result["content"]

    def test_fetch_strips_html_tags(self):
        agent = WebAgent()
        html = "<html><body><b>Bold</b> text</body></html>"
        with patch("socket.gethostbyname", return_value="1.2.3.4"), \
             patch("urllib.request.urlopen", return_value=make_response(html)):
            result = json.loads(agent.perform(action="fetch", url="http://example.com/"))
        assert "<b>" not in result["content"]
        assert "Bold" in result["content"]

    def test_fetch_strips_script_tags(self):
        agent = WebAgent()
        html = "<html><body><script>alert('xss')</script><p>Safe</p></body></html>"
        with patch("socket.gethostbyname", return_value="1.2.3.4"), \
             patch("urllib.request.urlopen", return_value=make_response(html)):
            result = json.loads(agent.perform(action="fetch", url="http://example.com/"))
        assert "alert" not in result["content"]
        assert "Safe" in result["content"]

    def test_fetch_strips_style_tags(self):
        agent = WebAgent()
        html = "<html><head><style>body{color:red}</style></head><body>Content</body></html>"
        with patch("socket.gethostbyname", return_value="1.2.3.4"), \
             patch("urllib.request.urlopen", return_value=make_response(html)):
            result = json.loads(agent.perform(action="fetch", url="http://example.com/"))
        assert "color:red" not in result["content"]

    def test_fetch_not_truncated_for_short_content(self):
        agent = WebAgent()
        html = "<p>Short</p>"
        with patch("socket.gethostbyname", return_value="1.2.3.4"), \
             patch("urllib.request.urlopen", return_value=make_response(html)):
            result = json.loads(agent.perform(action="fetch", url="http://example.com/"))
        assert result["truncated"] is False

    def test_fetch_truncates_long_content(self):
        agent = WebAgent()
        # 6000 chars of text content (stripped HTML)
        html = "<p>" + "x" * 6000 + "</p>"
        with patch("socket.gethostbyname", return_value="1.2.3.4"), \
             patch("urllib.request.urlopen", return_value=make_response(html)):
            result = json.loads(agent.perform(action="fetch", url="http://example.com/"))
        assert result["truncated"] is True
        assert len(result["content"]) <= 5000

    def test_fetch_url_in_result(self):
        agent = WebAgent()
        with patch("socket.gethostbyname", return_value="1.2.3.4"), \
             patch("urllib.request.urlopen", return_value=make_response("<p>hi</p>")):
            result = json.loads(agent.perform(action="fetch", url="http://example.com/"))
        assert result["url"] == "http://example.com/"

    def test_fetch_length_in_result(self):
        agent = WebAgent()
        with patch("socket.gethostbyname", return_value="1.2.3.4"), \
             patch("urllib.request.urlopen", return_value=make_response("<p>hello</p>")):
            result = json.loads(agent.perform(action="fetch", url="http://example.com/"))
        assert "length" in result
        assert isinstance(result["length"], int)


# ---------------------------------------------------------------------------
# Tests: fetch action – network errors
# ---------------------------------------------------------------------------

class TestFetchErrors:
    def test_fetch_handles_url_error(self):
        agent = WebAgent()
        with patch("socket.gethostbyname", return_value="1.2.3.4"), \
             patch("urllib.request.urlopen", side_effect=URLError("connection refused")):
            result = json.loads(agent.perform(action="fetch", url="http://example.com/"))
        assert result["status"] == "error"

    def test_fetch_handles_ssrf_error_gracefully(self):
        agent = WebAgent()
        result = json.loads(agent.perform(action="fetch", url="http://localhost/secret"))
        assert result["status"] == "error"

    def test_fetch_dns_failure_does_not_crash(self):
        agent = WebAgent()
        with patch("socket.gethostbyname", side_effect=socket.gaierror("no such host")), \
             patch("urllib.request.urlopen", side_effect=URLError("name resolution failed")):
            result = json.loads(agent.perform(action="fetch", url="http://nonexistent-domain-xyz.example/"))
        assert result["status"] == "error"


# ---------------------------------------------------------------------------
# Tests: search action – parameter validation
# ---------------------------------------------------------------------------

class TestSearchValidation:
    def test_search_requires_query(self):
        agent = WebAgent()
        result = json.loads(agent.perform(action="search"))
        assert result["status"] == "error"
        assert "query" in result["message"].lower() or "Query" in result["message"]


# ---------------------------------------------------------------------------
# Tests: search action – success path
# ---------------------------------------------------------------------------

class TestSearchSuccess:
    def _make_ddg_html(self, count=3):
        """Build minimal DuckDuckGo lite HTML with `count` results."""
        results = []
        for i in range(count):
            results.append(
                f'<a href="https://example{i}.com/" class="result-link">Result {i}</a>'
            )
            results.append(
                f'<td class="result-snippet">Snippet {i}</td>'
            )
        return "<html><body>" + "\n".join(results) + "</body></html>"

    def test_search_returns_success_status(self):
        agent = WebAgent()
        html = self._make_ddg_html(count=2)
        with patch("urllib.request.urlopen", return_value=make_response(html)):
            result = json.loads(agent.perform(action="search", query="python"))
        assert result["status"] == "success"
        assert result["action"] == "search"

    def test_search_returns_query_in_result(self):
        agent = WebAgent()
        with patch("urllib.request.urlopen", return_value=make_response(self._make_ddg_html())):
            result = json.loads(agent.perform(action="search", query="openai"))
        assert result["query"] == "openai"

    def test_search_parses_results(self):
        agent = WebAgent()
        html = self._make_ddg_html(count=3)
        with patch("urllib.request.urlopen", return_value=make_response(html)):
            result = json.loads(agent.perform(action="search", query="test"))
        assert result["count"] == 3
        assert len(result["results"]) == 3

    def test_search_result_has_title_url_snippet(self):
        agent = WebAgent()
        html = self._make_ddg_html(count=1)
        with patch("urllib.request.urlopen", return_value=make_response(html)):
            result = json.loads(agent.perform(action="search", query="test"))
        entry = result["results"][0]
        assert "title" in entry
        assert "url" in entry
        assert "snippet" in entry

    def test_search_caps_results_at_10(self):
        agent = WebAgent()
        html = self._make_ddg_html(count=15)
        with patch("urllib.request.urlopen", return_value=make_response(html)):
            result = json.loads(agent.perform(action="search", query="test"))
        assert result["count"] <= 10

    def test_search_empty_results_when_no_html_matches(self):
        agent = WebAgent()
        with patch("urllib.request.urlopen", return_value=make_response("<html><body>nothing here</body></html>")):
            result = json.loads(agent.perform(action="search", query="obscure"))
        assert result["count"] == 0
        assert result["results"] == []


# ---------------------------------------------------------------------------
# Tests: search action – errors
# ---------------------------------------------------------------------------

class TestSearchErrors:
    def test_search_handles_network_error(self):
        agent = WebAgent()
        with patch("urllib.request.urlopen", side_effect=URLError("network error")):
            result = json.loads(agent.perform(action="search", query="test"))
        assert result["status"] == "error"
