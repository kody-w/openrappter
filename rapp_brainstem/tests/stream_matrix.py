#!/usr/bin/env python3
"""stream_matrix.py — acceptance harness for /chat/stream across EVERY model.

Kody's bar: streaming has to be solid across ALL models, and any model that
can't stream must still PASS by transparently falling back to non-streaming.

For each model the running rig advertises (GET /models) this harness:
  (a) sends a plain prompt via /chat/stream and asserts >=3 delta chunks arrived
      before the done event (unless the model fell back) and the final is non-empty;
  (b) sends a tool prompt ("get my latest hacker news") and asserts an 'agent'
      event fired and the final mentions a story — or that it cleanly reports;
and records, per model: streamed vs fell-back, chunk count, time-to-first-token,
total time, and any error. It prints a per-test detail table and a summary matrix.

Usage:
    python stream_matrix.py [BASE_URL]
    # default BASE_URL = http://127.0.0.1:7099

Exit code 0 iff every model PASSED (streaming OR fallback). Nothing is committed
or pushed — this is a read-only probe against a locally running rig.
"""

import json
import sys
import time

import requests

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:7099"

PLAIN_PROMPT = "In 2 to 3 sentences, explain what the brainstem does in the human body."
TOOL_PROMPT = "get my latest hacker news"

CONNECT_TIMEOUT = 20
SILENCE_TIMEOUT = 35   # >30s of no bytes == dead, matching call_copilot_stream's read ceiling
MIN_CHUNKS = 3

STORY_HINTS = ("point", "comment", "http", "news", "story", "hn", "ycombinator", "1.", "•", "- ")


def stream_chat(prompt):
    """POST /chat/stream and consume the SSE. Returns a result dict."""
    url = BASE + "/chat/stream"
    t0 = time.time()
    ttft = None
    chunks = 0
    agent_fired = False
    done = None
    error = None
    try:
        with requests.post(url, json={"user_input": prompt}, stream=True,
                           timeout=(CONNECT_TIMEOUT, SILENCE_TIMEOUT)) as r:
            if r.status_code != 200:
                return {"error": f"http {r.status_code}: {r.text[:160]}",
                        "ttft": None, "chunks": 0, "total": time.time() - t0,
                        "agent": False, "streamed": None, "final": ""}
            r.encoding = "utf-8"
            for line in r.iter_lines(decode_unicode=True):
                if not line or not line.startswith("data:"):
                    continue
                try:
                    evt = json.loads(line[5:].strip())
                except Exception:
                    continue
                etype = evt.get("type")
                if etype == "delta":
                    if ttft is None:
                        ttft = time.time() - t0
                    chunks += 1
                elif etype == "agent":
                    agent_fired = True
                elif etype == "done":
                    done = evt
                elif etype == "error":
                    error = evt.get("error", "stream error")
    except requests.exceptions.Timeout:
        error = error or "read/connect timeout (dead stream)"
    except Exception as e:
        error = error or f"{type(e).__name__}: {str(e)[:160]}"

    total = time.time() - t0
    final = (done or {}).get("response", "") or ""
    streamed = (done or {}).get("streamed") if done else None
    return {"error": error, "ttft": ttft, "chunks": chunks, "total": total,
            "agent": agent_fired, "streamed": streamed, "final": final,
            "model_used": (done or {}).get("model"), "requested": (done or {}).get("requested_model")}


def get_models():
    r = requests.get(BASE + "/models", timeout=30)
    r.raise_for_status()
    data = r.json()
    return data.get("models", []), data.get("current")


def set_model(model_id):
    r = requests.post(BASE + "/models/set", json={"model": model_id}, timeout=30)
    return r.status_code == 200, (r.json() if r.headers.get("content-type", "").startswith("application/json") else {})


def fmt_t(x):
    return f"{x:.2f}" if isinstance(x, (int, float)) else "-"


