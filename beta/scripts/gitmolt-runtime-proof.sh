#!/usr/bin/env bash
# Prove git-molt can evolve a live copied Brainstem without killing it.
# shellcheck disable=SC2034,SC2317,SC2329

set -u

SCRIPT_DIR=$(CDPATH='' cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd "$SCRIPT_DIR/../.." && pwd)
BETA_ROOT=$(CDPATH='' cd "$SCRIPT_DIR/.." && pwd)
GIT_MOLT=${GIT_MOLT:-"$BETA_ROOT/tools/git-molt/bin/git-molt"}
MOLTER_GATE="$SCRIPT_DIR/molter-gate.py"
BRAINSTEM_PYTHON=${BRAINSTEM_PYTHON:-"$HOME/.brainstem/venv/bin/python"}
RAPP_SKILLS_REF=${RAPP_SKILLS_REF:-312617f8479e28c654897d713141573a191d6552}

for command_name in git curl; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
        printf 'FAIL: required command is unavailable: %s\n' "$command_name" >&2
        exit 2
    fi
done
if [ ! -x "$GIT_MOLT" ]; then
    printf 'FAIL: git-molt is not executable: %s\n' "$GIT_MOLT" >&2
    exit 2
fi
if [ ! -x "$MOLTER_GATE" ]; then
    printf 'FAIL: Molter gate is not executable: %s\n' "$MOLTER_GATE" >&2
    exit 2
fi
if [ ! -x "$BRAINSTEM_PYTHON" ]; then
    printf 'FAIL: Brainstem Python is not executable: %s\n' "$BRAINSTEM_PYTHON" >&2
    exit 2
fi
if ! "$BRAINSTEM_PYTHON" -c "import flask" >/dev/null 2>&1; then
    printf 'FAIL: Brainstem Python cannot import Flask: %s\n' "$BRAINSTEM_PYTHON" >&2
    exit 2
fi

SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/gitmolt-runtime.XXXXXX") || exit 2
RESULTS="$SCRATCH/results.tsv"
PRIMARY_PID=""
SECONDARY_PID=""
FAILURES=0
OBSERVATION_NUMBER=0
LAST_HEALTH_OK=1
LAST_HEARTBEAT="dead"
LAST_STATUS="unreachable"
LAST_AGENTS=""
LAST_QUARANTINE="unavailable"
LAST_OBSERVATION=""

# Invoked by the EXIT/signal traps below.
# shellcheck disable=SC2317,SC2329
cleanup() {
    cleanup_status=$?
    trap - EXIT
    for cleanup_pid in "$SECONDARY_PID" "$PRIMARY_PID"; do
        if [ -n "$cleanup_pid" ] && kill -0 "$cleanup_pid" 2>/dev/null; then
            kill "$cleanup_pid" 2>/dev/null || true
            wait "$cleanup_pid" 2>/dev/null || true
        fi
    done
    case "$(basename "$SCRATCH")" in
        gitmolt-runtime.*) rm -rf "$SCRATCH" ;;
    esac
    exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

one_line() {
    printf '%s' "$1" | tr '\n\t|' '   '
}

record_claim() {
    claim_name=$(one_line "$1")
    claim_code=$2
    claim_evidence=$(one_line "$3")
    if [ "$claim_code" -eq 0 ]; then
        claim_result="PASS"
    else
        claim_result="FAIL"
        FAILURES=$((FAILURES + 1))
    fi
    printf '%s\t%s\t%s\n' "$claim_name" "$claim_result" "$claim_evidence" >>"$RESULTS"
}

finish_proof() {
    printf '\n## PASS/FAIL table\n\n'
    printf '| Claim | Result | Evidence |\n'
    printf '|---|---|---|\n'
    awk -F '\t' '{printf "| %s | %s | %s |\n", $1, $2, $3}' "$RESULTS"
    printf '\nSummary: %s claim(s), %s failure(s)\n' \
        "$(wc -l <"$RESULTS" | tr -d ' ')" "$FAILURES"
    if [ "$FAILURES" -ne 0 ]; then
        exit 1
    fi
    exit 0
}

abort_proof() {
    record_claim "$1" 1 "$2"
    finish_proof
}

molt_at() {
    molt_repo=$1
    shift
    GIT_MOLT_DIR="$molt_repo" "$GIT_MOLT" "$@"
}

verify_at() {
    verify_repo=$1
    verify_grail=$2
    verify_locus=$3
    verify_ring=$4
    MOLTER_GRAIL="$verify_grail" \
        GIT_MOLT_VERIFIER="$MOLTER_GATE" \
        GIT_MOLT_DIR="$verify_repo" \
        "$GIT_MOLT" verify "$verify_locus" "$verify_ring"
}

direct_gate() {
    gate_grail=$1
    gate_source=$2
    MOLTER_GRAIL="$gate_grail" "$MOLTER_GATE" <"$gate_source"
}

