import json
import stat
import sys
import textwrap
import time

import pytest

from openrappter.imessage.rpc import (
    ImsgRpcAmbiguous,
    ImsgRpcClient,
    ImsgRpcClosed,
    ImsgRpcProtocolError,
    ImsgRpcTimeout,
)

# Tests that assert a *terminal* condition -- the child exited, or emitted
# unframeable output -- resolve as soon as the child acts, so this timeout is
# only a safety net against a hang and must be generous. It was previously 1s,
# which raced a cold Python interpreter spawn: warm, the request resolves in
# ~25ms, but the first spawn after heavy disk activity measured ~920ms against
# that 1s budget. Any jitter past it surfaced as ImsgRpcTimeout instead of the
# expected terminal error, so the suite failed ~50% of the time when run
# straight after the full suite and passed when run warm.
TERMINAL_TIMEOUT = 30.0


def fake_rpc(tmp_path, behavior="normal"):
    script = tmp_path / "fake-imsg"
    script.write_text(
        "#!" + sys.executable + "\n"
        + textwrap.dedent(
            f"""
            import json, sys, time
            behavior = {behavior!r}
            for line in sys.stdin:
                request = json.loads(line)
                if behavior == "malformed":
                    print("not-json", flush=True)
                    continue
                if behavior == "timeout":
                    time.sleep(2)
                    continue
                if behavior == "exit":
                    raise SystemExit(7)
                print(json.dumps({{"jsonrpc":"2.0","id":request["id"],"result":{{"ok":True}}}}), flush=True)
                print(json.dumps({{"jsonrpc":"2.0","method":"message","params":{{"message":{{"guid":"G"}}}}}}), flush=True)
            """
        )
    )
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    return str(script)


def test_rpc_request_and_notification(tmp_path):
    notifications = []
    client = ImsgRpcClient(
        fake_rpc(tmp_path),
        on_notification=lambda method, params: notifications.append((method, params)),
    )
    client.start()
    assert client.request("probe", {}, timeout=3) == {"ok": True}
    deadline = time.time() + 1
    while not notifications and time.time() < deadline:
        time.sleep(0.01)
    assert notifications[0][0] == "message"
    client.stop()


def test_rpc_timeout_does_not_retry(tmp_path):
    client = ImsgRpcClient(fake_rpc(tmp_path, "timeout"), default_timeout=0.05)
    client.start()
    with pytest.raises(ImsgRpcAmbiguous):
        client.request("send", {"text": "synthetic"})
    client.stop()


def test_rpc_child_exit_fails_request(tmp_path):
    client = ImsgRpcClient(fake_rpc(tmp_path, "exit"))
    client.start()
    with pytest.raises(ImsgRpcClosed):
        client.request("probe", {}, timeout=TERMINAL_TIMEOUT)


def test_rpc_malformed_stdout_is_terminal(tmp_path):
    client = ImsgRpcClient(fake_rpc(tmp_path, "malformed"))
    client.start()
    with pytest.raises(ImsgRpcProtocolError):
        client.request("probe", {}, timeout=TERMINAL_TIMEOUT)
