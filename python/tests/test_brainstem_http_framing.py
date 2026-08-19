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
