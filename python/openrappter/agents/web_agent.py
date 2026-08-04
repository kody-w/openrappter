"""
WebAgent - HTTP requests and web search agent.

Provides web content fetching with SSRF protection and DuckDuckGo search.
Includes inline validation to block access to private IP ranges.

Actions: fetch, search

Mirrors TypeScript agents/WebAgent.ts
"""

import ipaddress
import json
import re
import socket
import urllib.error
import urllib.request
from datetime import datetime
from urllib.parse import urljoin, urlparse, quote

from openrappter.agents.basic_agent import BasicAgent



__manifest__ = {
    "schema": "rapp-agent/1.0",
    "name": "@openrappter/web",
    "version": "1.0.0",
    "display_name": "Web",
    "description": "Fetch web pages and search the web. Includes SSRF protection to prevent access to private networks.",
    "author": "Kody Wildfeuer",
    "ring": "ga",
    "capabilities": [
        "network"
    ],
    "tags": [
        "openrappter",
        "web"
    ],
    "category": "research",
    "quality_tier": "official",
    "requires_env": []
}

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Stop urllib following redirects so each hop can be validated first."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class WebAgent(BasicAgent):
    def __init__(self):
        self.name = 'Web'
        self.metadata = {
            "name": self.name,
            "description": "Fetch web pages and search the web. Includes SSRF protection to prevent access to private networks.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "The web action to perform.",
                        "enum": ["fetch", "search"]
                    },
                    "url": {
                        "type": "string",
                        "description": "URL to fetch (for 'fetch' action)."
                    },
                    "query": {
                        "type": "string",
                        "description": "Search query (for 'search' action)."
                    }
                },
                "required": []
            }
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        action = kwargs.get('action')
        url = kwargs.get('url')
        query = kwargs.get('query')

        if not action:
            return json.dumps({
                "status": "error",
                "message": "No action specified. Use: fetch or search"
            })

        try:
            if action == 'fetch':
                if not url:
                    return json.dumps({"status": "error", "message": "URL required for fetch action"})
                return self._fetch_url(url)
            elif action == 'search':
                if not query:
                    return json.dumps({"status": "error", "message": "Query required for search action"})
                return self._search_web(query)
            else:
                return json.dumps({
                    "status": "error",
                    "message": f"Unknown action: {action}"
                })
        except Exception as e:
            return json.dumps({
                "status": "error",
                "action": action,
                "message": str(e)
            })

    _ALLOWED_SCHEMES = ('http', 'https')
    _MAX_REDIRECTS = 5

    def _resolve_addresses(self, hostname):
        """Every address a host answers with, IPv4 and IPv6.

        `socket.gethostbyname` returns one IPv4 address and nothing else. A name
        published only as AAAA raised gaierror and was waved through, and a name
        answering with several addresses was judged by whichever came first.
        `getaddrinfo` asks for all of them.
        """
        infos = socket.getaddrinfo(hostname, None)
        return [info[4][0] for info in infos]

    def _validate_url(self, url):
        """Validate URL against SSRF attacks by checking for private IP ranges."""
        parsed = urlparse(url)

        # A web fetcher has no business on any other scheme. urllib will happily
        # open file:// and read from disk; that is currently refused only
        # because such URLs have no hostname, which is an accident rather than a
        # decision.
        if parsed.scheme not in self._ALLOWED_SCHEMES:
            raise ValueError(f"Unsupported URL scheme: {parsed.scheme or '(none)'}")

        hostname = parsed.hostname
        if not hostname:
            raise ValueError(f"Invalid URL: {url}")

        # Block localhost
        if hostname == 'localhost' or hostname.endswith('.local'):
            raise ValueError(f"Access to localhost blocked: {hostname}")

        # Resolve hostname and check every address it answers with
        try:
            addresses = self._resolve_addresses(hostname)
        except socket.gaierror:
            # If DNS resolution fails, let the fetch fail naturally
            return

        for address in addresses:
            ip = ipaddress.ip_address(address)
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                raise ValueError(
                    f"Access to private IP range blocked: {hostname} resolves to {address}"
                )

    def _open_validating_redirects(self, url):
        """Open a URL, validating every hop rather than only the first.

        `urlopen` follows redirects on its own, so the check above only ever
        covered the URL the caller supplied. A public host replying
        `302 Location: http://127.0.0.1:.../` had its target fetched and the
        body returned — verified against a local pair of servers, which handed
        back the internal service's content.

        Redirects are resolved by hand so the same validation runs on each
        target, with a hop limit so a redirect cycle cannot spin.
        """
        opener = urllib.request.build_opener(_NoRedirect)
        target = url

        for _ in range(self._MAX_REDIRECTS + 1):
            self._validate_url(target)
            req = urllib.request.Request(
                target, headers={'User-Agent': 'OpenRappter/1.0'}
            )
            try:
                return opener.open(req, timeout=10)
            except urllib.error.HTTPError as exc:
                if exc.code not in (301, 302, 303, 307, 308):
                    raise
                location = exc.headers.get('Location')
                if not location:
                    raise
                # Resolve a relative Location against the hop it came from.
                target = urljoin(target, location)

        raise ValueError(f"Too many redirects (limit {self._MAX_REDIRECTS}): {url}")

    def _fetch_url(self, url):
        """Fetch a URL and return stripped text content."""
        response = self._open_validating_redirects(url)

        if response.status != 200:
            return json.dumps({
                "status": "error",
                "message": f"HTTP {response.status}: {response.reason}",
                "url": url,
            })

        content = response.read().decode('utf-8', errors='replace')

        # Strip HTML tags
        content = re.sub(r'<script\b[^<]*(?:(?!</script>)<[^<]*)*</script>', '', content, flags=re.IGNORECASE)
        content = re.sub(r'<style\b[^<]*(?:(?!</style>)<[^<]*)*</style>', '', content, flags=re.IGNORECASE)
        content = re.sub(r'<[^>]+>', ' ', content)
        content = re.sub(r'\s+', ' ', content).strip()

        # Limit to 5000 characters
        truncated = len(content) > 5000
        content = content[:5000]

        return json.dumps({
            "status": "success",
            "action": "fetch",
            "url": url,
            "content": content,
            "truncated": truncated,
            "length": len(content),
        })

    def _search_web(self, query):
        """Search DuckDuckGo Lite and parse results."""
        search_url = f"https://lite.duckduckgo.com/lite/?q={quote(query)}"

        req = urllib.request.Request(search_url, headers={'User-Agent': 'OpenRappter/1.0'})
        response = urllib.request.urlopen(req, timeout=10)

        if response.status != 200:
            return json.dumps({
                "status": "error",
                "message": f"Search failed: HTTP {response.status}",
                "query": query,
            })

        html = response.read().decode('utf-8', errors='replace')

        # Parse DuckDuckGo lite HTML results
        results = []
        link_pattern = re.compile(
            r'<a[^>]+href="([^"]+)"[^>]*class="result-link"[^>]*>([^<]+)</a>',
            re.IGNORECASE
        )
        snippet_pattern = re.compile(
            r'<td class="result-snippet">([^<]+)</td>',
            re.IGNORECASE
        )

        links = [(m.group(1), m.group(2)) for m in link_pattern.finditer(html)]
        snippets = [m.group(1).strip() for m in snippet_pattern.finditer(html)]

        for i in range(min(len(links), len(snippets), 10)):
            results.append({
                "title": links[i][1],
                "url": links[i][0],
                "snippet": snippets[i],
            })

        return json.dumps({
            "status": "success",
            "action": "search",
            "query": query,
            "results": results,
            "count": len(results),
        })
