"""The brainstem's HTTP entry point, tested on malformed framing.

`do_POST` began with

    length = int(self.headers.get("Content-Length") or 0)
    raw = self.rfile.read(length) if length else b""

Three things follow from those two lines, all reproduced against the running
server with a raw socket before anything was changed:

    Content-Length: abc          no HTTP response at all -- ValueError left
                                 do_POST unhandled and the connection closed
    Content-Length: -5           no HTTP response
    Content-Length: 2000000000   blocked forever waiting for bytes that were
    (19 bytes sent)              never sent

The TypeScript gateway answers the first two `400 Bad Request` and always
answers something, so the target behaviour here is not invented -- the same
three headers were sent to both runtimes and this file encodes what the other
one already did.

`ThreadingHTTPServer` gives each request its own thread, so the third case did
not wedge the server; it leaked one thread per request instead, which is a
slower version of the same thing on a daemon meant to run for weeks.
"""
import inspect
import socket
import urllib.parse

from openrappter import brainstem


def _raw_post(base, headers, body=b'{"user_input":"hi"}', timeout=15, half_close=False):
    """Send a hand-built request so the framing itself can be malformed."""
    parts = urllib.parse.urlparse(base)
    conn = socket.create_connection((parts.hostname, parts.port), timeout=timeout)
    try:
        conn.sendall(
            b"POST /chat HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n"
            + headers
            + b"\r\n"
            + body
        )
        if half_close:
            # Signal "that is the whole body" so the server sees EOF instead of
            # waiting for bytes the caller still might send. Without this the
            # server is right to wait, and the request is slow rather than
            # malformed.
            conn.shutdown(socket.SHUT_WR)
        # Read to EOF rather than taking one `recv`. The server answers
        # HTTP/1.0 and closes, but the headers and the body do not have to
        # arrive in the same segment -- a single recv made this file fail about
        # one run in three, on the body assertions only.
        data = b""
        try:
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                data += chunk
        except (TimeoutError, socket.timeout):
            if not data:
                return None, b""
    finally:
        conn.close()
    if not data:
        return None, b""
    head, _, rest = data.partition(b"\r\n\r\n")
    status = int(head.split(b"\r\n")[0].split(b" ")[1])
    return status, rest


class TestContentLengthFraming:
    def test_a_non_numeric_content_length_is_a_400_not_a_dropped_connection(self, server):
        status, body = _raw_post(server, b"Content-Length: abc\r\n")
        assert status == 400, "a malformed Content-Length must be answered, not dropped"
        assert b"Content-Length" in body

    def test_a_negative_content_length_is_a_400(self, server):
        status, body = _raw_post(server, b"Content-Length: -5\r\n")
        assert status == 400
        assert b"negative" in body

    def test_the_rejection_uses_the_same_envelope_as_every_other_rejection(self, server):
        """`contracts/rapp-chat-v1.json` fixes the shape of an error reply."""
        for header in (b"Content-Length: abc\r\n", b"Content-Length: -5\r\n"):
            _, body = _raw_post(server, header)
            assert b'"schema": "rapp-chat/1.0"' in body, header
            assert b'"status": "error"' in body, header

    def test_a_body_shorter_than_its_content_length_is_refused(self, server):
        """Claiming 400 bytes, sending 19, then closing, is malformed input.

        The half close is what makes this different from a slow caller: a client
        that has not finished sending is waited for, and only a client that says
        "that is all" while owing bytes is refused.
        """
        status, body = _raw_post(server, b"Content-Length: 400\r\n", half_close=True)
        assert status == 400
        assert b"shorter than" in body

    def test_a_well_formed_request_still_reaches_the_handler(self, server):
        """Anti-vacuity: the guards above must not reject ordinary traffic.

        Without a model configured this reaches a 503, which is the point --
        it got past framing and into the chat handler.
        """
        status, _ = _raw_post(server, b"Content-Length: 19\r\n")
        assert status not in (400, None)


class TestStallBudget:
    def test_the_handler_bounds_a_stalled_body_read(self):
        """A claimed Content-Length the caller never sends must not block forever.

        Asserted on the attribute rather than by stalling a real socket: the
        behaviour was verified once against the running server (the connection
        released at 30.0s instead of never), and repeating that in the suite
        would cost thirty seconds per run to re-learn the same fact.
        """
        assert isinstance(brainstem.BrainstemHandler.timeout, (int, float))
        assert 0 < brainstem.BrainstemHandler.timeout <= 120


