"""
Tests for Claude model auto-selection (Haiku-first) + sticky model persistence (brainstem.py).

Runs two ways:
    python3 -m pytest test_model_selection.py -v     # with pytest
    python  test_model_selection.py                  # standalone (no pytest needed)
"""
import os
import sys
import tempfile

BRAINSTEM_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BRAINSTEM_DIR not in sys.path:
    sys.path.insert(0, BRAINSTEM_DIR)

import brainstem as bs


# ── Test isolation ────────────────────────────────────────────────────────────
# These tests mutate module globals and call _save/_clear_sticky_model, which
# writes/deletes .brainstem_model NEXT TO brainstem.py — i.e. the user's real
# persisted model pick. Redirect that file to a throwaway path so a test run can
# never touch real state, and snapshot the globals so the module is left exactly
# as it was found. Works in both pytest and the standalone runner below.
bs._model_file = os.path.join(tempfile.mkdtemp(prefix="bs-model-test-"), ".brainstem_model")

_SNAPSHOT_ATTRS = ("MODEL", "MODEL_PINNED", "AVAILABLE_MODELS", "_models_fetched", "_default_model_selected")
_ORIG_GLOBALS = {a: getattr(bs, a) for a in _SNAPSHOT_ATTRS}

def _restore_globals():
    for a, v in _ORIG_GLOBALS.items():
        setattr(bs, a, v)
    bs._clear_sticky_model()

try:
    import pytest

    @pytest.fixture(autouse=True)
    def _isolate_brainstem_state():
        yield
        _restore_globals()
except ImportError:
    pass


# ── _sonnet_rank ──────────────────────────────────────────────────────────────

def test_sonnet_rank_both_naming_shapes():
    # version-before-name
    assert bs._sonnet_rank("claude-3-sonnet") == (3, 0)
    assert bs._sonnet_rank("claude-3.5-sonnet") == (3, 5)
    assert bs._sonnet_rank("claude-3-5-sonnet") == (3, 5)
    assert bs._sonnet_rank("claude-3.7-sonnet") == (3, 7)
    # version-after-name
    assert bs._sonnet_rank("claude-sonnet-4") == (4, 0)
    assert bs._sonnet_rank("claude-sonnet-4.5") == (4, 5)
    assert bs._sonnet_rank("claude-sonnet-4-5") == (4, 5)
    assert bs._sonnet_rank("claude-sonnet-4.6") == (4, 6)
    # spaces (display-name style)
    assert bs._sonnet_rank("", "Claude Sonnet 4.6") is None  # id empty, no claude marker
    assert bs._sonnet_rank("claude-x", "Claude Sonnet 4.6") == (4, 6)  # name fallback


def test_sonnet_rank_strips_date_suffix():
    assert bs._sonnet_rank("claude-3-sonnet-20240229") == (3, 0)
    assert bs._sonnet_rank("claude-3-5-sonnet-20241022") == (3, 5)
    assert bs._sonnet_rank("claude-sonnet-4-20250514") == (4, 0)
    assert bs._sonnet_rank("claude-sonnet-4-5-20250929") == (4, 5)


def test_sonnet_rank_strips_reasoning_variant():
    assert bs._sonnet_rank("claude-3.7-sonnet-thought") == (3, 7)
    assert bs._sonnet_rank("claude-3-7-sonnet-thinking") == (3, 7)


def test_sonnet_rank_excludes_non_sonnet():
    for neg in [
        "gpt-4o", "gpt-4.1", "gpt-4o-mini", "o1", "o3-mini", "gemini-2.5-pro",
        "claude-opus-4", "claude-opus-4.1", "claude-opus-41", "claude-opus-4-5",
        "claude-3-haiku-20240307", "claude-3.5-haiku", "claude-3-5-haiku",
        "claude-haiku-4.5", "", "claude-personnet-4.5",
    ]:
        assert bs._sonnet_rank(neg) is None, f"{neg!r} should not rank as Sonnet"


def test_sonnet_rank_name_spoof_blocked():
    # A non-Claude id must not borrow a Sonnet rank from free text in its name.
    assert bs._sonnet_rank("gpt-5", "GPT-5 (as good as Claude Sonnet 4.5)") is None


def test_sonnet_rank_double_digit_major_outranks():
    assert bs._sonnet_rank("claude-sonnet-10") == (10, 0)
    assert bs._sonnet_rank("claude-sonnet-10") > bs._sonnet_rank("claude-sonnet-4.5")


