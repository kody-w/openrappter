"""
CodeReviewAgent - Deterministic heuristic code review agent.

Performs static code analysis using pattern matching (no LLM).
Checks for common code quality issues and produces a scored review.

Checks:
  1. Line length > max (default 120)
  2. TODO/FIXME/HACK comments
  3. console.log/warn/error in non-test files
  4. Excessive `any` types (>5)
  5. Duplicate imports
  6. Missing explicit return types on exports

Scoring: 100 - (errors * 20) - (warnings * 5) - (info * 1), clamped to 0

Actions: review, suggest, diff_review

Mirrors TypeScript agents/CodeReviewAgent.ts
"""

import json
import re
from datetime import datetime

from openrappter.agents.basic_agent import BasicAgent


class CodeReviewAgent(BasicAgent):
    def __init__(self, max_line_length=120):
        self.name = 'CodeReview'
        self.metadata = {
            "name": self.name,
            "description": "Deterministic heuristic code review agent. Checks for common quality issues like long lines, TODO comments, console.log usage, excessive any types, duplicate imports, and missing return types.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "The review action to perform.",
                        "enum": ["review", "suggest", "diff_review"]
                    },
                    "content": {
                        "type": "string",
                        "description": "Source code content to review."
                    },
                    "file": {
                        "type": "string",
                        "description": "File name (used for context, e.g. test detection)."
                    },
                    "diff": {
                        "type": "string",
                        "description": "Git diff content for diff_review action."
                    },
                    "maxLineLength": {
                        "type": "number",
                        "description": "Maximum line length (default: 120)."
                    }
                },
                "required": []
            }
        }
        super().__init__(name=self.name, metadata=self.metadata)
        self._max_line_length = max_line_length

    def perform(self, **kwargs):
        action = kwargs.get('action')

        if not action:
            return json.dumps({
                "status": "error",
                "message": "No action specified. Use: review, suggest, or diff_review"
            })

        try:
            if action == 'review':
                return self._review_code(kwargs)
            elif action == 'suggest':
                return self._suggest_fixes(kwargs)
            elif action == 'diff_review':
                return self._diff_review(kwargs)
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

    def _review_code(self, kwargs):
        content = kwargs.get('content')
        file_name = kwargs.get('file')
        max_len = kwargs.get('maxLineLength', self._max_line_length)

        if not content:
            return json.dumps({
                "status": "error",
                "message": "content is required for review"
            })

        findings = self._analyze_code(content, file_name, max_len)
        result = self._build_review_result(findings, file_name)

        data_slush = self.slush_out(
            signals={
                'score': result['score'],
                'finding_count': len(findings),
                'review_status': result['status'],
            }
        )

        return json.dumps({
            "status": "success",
            "action": "review",
            "review": result,
            "data_slush": data_slush,
        })

    def _suggest_fixes(self, kwargs):
        content = kwargs.get('content')
        file_name = kwargs.get('file')
        max_len = kwargs.get('maxLineLength', self._max_line_length)

        if not content:
            return json.dumps({
                "status": "error",
                "message": "content is required for suggest"
            })

        findings = self._analyze_code(content, file_name, max_len)
        suggestions = []
        for f in findings:
            suggestion = dict(f)
            suggestion['suggestion'] = self._get_suggestion(f)
            suggestions.append(suggestion)

        result = self._build_review_result(findings, file_name)

        data_slush = self.slush_out(
            signals={
                'score': result['score'],
                'suggestion_count': len(suggestions),
            }
        )

        return json.dumps({
            "status": "success",
            "action": "suggest",
            "review": result,
            "suggestions": suggestions,
            "data_slush": data_slush,
        })

    def _diff_review(self, kwargs):
        diff = kwargs.get('diff')
        max_len = kwargs.get('maxLineLength', self._max_line_length)

        if not diff:
            return json.dumps({
                "status": "error",
                "message": "diff is required for diff_review"
            })

        # Parse diff: only review added lines
        added_lines = []
        for line in diff.split('\n'):
            if line.startswith('+') and not line.startswith('+++'):
                added_lines.append(line[1:])

        content = '\n'.join(added_lines)
        findings = self._analyze_code(content, None, max_len)
        result = self._build_review_result(findings)

        data_slush = self.slush_out(
            signals={
                'score': result['score'],
                'added_lines': len(added_lines),
                'finding_count': len(findings),
            }
        )

        return json.dumps({
            "status": "success",
            "action": "diff_review",
            "review": result,
            "addedLineCount": len(added_lines),
            "data_slush": data_slush,
        })

    def _analyze_code(self, content, file_name=None, max_len=None):
        """Run all code analysis checks."""
        findings = []
        lines = content.split('\n')
        effective_max_len = max_len or self._max_line_length
        is_test_file = bool(file_name and re.search(r'\.(test|spec)\.(ts|js|tsx|jsx)$', file_name))

        # Check 1: Line length
        for i, line in enumerate(lines):
            if len(line) > effective_max_len:
                findings.append({
                    'severity': 'warning',
                    'rule': 'line-length',
                    'message': f'Line exceeds {effective_max_len} characters ({len(line)})',
                    'line': i + 1,
                })

        # Check 2: TODO/FIXME/HACK comments
        for i, line in enumerate(lines):
            match = re.search(r'\b(TODO|FIXME|HACK)\b', line)
            if match:
                findings.append({
                    'severity': 'info',
                    'rule': 'todo-comment',
                    'message': f'{match.group(1)} comment found',
                    'line': i + 1,
                })

        # Check 3: console.log/warn/error in non-test files
        if not is_test_file:
            for i, line in enumerate(lines):
                if re.search(r'\bconsole\.(log|warn|error)\b', line):
                    findings.append({
                        'severity': 'warning',
                        'rule': 'no-console',
                        'message': 'console statement found in non-test file',
                        'line': i + 1,
                    })

        # Check 4: Excessive `any` types
        any_count = 0
        for line in lines:
            any_count += len(re.findall(r':\s*any\b', line))
        if any_count > 5:
            findings.append({
                'severity': 'warning',
                'rule': 'no-excessive-any',
                'message': f"Excessive use of 'any' type ({any_count} occurrences)",
            })

        # Check 5: Duplicate imports
        imports = {}
        for i, line in enumerate(lines):
            match = re.match(r"^import\s+.*from\s+['\"]([^'\"]+)['\"]", line)
            if match:
                source = match.group(1)
                if source not in imports:
                    imports[source] = []
                imports[source].append(i + 1)
        for source, line_nums in imports.items():
            if len(line_nums) > 1:
                findings.append({
                    'severity': 'warning',
                    'rule': 'no-duplicate-imports',
                    'message': f"Duplicate import from '{source}' on lines {', '.join(str(n) for n in line_nums)}",
                    'line': line_nums[1],
                })

        # Check 6: Missing explicit return types on exports
        for i, line in enumerate(lines):
            match = re.match(r'^export\s+(async\s+)?function\s+\w+\([^)]*\)\s*\{', line)
            if match and not re.search(r'\)\s*:\s*\S+', line):
                findings.append({
                    'severity': 'info',
                    'rule': 'explicit-return-type',
                    'message': 'Exported function missing explicit return type',
                    'line': i + 1,
                })

        return findings

    def _build_review_result(self, findings, file_name=None):
        """Build a review result with score and status."""
        errors = sum(1 for f in findings if f['severity'] == 'error')
        warnings = sum(1 for f in findings if f['severity'] == 'warning')
        infos = sum(1 for f in findings if f['severity'] == 'info')

        score = max(0, 100 - (errors * 20) - (warnings * 5) - (infos * 1))

        if errors > 0:
            status = 'critical'
        elif warnings > 0:
            status = 'issues'
        else:
            status = 'clean'

        if not findings:
            summary = 'No issues found'
        else:
            summary = f'Found {len(findings)} issue(s): {errors} error(s), {warnings} warning(s), {infos} info(s)'

        result = {
            'findings': findings,
            'summary': summary,
            'score': score,
            'status': status,
        }
        if file_name:
            result['file'] = file_name

        return result

    def _get_suggestion(self, finding):
        """Get a fix suggestion for a finding."""
        rule = finding.get('rule', '')
        suggestions = {
            'line-length': 'Break the line into multiple lines or extract into a variable',
            'todo-comment': 'Address the TODO/FIXME/HACK or create a tracking issue',
            'no-console': 'Remove console statement or replace with a proper logger',
            'no-excessive-any': 'Replace any with specific types or use unknown',
            'no-duplicate-imports': 'Merge duplicate imports into a single import statement',
            'explicit-return-type': 'Add an explicit return type annotation to the exported function',
        }
        return suggestions.get(rule, 'Review and fix the issue')
