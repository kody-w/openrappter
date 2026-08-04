"""The Python WebAgent had the same SSRF holes as the TypeScript one.

It claims "SSRF protection to prevent access to private networks". Two ways
past it, both reproduced before this file existed:

  1. `urlopen` follows redirects by itself, so validation only ever covered the
     URL the caller supplied. A public host replying
     `302 Location: http://127.0.0.1:.../` had its target fetched and the body
     returned — a local pair of servers handed back the internal content.

  2. `socket.gethostbyname` returns one IPv4 address. A name published only as
     AAAA raised gaierror and was waved through; a name answering with several
     addresses was judged by whichever came first.

The scheme was never checked either. urllib opens `file://` and reads from
disk — verified, it returned /etc/hosts — and that was refused only because
such URLs have no hostname, which is an accident rather than a decision.

Fixed in TypeScript in openrappter#71 and #72; this is the same fix in the
other body.
"""

import http.server
import socket
import threading

import pytest

from openrappter.agents.web_agent import WebAgent


@pytest.fixture
def agent():
    return WebAgent()


def _serve(handler_body=None, redirect_to=None):
    """Start a loopback server that either answers or redirects."""
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if redirect_to is not None:
                self.send_response(302)
                self.send_header('Location', redirect_to())
                self.end_headers()
                return
            self.send_response(200)
            self.end_headers()
            self.wfile.write(handler_body)

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


class TestScheme:
    @pytest.mark.parametrize('url', [
        'file:///etc/passwd',
        'ftp://example.com/x',
        'data:text/plain,hello',
        'gopher://example.com/',
    ])
    def test_non_http_schemes_are_refused(self, agent, url):
        with pytest.raises(ValueError, match='Unsupported URL scheme'):
            agent._validate_url(url)

    @pytest.mark.parametrize('url', ['http://example.com/', 'https://example.com/p?q=1'])
    def test_http_and_https_are_allowed(self, agent, url):
        agent._validate_url(url)


class TestAddresses:
    @pytest.mark.parametrize('url', [
        'http://127.0.0.1/',
        'http://[::1]/',
        'http://10.0.0.1/',
        'http://192.168.1.1/',
        'http://169.254.169.254/latest/meta-data/',
        'http://localhost/',
    ])
    def test_private_addresses_are_blocked(self, agent, url):
        with pytest.raises(ValueError, match='blocked'):
            agent._validate_url(url)

    def test_public_addresses_are_allowed(self, agent):
        """Without this the blocks above would pass by refusing everything."""
        agent._validate_url('http://93.184.216.34/')

    def test_every_resolved_address_is_checked_not_just_the_first(self, agent, monkeypatch):
        """One private answer is enough, wherever it appears in the list."""
        monkeypatch.setattr(
            agent, '_resolve_addresses',
            lambda hostname: ['93.184.216.34', '127.0.0.1'],
        )
        with pytest.raises(ValueError, match='resolves to 127.0.0.1'):
            agent._validate_url('http://public-looking.example/')

    def test_ipv6_only_names_are_checked(self, agent, monkeypatch):
        """gethostbyname could not see these at all; getaddrinfo can."""
        monkeypatch.setattr(agent, '_resolve_addresses', lambda hostname: ['::1'])
        with pytest.raises(ValueError, match='resolves to ::1'):
            agent._validate_url('http://ipv6-only.example/')

    def test_unresolvable_names_are_left_to_the_fetch(self, agent, monkeypatch):
        """Failing closed on every lookup error breaks hosts that were never private."""
        def boom(hostname):
            raise socket.gaierror('nope')
        monkeypatch.setattr(agent, '_resolve_addresses', boom)
        agent._validate_url('http://does-not-exist.invalid/')


class TestRedirects:
    def test_a_redirect_onto_a_private_address_is_refused(self, agent, monkeypatch):
        secret, sport = _serve(handler_body=b'INTERNAL-SERVICE-CONTENT')
        redir, rport = _serve(redirect_to=lambda: f'http://127.0.0.1:{sport}/')
        try:
            # The first hop has to pass for this to exercise the second one.
            real = agent._validate_url
            seen = {'first': True}

            def only_after_first(url):
                if seen['first']:
                    seen['first'] = False
                    return
                real(url)

            monkeypatch.setattr(agent, '_validate_url', only_after_first)

            with pytest.raises(ValueError, match='blocked'):
                agent._open_validating_redirects(f'http://127.0.0.1:{rport}/')
        finally:
            secret.shutdown()
            redir.shutdown()

    def test_a_redirect_loop_stops_after_a_bounded_number_of_hops(self, agent, monkeypatch):
        hits = {'n': 0}
        port_holder = {}

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                hits['n'] += 1
                self.send_response(302)
                self.send_header('Location', f"http://127.0.0.1:{port_holder['p']}/")
                self.end_headers()

            def log_message(self, *args):
                pass

        server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
        port_holder['p'] = server.server_address[1]
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            monkeypatch.setattr(agent, '_validate_url', lambda url: None)
            with pytest.raises(ValueError, match='Too many redirects'):
                agent._open_validating_redirects(f"http://127.0.0.1:{port_holder['p']}/")
            # Counting matters: "eventually raises" would also pass with a
            # limit of 100000, which is not a limit worth having.
            assert hits['n'] <= 10
        finally:
            server.shutdown()

    def test_a_redirect_to_an_allowed_address_is_still_followed(self, agent, monkeypatch):
        """Positive control: refusing every redirect passes the tests above and
        breaks ordinary browsing."""
        target, tport = _serve(handler_body=b'DESTINATION')
        redir, rport = _serve(redirect_to=lambda: f'http://127.0.0.1:{tport}/')
        try:
            monkeypatch.setattr(agent, '_validate_url', lambda url: None)
            response = agent._open_validating_redirects(f'http://127.0.0.1:{rport}/')
            assert response.read() == b'DESTINATION'
        finally:
            target.shutdown()
            redir.shutdown()

    def test_fetch_url_goes_through_the_validating_path(self, agent, monkeypatch):
        """The guard is only worth having if the public entry point uses it.

        Every other redirect test here calls `_open_validating_redirects`
        directly, so reverting `_fetch_url` to a plain `urlopen` left them all
        green. This one goes in the front door.
        """
        secret, sport = _serve(handler_body=b'INTERNAL-SERVICE-CONTENT')
        redir, rport = _serve(redirect_to=lambda: f'http://127.0.0.1:{sport}/')
        try:
            real = agent._validate_url
            seen = {'first': True}

            def only_after_first(url):
                if seen['first']:
                    seen['first'] = False
                    return
                real(url)

            monkeypatch.setattr(agent, '_validate_url', only_after_first)

            with pytest.raises(ValueError, match='blocked'):
                agent._fetch_url(f'http://127.0.0.1:{rport}/')
        finally:
            secret.shutdown()
            redir.shutdown()

    def test_a_direct_response_still_works(self, agent, monkeypatch):
        server, port = _serve(handler_body=b'DIRECT')
        try:
            monkeypatch.setattr(agent, '_validate_url', lambda url: None)
            response = agent._open_validating_redirects(f'http://127.0.0.1:{port}/')
            assert response.read() == b'DIRECT'
        finally:
            server.shutdown()
