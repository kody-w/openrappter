"""Independently verify Catch-me-up pages against canonical frames and trusted inputs."""
import json
import pathlib
import re
import sys

BASE = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE / "vendor/rapp1"))
import rapp as R


HEX = re.compile(r"^[0-9a-f]{64}$")
INPUT_SCHEMA = "rapp-work.catch-up-verification-input/1"
MANIFEST_SCHEMA = "rapp-work.catch-up-verification-manifest/1"
MAX_STEPS = 16


def frame_head(frame):
    return {
        "stream_id": frame["stream_id"],
        "seq": frame["seq"],
        "utc": frame["utc"],
        "payload_hash": frame["payload_hash"],
        "frame_hash": frame["frame_hash"],
    }


def source_key(root, scope):
    return R.H("rapp/1:particle", {"root": root, "scope": scope})


def source_stream(root, scope):
    if scope == "root":
        return f"{root}:work"
    return f"{root}:s-{source_key(root, scope)[:62]}"


def unique(values):
    return list(dict.fromkeys(values))


def root_record(roots, root):
    return roots.setdefault(root, {
        "body": [],
        "memory": [],
        "branches": [],
        "sources": {},
    })


def source_record(root, key, frame):
    scope = frame["payload"]["scope"]
    source = root["sources"].setdefault(key, {
        "key": key,
        "scope": scope,
        "stream": frame["stream_id"],
        "frames": [],
        "branches": {},
    })
    assert source["scope"] == scope
    assert source["stream"] == frame["stream_id"]
    return source


def load_evidence(canonical_directory, evidence_directories):
    frames = {}
    roots = {}
    canonical_directory = pathlib.Path(canonical_directory)
    canonical_files = sorted(canonical_directory.glob("**/frames/[0-9]*.json"))
    assert canonical_files, "No canonical frame files were supplied"
    for filename in canonical_files:
        frame = json.loads(filename.read_bytes())
        frames[frame["frame_hash"]] = frame
        parts = filename.relative_to(canonical_directory).parts
        if "bots" not in parts:
            continue
        bot = parts.index("bots")
        relative = parts[bot + 2:]
        payload = frame["payload"]
        root_id = payload["root"]
        root = root_record(roots, root_id)
        if relative[:2] == ("body", "frames"):
            root["body"].append(frame)
        elif relative[:2] == ("memory", "frames"):
            root["memory"].append(frame)
        elif len(relative) >= 3 and relative[0] == "scopes":
            key = relative[1]
            source = source_record(root, key, frame)
            if relative[2] == "frames":
                source["frames"].append(frame)
            elif len(relative) >= 6 and relative[2] == "branches" and relative[4] == "frames":
                source["branches"].setdefault(relative[3], []).append(frame)
        elif len(relative) >= 4 and relative[0] == "branches" and relative[2] == "frames":
            root["branches"].append(frame)
    for directory in evidence_directories:
        for filename in pathlib.Path(directory).glob("**/frames/[0-9]*.json"):
            frame = json.loads(filename.read_bytes())
            frames[frame["frame_hash"]] = frame
    for root in roots.values():
        root["body"].sort(key=lambda frame: frame["seq"])
        root["memory"].sort(key=lambda frame: frame["seq"])
        for source in root["sources"].values():
            source["frames"].sort(key=lambda frame: frame["seq"])
            for branch in source["branches"].values():
                branch.sort(key=lambda frame: frame["seq"])
        assert len(root["body"]) == 1
        assert_canonical_selection(root)
    return roots, frames


def selected_frames(root):
    return [
        *root["body"],
        *root["memory"],
        *(frame for source in root["sources"].values() for frame in source["frames"]),
    ]


def retained_frames(root):
    return [
        *root["branches"],
        *(frame for source in root["sources"].values()
          for branch in source["branches"].values() for frame in branch),
    ]


def assert_canonical_selection(root):
    groups = {}
    for frame in [*selected_frames(root), *retained_frames(root)]:
        key = (frame["stream_id"], frame["seq"], frame["prev"])
        groups.setdefault(key, set()).add(frame["frame_hash"])
    assert not any(len(group) > 1 for group in groups.values()), \
        "Conflicting retained branches authorize no replay interpretation"
    selected = {frame["frame_hash"] for frame in selected_frames(root)}
    assert all(frame["frame_hash"] in selected for frame in retained_frames(root)), \
        "A retained successor cannot be treated as inactive catalogue state"


