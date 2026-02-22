"""Tests for CodeReviewAgent - deterministic heuristic code review."""

import json
import pytest

from openrappter.agents.code_review_agent import CodeReviewAgent


# ---------------------------------------------------------------------------
# Sample code fixtures
# ---------------------------------------------------------------------------

CLEAN_CODE = """\
export function add(a: number, b: number): number {
    return a + b;
}

export function multiply(x: number, y: number): number {
    return x * y;
}
"""

LONG_LINE_CODE = "x" * 125 + "\n"

TODO_CODE = """\
function doSomething() {
    // TODO: implement this
    return null;
}
"""

CONSOLE_CODE = """\
function foo() {
    console.log("debug");
    console.warn("warning");
    return 42;
}
"""

EXCESSIVE_ANY_CODE = """\
function a(x: any, y: any, z: any): any {
    const q: any = x;
    const w: any = y;
    return q + w + (z as any);
}
"""

DUPLICATE_IMPORT_CODE = """\
import { foo } from './utils';
import { bar } from './utils';
function run() {}
"""

MISSING_RETURN_TYPE_CODE = """\
export function doStuff(a, b) {
    return a + b;
}
"""

MULTIPLE_ISSUES_CODE = """\
import { a } from './lib';
import { b } from './lib';
export function broken(x: any): any {
    // FIXME: bad code
    console.log("debug");
    return x;
}
"""


# ---------------------------------------------------------------------------
# Tests: constructor and metadata
# ---------------------------------------------------------------------------

class TestCodeReviewAgentInit:
    def test_name_is_code_review(self):
        agent = CodeReviewAgent()
        assert agent.name == "CodeReview"

    def test_metadata_has_correct_actions(self):
        agent = CodeReviewAgent()
        actions = agent.metadata["parameters"]["properties"]["action"]["enum"]
        assert set(actions) == {"review", "suggest", "diff_review"}

    def test_default_max_line_length(self):
        agent = CodeReviewAgent()
        assert agent._max_line_length == 120

    def test_custom_max_line_length(self):
        agent = CodeReviewAgent(max_line_length=80)
        assert agent._max_line_length == 80


# ---------------------------------------------------------------------------
# Tests: no action / unknown action
# ---------------------------------------------------------------------------

class TestActionValidation:
    def test_no_action_returns_error(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform())
        assert result["status"] == "error"

    def test_unknown_action_returns_error(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="analyze"))
        assert result["status"] == "error"
        assert "Unknown action" in result["message"]


# ---------------------------------------------------------------------------
# Tests: review action
# ---------------------------------------------------------------------------

class TestReviewAction:
    def test_review_requires_content(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="review"))
        assert result["status"] == "error"
        assert "content" in result["message"]

    def test_review_clean_code_score_100(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="review", content=CLEAN_CODE))
        assert result["status"] == "success"
        assert result["review"]["score"] == 100
        assert result["review"]["status"] == "clean"

    def test_review_clean_code_no_findings(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="review", content=CLEAN_CODE))
        assert result["review"]["findings"] == []

    def test_review_detects_long_lines(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="review", content=LONG_LINE_CODE))
        rules = [f["rule"] for f in result["review"]["findings"]]
        assert "line-length" in rules

    def test_review_long_line_is_warning(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="review", content=LONG_LINE_CODE))
        findings = result["review"]["findings"]
        long_line_findings = [f for f in findings if f["rule"] == "line-length"]
        assert all(f["severity"] == "warning" for f in long_line_findings)

    def test_review_detects_todo_comments(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="review", content=TODO_CODE))
        rules = [f["rule"] for f in result["review"]["findings"]]
        assert "todo-comment" in rules

    def test_review_todo_is_info_severity(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="review", content=TODO_CODE))
        findings = result["review"]["findings"]
        todo = [f for f in findings if f["rule"] == "todo-comment"]
        assert all(f["severity"] == "info" for f in todo)

    def test_review_detects_console_log(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="review", content=CONSOLE_CODE))
        rules = [f["rule"] for f in result["review"]["findings"]]
        assert "no-console" in rules

    def test_review_console_is_warning(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="review", content=CONSOLE_CODE))
        findings = result["review"]["findings"]
        console = [f for f in findings if f["rule"] == "no-console"]
        assert all(f["severity"] == "warning" for f in console)

    def test_review_skips_console_check_in_test_file(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(
            action="review",
            content=CONSOLE_CODE,
            file="foo.test.ts",
        ))
        rules = [f["rule"] for f in result["review"]["findings"]]
        assert "no-console" not in rules

    def test_review_detects_excessive_any(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="review", content=EXCESSIVE_ANY_CODE))
        rules = [f["rule"] for f in result["review"]["findings"]]
        assert "no-excessive-any" in rules

    def test_review_detects_duplicate_imports(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="review", content=DUPLICATE_IMPORT_CODE))
        rules = [f["rule"] for f in result["review"]["findings"]]
        assert "no-duplicate-imports" in rules

    def test_review_detects_missing_return_type(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="review", content=MISSING_RETURN_TYPE_CODE))
        rules = [f["rule"] for f in result["review"]["findings"]]
        assert "explicit-return-type" in rules

    def test_review_missing_return_type_is_info(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="review", content=MISSING_RETURN_TYPE_CODE))
        findings = result["review"]["findings"]
        rt = [f for f in findings if f["rule"] == "explicit-return-type"]
        assert all(f["severity"] == "info" for f in rt)

    def test_review_score_deducted_for_warnings(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="review", content=CONSOLE_CODE))
        # Each warning costs 5 points; 2 console statements = -10
        assert result["review"]["score"] < 100

    def test_review_status_issues_when_warnings_present(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="review", content=CONSOLE_CODE))
        assert result["review"]["status"] == "issues"

    def test_review_includes_data_slush(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="review", content=CLEAN_CODE))
        assert "data_slush" in result

    def test_review_data_slush_has_score_signal(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="review", content=CLEAN_CODE))
        signals = result["data_slush"].get("signals", {})
        assert "score" in signals

    def test_review_custom_max_line_length(self):
        code = "x" * 85 + "\n"  # exceeds 80 but not 120
        agent = CodeReviewAgent()
        result_default = json.loads(agent.perform(action="review", content=code))
        rules_default = [f["rule"] for f in result_default["review"]["findings"]]
        assert "line-length" not in rules_default

        result_strict = json.loads(agent.perform(action="review", content=code, maxLineLength=80))
        rules_strict = [f["rule"] for f in result_strict["review"]["findings"]]
        assert "line-length" in rules_strict

    def test_review_file_name_in_result(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="review", content=CLEAN_CODE, file="foo.ts"))
        assert result["review"]["file"] == "foo.ts"

    def test_review_summary_no_issues(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="review", content=CLEAN_CODE))
        assert "No issues" in result["review"]["summary"]

    def test_review_summary_with_issues(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="review", content=MULTIPLE_ISSUES_CODE))
        assert "Found" in result["review"]["summary"]

    def test_review_score_clamped_at_zero(self):
        # Code with many warnings should not go below 0
        lots_of_issues = "\n".join([f"console.log({i});" for i in range(30)])
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="review", content=lots_of_issues))
        assert result["review"]["score"] >= 0