def test_sonnet_rank_total_order():
    order = [
        bs._sonnet_rank("claude-3-sonnet"),
        bs._sonnet_rank("claude-3.5-sonnet"),
        bs._sonnet_rank("claude-3.7-sonnet"),
        bs._sonnet_rank("claude-sonnet-4"),
        bs._sonnet_rank("claude-sonnet-4.5"),
        bs._sonnet_rank("claude-sonnet-4.6"),
    ]
    assert order == sorted(order)
    assert len(set(order)) == len(order)  # strictly increasing


# ── _haiku_rank ───────────────────────────────────────────────────────────────

def test_haiku_rank_both_naming_shapes():
    assert bs._haiku_rank("claude-3-5-haiku-20241022") == (3, 5)
    assert bs._haiku_rank("claude-3.5-haiku") == (3, 5)
    assert bs._haiku_rank("claude-haiku-4.5") == (4, 5)
    assert bs._haiku_rank("claude-haiku-4-5") == (4, 5)
    assert bs._haiku_rank("claude-x", "Claude Haiku 4.5") == (4, 5)  # name fallback


def test_haiku_rank_excludes_non_haiku():
    assert bs._haiku_rank("claude-sonnet-4.5") is None
    assert bs._haiku_rank("claude-opus-4.5") is None
    assert bs._haiku_rank("gpt-4o") is None
    assert bs._haiku_rank("gpt-5", "Claude Haiku 4.5") is None  # name spoof blocked


# ── _model_is_available ───────────────────────────────────────────────────────

def test_available_policy_states():
    assert bs._model_is_available({"id": "gpt-4o"}) is True               # no policy => available
    assert bs._model_is_available({"policy": {"state": "enabled"}}) is True
    assert bs._model_is_available({"policy": {"state": "unconfigured"}}) is False
    assert bs._model_is_available({"policy": {"state": "disabled"}}) is False


def test_available_picker_and_caps():
    assert bs._model_is_available({"model_picker_enabled": False}) is False
    assert bs._model_is_available({"model_picker_enabled": True}) is True
    assert bs._model_is_available({"capabilities": {"type": "embeddings"}}) is False
    assert bs._model_is_available({"capabilities": {"type": "chat"}}) is True
    assert bs._model_is_available(
        {"capabilities": {"supports": {"tool_calls": False}}}) is False
    assert bs._model_is_available(
        {"capabilities": {"supports": {"tool_calls": True}}}) is True


def test_available_conservative_on_garbage():
    assert bs._model_is_available({}) is True            # unknown => available
    assert bs._model_is_available("not-a-dict") is False  # malformed => unavailable


# ── _auto_select_default_model ────────────────────────────────────────────────

def _reset(models, *, model="gpt-4o", pinned=False, fetched=True):
    """Reset module state for an auto-select scenario (no sticky file)."""
    bs._clear_sticky_model()
    bs._default_model_selected = False
    bs._models_fetched = fetched
    bs.MODEL_PINNED = pinned
    bs.MODEL = model
    bs.AVAILABLE_MODELS = models


def test_auto_select_prefers_haiku_over_higher_sonnet():
    # Haiku wins the default even against a higher-versioned Sonnet:
    # response speed beats raw intelligence for the default chat experience.
    _reset([
        {"id": "claude-sonnet-4-6-20260217", "name": "Claude Sonnet 4.6", "available": True},
        {"id": "claude-haiku-4.5", "name": "Claude Haiku 4.5", "available": True},
        {"id": "gpt-4o", "name": "GPT-4o", "available": True},
    ])
    bs._auto_select_default_model()
    assert bs.MODEL == "claude-haiku-4.5"


def test_auto_select_picks_highest_available_haiku():
    _reset([
        {"id": "claude-3-5-haiku-20241022", "name": "Claude 3.5 Haiku", "available": True},
        {"id": "claude-haiku-4.5", "name": "Claude Haiku 4.5", "available": True},
        {"id": "claude-haiku-5", "name": "Claude Haiku 5", "available": False},  # not on plan
    ])
    bs._auto_select_default_model()
    assert bs.MODEL == "claude-haiku-4.5"