def dependency_hashes(frame, active, body):
    payload = frame["payload"]
    data = payload.get("data", {})
    dependencies = set()

    def add(value):
        if isinstance(value, str) and value in active:
            dependencies.add(value)

    if frame["seq"]:
        previous = next((candidate for candidate in active.values()
                         if candidate["stream_id"] == frame["stream_id"]
                         and candidate["seq"] == frame["seq"] - 1), None)
        assert previous, "A source stream has incomplete ancestry"
        dependencies.add(previous["frame_hash"])
    for value in payload.get("parents", []):
        assert value in active or value in body, "An explicit source parent is missing"
        add(value)
    for name in [
        "replyTo", "proposalWave", "targetWave", "approval", "bindingWave",
        "requestWave", "responseWave", "grantWave", "deliveryId", "attempt",
        "policyWave", "answerTo", "sourceWave", "preflight",
    ]:
        add(data.get(name))
    for name in ["evidence", "causes", "viewParents", "deliveryIds"]:
        for value in data.get(name, []) if isinstance(data.get(name), list) else []:
            add(value)
    for value in data.get("sourceRefs", []) if isinstance(data.get("sourceRefs"), list) else []:
        add(value.get("frame_hash") if isinstance(value, dict) else None)
    actor = data.get("actor")
    if isinstance(actor, dict):
        add(actor.get("grantWave"))
    content = data.get("content")
    if payload.get("event", "").startswith("client.") and isinstance(content, dict):
        for name in ["evidence", "references"]:
            for value in content.get(name, []) if isinstance(content.get(name), list) else []:
                add(value)
        view = data.get("view")
        if isinstance(view, dict):
            add(view.get("progress"))
            for card in view.get("cards", []) if isinstance(view.get("cards"), list) else []:
                add(card.get("ref") if isinstance(card, dict) else None)
    draft = data.get("draft")
    if isinstance(draft, dict):
        for value in draft.get("resolves", []) if isinstance(draft.get("resolves"), list) else []:
            add(value)
        for action in draft.get("actions", []) if isinstance(draft.get("actions"), list) else []:
            add(action.get("evidenceWave") if isinstance(action, dict) else None)
    return dependencies


def memory_order(root, selected=None):
    active_frames = [*root["memory"], *(frame for source in root["sources"].values() for frame in source["frames"])]
    if selected is not None:
        active_frames = [frame for frame in active_frames if frame["frame_hash"] in selected]
    active = {frame["frame_hash"]: frame for frame in active_frames}
    body = {frame["frame_hash"] for frame in root["body"]}
    dependencies = {wave: dependency_hashes(frame, active, body) for wave, frame in active.items()}
    children = {}
    indegree = {}
    for wave, parents in dependencies.items():
        indegree[wave] = len(parents)
        for parent in parents:
            children.setdefault(parent, []).append(wave)
    ready = [frame for frame in active_frames if indegree[frame["frame_hash"]] == 0]
    result = []
    while ready:
        ready.sort(key=lambda frame: (frame["utc"], frame["frame_hash"]))
        frame = ready.pop(0)
        result.append(frame)
        for child in children.get(frame["frame_hash"], []):
            indegree[child] -= 1
            if indegree[child] == 0:
                ready.append(active[child])
    assert len(result) == len(active_frames), "Source references are cyclic or incomplete"
    return result


def all_branch_heads(root):
    return {
        source["scope"]: set(source["branches"])
        for source in root["sources"].values()
    }


def full_cut(root):
    return {
        "selected": {frame["frame_hash"] for frame in memory_order(root)},
        "branches": all_branch_heads(root),
    }


def cut_chain(chain, head):
    if head is None:
        return []
    for index, frame in enumerate(chain):
        if frame_head(frame) == head:
            return chain[:index + 1]
    raise AssertionError("A cursor head is not a retained exact occurrence")