def _multipart_post(base, content_type, body, timeout=15):
    """POST to /agents/import with hand-built multipart framing."""
    parts = urllib.parse.urlparse(base)
    conn = socket.create_connection((parts.hostname, parts.port), timeout=timeout)
    try:
        conn.sendall(
            b"POST /agents/import HTTP/1.1\r\nHost: x\r\nContent-Type: "
            + content_type
            + b"\r\nContent-Length: "
            + str(len(body)).encode()
            + b"\r\n\r\n"
            + body
        )
        conn.shutdown(socket.SHUT_WR)
        data = b""
        while True:
            chunk = conn.recv(4096)
            if not chunk:
                break
            data += chunk
    finally:
        conn.close()
    if not data:
        return None, b""
    head, _, rest = data.partition(b"\r\n\r\n")
    return int(head.split(b"\r\n")[0].split(b" ")[1]), rest


BOUNDARY = b"multipart/form-data; boundary=----X"
WELL_FORMED = (
    b'------X\r\nContent-Disposition: form-data; name="f"; filename="a.py"'
    b"\r\n\r\nprint(1)\r\n------X--\r\n"
)


class TestAgentImportFraming:
    """`/agents/import` parses multipart by hand, and hand-rolled parsers fall over.

    This is the same defect as `Content-Length` one handler above: an unguarded
    index raised out of `do_POST`, so a malformed upload closed the connection
    without ever sending a status line.
    """

    def test_a_part_with_no_blank_line_is_a_400_not_a_dropped_connection(self, server):
        body = (
            b'------X\r\nContent-Disposition: form-data; name="f"; filename="a.py"'
            b"\r\n------X--\r\n"
        )
        status, payload = _multipart_post(server, BOUNDARY, body)
        assert status == 400, "a malformed part must be answered, not dropped"
        assert b"Malformed multipart" in payload

    def test_a_missing_boundary_is_refused_rather_than_silently_corrupting(self, server):
        """Without a boundary the delimiter was written into the agent as source.

        The saved bytes were `print(1)\\r\\n------X--\\r\\n` and the endpoint
        answered 200, so the caller was told the import succeeded while the file
        on disk could not parse.
        """
        status, payload = _multipart_post(server, b"multipart/form-data", WELL_FORMED)
        assert status == 400
        assert b"boundary" in payload

    def test_a_well_formed_upload_still_imports(self, server):
        """Anti-vacuity: the guards must not reject a real upload."""
        status, _ = _multipart_post(server, BOUNDARY, WELL_FORMED)
        assert status == 200

    def test_the_saved_agent_is_exactly_the_uploaded_source(self, server):
        """The bytes on disk are the file, with no envelope left in them."""
        _multipart_post(server, BOUNDARY, WELL_FORMED)
        saved = brainstem.AGENTS_PATH / "a_agent.py"
        assert saved.exists()
        assert saved.read_bytes() == b"print(1)"


def _raw_get(base, path=b"/health", timeout=15):
    parts = urllib.parse.urlparse(base)
    conn = socket.create_connection((parts.hostname, parts.port), timeout=timeout)
    try:
        conn.sendall(b"GET " + path + b" HTTP/1.1\r\nHost: x\r\n\r\n")
        data = b""
        while True:
            chunk = conn.recv(4096)
            if not chunk:
                break
            data += chunk
    finally:
        conn.close()
    if not data:
        return None, b""
    head, _, rest = data.partition(b"\r\n\r\n")
    return int(head.split(b"\r\n")[0].split(b" ")[1]), rest


def _raising(*_args, **_kwargs):
    raise RuntimeError("deliberate failure planted by the test")