# ---------------------------------------------------------------------------
# Tests: suggest action
# ---------------------------------------------------------------------------

class TestSuggestAction:
    def test_suggest_requires_content(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="suggest"))
        assert result["status"] == "error"

    def test_suggest_returns_suggestions_list(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="suggest", content=TODO_CODE))
        assert "suggestions" in result

    def test_suggest_each_entry_has_suggestion_key(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="suggest", content=TODO_CODE))
        for s in result["suggestions"]:
            assert "suggestion" in s

    def test_suggest_todo_has_meaningful_suggestion(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="suggest", content=TODO_CODE))
        todo_suggestions = [
            s["suggestion"] for s in result["suggestions"]
            if s.get("rule") == "todo-comment"
        ]
        assert len(todo_suggestions) > 0
        assert all(len(s) > 0 for s in todo_suggestions)

    def test_suggest_includes_review_and_data_slush(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="suggest", content=CLEAN_CODE))
        assert "review" in result
        assert "data_slush" in result

    def test_suggest_clean_code_has_no_suggestions(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="suggest", content=CLEAN_CODE))
        assert result["suggestions"] == []


# ---------------------------------------------------------------------------
# Tests: diff_review action
# ---------------------------------------------------------------------------

class TestDiffReviewAction:
    def test_diff_review_requires_diff(self):
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="diff_review"))
        assert result["status"] == "error"
        assert "diff" in result["message"]

    def test_diff_review_only_checks_added_lines(self):
        diff = """\
--- a/foo.ts
+++ b/foo.ts
@@ -1,2 +1,3 @@
 unchanged line
-removed line
+console.log("debug")
"""
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="diff_review", diff=diff))
        # "removed line" should NOT be flagged; only the added console.log
        rules = [f["rule"] for f in result["review"]["findings"]]
        assert "no-console" in rules

    def test_diff_review_reports_added_line_count(self):
        diff = "+line one\n+line two\n-removed\n unchanged\n"
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="diff_review", diff=diff))
        assert result["addedLineCount"] == 2

    def test_diff_review_skips_plus_plus_plus_header(self):
        diff = "+++ b/foo.ts\n+console.log('x');\n"
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="diff_review", diff=diff))
        # Only one added line (the console.log), not the +++ header
        assert result["addedLineCount"] == 1

    def test_diff_review_includes_data_slush(self):
        diff = "+const x = 1;\n"
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="diff_review", diff=diff))
        assert "data_slush" in result

    def test_diff_review_clean_diff_scores_100(self):
        diff = "+const x = 1;\n"
        agent = CodeReviewAgent()
        result = json.loads(agent.perform(action="diff_review", diff=diff))
        assert result["review"]["score"] == 100


# ---------------------------------------------------------------------------
# Tests: scoring formula
# ---------------------------------------------------------------------------

class TestScoringFormula:
    def test_score_100_for_no_findings(self):
        agent = CodeReviewAgent()
        findings = []
        result = agent._build_review_result(findings)
        assert result["score"] == 100

    def test_score_deducted_5_per_warning(self):
        agent = CodeReviewAgent()
        findings = [
            {"severity": "warning", "rule": "no-console", "message": "x", "line": 1},
            {"severity": "warning", "rule": "no-console", "message": "x", "line": 2},
        ]
        result = agent._build_review_result(findings)
        assert result["score"] == 90  # 100 - (2 * 5)

    def test_score_deducted_1_per_info(self):
        agent = CodeReviewAgent()
        findings = [
            {"severity": "info", "rule": "todo-comment", "message": "x", "line": 1},
        ]
        result = agent._build_review_result(findings)
        assert result["score"] == 99

    def test_status_clean_no_findings(self):
        agent = CodeReviewAgent()
        result = agent._build_review_result([])
        assert result["status"] == "clean"

    def test_status_issues_with_warnings(self):
        agent = CodeReviewAgent()
        findings = [{"severity": "warning", "rule": "x", "message": "y", "line": 1}]
        result = agent._build_review_result(findings)
        assert result["status"] == "issues"

    def test_status_critical_with_errors(self):
        agent = CodeReviewAgent()
        findings = [{"severity": "error", "rule": "x", "message": "y", "line": 1}]
        result = agent._build_review_result(findings)
        assert result["status"] == "critical"