def cursor_for(root, cut, available_branches=None):
    selected = cut["selected"]
    available = cut["branches"] if available_branches is None else available_branches
    source_items = []
    for source in sorted(root["sources"].values(), key=lambda item: item["scope"]):
        chain = [frame for frame in source["frames"] if frame["frame_hash"] in selected]
        if not chain:
            continue
        branches = [
            head for head, frames in source["branches"].items()
            if head in available.get(source["scope"], set())
            and all(frame["frame_hash"] in selected for frame in frames)
        ]
        source_items.append({
            "key": source_key(root["body"][0]["payload"]["root"], source["scope"]),
            "head": frame_head(chain[-1]),
            "branches": sorted(branches),
        })
    root_chain = [frame for frame in root["memory"] if frame["frame_hash"] in selected]
    if not source_items:
        return frame_head(root_chain[-1]) if root_chain else None
    return {
        "schema": "rapp-work.source-cursor/1",
        "guid": root["body"][0]["payload"]["root"],
        "root": frame_head(root_chain[-1]) if root_chain else None,
        "sources": source_items,
    }


def validate_closed_cut(root, cut):
    selected = cut["selected"]
    order = memory_order(root, selected)
    assert {frame["frame_hash"] for frame in order} == selected
    for source in root["sources"].values():
        selected_chain = [frame for frame in source["frames"] if frame["frame_hash"] in selected]
        assert selected_chain == source["frames"][:len(selected_chain)], "A cursor source head is not a prefix"
        for head in cut["branches"].get(source["scope"], set()):
            assert head in source["branches"], "A cursor names an unknown retained branch"
            assert all(frame["frame_hash"] in selected for frame in source["branches"][head]), \
                "A cursor branch omits its retained ancestry"
    root_chain = [frame for frame in root["memory"] if frame["frame_hash"] in selected]
    assert root_chain == root["memory"][:len(root_chain)], "A cursor root head is not a prefix"


def cut_from_cursor(root, cursor):
    if cursor is None:
        return {"selected": set(), "branches": {}}
    if cursor.get("schema") != "rapp-work.source-cursor/1":
        chain = cut_chain(root["memory"], cursor)
        cut = {"selected": {frame["frame_hash"] for frame in chain}, "branches": {}}
        validate_closed_cut(root, cut)
        assert cursor_for(root, cut) == cursor
        return cut
    assert cursor.get("guid") == root["body"][0]["payload"]["root"]
    selected = {frame["frame_hash"] for frame in cut_chain(root["memory"], cursor.get("root"))}
    branches = {}
    seen = set()
    by_key = {source_key(root["body"][0]["payload"]["root"], source["scope"]): source
              for source in root["sources"].values()}
    for item in cursor.get("sources", []):
        key = item.get("key")
        assert key in by_key and key not in seen, "Unknown or duplicate source cursor key"
        seen.add(key)
        source = by_key[key]
        selected.update(frame["frame_hash"] for frame in cut_chain(source["frames"], item.get("head")))
        heads = item.get("branches")
        assert isinstance(heads, list) and all(head in source["branches"] for head in heads)
        branches[source["scope"]] = set(heads)
    cut = {"selected": selected, "branches": branches}
    validate_closed_cut(root, cut)
    assert cursor_for(root, cut) == cursor, "A source vector is not in canonical order"
    return cut


def prefix_cut(root, end_cut, count):
    order = memory_order(root, end_cut["selected"])
    selected = {frame["frame_hash"] for frame in order[:count]}
    branches = {
        source["scope"]: {
            head for head, frames in source["branches"].items()
            if head in end_cut["branches"].get(source["scope"], set())
            and all(frame["frame_hash"] in selected for frame in frames)
        }
        for source in root["sources"].values()
    }
    cut = {"selected": selected, "branches": branches}
    validate_closed_cut(root, cut)
    return cut


def advance_cut(root, from_cut, end_cut, pending, count):
    selected = set(from_cut["selected"])
    selected.update(frame["frame_hash"] for frame in pending[:count])
    branches = {
        source["scope"]: {
            head for head, frames in source["branches"].items()
            if head in end_cut["branches"].get(source["scope"], set())
            and all(frame["frame_hash"] in selected for frame in frames)
        }
        for source in root["sources"].values()
    }
    cut = {"selected": selected, "branches": branches}
    validate_closed_cut(root, cut)
    return cut