free_port() {
    "$BRAINSTEM_PYTHON" -c \
        'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

start_kernel() {
    kernel_body=$1
    kernel_agents=$2
    kernel_port=$3
    kernel_home=$4
    kernel_log=$5
    (
        cd "$kernel_body" || exit 1
        exec env \
            AGENTS_PATH="$kernel_agents" \
            PORT="$kernel_port" \
            HOME="$kernel_home" \
            GH_CONFIG_DIR="$kernel_home/gh" \
            GITHUB_TOKEN= \
            PYTHONDONTWRITEBYTECODE=1 \
            PYTHONUNBUFFERED=1 \
            "$BRAINSTEM_PYTHON" brainstem.py
    ) >"$kernel_log" 2>&1 &
    STARTED_PID=$!
}

wait_for_health() {
    wait_port=$1
    wait_pid=$2
    wait_count=0
    while [ "$wait_count" -lt 60 ]; do
        if ! kill -0 "$wait_pid" 2>/dev/null; then
            return 1
        fi
        if curl -fsS --connect-timeout 1 --max-time 3 \
            "http://127.0.0.1:$wait_port/health" >/dev/null 2>&1; then
            return 0
        fi
        wait_count=$((wait_count + 1))
        sleep 0.25
    done
    return 1
}

observe() {
    observe_label=$1
    observe_port=$2
    observe_pid=$3
    OBSERVATION_NUMBER=$((OBSERVATION_NUMBER + 1))
    observe_file="$SCRATCH/health-$OBSERVATION_NUMBER.json"

    LAST_HEALTH_OK=1
    if curl -fsS --connect-timeout 1 --max-time 5 \
        "http://127.0.0.1:$observe_port/health" >"$observe_file" 2>/dev/null; then
        LAST_STATUS=$(
            "$BRAINSTEM_PYTHON" -c \
                'import json,sys; print(json.load(open(sys.argv[1])).get("status", "missing"))' \
                "$observe_file" 2>/dev/null
        ) || LAST_STATUS="invalid-json"
        LAST_AGENTS=$(
            "$BRAINSTEM_PYTHON" -c \
                'import json,sys; print(",".join(sorted(json.load(open(sys.argv[1])).get("agents", []))))' \
                "$observe_file" 2>/dev/null
        ) || LAST_AGENTS=""
        LAST_QUARANTINE=$(
            "$BRAINSTEM_PYTHON" -c \
                'import json,sys; q=json.load(open(sys.argv[1])).get("quarantined", []); print("none" if not q else ";".join("{}:{}".format(x.get("file", "?"), x.get("reason", "?")) for x in q))' \
                "$observe_file" 2>/dev/null
        ) || LAST_QUARANTINE="invalid-json"
        if [ "$LAST_STATUS" = "invalid-json" ]; then
            LAST_HEALTH_OK=1
        else
            LAST_HEALTH_OK=0
        fi
    else
        LAST_STATUS="unreachable"
        LAST_AGENTS=""
        LAST_QUARANTINE="unavailable"
    fi

    if kill -0 "$observe_pid" 2>/dev/null; then
        LAST_HEARTBEAT="alive"
    else
        LAST_HEARTBEAT="dead"
    fi
    LAST_OBSERVATION="pulse(status=$LAST_STATUS agents=[$LAST_AGENTS] quarantined=$LAST_QUARANTINE); heartbeat=$LAST_HEARTBEAT"
    printf 'OBSERVE %-24s %s\n' "$observe_label" "$LAST_OBSERVATION"
}

runtime_is_alive() {
    [ "$LAST_HEALTH_OK" -eq 0 ] && [ "$LAST_HEARTBEAT" = "alive" ]
}

is_exact_addition() {
    base_csv=$1
    grown_csv=$2
    added_name=$3
    "$BRAINSTEM_PYTHON" -c \
        'import sys; before=set(filter(None,sys.argv[1].split(","))); after=set(filter(None,sys.argv[2].split(","))); raise SystemExit(0 if after == before | {sys.argv[3]} and sys.argv[3] not in before else 1)' \
        "$base_csv" "$grown_csv" "$added_name"
}

factory_files_match() {
    source_dir=$1
    composed_dir=$2
    source_count=0
    composed_count=0
    for source_file in "$source_dir"/*_agent.py; do
        [ -f "$source_file" ] || continue
        source_count=$((source_count + 1))
        if ! cmp -s "$source_file" "$composed_dir/$(basename "$source_file")"; then
            return 1
        fi
    done
    for composed_file in "$composed_dir"/*_agent.py; do
        [ -f "$composed_file" ] || continue
        composed_count=$((composed_count + 1))
    done
    [ "$source_count" -eq "$composed_count" ]
}

write_good_generation() {
    generation_file=$1
    generation_marker=$2
    generation_result=$3
    cat >"$generation_file" <<PY
from agents.basic_agent import BasicAgent


class HelloRapp(BasicAgent):
    def __init__(self):
        self.name = "HelloRapp"
        self.metadata = {
            "name": self.name,
            "description": "$generation_marker",
            "parameters": {
                "type": "object",
                "properties": {
                    "person": {"type": "string", "description": "Name to greet."}
                },
                "required": ["person"],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return "$generation_result"
PY
}

scramble_attempt() {
    scramble_label=$1
    scramble_source=$2
    expected_lesson=$3

    scramble_ok=0
    scramble_ring=$(molt_at "$PRIMARY_MOLT" record "$AGENT_LOCUS" "$scramble_source" 2>&1)
    scramble_record_rc=$?
    scramble_lesson=$(direct_gate "$PRIMARY_BODY" "$scramble_source" 2>&1)
    scramble_gate_rc=$?
    verify_at "$PRIMARY_MOLT" "$PRIMARY_BODY" \
        "$AGENT_LOCUS" "$scramble_ring" >/dev/null 2>&1
    scramble_verify_rc=$?
    molt_at "$PRIMARY_MOLT" activate \
        "$AGENT_LOCUS" "$scramble_ring" >/dev/null 2>&1
    scramble_activate_rc=$?
    molt_at "$PRIMARY_MOLT" compose "$PRIMARY_AGENTS" >/dev/null 2>&1
    scramble_compose_rc=$?
    observe "$scramble_label" "$PRIMARY_PORT" "$PRIMARY_PID"

    if [ "$scramble_record_rc" -ne 0 ] \
        || [ "$scramble_gate_rc" -eq 0 ] \
        || [ "$scramble_verify_rc" -eq 0 ] \
        || [ "$scramble_activate_rc" -eq 0 ] \
        || [ "$scramble_compose_rc" -ne 0 ] \
        || ! printf '%s' "$scramble_lesson" | grep -F "$expected_lesson" >/dev/null 2>&1 \
        || ! cmp -s "$ACTIVE_GOOD_SOURCE" "$PRIMARY_AGENTS/hello_rapp_agent.py" \
        || [ "$LAST_AGENTS" != "$GROWN_AGENTS" ] \
        || [ "$LAST_QUARANTINE" != "none" ] \
        || ! runtime_is_alive; then
        scramble_ok=1
    fi
    record_claim "scramble refused: $scramble_label" "$scramble_ok" \
        "Molter: $scramble_lesson; verify_rc=$scramble_verify_rc; activate_rc=$scramble_activate_rc; $LAST_OBSERVATION"
}

PRIMARY_BODY="$SCRATCH/runtime-one"
PRIMARY_AGENTS="$SCRATCH/agents-one"
PRIMARY_MOLT="$SCRATCH/molt-one.git"
PRIMARY_HOME="$SCRATCH/home-one"
mkdir -p "$PRIMARY_AGENTS" "$PRIMARY_HOME"
if ! cp -R "$REPO_ROOT/rapp_brainstem" "$PRIMARY_BODY"; then
    abort_proof "scratch runtime" "could not copy rapp_brainstem"
fi
if ! molt_at "$PRIMARY_MOLT" init >/dev/null 2>&1; then
    abort_proof "git-molt init" "could not initialize the primary molt repository"
fi

PRIMARY_PORT=$(free_port) || abort_proof "free loopback port" "could not allocate a port"
start_kernel "$PRIMARY_BODY" "$PRIMARY_AGENTS" "$PRIMARY_PORT" \
    "$PRIMARY_HOME" "$SCRATCH/kernel-one.log"
PRIMARY_PID=$STARTED_PID
if ! wait_for_health "$PRIMARY_PORT" "$PRIMARY_PID"; then
    kernel_tail=$(tail -30 "$SCRATCH/kernel-one.log" 2>/dev/null || true)
    abort_proof "running copied kernel" "kernel did not answer /health: $kernel_tail"
fi
observe "initialized" "$PRIMARY_PORT" "$PRIMARY_PID"
kernel_start_ok=0
runtime_is_alive || kernel_start_ok=1
record_claim "copied kernel starts without sign-in" "$kernel_start_ok" "$LAST_OBSERVATION"

HN_LOCUS=""
FACTORY_BASELINE_COUNT=0
for factory_source in "$PRIMARY_BODY"/agents/*_agent.py; do
    [ -f "$factory_source" ] || continue
    factory_name=$(basename "$factory_source")
    factory_locus=$(molt_at "$PRIMARY_MOLT" baseline \
        "$factory_name" "$factory_source" 2>&1)
    factory_rc=$?
    if [ "$factory_rc" -ne 0 ]; then
        abort_proof "factory baselines" "$factory_name failed: $factory_locus"
    fi
    FACTORY_BASELINE_COUNT=$((FACTORY_BASELINE_COUNT + 1))
    if [ "$factory_name" = "hacker_news_agent.py" ]; then
        HN_LOCUS=$factory_locus
    fi
done
if ! molt_at "$PRIMARY_MOLT" compose "$PRIMARY_AGENTS" >/dev/null 2>&1; then
    abort_proof "factory compose" "git-molt compose returned non-zero"
fi
observe "factory-baseline" "$PRIMARY_PORT" "$PRIMARY_PID"
FACTORY_AGENTS=$LAST_AGENTS
factory_ok=0
if [ "$FACTORY_BASELINE_COUNT" -eq 0 ] \
    || [ -z "$HN_LOCUS" ] \
    || [ -z "$FACTORY_AGENTS" ] \
    || ! factory_files_match "$PRIMARY_BODY/agents" "$PRIMARY_AGENTS" \
    || [ "$LAST_QUARANTINE" != "none" ] \
    || ! runtime_is_alive; then
    factory_ok=1
fi
record_claim "factory agents compose exactly" "$factory_ok" \
    "$FACTORY_BASELINE_COUNT byte-identical loci; tools=[$FACTORY_AGENTS]; $LAST_OBSERVATION"

if [ -n "${RAPP_SKILLS_DIR:-}" ]; then
    CORPUS_DIR=$RAPP_SKILLS_DIR
    if [ ! -d "$CORPUS_DIR" ]; then
        abort_proof "RAPP skills corpus" "RAPP_SKILLS_DIR is not a directory: $CORPUS_DIR"
    fi
else
    CORPUS_DIR="$SCRATCH/rapp-skills"
    if ! git clone --depth 1 --quiet \
        https://github.com/kody-w/rapp-skills "$CORPUS_DIR" 2>"$SCRATCH/clone.err"; then
        abort_proof "RAPP skills corpus" "git clone failed: $(cat "$SCRATCH/clone.err")"
    fi
    if ! git -C "$CORPUS_DIR" fetch --depth 1 --quiet \
        origin "$RAPP_SKILLS_REF" 2>"$SCRATCH/fetch.err" \
        || ! git -C "$CORPUS_DIR" checkout --detach --quiet FETCH_HEAD \
            2>"$SCRATCH/checkout.err"; then
        abort_proof "RAPP skills corpus" \
            "could not select pinned commit $RAPP_SKILLS_REF: $(cat "$SCRATCH/fetch.err" "$SCRATCH/checkout.err" 2>/dev/null)"
    fi
fi
CORPUS_AGENT="$CORPUS_DIR/cat-agent-skills/rapp-agent-converter/assets/hello_rapp_agent.py"
if [ ! -f "$CORPUS_AGENT" ]; then
    abort_proof "RAPP skills agent" "missing corpus cartridge: cat-agent-skills/rapp-agent-converter/assets/hello_rapp_agent.py"
fi
CORPUS_COMMIT=$(git -C "$CORPUS_DIR" rev-parse --short=12 HEAD 2>/dev/null || printf 'provided-tree')
CORPUS_GATE=$(direct_gate "$PRIMARY_BODY" "$CORPUS_AGENT" 2>&1)
CORPUS_GATE_RC=$?
"$BRAINSTEM_PYTHON" -c \
    'import ast,sys; tree=ast.parse(open(sys.argv[1], encoding="utf-8").read()); roots=set(); [(roots.update(a.name.split(".")[0] for a in n.names) if isinstance(n,ast.Import) else roots.add((n.module or "").split(".")[0])) for n in ast.walk(tree) if isinstance(n,(ast.Import,ast.ImportFrom))]; roots.discard(""); allowed=set(sys.stdlib_module_names)|{"agents"}; unknown=sorted(roots-allowed); print(",".join(unknown)); raise SystemExit(bool(unknown))' \
    "$CORPUS_AGENT" >"$SCRATCH/non-stdlib.txt" 2>&1
STDLIB_RC=$?
STDLIB_UNKNOWN=$(cat "$SCRATCH/non-stdlib.txt")
AGENT_LOCUS=$(molt_at "$PRIMARY_MOLT" baseline \
    "hello_rapp_agent.py" "$CORPUS_AGENT" 2>&1)
AGENT_BASELINE_RC=$?
molt_at "$PRIMARY_MOLT" compose "$PRIMARY_AGENTS" >/dev/null 2>&1
AGENT_COMPOSE_RC=$?
observe "absorbed-corpus" "$PRIMARY_PORT" "$PRIMARY_PID"
GROWN_AGENTS=$LAST_AGENTS
absorb_ok=0
if [ "$CORPUS_GATE_RC" -ne 0 ] \
    || [ "$STDLIB_RC" -ne 0 ] \
    || [ "$AGENT_BASELINE_RC" -ne 0 ] \
    || [ "$AGENT_COMPOSE_RC" -ne 0 ] \
    || ! is_exact_addition "$FACTORY_AGENTS" "$GROWN_AGENTS" "HelloRapp" \
    || ! cmp -s "$CORPUS_AGENT" "$PRIMARY_AGENTS/hello_rapp_agent.py" \
    || [ "$LAST_QUARANTINE" != "none" ] \
    || ! runtime_is_alive; then
    absorb_ok=1
fi
record_claim "runtime absorbs one stdlib RAPPID agent" "$absorb_ok" \
    "rapp-skills@$CORPUS_COMMIT; $CORPUS_GATE; non_stdlib=[$STDLIB_UNKNOWN]; tools=[$GROWN_AGENTS]; $LAST_OBSERVATION"

CANDIDATES="$SCRATCH/candidates"
mkdir -p "$CANDIDATES"
GOOD_V2="$CANDIDATES/hello-v2.py"
write_good_generation "$GOOD_V2" "GIT_MOLT_GENERATION_V2" "hello-rapp-v2"
GOOD_RING=$(molt_at "$PRIMARY_MOLT" record "$AGENT_LOCUS" "$GOOD_V2" 2>&1)
GOOD_RECORD_RC=$?
GOOD_VRING=$(verify_at "$PRIMARY_MOLT" "$PRIMARY_BODY" \
    "$AGENT_LOCUS" "$GOOD_RING" 2>&1)
GOOD_VERIFY_RC=$?
molt_at "$PRIMARY_MOLT" activate \
    "$AGENT_LOCUS" "$GOOD_VRING" >/dev/null 2>&1
GOOD_ACTIVATE_RC=$?
molt_at "$PRIMARY_MOLT" compose "$PRIMARY_AGENTS" >/dev/null 2>&1
GOOD_COMPOSE_RC=$?
observe "grown-v2" "$PRIMARY_PORT" "$PRIMARY_PID"
ACTIVE_GOOD_SOURCE=$GOOD_V2
grow_ok=0
if [ "$GOOD_RECORD_RC" -ne 0 ] \
    || [ "$GOOD_VERIFY_RC" -ne 0 ] \
    || [ "$GOOD_ACTIVATE_RC" -ne 0 ] \
    || [ "$GOOD_COMPOSE_RC" -ne 0 ] \
    || ! cmp -s "$GOOD_V2" "$PRIMARY_AGENTS/hello_rapp_agent.py" \
    || ! grep -F "GIT_MOLT_GENERATION_V2" \
        "$PRIMARY_AGENTS/hello_rapp_agent.py" >/dev/null 2>&1 \
    || [ "$LAST_AGENTS" != "$GROWN_AGENTS" ] \
    || ! runtime_is_alive; then
    grow_ok=1
fi
record_claim "verified generation grows live runtime" "$grow_ok" \
    "recorded, Molter-verified, activated; marker=GIT_MOLT_GENERATION_V2; $LAST_OBSERVATION"

LETHAL="$CANDIDATES/lethal.py"
cat >"$LETHAL" <<'PY'
import os
from agents.basic_agent import BasicAgent

os._exit(0)

class HelloRapp(BasicAgent):
    metadata = {"name": "HelloRapp", "parameters": {"type": "object", "properties": {}}}
    def perform(self, **kwargs):
        return "never"
PY

NONFUNCTIONAL="$CANDIDATES/nonfunctional.py"
cat >"$NONFUNCTIONAL" <<'PY'
from agents.basic_agent import BasicAgent

class HelloRapp(BasicAgent):
    metadata = {"name": "HelloRapp", "parameters": {"type": "object", "properties": {}}}
PY

SYNTAX_ERROR="$CANDIDATES/syntax-error.py"
cat >"$SYNTAX_ERROR" <<'PY'
from agents.basic_agent import BasicAgent

class HelloRapp(BasicAgent)
    def perform(self, **kwargs):
        return "never"
PY

IMPORT_EXCEPTION="$CANDIDATES/import-exception.py"
cat >"$IMPORT_EXCEPTION" <<'PY'
from agents.basic_agent import BasicAgent

class HelloRapp(BasicAgent):
    metadata = {"name": "HelloRapp", "parameters": {"type": "object", "properties": {}}}
    def perform(self, **kwargs):
        return "never"

raise RuntimeError("GIT_MOLT_IMPORT_BOOM")
PY

DECOY="$CANDIDATES/decoy.py"
cat >"$DECOY" <<'PY'
BasicAgent = object

class HelloRapp(BasicAgent):
    metadata = {"name": "HelloRapp", "parameters": {"type": "object", "properties": {}}}
    def perform(self, **kwargs):
        return "decoy"
PY

scramble_attempt "lethal-os-exit" "$LETHAL" "terminate the Brainstem"
scramble_attempt "nonfunctional-no-perform" "$NONFUNCTIONAL" "does not define perform()"
scramble_attempt "syntax-error" "$SYNTAX_ERROR" "SyntaxError"
scramble_attempt "import-exception" "$IMPORT_EXCEPTION" "failed to load cleanly"
scramble_attempt "decoy-basic-agent" "$DECOY" "imported from agents.basic_agent"

COLLISION="$CANDIDATES/collision.py"
cat >"$COLLISION" <<'PY'
from agents.basic_agent import BasicAgent

class HelloRapp(BasicAgent):
    def __init__(self):
        self.name = "HackerNews"
        self.metadata = {
            "name": self.name,
            "description": "GIT_MOLT_VALID_COLLISION",
            "parameters": {"type": "object", "properties": {}},
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return "collision"
PY
COLLISION_GATE=$(direct_gate "$PRIMARY_BODY" "$COLLISION" 2>&1)
COLLISION_GATE_RC=$?
COLLISION_RING=$(molt_at "$PRIMARY_MOLT" record \
    "$AGENT_LOCUS" "$COLLISION" 2>&1)
COLLISION_RECORD_RC=$?
COLLISION_VRING=$(verify_at "$PRIMARY_MOLT" "$PRIMARY_BODY" \
    "$AGENT_LOCUS" "$COLLISION_RING" 2>&1)
COLLISION_VERIFY_RC=$?
molt_at "$PRIMARY_MOLT" activate \
    "$AGENT_LOCUS" "$COLLISION_VRING" >/dev/null 2>&1
COLLISION_ACTIVATE_RC=$?
molt_at "$PRIMARY_MOLT" compose "$PRIMARY_AGENTS" >/dev/null 2>&1
COLLISION_COMPOSE_RC=$?
observe "valid-name-collision" "$PRIMARY_PORT" "$PRIMARY_PID"
COLLISION_OBSERVATION=$LAST_OBSERVATION
collision_ok=0
if [ "$COLLISION_GATE_RC" -ne 0 ] \
    || [ "$COLLISION_RECORD_RC" -ne 0 ] \
    || [ "$COLLISION_VERIFY_RC" -ne 0 ] \
    || [ "$COLLISION_ACTIVATE_RC" -ne 0 ] \
    || [ "$COLLISION_COMPOSE_RC" -ne 0 ] \
    || [ "$LAST_AGENTS" != "$FACTORY_AGENTS" ] \
    || ! printf '%s' "$LAST_QUARANTINE" | grep -F \
        "duplicate agent name 'HackerNews'" >/dev/null 2>&1 \
    || ! runtime_is_alive; then
    collision_ok=1
fi

RECOVERY_V3="$CANDIDATES/hello-v3.py"
write_good_generation "$RECOVERY_V3" \
    "GIT_MOLT_RECOVERY_V3" "hello-rapp-v3-recovered"
RECOVERY_RING=$(molt_at "$PRIMARY_MOLT" record \
    "$AGENT_LOCUS" "$RECOVERY_V3" 2>&1)
RECOVERY_RECORD_RC=$?
RECOVERY_VRING=$(verify_at "$PRIMARY_MOLT" "$PRIMARY_BODY" \
    "$AGENT_LOCUS" "$RECOVERY_RING" 2>&1)
RECOVERY_VERIFY_RC=$?
molt_at "$PRIMARY_MOLT" activate \
    "$AGENT_LOCUS" "$RECOVERY_VRING" >/dev/null 2>&1
RECOVERY_ACTIVATE_RC=$?
molt_at "$PRIMARY_MOLT" compose "$PRIMARY_AGENTS" >/dev/null 2>&1
RECOVERY_COMPOSE_RC=$?
ACTIVE_GOOD_SOURCE=$RECOVERY_V3
observe "collision-recovery" "$PRIMARY_PORT" "$PRIMARY_PID"
if [ "$RECOVERY_RECORD_RC" -ne 0 ] \
    || [ "$RECOVERY_VERIFY_RC" -ne 0 ] \
    || [ "$RECOVERY_ACTIVATE_RC" -ne 0 ] \
    || [ "$RECOVERY_COMPOSE_RC" -ne 0 ] \
    || ! cmp -s "$RECOVERY_V3" "$PRIMARY_AGENTS/hello_rapp_agent.py" \
    || [ "$LAST_AGENTS" != "$GROWN_AGENTS" ] \
    || [ "$LAST_QUARANTINE" != "none" ] \
    || ! runtime_is_alive; then
    collision_ok=1
fi
record_claim "valid collision exposes gate/kernel disagreement" "$collision_ok" \
    "Molter accepted ($COLLISION_GATE); kernel quarantined the later duplicate ($COLLISION_OBSERVATION); recovered last good generation ($LAST_OBSERVATION)"

LOCUS_LOG=$(molt_at "$PRIMARY_MOLT" log "$AGENT_LOCUS" 2>&1)
LOCUS_LOG_RC=$?
printf '\n## Agent locus log\n%s\n\n' "$LOCUS_LOG"
observe "locus-log" "$PRIMARY_PORT" "$PRIMARY_PID"
log_ok=0
if [ "$LOCUS_LOG_RC" -ne 0 ] \
    || ! printf '%s' "$LOCUS_LOG" | grep -F "[ok]" >/dev/null 2>&1 \
    || ! printf '%s' "$LOCUS_LOG" | grep -F "[--]" >/dev/null 2>&1 \
    || ! runtime_is_alive; then
    log_ok=1
fi
record_claim "locus log retains good and refused history" "$log_ok" \
    "$(printf '%s\n' "$LOCUS_LOG" | wc -l | tr -d ' ') entries with verified and unverified rings; $LAST_OBSERVATION"

molt_at "$PRIMARY_MOLT" revert "$AGENT_LOCUS" >/dev/null 2>&1
REVERT_RC=$?
molt_at "$PRIMARY_MOLT" compose "$PRIMARY_AGENTS" >/dev/null 2>&1
REVERT_COMPOSE_RC=$?
observe "time-travel-revert" "$PRIMARY_PORT" "$PRIMARY_PID"
revert_ok=0
if [ "$REVERT_RC" -ne 0 ] \
    || [ "$REVERT_COMPOSE_RC" -ne 0 ] \
    || ! cmp -s "$CORPUS_AGENT" "$PRIMARY_AGENTS/hello_rapp_agent.py" \
    || [ "$LAST_AGENTS" != "$GROWN_AGENTS" ] \
    || ! runtime_is_alive; then
    revert_ok=1
fi
record_claim "revert returns to absorbed corpus baseline" "$revert_ok" \
    "composed bytes match hello_rapp_agent.py at rapp-skills@$CORPUS_COMMIT; $LAST_OBSERVATION"

molt_at "$PRIMARY_MOLT" restore "$AGENT_LOCUS" >/dev/null 2>&1
RESTORE_RC=$?
molt_at "$PRIMARY_MOLT" compose "$PRIMARY_AGENTS" >/dev/null 2>&1
RESTORE_COMPOSE_RC=$?
observe "time-travel-restore" "$PRIMARY_PORT" "$PRIMARY_PID"
restore_ok=0
if [ "$RESTORE_RC" -ne 0 ] \
    || [ "$RESTORE_COMPOSE_RC" -ne 0 ] \
    || ! cmp -s "$RECOVERY_V3" "$PRIMARY_AGENTS/hello_rapp_agent.py" \
    || ! runtime_is_alive; then
    restore_ok=1
fi
record_claim "restore selects newest verified safe generation" "$restore_ok" \
    "marker=GIT_MOLT_RECOVERY_V3; $LAST_OBSERVATION"

molt_at "$PRIMARY_MOLT" policy "$AGENT_LOCUS" pinned >/dev/null 2>&1
PIN_RC=$?
molt_at "$PRIMARY_MOLT" compose "$PRIMARY_AGENTS" >/dev/null 2>&1
PIN_COMPOSE_RC=$?
observe "policy-pinned" "$PRIMARY_PORT" "$PRIMARY_PID"
pin_ok=0
if [ "$PIN_RC" -ne 0 ] \
    || [ "$PIN_COMPOSE_RC" -ne 0 ] \
    || ! cmp -s "$CORPUS_AGENT" "$PRIMARY_AGENTS/hello_rapp_agent.py" \
    || ! runtime_is_alive; then
    pin_ok=1
fi
record_claim "pinned policy forces baseline" "$pin_ok" \
    "newer verified rings retained but baseline bytes composed; $LAST_OBSERVATION"

molt_at "$PRIMARY_MOLT" policy "$AGENT_LOCUS" mutable >/dev/null 2>&1
MUTABLE_RC=$?
molt_at "$PRIMARY_MOLT" restore "$AGENT_LOCUS" >/dev/null 2>&1
MUTABLE_RESTORE_RC=$?
molt_at "$PRIMARY_MOLT" compose "$PRIMARY_AGENTS" >/dev/null 2>&1
MUTABLE_COMPOSE_RC=$?
observe "policy-mutable" "$PRIMARY_PORT" "$PRIMARY_PID"
mutable_ok=0
if [ "$MUTABLE_RC" -ne 0 ] \
    || [ "$MUTABLE_RESTORE_RC" -ne 0 ] \
    || [ "$MUTABLE_COMPOSE_RC" -ne 0 ] \
    || ! cmp -s "$RECOVERY_V3" "$PRIMARY_AGENTS/hello_rapp_agent.py" \
    || ! runtime_is_alive; then
    mutable_ok=1
fi
record_claim "mutable policy restores evolution" "$mutable_ok" \
    "newest verified safe bytes active again; $LAST_OBSERVATION"

TRANSFER_V4="$CANDIDATES/hello-v4-transfer.py"
write_good_generation "$TRANSFER_V4" \
    "GIT_MOLT_TRANSFER_V4" "hello-rapp-v4-transferred"
TRANSFER_RING=$(molt_at "$PRIMARY_MOLT" record \
    "$AGENT_LOCUS" "$TRANSFER_V4" 2>&1)
TRANSFER_RECORD_RC=$?
FRAME="$SCRATCH/hello-rapp.molt-frame"
molt_at "$PRIMARY_MOLT" frame export \
    "$AGENT_LOCUS" "$FRAME" >/dev/null 2>&1
FRAME_EXPORT_RC=$?
observe "frame-export" "$PRIMARY_PORT" "$PRIMARY_PID"
frame_export_ok=0
if [ "$TRANSFER_RECORD_RC" -ne 0 ] \
    || [ "$FRAME_EXPORT_RC" -ne 0 ] \
    || [ ! -s "$FRAME" ] \
    || ! cmp -s "$RECOVERY_V3" "$PRIMARY_AGENTS/hello_rapp_agent.py" \
    || ! runtime_is_alive; then
    frame_export_ok=1
fi
record_claim "frame exports full locus without changing live runtime" \
    "$frame_export_ok" "frame written; unverified transfer tip recorded; $LAST_OBSERVATION"

SECONDARY_BODY="$SCRATCH/runtime-two"
SECONDARY_AGENTS="$SCRATCH/agents-two"
SECONDARY_MOLT="$SCRATCH/molt-two.git"
SECONDARY_HOME="$SCRATCH/home-two"
mkdir -p "$SECONDARY_AGENTS" "$SECONDARY_HOME"
if ! cp -R "$REPO_ROOT/rapp_brainstem" "$SECONDARY_BODY"; then
    abort_proof "second runtime" "could not copy rapp_brainstem"
fi
if ! molt_at "$SECONDARY_MOLT" init >/dev/null 2>&1; then
    abort_proof "second molt repo" "could not initialize second molt repository"
fi
for second_factory in "$SECONDARY_BODY"/agents/*_agent.py; do
    [ -f "$second_factory" ] || continue
    second_name=$(basename "$second_factory")
    if ! molt_at "$SECONDARY_MOLT" baseline \
        "$second_name" "$second_factory" >/dev/null 2>&1; then
        abort_proof "second factory baselines" "$second_name failed"
    fi
done
molt_at "$SECONDARY_MOLT" frame import "$FRAME" >/dev/null 2>&1
FRAME_IMPORT_RC=$?
IMPORTED_LIVE=$(git --git-dir="$SECONDARY_MOLT" rev-parse \
    "refs/molt/live/$AGENT_LOCUS" 2>/dev/null)
IMPORTED_BASE=$(git --git-dir="$SECONDARY_MOLT" rev-parse \
    "refs/molt/base/$AGENT_LOCUS" 2>/dev/null)
molt_at "$SECONDARY_MOLT" activate \
    "$AGENT_LOCUS" "$RECOVERY_VRING" >/dev/null 2>&1
FOREIGN_VERIFIED_ACTIVATE_RC=$?
molt_at "$SECONDARY_MOLT" revert "$AGENT_LOCUS" >/dev/null 2>&1
IMPORTED_ACTIVATE=$(molt_at "$SECONDARY_MOLT" activate \
    "$AGENT_LOCUS" "$TRANSFER_RING" 2>&1)
IMPORTED_ACTIVATE_RC=$?
IMPORTED_PATH=$(
    git --git-dir="$SECONDARY_MOLT" config --get \
        "molt.locus.$AGENT_LOCUS.path" 2>/dev/null || true
)
observe "frame-import-primary-alive" "$PRIMARY_PORT" "$PRIMARY_PID"
# Spec invariant I1: imported is not trusted. A ring that carries a foreign
# `Molt-Verified: yes` trailer must NOT activate on the receiver until the
# receiver's own gate has run (the verdict ref is local and never travels).
foreign_trust_ok=0
if [ "$FOREIGN_VERIFIED_ACTIVATE_RC" -eq 0 ] \
    || ! runtime_is_alive; then
    foreign_trust_ok=1
fi
record_claim "a foreign verified trailer does not transfer authority" \
    "$foreign_trust_ok" \
    "receiver activate rc=$FOREIGN_VERIFIED_ACTIVATE_RC before local verification (want non-zero); $LAST_OBSERVATION"

# The frame carries the locus's agent path (refs/molt/meta/<locus>), so the
# receiver needs no hand rebinding; the unverified tip stays parked at base.
import_trust_ok=0
if [ "$FRAME_IMPORT_RC" -ne 0 ] \
    || [ "$IMPORTED_LIVE" != "$IMPORTED_BASE" ] \
    || [ "$IMPORTED_ACTIVATE_RC" -eq 0 ] \
    || [ "$IMPORTED_PATH" != "hello_rapp_agent.py" ] \
    || ! printf '%s' "$IMPORTED_ACTIVATE" | grep -F \
        "unverified generation" >/dev/null 2>&1 \
    || ! runtime_is_alive; then
    import_trust_ok=1
fi
record_claim "unverified transfer tip is parked and the frame carried its path" \
    "$import_trust_ok" \
    "activate rc=$IMPORTED_ACTIVATE_RC ($IMPORTED_ACTIVATE); imported path=${IMPORTED_PATH:-<missing>}; $LAST_OBSERVATION"

SECOND_GATE=$(direct_gate "$SECONDARY_BODY" "$TRANSFER_V4" 2>&1)
SECOND_GATE_RC=$?
SECOND_VRING=$(verify_at "$SECONDARY_MOLT" "$SECONDARY_BODY" \
    "$AGENT_LOCUS" "$TRANSFER_RING" 2>&1)
SECOND_VERIFY_RC=$?
molt_at "$SECONDARY_MOLT" activate \
    "$AGENT_LOCUS" "$SECOND_VRING" >/dev/null 2>&1
SECOND_ACTIVATE_RC=$?
molt_at "$SECONDARY_MOLT" compose "$SECONDARY_AGENTS" >/dev/null 2>&1
SECOND_COMPOSE_RC=$?
SECONDARY_PORT=$(free_port) || abort_proof "second loopback port" "could not allocate a port"
start_kernel "$SECONDARY_BODY" "$SECONDARY_AGENTS" "$SECONDARY_PORT" \
    "$SECONDARY_HOME" "$SCRATCH/kernel-two.log"
SECONDARY_PID=$STARTED_PID
if ! wait_for_health "$SECONDARY_PORT" "$SECONDARY_PID"; then
    kernel_tail=$(tail -30 "$SCRATCH/kernel-two.log" 2>/dev/null || true)
    abort_proof "second running kernel" "kernel did not answer /health: $kernel_tail"
fi
observe "second-runtime" "$SECONDARY_PORT" "$SECONDARY_PID"
SECOND_FILES=""
for second_file in "$SECONDARY_AGENTS"/*; do
    [ -f "$second_file" ] || continue
    if [ -n "$SECOND_FILES" ]; then
        SECOND_FILES="$SECOND_FILES,"
    fi
    SECOND_FILES="$SECOND_FILES$(basename "$second_file")"
done
SECOND_LOAD_NOTE=$(
    grep -E "hello_rapp_agent|HelloRapp" "$SCRATCH/kernel-two.log" 2>/dev/null \
        | tail -3 | tr '\n\t|' '   '
)
second_ok=0
if [ "$SECOND_GATE_RC" -ne 0 ] \
    || [ "$SECOND_VERIFY_RC" -ne 0 ] \
    || [ "$SECOND_ACTIVATE_RC" -ne 0 ] \
    || [ "$SECOND_COMPOSE_RC" -ne 0 ] \
    || ! cmp -s "$TRANSFER_V4" "$SECONDARY_AGENTS/hello_rapp_agent.py" \
    || ! grep -F "GIT_MOLT_TRANSFER_V4" \
        "$SECONDARY_AGENTS/hello_rapp_agent.py" >/dev/null 2>&1 \
    || ! is_exact_addition "$FACTORY_AGENTS" "$LAST_AGENTS" "HelloRapp" \
    || [ "$LAST_QUARANTINE" != "none" ] \
    || ! runtime_is_alive; then
    second_ok=1
fi
record_claim "same gate admits agent into second runtime" "$second_ok" \
    "$SECOND_GATE; files=[$SECOND_FILES]; marker=GIT_MOLT_TRANSFER_V4; loader=[$SECOND_LOAD_NOTE]; $LAST_OBSERVATION"

HN_RING_SOURCE="$CANDIDATES/hacker-news-ring.py"
cp "$PRIMARY_BODY/agents/hacker_news_agent.py" "$HN_RING_SOURCE"
printf '\n# GIT_MOLT_USER_RING_BEFORE_FACTORY_UPGRADE\n' >>"$HN_RING_SOURCE"
HN_RING=$(molt_at "$PRIMARY_MOLT" record \
    "$HN_LOCUS" "$HN_RING_SOURCE" 2>&1)
HN_RING_RC=$?
HN_VRING=$(verify_at "$PRIMARY_MOLT" "$PRIMARY_BODY" \
    "$HN_LOCUS" "$HN_RING" 2>&1)
HN_VERIFY_RC=$?
molt_at "$PRIMARY_MOLT" activate "$HN_LOCUS" "$HN_VRING" >/dev/null 2>&1
HN_ACTIVATE_RC=$?
molt_at "$PRIMARY_MOLT" compose "$PRIMARY_AGENTS" >/dev/null 2>&1
molt_at "$PRIMARY_MOLT" log "$HN_LOCUS" >/dev/null 2>&1
HN_PRE_LOG_RC=$?
observe "grail-user-ring" "$PRIMARY_PORT" "$PRIMARY_PID"

printf '\n# GIT_MOLT_CURRENT_FACTORY_UPGRADE\n' \
    >>"$PRIMARY_BODY/agents/hacker_news_agent.py"
HN_CURRENT_FACTORY="$PRIMARY_BODY/agents/hacker_news_agent.py"
HN_LOCUS_AFTER=$(molt_at "$PRIMARY_MOLT" baseline \
    "hacker_news_agent.py" "$HN_CURRENT_FACTORY" 2>&1)
HN_BASELINE_RC=$?
HN_POST_LOG=$(molt_at "$PRIMARY_MOLT" log "$HN_LOCUS" 2>&1)
HN_POST_LOG_RC=$?
HN_SHORT=$(printf '%s' "$HN_VRING" | cut -c1-12)
molt_at "$PRIMARY_MOLT" revert "$HN_LOCUS" >/dev/null 2>&1
HN_REVERT_RC=$?
molt_at "$PRIMARY_MOLT" compose "$PRIMARY_AGENTS" >/dev/null 2>&1
HN_COMPOSE_RC=$?
observe "grail-upgrade-revert" "$PRIMARY_PORT" "$PRIMARY_PID"
grail_upgrade_ok=0
if [ "$HN_RING_RC" -ne 0 ] \
    || [ "$HN_VERIFY_RC" -ne 0 ] \
    || [ "$HN_ACTIVATE_RC" -ne 0 ] \
    || [ "$HN_PRE_LOG_RC" -ne 0 ] \
    || [ "$HN_BASELINE_RC" -ne 0 ] \
    || [ "$HN_POST_LOG_RC" -ne 0 ] \
    || [ "$HN_REVERT_RC" -ne 0 ] \
    || [ "$HN_COMPOSE_RC" -ne 0 ] \
    || [ "$HN_LOCUS_AFTER" != "$HN_LOCUS" ] \
    || ! printf '%s' "$HN_POST_LOG" | grep -F "$HN_SHORT" >/dev/null 2>&1 \
    || ! cmp -s "$HN_CURRENT_FACTORY" \
        "$PRIMARY_AGENTS/hacker_news_agent.py" \
    || ! grep -F "GIT_MOLT_CURRENT_FACTORY_UPGRADE" \
        "$PRIMARY_AGENTS/hacker_news_agent.py" >/dev/null 2>&1 \
    || [ "$LAST_AGENTS" != "$GROWN_AGENTS" ] \
    || ! runtime_is_alive; then
    grail_upgrade_ok=1
fi
record_claim "Grail re-baseline preserves locus and rings" "$grail_upgrade_ok" \
    "locus=$HN_LOCUS unchanged; earlier verified ring $HN_SHORT retained; revert composed current factory marker; $LAST_OBSERVATION"

LIVE_AGENT=$(git --git-dir="$PRIMARY_MOLT" rev-parse \
    "refs/molt/live/$AGENT_LOCUS" 2>/dev/null)
OBJECT_PREFIX=$(printf '%s' "$LIVE_AGENT" | cut -c1-2)
OBJECT_SUFFIX=$(printf '%s' "$LIVE_AGENT" | cut -c3-)
LOOSE_OBJECT="$PRIMARY_MOLT/objects/$OBJECT_PREFIX/$OBJECT_SUFFIX"
tamper_write_rc=0
if [ -f "$LOOSE_OBJECT" ]; then
    chmod u+w "$LOOSE_OBJECT" 2>/dev/null || tamper_write_rc=$?
    if [ "$tamper_write_rc" -eq 0 ]; then
        : >"$LOOSE_OBJECT" || tamper_write_rc=$?
    fi
else
    tamper_write_rc=1
fi
FSCK_OUTPUT=$(git --git-dir="$PRIMARY_MOLT" fsck --no-progress 2>&1)
FSCK_RC=$?
molt_at "$PRIMARY_MOLT" compose "$PRIMARY_AGENTS" >/dev/null 2>&1
TAMPER_COMPOSE_RC=$?
observe "tampered-ring-fallback" "$PRIMARY_PORT" "$PRIMARY_PID"
tamper_ok=0
if [ "$tamper_write_rc" -ne 0 ] \
    || [ "$FSCK_RC" -eq 0 ] \
    || [ "$TAMPER_COMPOSE_RC" -ne 0 ] \
    || ! cmp -s "$CORPUS_AGENT" "$PRIMARY_AGENTS/hello_rapp_agent.py" \
    || [ "$LAST_AGENTS" != "$GROWN_AGENTS" ] \
    || ! runtime_is_alive; then
    tamper_ok=1
fi
FSCK_FIRST=$(printf '%s\n' "$FSCK_OUTPUT" | sed -n '1p')
if printf '%s' "$FSCK_OUTPUT" | grep -F "is empty" >/dev/null 2>&1; then
    FSCK_FIRST="reported the active loose object as empty"
fi
record_claim "tampered loose object is detected and contained" "$tamper_ok" \
    "git fsck rc=$FSCK_RC ($FSCK_FIRST); compose rc=$TAMPER_COMPOSE_RC fell back to agent baseline; $LAST_OBSERVATION"

observe "final-primary" "$PRIMARY_PORT" "$PRIMARY_PID"
final_primary_ok=0
runtime_is_alive || final_primary_ok=1
record_claim "primary runtime finishes alive" "$final_primary_ok" "$LAST_OBSERVATION"
observe "final-secondary" "$SECONDARY_PORT" "$SECONDARY_PID"
final_secondary_ok=0
runtime_is_alive || final_secondary_ok=1
record_claim "second runtime finishes alive" "$final_secondary_ok" "$LAST_OBSERVATION"

finish_proof