def test_auto_select_picks_highest_available_sonnet():
    _reset([
        {"id": "gpt-4o", "name": "GPT-4o", "available": True},
        {"id": "claude-3.5-sonnet", "name": "Claude 3.5 Sonnet", "available": True},
        {"id": "claude-sonnet-4", "name": "Claude Sonnet 4", "available": True},
        {"id": "claude-sonnet-4.5", "name": "Claude Sonnet 4.5", "available": True},
        {"id": "claude-sonnet-4-6-20260217", "name": "Claude Sonnet 4.6", "available": True},
        {"id": "claude-opus-4.5", "name": "Claude Opus 4.5", "available": True},
    ])
    bs._auto_select_default_model()
    assert bs.MODEL == "claude-sonnet-4-6-20260217"


def test_auto_select_skips_unavailable_sonnet():
    _reset([
        {"id": "claude-sonnet-4.5", "name": "Claude Sonnet 4.5", "available": True},
        {"id": "claude-sonnet-4.6", "name": "Claude Sonnet 4.6", "available": False},
    ])
    bs._auto_select_default_model()
    assert bs.MODEL == "claude-sonnet-4.5"


def test_auto_select_prefers_base_over_reasoning_variant():
    _reset([
        {"id": "claude-3.7-sonnet", "name": "Claude 3.7 Sonnet", "available": True},
        {"id": "claude-3.7-sonnet-thought", "name": "Claude 3.7 Sonnet Thinking", "available": True},
    ])
    bs._auto_select_default_model()
    assert bs.MODEL == "claude-3.7-sonnet"


def test_auto_select_keeps_gpt4o_when_no_sonnet():
    _reset([
        {"id": "gpt-4o", "name": "GPT-4o", "available": True},
        {"id": "gpt-4.1", "name": "GPT-4.1", "available": True},
    ])
    bs._auto_select_default_model()
    assert bs.MODEL == "gpt-4o"


def test_auto_select_ignores_unverified_bootstrap_models():
    # Bootstrap entries lack the "available" key -> never auto-picked.
    _reset([
        {"id": "claude-sonnet-4", "name": "Claude Sonnet 4"},  # no 'available'
        {"id": "gpt-4o", "name": "GPT-4o"},
    ])
    bs._auto_select_default_model()
    assert bs.MODEL == "gpt-4o"


def test_auto_select_locked_out_by_env_pin():
    _reset([{"id": "claude-sonnet-4.5", "name": "Claude Sonnet 4.5", "available": True}],
           model="gpt-4.1", pinned=True)
    bs._auto_select_default_model()
    assert bs.MODEL == "gpt-4.1"  # explicit pin wins


def test_auto_select_locked_out_by_sticky_pick():
    _reset([{"id": "claude-sonnet-4.5", "name": "Claude Sonnet 4.5", "available": True}])
    bs._save_sticky_model("gpt-4o-mini")
    try:
        bs.MODEL = "gpt-4o-mini"
        bs._default_model_selected = False
        bs._auto_select_default_model()
        assert bs.MODEL == "gpt-4o-mini"  # sticky pick wins over auto-Sonnet
    finally:
        bs._clear_sticky_model()


def test_auto_select_waits_for_real_fetch():
    _reset([{"id": "claude-sonnet-4.5", "name": "Claude Sonnet 4.5", "available": True}],
           fetched=False)
    bs._auto_select_default_model()
    assert bs.MODEL == "gpt-4o"  # no catalog yet -> unchanged


# ── sticky persistence round-trip ─────────────────────────────────────────────

def test_sticky_roundtrip():
    bs._clear_sticky_model()
    assert bs._load_sticky_model() is None
    bs._save_sticky_model("claude-sonnet-4.5")
    try:
        assert bs._load_sticky_model() == "claude-sonnet-4.5"
    finally:
        bs._clear_sticky_model()
    assert bs._load_sticky_model() is None


if __name__ == "__main__":
    # Standalone runner (no pytest dependency).
    fns = [v for k, v in sorted(globals().items())
           if k.startswith("test_") and callable(v)]
    passed = failed = 0
    for fn in fns:
        try:
            fn()
            print(f"  PASS  {fn.__name__}")
            passed += 1
        except AssertionError as e:
            print(f"  FAIL  {fn.__name__}: {e}")
            failed += 1
        except Exception as e:
            print(f"  ERROR {fn.__name__}: {type(e).__name__}: {e}")
            failed += 1
        finally:
            _restore_globals()   # keep each test hermetic in the standalone runner too
    print(f"\n{passed} passed, {failed} failed")
    raise SystemExit(1 if failed else 0)