def branch_delta(root, end_cut, from_cut):
    result = []
    for source in sorted(root["sources"].values(), key=lambda item: item["scope"]):
        previous = from_cut["branches"].get(source["scope"], set())
        for head in sorted(end_cut["branches"].get(source["scope"], set()) - previous):
            result.append(head)
    return result


def origin(frame):
    payload = frame["payload"]
    root = payload["root"]
    scope = payload["scope"]
    owned = source_stream(root, scope)
    assert frame["stream_id"] in {owned, f"{root}:work"}
    return {
        "guid": root,
        "scope": scope,
        **frame_head(frame),
        "ownership": "source-owned" if frame["stream_id"] == owned else "legacy-root-stream",
    }


def provenance(frame):
    payload = frame["payload"]
    event = payload["event"]
    data = payload.get("data", {})
    if event.startswith("client."):
        kind = event.removeprefix("client.")
        content = data.get("content", {})
        references = content.get("evidence", []) if kind == "activity" \
            else content.get("references", []) if kind in {"evidence", "attention"} else []
        return unique([
            frame["frame_hash"],
            *data.get("causes", []),
            *data.get("viewParents", []),
            *(references if isinstance(references, list) else []),
        ])
    evidence = data.get("evidence", [])
    references = [value for value in evidence if isinstance(value, str) and HEX.fullmatch(value)] \
        if isinstance(evidence, list) else []
    return unique([frame["frame_hash"], *references])


def memory_head_hashes(root, cut):
    selected = cut["selected"]
    result = []
    root_chain = [frame for frame in root["memory"] if frame["frame_hash"] in selected]
    if root_chain:
        result.append(root_chain[-1]["frame_hash"])
    for source in sorted(root["sources"].values(), key=lambda item: item["key"]):
        chain = [frame for frame in source["frames"] if frame["frame_hash"] in selected]
        if chain:
            result.append(chain[-1]["frame_hash"])
    return result


def verify_state(point, root_id, scope, cursor):
    if point["state"] is None:
        assert point["stateDigest"] is None
        return 0
    assert R.H("rapp/1:particle", point["state"]) == point["stateDigest"]
    assert point["state"]["root"] == root_id
    assert point["state"]["scope"] == scope
    assert point["state"]["cursor"] == cursor
    return 1