def main():
    print(f"\n=== stream_matrix.py — /chat/stream acceptance vs {BASE} ===\n")
    try:
        models, current = get_models()
    except Exception as e:
        print(f"FATAL: could not fetch /models from {BASE}: {e}")
        return 2
    if not models:
        print("FATAL: rig returned no models.")
        return 2

    print(f"Rig advertises {len(models)} model(s); current={current}. Restoring to 'auto' at the end.\n")

    detail_rows = []
    summary = []

    for m in models:
        mid = m.get("id")
        avail = m.get("available", True)
        ok_set, _ = set_model(mid)
        if not ok_set:
            summary.append({"model": mid, "avail": avail, "streams": "-", "fallback": "-",
                            "chunks": "-", "ttft": "-", "total": "-", "agent": "-",
                            "result": "SKIP(set failed)", "error": "could not select model"})
            detail_rows.append((mid, "set", "-", "-", "-", "-", "-", "could not select model"))
            print(f"[{mid}] could not select — skipping")
            continue

        print(f"[{mid}] avail={avail} — plain…", end="", flush=True)
        pa = stream_chat(PLAIN_PROMPT)
        p_streamed = pa["streamed"]
        p_mode = "stream" if p_streamed else ("fallback" if p_streamed is False else "err")
        # Plain passes if: no error, non-empty final, and (>=3 chunks when streamed;
        # fallback models are exempt from the chunk floor since they emit 1 blob).
        plain_ok = (pa["error"] is None and bool(pa["final"].strip())
                    and (pa["chunks"] >= MIN_CHUNKS if p_streamed else True))
        print(f" {p_mode} chunks={pa['chunks']} ttft={fmt_t(pa['ttft'])}s "
              f"total={fmt_t(pa['total'])}s ok={plain_ok}; tool…", end="", flush=True)

        ta = stream_chat(TOOL_PROMPT)
        t_streamed = ta["streamed"]
        t_mode = "stream" if t_streamed else ("fallback" if t_streamed is False else "err")
        story_hint = any(k in ta["final"].lower() for k in STORY_HINTS)
        # Tool passes if: no error and a non-empty final. Agent-fired + story-hint are
        # recorded; a model that answers cleanly WITHOUT calling the tool still passes
        # (a behavioural finding, not a harness failure).
        tool_ok = ta["error"] is None and bool(ta["final"].strip())
        print(f" {t_mode} agent={ta['agent']} story={story_hint} "
              f"chunks={ta['chunks']} ttft={fmt_t(ta['ttft'])}s total={fmt_t(ta['total'])}s ok={tool_ok}")

        result = "PASS" if (plain_ok and tool_ok) else "FAIL"
        fell_back = "yes" if (p_streamed is False or t_streamed is False) else ("no" if p_streamed else "?")
        streams_flag = "yes" if (p_streamed or t_streamed) else ("no" if p_streamed is False else "?")

        err = pa["error"] or ta["error"] or ""
        summary.append({"model": mid, "avail": avail, "streams": streams_flag, "fallback": fell_back,
                        "chunks": pa["chunks"], "ttft": fmt_t(pa["ttft"]), "total": fmt_t(pa["total"]),
                        "agent": "yes" if ta["agent"] else "no", "result": result, "error": err[:60]})

        detail_rows.append((mid, "plain", p_mode, pa["chunks"], fmt_t(pa["ttft"]),
                            fmt_t(pa["total"]), "PASS" if plain_ok else "FAIL", (pa["error"] or "")[:60]))
        detail_rows.append((mid, "tool", t_mode + ("+agent" if ta["agent"] else ""),
                            ta["chunks"], fmt_t(ta["ttft"]), fmt_t(ta["total"]),
                            "PASS" if tool_ok else "FAIL", (ta["error"] or "")[:60]))

    # Restore the rig to its default so the matrix leaves no sticky model behind.
    try:
        set_model("auto")
    except Exception:
        pass

    # ── Detail table ──
    print("\n" + "=" * 100)
    print("DETAIL — per (model, test)")
    print("=" * 100)
    hdr = f"{'MODEL':<26} {'TEST':<6} {'MODE':<14} {'CHUNKS':>6} {'TTFT':>6} {'TOTAL':>6} {'OK':<5} ERROR"
    print(hdr)
    print("-" * 100)
    for row in detail_rows:
        mid, test, mode, chunks, ttft, total, ok, err = row
        print(f"{mid:<26} {test:<6} {mode:<14} {str(chunks):>6} {ttft:>6} {total:>6} {ok:<5} {err}")

    # ── Summary matrix ──
    print("\n" + "=" * 100)
    print("SUMMARY MATRIX — per model")
    print("=" * 100)
    hdr2 = (f"{'MODEL':<26} {'AVAIL':<5} {'STREAMS':<7} {'FALLBACK':<8} "
            f"{'CHUNKS':>6} {'TTFT':>6} {'TOTAL':>6} {'AGENT':<5} {'RESULT':<16} ERROR")
    print(hdr2)
    print("-" * 100)
    passed = 0
    for s in summary:
        if s["result"] == "PASS":
            passed += 1
        print(f"{s['model']:<26} {str(s['avail']):<5} {s['streams']:<7} {s['fallback']:<8} "
              f"{str(s['chunks']):>6} {s['ttft']:>6} {s['total']:>6} {s['agent']:<5} "
              f"{s['result']:<16} {s['error']}")

    total_models = len(summary)
    print("-" * 100)
    print(f"RESULT: {passed}/{total_models} models PASSED "
          f"(streaming OR transparent fallback). "
          f"{total_models - passed} did not pass.")
    print("=" * 100 + "\n")

    return 0 if passed == total_models else 1


if __name__ == "__main__":
    sys.exit(main())
