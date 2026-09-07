"""Inert subprocess fixture; HOME and memory paths are supplied by its test."""

import json
import faulthandler
from pathlib import Path
import sys
import threading
import time

print("memory fixture: importing runtime", file=sys.stderr, flush=True)
faulthandler.dump_traceback_later(3)
from openrappter.agents.manage_memory_agent import ManageMemoryAgent
from openrappter.agents import manage_memory_agent as json_store

directory, mode, prefix, count = sys.argv[1:]


def report(value):
    print(value if isinstance(value, str) else json.dumps(value), flush=True)


class Writer(ManageMemoryAgent):
    def _load_memories(self):
        result = super()._load_memories()
        # Widen the read/write interleaving; the lock must cover this interval.
        time.sleep(0.005)
        return result


print("memory fixture: constructing agent", file=sys.stderr, flush=True)
agent = Writer()
agent.home = Path(directory)
agent.memory_file = agent.home / "memory.json"
report("ready")
print("memory fixture: awaiting start", file=sys.stderr, flush=True)
faulthandler.cancel_dump_traceback_later()
sys.stdin.readline()
report("attempting")
if mode == "hold":
    with json_store._memory_file_lock(agent.memory_file):
        report("locked")
        threading.Event().wait()
else:
    replace = json_store.os.replace

    def interrupted_replace(source, target):
        if mode == "before-replace":
            report(mode)
            threading.Event().wait()
        replace(source, target)
        if mode == "after-replace":
            report(mode)
            threading.Event().wait()

    if mode in ("before-replace", "after-replace"):
        json_store.os.replace = interrupted_replace
    results = [
        json.loads(agent.perform(content=f"{prefix}-{index}"))
        for index in range(int(count))
    ]
    report(results)
    if mode == "acknowledged":
        threading.Event().wait()