def verify_page(page, trusted, roots, frames):
    assert trusted.get("schema") == INPUT_SCHEMA
    root_id = trusted["root"]
    scope = trusted["scope"]
    root = roots[root_id]
    request = trusted.get("request", {})
    limit = request.get("limit", MAX_STEPS)
    assert isinstance(limit, int) and 1 <= limit <= MAX_STEPS
    end_cut = cut_from_cursor(root, request["to"]) if "to" in request else full_cut(root)
    end_order = memory_order(root, end_cut["selected"])
    from_cut = cut_from_cursor(root, request["from"]) if "from" in request \
        else prefix_cut(root, end_cut, max(0, len(end_order) - limit))
    assert from_cut["selected"].issubset(end_cut["selected"])
    assert all(head in end_cut["branches"].get(source, set())
               for source, heads in from_cut["branches"].items() for head in heads)
    expected_from = cursor_for(root, from_cut)
    expected_to = cursor_for(root, end_cut)
    pending = [frame for frame in end_order if frame["frame_hash"] not in from_cut["selected"]]
    guest_policy = request.get("guest")
    selection = {
        "root": root_id,
        "scope": scope,
        "from": expected_from,
        "to": expected_to,
        "sourceFrameHashes": [frame["frame_hash"] for frame in pending],
        "guestPolicy": guest_policy,
        "guestEvidenceDigest": trusted.get("guestEvidenceDigest") if guest_policy is not None else None,
    }
    assert page["schema"] == "rapp-work.catch-up/1"
    assert page["root"] == root_id and page["scope"] == scope
    assert page["from"] == expected_from and page["to"] == expected_to
    assert page["selectionDigest"] == R.H("rapp/1:particle", selection)
    assert page["baseline"]["cursor"] == expected_from
    assert page["baseline"]["sourceFrameHashes"] == [
        root["body"][0]["frame_hash"], *memory_head_hashes(root, from_cut)
    ]
    checkpoints = verify_state(page["baseline"], root_id, scope, expected_from)
    guest_checkpoints = 0
    visible = set(trusted["visibleScopes"])
    assert scope in visible
    occurrence = 0
    cursor = expected_from
    state_only = False
    assert len(page["steps"]) <= limit
    for step in page["steps"]:
        assert step["previousCursor"] == cursor
        if step["stepKind"] == "occurrence":
            assert not state_only and occurrence < len(pending)
            frame = pending[occurrence]
            occurrence += 1
            after = advance_cut(root, from_cut, end_cut, pending, occurrence)
            cursor = cursor_for(root, after)
            is_visible = frame["payload"]["scope"] in visible
            assert step["cursor"] == cursor
            assert step["event"] == (frame["payload"]["event"] if is_visible else "scoped-record-unavailable")
            assert step["origin"] == (origin(frame) if is_visible else None)
            if step.get("guest") is None:
                assert step["sourceFrameHashes"] == (provenance(frame) if is_visible else [frame["frame_hash"]])
            else:
                assert frame["frame_hash"] in step["sourceFrameHashes"]
        else:
            assert step["stepKind"] == "state-only"
            assert not state_only and occurrence == len(pending) and cursor != expected_to
            assert step["event"] == "retained-source-branches-changed"
            assert step["workGrade"] == "unavailable"
            assert step["origin"] is None
            assert step["sourceFrameHashes"] == branch_delta(root, end_cut, from_cut)
            cursor = expected_to
            assert step["cursor"] == cursor
            state_only = True
        checkpoints += verify_state(step, root_id, scope, cursor)
        for source in step["sourceFrameHashes"]:
            assert source in frames, f"Missing exact source frame {source}"
        if step.get("guest") is not None:
            assert R.H("rapp/1:particle", step["guest"]) == step["guestDigest"]
            guest_checkpoints += 1
        else:
            assert step["guestDigest"] is None
    assert page["next"] == cursor
    expected_more = occurrence < len(pending) or cursor != expected_to
    assert page["more"] is expected_more
    if not page["more"]:
        assert page["next"] == page["to"]
    expected_grades = {
        grade: sum(step["grade"] == grade for step in page["steps"])
        for grade in ["recorded", "reconstructed", "unavailable"]
    }
    assert page["grades"] == expected_grades
    expected_timeline = trusted["trustedTimelineDigest"]
    assert HEX.fullmatch(expected_timeline)
    assert page["timelineDigest"] == expected_timeline
    payload = {key: value for key, value in page.items() if key != "timelineDigest"}
    assert R.H("rapp/1:particle", payload) == expected_timeline
    for point in [page["baseline"], *page["steps"]]:
        for source in point["sourceFrameHashes"]:
            assert source in frames, f"Missing exact source frame {source}"
    return checkpoints, guest_checkpoints


def main():
    assert len(sys.argv) >= 4, \
        "usage: check-replay-digests.py REPLAY_JSON TRUSTED_INPUT_JSON CANONICAL_DIRECTORY [EVIDENCE_DIRECTORY ...]"
    pages = json.loads(pathlib.Path(sys.argv[1]).read_bytes())
    trusted = json.loads(pathlib.Path(sys.argv[2]).read_bytes())
    assert trusted.get("schema") == MANIFEST_SCHEMA and isinstance(trusted.get("pages"), list)
    assert len(pages) == len(trusted["pages"])
    roots, frames = load_evidence(sys.argv[3], sys.argv[4:])
    checkpoints = 0
    guest_checkpoints = 0
    for page, inputs in zip(pages, trusted["pages"]):
        checked, guests = verify_page(page, inputs, roots, frames)
        checkpoints += checked
        guest_checkpoints += guests
    print(json.dumps({
        "verifier": "canonical frames + explicit trusted request and timeline digest pins; unmodified rapp.py H(rapp/1:particle, value)",
        "pages": len(pages),
        "stateCheckpoints": checkpoints,
        "guestCheckpoints": guest_checkpoints,
        "sourceFrames": len(frames),
        "originsReconstructed": True,
        "cursorsReconstructed": True,
        "selectionReconstructed": True,
        "timelineDigestsPinnedAndReconstructed": True,
        "sourceReferencesVerified": True,
        "writes": 0,
        "modelCalls": 0,
        "toolExecutions": 0,
    }, indent=2))


if __name__ == "__main__":
    main()