class TestNoRequestEndsWithoutAReply:
    """An exception inside a route must become a status, never a closed socket.

    Three separate handlers were fixed for this one at a time -- `Content-Length`
    parsing (#355), multipart framing (#356), and any failure while serving
    `/health`, which returned nothing at all until the guard was added. The
    point of testing it here is that the next unguarded line, wherever it is,
    is already covered.
    """

    def test_a_failing_get_route_answers_500_rather_than_dropping(self, server, monkeypatch):
        monkeypatch.setattr(brainstem, "load_agents", _raising)
        status, body = _raw_get(server, b"/health")
        assert status == 500, "a failing route must answer, not close the connection"
        assert b"Internal error" in body

    def test_a_failing_chat_route_answers_in_the_contract_envelope(self, server, monkeypatch):
        """`/chat` replies are fixed by `contracts/rapp-chat-v1.json`.

        `_validate_conversation_history` runs before the handler's own
        `except Exception`, so raising there reaches the dispatch guard.
        """
        monkeypatch.setattr(brainstem, "_validate_conversation_history", _raising)
        status, body = _raw_post(server, b"Content-Length: 19\r\n")
        assert status == 500
        assert b'"schema": "rapp-chat/1.0"' in body
        assert b'"status": "error"' in body

    def test_the_caller_is_not_handed_our_stack_trace(self, server, monkeypatch):
        """The operator gets the traceback; the caller gets a sentence."""
        monkeypatch.setattr(brainstem, "load_agents", _raising)
        _, body = _raw_get(server, b"/health")
        assert b"Traceback" not in body
        assert b"deliberate failure planted by the test" not in body
        assert b"brainstem.py" not in body

    def test_healthy_requests_are_unaffected(self, server):
        """Anti-vacuity: the guard must not change a request that works."""
        status, body = _raw_get(server, b"/health")
        assert status == 200
        assert b'"status": "ok"' in body


def _raw_request(base, verb=b"GET", path=b"/health", timeout=15):
    """Send a bare request and return the whole reply, framing included."""
    parts = urllib.parse.urlparse(base)
    conn = socket.create_connection((parts.hostname, parts.port), timeout=timeout)
    try:
        conn.sendall(verb + b" " + path + b" HTTP/1.1\r\nHost: x\r\n\r\n")
        data = b""
        while True:
            chunk = conn.recv(4096)
            if not chunk:
                break
            data += chunk
    finally:
        conn.close()
    return data


class TestTheGuardItself:
    """Two defects in the dispatch guard added by #357, found by auditing it.

    The guard turned a dropped connection into a `500`. Both of these are ways
    it did not finish the job it claimed to have done generally.
    """

    def test_a_route_that_already_replied_does_not_get_a_second_response(
        self, server, monkeypatch
    ):
        """The guard must not append a status line to a reply in progress.

        Before this, a route that wrote its headers and then raised produced

            HTTP/1.0 200 OK ... HALF!HTTP/1.0 500 Internal Server Error ...

        -- two responses concatenated inside one, which is a worse failure than
        the dropped connection the guard exists to prevent. A truncated reply is
        recognisably broken; this is not.
        """

        def half_written(self):
            self.send_response(200)
            self.send_header("Content-Length", "5")
            self.end_headers()
            self.wfile.write(b"HALF!")
            raise RuntimeError("deliberate failure after the reply began")

        monkeypatch.setattr(brainstem.BrainstemHandler, "_route_get", half_written)
        reply = _raw_request(server)
        assert reply.count(b"HTTP/1.0") == 1, "a second status line was appended"
        assert reply.endswith(b"HALF!")

    def test_delete_is_guarded_too(self, server, monkeypatch):
        """`do_DELETE` was left out of the guard that was described as general."""
        monkeypatch.setattr(brainstem, "AGENTS_PATH", None)
        reply = _raw_request(server, b"DELETE", b"/agents/x.py")
        assert reply, "a failing DELETE must answer, not close the connection"
        assert reply.split(b"\r\n")[0].split(b" ")[1] == b"500"

    def test_a_healthy_delete_is_unaffected(self, server):
        """Anti-vacuity: the guard must not change a DELETE that works."""
        reply = _raw_request(server, b"DELETE", b"/agents/not-there.py")
        assert reply.split(b"\r\n")[0].split(b" ")[1] == b"404"

    def test_every_verb_the_handler_serves_is_dispatched_through_the_guard(self):
        """The gap this class exists for was a verb, so name them all.

        `do_DELETE` existed for the whole life of the guard and was not wrapped,
        because the fix was written by editing the two methods that were in
        front of me rather than by asking which methods there were.
        """
        verbs = [
            name for name in dir(brainstem.BrainstemHandler)
            if name.startswith("do_")
        ]
        assert verbs, "expected the handler to serve at least one verb"
        for verb in verbs:
            source = inspect.getsource(getattr(brainstem.BrainstemHandler, verb))
            assert "_guarded(" in source, f"{verb} does not go through _guarded"
