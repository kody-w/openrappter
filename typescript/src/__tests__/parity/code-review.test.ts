/**
 * CodeReviewAgent Parity Tests
 *
 * Tests the deterministic heuristic code review agent — static analysis checks,
 * scoring, suggestions, diff review, data sloshing, and metadata contract.
 *
 * Mirrors Python agents/code_review_agent.py
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CodeReviewAgent } from '../../agents/CodeReviewAgent.js';
import { BasicAgent } from '../../agents/BasicAgent.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a string of exactly `length` chars using a repeating pattern.
 * Useful for crafting lines that land precisely on the length threshold.
 */
function padLine(content: string, length: number): string {
  const base = content.padEnd(length - 1, 'x');
  return base.length >= length ? base.slice(0, length) : base + 'x';
}

/** Repeat `char` n times. */
function repeat(char: string, n: number): string {
  return char.repeat(n);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CodeReviewAgent Parity', () => {

  // ── 1. Constructor ────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('should have name CodeReview', () => {
      const reviewer = new CodeReviewAgent();
      expect(reviewer.name).toBe('CodeReview');
    });

    it('should have a non-empty description', () => {
      const reviewer = new CodeReviewAgent();
      expect(reviewer.metadata.description).toBeDefined();
      expect(reviewer.metadata.description.length).toBeGreaterThan(0);
    });

    it('action parameter enum should be [review, suggest, diff_review]', () => {
      const reviewer = new CodeReviewAgent();
      const actionProp = reviewer.metadata.parameters.properties.action;
      expect(actionProp).toBeDefined();
      expect(actionProp.enum).toEqual(['review', 'suggest', 'diff_review']);
    });

    it('should extend BasicAgent', () => {
      const reviewer = new CodeReviewAgent();
      expect(reviewer).toBeInstanceOf(BasicAgent);
    });
  });

  // ── 2. No action / unknown action ────────────────────────────────────────

  describe('no action / unknown action', () => {
    it('should return an error when no action is provided', async () => {
      const reviewer = new CodeReviewAgent();
      const raw = await reviewer.perform({ content: 'const x = 1;' });
      const result = JSON.parse(raw);
      expect(result.status).toBe('error');
      expect(result.message).toMatch(/no action/i);
    });

    it('should return an error for an unknown action', async () => {
      const reviewer = new CodeReviewAgent();
      const raw = await reviewer.perform({ action: 'unknown_action', content: 'const x = 1;' });
      const result = JSON.parse(raw);
      expect(result.status).toBe('error');
      expect(result.message).toMatch(/unknown action/i);
    });
  });

  // ── 3. review: clean code ────────────────────────────────────────────────

  describe('review: clean code', () => {
    it('should return score=100, status=clean, and no findings for short clean code', async () => {
      const reviewer = new CodeReviewAgent();
      const cleanCode = [
        'export function add(a: number, b: number): number {',
        '  return a + b;',
        '}',
      ].join('\n');

      const raw = await reviewer.perform({ action: 'review', content: cleanCode, file: 'math.ts' });
      const result = JSON.parse(raw);

      expect(result.status).toBe('success');
      expect(result.action).toBe('review');
      expect(result.review.score).toBe(100);
      expect(result.review.status).toBe('clean');
      expect(result.review.findings).toHaveLength(0);
    });
  });

  // ── 4. review: line-length ────────────────────────────────────────────────

  describe('review: line-length', () => {
    it('should produce a warning with rule=line-length and correct line number for an overlong line', async () => {
      const reviewer = new CodeReviewAgent();
      // Line 2 exceeds 120 characters
      const longLine = 'const veryLongVariableName = ' + repeat('a', 100) + ';';
      expect(longLine.length).toBeGreaterThan(120);

      const code = ['const x = 1;', longLine, 'const y = 2;'].join('\n');

      const raw = await reviewer.perform({ action: 'review', content: code, file: 'file.ts' });
      const result = JSON.parse(raw);

      const lineLengthFindings = result.review.findings.filter(
        (f: { rule: string }) => f.rule === 'line-length'
      );
      expect(lineLengthFindings.length).toBeGreaterThanOrEqual(1);

      const finding = lineLengthFindings[0];
      expect(finding.severity).toBe('warning');
      expect(finding.rule).toBe('line-length');
      expect(finding.message).toContain('120');
      expect(finding.line).toBe(2);
    });
  });

  // ── 5. review: todo-comment ───────────────────────────────────────────────

  describe('review: todo-comment', () => {
    it('should produce an info finding with rule=todo-comment for a TODO comment', async () => {
      const reviewer = new CodeReviewAgent();
      const code = ['const x = 1;', '// TODO: fix this later', 'const y = 2;'].join('\n');

      const raw = await reviewer.perform({ action: 'review', content: code, file: 'app.ts' });
      const result = JSON.parse(raw);

      const todoFindings = result.review.findings.filter(
        (f: { rule: string }) => f.rule === 'todo-comment'
      );
      expect(todoFindings.length).toBeGreaterThanOrEqual(1);

      const finding = todoFindings[0];
      expect(finding.severity).toBe('info');
      expect(finding.rule).toBe('todo-comment');
      expect(finding.line).toBe(2);
    });
  });

  // ── 6. review: no-console (non-test file) ────────────────────────────────

  describe('review: no-console', () => {
    it('should produce a warning with rule=no-console for console.log in a non-test file', async () => {
      const reviewer = new CodeReviewAgent();
      const code = ['function greet(name: string) {', "  console.log('hello', name);", '}'].join('\n');

      const raw = await reviewer.perform({ action: 'review', content: code, file: 'app.ts' });
      const result = JSON.parse(raw);

      const consoleFindings = result.review.findings.filter(
        (f: { rule: string }) => f.rule === 'no-console'
      );
      expect(consoleFindings.length).toBeGreaterThanOrEqual(1);

      const finding = consoleFindings[0];
      expect(finding.severity).toBe('warning');
      expect(finding.rule).toBe('no-console');
      expect(finding.line).toBe(2);
    });
  });

  // ── 7. review: console in test file ─────────────────────────────────────

  describe('review: console in test file', () => {
    it('should NOT produce a no-console warning for a .test.ts file', async () => {
      const reviewer = new CodeReviewAgent();
      const code = ["console.log('debug output in test');", 'expect(true).toBe(true);'].join('\n');

      const raw = await reviewer.perform({ action: 'review', content: code, file: 'app.test.ts' });
      const result = JSON.parse(raw);

      const consoleFindings = result.review.findings.filter(
        (f: { rule: string }) => f.rule === 'no-console'
      );
      expect(consoleFindings).toHaveLength(0);
    });
  });

  // ── 8. review: no-excessive-any ──────────────────────────────────────────

  describe('review: no-excessive-any', () => {
    it('should produce a warning with rule=no-excessive-any when code has more than 5 : any occurrences', async () => {
      const reviewer = new CodeReviewAgent();
      // Exactly 6 `: any` occurrences
      const anyLines = [
        'function process(a: any, b: any, c: any): any {',
        '  const x: any = a;',
        '  const y: any = b;',
        '  return x as any;',
        '}',
      ];
      // Count occurrences to verify fixture
      const code = anyLines.join('\n');
      const anyCount = (code.match(/:\s*any\b/g) ?? []).length;
      expect(anyCount).toBeGreaterThan(5);

      const raw = await reviewer.perform({ action: 'review', content: code, file: 'util.ts' });
      const result = JSON.parse(raw);

      const anyFindings = result.review.findings.filter(
        (f: { rule: string }) => f.rule === 'no-excessive-any'
      );
      expect(anyFindings.length).toBeGreaterThanOrEqual(1);

      const finding = anyFindings[0];
      expect(finding.severity).toBe('warning');
      expect(finding.rule).toBe('no-excessive-any');
      expect(finding.message).toContain('any');
    });
  });

  // ── 9. review: no-duplicate-imports ──────────────────────────────────────

  describe('review: no-duplicate-imports', () => {
    it('should produce a warning with rule=no-duplicate-imports for two imports from the same module', async () => {
      const reviewer = new CodeReviewAgent();
      const code = [
        "import { foo } from './utils.js';",
        'const x = 1;',
        "import { bar } from './utils.js';",
      ].join('\n');

      const raw = await reviewer.perform({ action: 'review', content: code, file: 'index.ts' });
      const result = JSON.parse(raw);

      const dupFindings = result.review.findings.filter(
        (f: { rule: string }) => f.rule === 'no-duplicate-imports'
      );
      expect(dupFindings.length).toBeGreaterThanOrEqual(1);

      const finding = dupFindings[0];
      expect(finding.severity).toBe('warning');
      expect(finding.rule).toBe('no-duplicate-imports');
      expect(finding.message).toContain('./utils.js');
    });
  });

  // ── 10. review: explicit-return-type ─────────────────────────────────────

  describe('review: explicit-return-type', () => {
    it('should produce an info finding with rule=explicit-return-type for an exported function without a return type', async () => {
      const reviewer = new CodeReviewAgent();
      const code = ['export function foo() {', '  return 42;', '}'].join('\n');

      const raw = await reviewer.perform({ action: 'review', content: code, file: 'helpers.ts' });
      const result = JSON.parse(raw);

      const returnTypeFindings = result.review.findings.filter(
        (f: { rule: string }) => f.rule === 'explicit-return-type'
      );
      expect(returnTypeFindings.length).toBeGreaterThanOrEqual(1);

      const finding = returnTypeFindings[0];
      expect(finding.severity).toBe('info');
      expect(finding.rule).toBe('explicit-return-type');
      expect(finding.line).toBe(1);
    });
  });

  // ── 11. review: scoring ──────────────────────────────────────────────────

  describe('review: scoring', () => {
    it('should reduce score below 100 when warnings are present', async () => {
      const reviewer = new CodeReviewAgent();
      // Trigger at least one warning (console.log in non-test file)
      const code = ["console.log('debug');", 'const x = 1;'].join('\n');

      const raw = await reviewer.perform({ action: 'review', content: code, file: 'main.ts' });
      const result = JSON.parse(raw);

      expect(result.review.score).toBeLessThan(100);
      expect(result.review.status).toBe('issues');
    });

    it('should yield score=100 for clean code with no findings', async () => {
      const reviewer = new CodeReviewAgent();
      const code = 'const message: string = "hello world";';

      const raw = await reviewer.perform({ action: 'review', content: code, file: 'clean.ts' });
      const result = JSON.parse(raw);

      expect(result.review.score).toBe(100);
      expect(result.review.status).toBe('clean');
    });
  });

  // ── 12. review: missing content ──────────────────────────────────────────

  describe('review: missing content', () => {
    it('should return an error when content is not provided for review', async () => {
      const reviewer = new CodeReviewAgent();
      const raw = await reviewer.perform({ action: 'review' });
      const result = JSON.parse(raw);

      expect(result.status).toBe('error');
      expect(result.message).toMatch(/content/i);
    });
  });

  // ── 13. suggest action ───────────────────────────────────────────────────

  describe('suggest action', () => {
    it('should return a suggestions array with a suggestion string for each finding', async () => {
      const reviewer = new CodeReviewAgent();
      const code = ["console.log('oops');", '// TODO: remove this'].join('\n');

      const raw = await reviewer.perform({ action: 'suggest', content: code, file: 'app.ts' });
      const result = JSON.parse(raw);

      expect(result.status).toBe('success');
      expect(result.action).toBe('suggest');
      expect(Array.isArray(result.suggestions)).toBe(true);
      expect(result.suggestions.length).toBeGreaterThan(0);

      for (const s of result.suggestions) {
        expect(typeof s.suggestion).toBe('string');
        expect(s.suggestion.length).toBeGreaterThan(0);
      }
    });

    it('each suggestion entry should include all ReviewFinding fields plus a suggestion string', async () => {
      const reviewer = new CodeReviewAgent();
      const code = "console.log('hello');";

      const raw = await reviewer.perform({ action: 'suggest', content: code, file: 'app.ts' });
      const result = JSON.parse(raw);

      expect(result.suggestions.length).toBeGreaterThan(0);
      const entry = result.suggestions[0];

      // Finding fields
      expect(entry.severity).toBeDefined();
      expect(entry.rule).toBeDefined();
      expect(entry.message).toBeDefined();
      // Suggestion field
      expect(typeof entry.suggestion).toBe('string');
      expect(entry.suggestion.length).toBeGreaterThan(0);
    });
  });

  // ── 14. diff_review action ───────────────────────────────────────────────

  describe('diff_review action', () => {
    it('should only review added lines (starting with + but not +++)', async () => {
      const reviewer = new CodeReviewAgent();
      // Removed line with console (starts with -) should be ignored
      // Context line (no prefix) should be ignored
      // +++ header line should be ignored
      // Only the + line with console.log should be reviewed
      const diff = [
        '+++ b/app.ts',
        ' const x = 1; // context line, not reviewed',
        "-console.log('old');",
        "+console.log('new');",
      ].join('\n');

      const raw = await reviewer.perform({ action: 'diff_review', diff });
      const result = JSON.parse(raw);

      expect(result.status).toBe('success');
      expect(result.action).toBe('diff_review');

      // Only the added line (console.log) should trigger a finding
      // The removed line and context line should produce no findings
      const consoleFindings = result.review.findings.filter(
        (f: { rule: string }) => f.rule === 'no-console'
      );
      expect(consoleFindings.length).toBeGreaterThanOrEqual(1);
    });

    it('should include addedLineCount in the response', async () => {
      const reviewer = new CodeReviewAgent();
      const diff = [
        '+++ b/file.ts',
        '+ const a = 1;',
        '+ const b = 2;',
        '- const c = 3;',
        ' const d = 4;',
      ].join('\n');

      const raw = await reviewer.perform({ action: 'diff_review', diff });
      const result = JSON.parse(raw);

      expect(result.addedLineCount).toBeDefined();
      expect(typeof result.addedLineCount).toBe('number');
      // Lines starting with '+' but not '+++': '+ const a = 1;' and '+ const b = 2;'
      expect(result.addedLineCount).toBe(2);
    });
  });

  // ── 15. data_slush ───────────────────────────────────────────────────────

  describe('data_slush', () => {
    it('review result should include data_slush with a score signal', async () => {
      const reviewer = new CodeReviewAgent();
      const code = 'const value: number = 42;';

      const raw = await reviewer.perform({ action: 'review', content: code, file: 'value.ts' });
      const result = JSON.parse(raw);

      expect(result.data_slush).toBeDefined();
      expect(result.data_slush.signals).toBeDefined();
      expect(typeof result.data_slush.signals.score).toBe('number');
    });
  });

  // ── 16. Python parity ────────────────────────────────────────────────────

  describe('Python parity', () => {
    it('metadata schema should match the expected structure mirroring the Python agent', () => {
      const reviewer = new CodeReviewAgent();
      const { metadata } = reviewer;

      // Top-level fields
      expect(metadata.name).toBe('CodeReview');
      expect(typeof metadata.description).toBe('string');
      expect(metadata.description.length).toBeGreaterThan(0);

      // Parameters schema structure
      const params = metadata.parameters;
      expect(params.type).toBe('object');
      expect(params.required).toEqual([]);

      // Required properties present in Python mirror
      const props = params.properties;
      expect(props.action).toBeDefined();
      expect(props.action.type).toBe('string');
      expect(props.action.enum).toEqual(['review', 'suggest', 'diff_review']);

      expect(props.content).toBeDefined();
      expect(props.content.type).toBe('string');

      expect(props.file).toBeDefined();
      expect(props.file.type).toBe('string');

      expect(props.diff).toBeDefined();
      expect(props.diff.type).toBe('string');

      expect(props.maxLineLength).toBeDefined();
      expect(props.maxLineLength.type).toBe('number');
    });
  });

  // ── Additional: custom maxLineLength constructor option ───────────────────

  describe('custom maxLineLength', () => {
    it('should honour a custom maxLineLength passed to the constructor', async () => {
      // Very short limit of 20 chars
      const reviewer = new CodeReviewAgent({ maxLineLength: 20 });
      const code = 'const longishVar = 1; // 24 chars';
      expect(code.length).toBeGreaterThan(20);

      const raw = await reviewer.perform({ action: 'review', content: code, file: 'short.ts' });
      const result = JSON.parse(raw);

      const lineLengthFindings = result.review.findings.filter(
        (f: { rule: string }) => f.rule === 'line-length'
      );
      expect(lineLengthFindings.length).toBeGreaterThanOrEqual(1);
      expect(lineLengthFindings[0].message).toContain('20');
    });

    it('should not flag lines within the custom maxLineLength', async () => {
      const reviewer = new CodeReviewAgent({ maxLineLength: 200 });
      // A line of 130 chars would normally trigger the default limit of 120
      const code = 'const x = ' + repeat('a', 120) + ';'; // 131 chars
      expect(code.length).toBeLessThan(200);

      const raw = await reviewer.perform({ action: 'review', content: code, file: 'wide.ts' });
      const result = JSON.parse(raw);

      const lineLengthFindings = result.review.findings.filter(
        (f: { rule: string }) => f.rule === 'line-length'
      );
      expect(lineLengthFindings).toHaveLength(0);
    });
  });

  // ── Additional: scoring formula validation ───────────────────────────────

  describe('scoring formula', () => {
    it('score = max(0, 100 - warnings*5 - infos*1) with no errors', async () => {
      const reviewer = new CodeReviewAgent();
      // 1 warning (console.log) + 1 info (TODO) → score = 100 - 5 - 1 = 94
      const code = ["console.log('x');", '// TODO: fix'].join('\n');

      const raw = await reviewer.perform({ action: 'review', content: code, file: 'app.ts' });
      const result = JSON.parse(raw);

      const warnings = result.review.findings.filter(
        (f: { severity: string }) => f.severity === 'warning'
      ).length;
      const infos = result.review.findings.filter(
        (f: { severity: string }) => f.severity === 'info'
      ).length;
      const errors = result.review.findings.filter(
        (f: { severity: string }) => f.severity === 'error'
      ).length;

      const expectedScore = Math.max(0, 100 - errors * 20 - warnings * 5 - infos * 1);
      expect(result.review.score).toBe(expectedScore);
    });

    it('status should be issues when only warnings are present (no errors)', async () => {
      const reviewer = new CodeReviewAgent();
      const code = "console.log('warn only');";

      const raw = await reviewer.perform({ action: 'review', content: code, file: 'main.ts' });
      const result = JSON.parse(raw);

      const hasWarnings = result.review.findings.some(
        (f: { severity: string }) => f.severity === 'warning'
      );
      const hasErrors = result.review.findings.some(
        (f: { severity: string }) => f.severity === 'error'
      );

      expect(hasWarnings).toBe(true);
      expect(hasErrors).toBe(false);
      expect(result.review.status).toBe('issues');
    });
  });

  // ── Additional: suggest missing content ──────────────────────────────────

  describe('suggest: missing content', () => {
    it('should return an error when content is not provided for suggest', async () => {
      const reviewer = new CodeReviewAgent();
      const raw = await reviewer.perform({ action: 'suggest' });
      const result = JSON.parse(raw);

      expect(result.status).toBe('error');
      expect(result.message).toMatch(/content/i);
    });
  });

  // ── Additional: diff_review missing diff ─────────────────────────────────

  describe('diff_review: missing diff', () => {
    it('should return an error when diff is not provided for diff_review', async () => {
      const reviewer = new CodeReviewAgent();
      const raw = await reviewer.perform({ action: 'diff_review' });
      const result = JSON.parse(raw);

      expect(result.status).toBe('error');
      expect(result.message).toMatch(/diff/i);
    });
  });

  // ── Additional: FIXME and HACK also trigger todo-comment ─────────────────

  describe('review: FIXME and HACK trigger todo-comment', () => {
    it('should find FIXME as an info todo-comment finding', async () => {
      const reviewer = new CodeReviewAgent();
      const code = '// FIXME: this is broken';

      const raw = await reviewer.perform({ action: 'review', content: code, file: 'broken.ts' });
      const result = JSON.parse(raw);

      const todoFindings = result.review.findings.filter(
        (f: { rule: string }) => f.rule === 'todo-comment'
      );
      expect(todoFindings.length).toBeGreaterThanOrEqual(1);
      expect(todoFindings[0].severity).toBe('info');
    });

    it('should find HACK as an info todo-comment finding', async () => {
      const reviewer = new CodeReviewAgent();
      const code = '// HACK: workaround for issue #42';

      const raw = await reviewer.perform({ action: 'review', content: code, file: 'hack.ts' });
      const result = JSON.parse(raw);

      const todoFindings = result.review.findings.filter(
        (f: { rule: string }) => f.rule === 'todo-comment'
      );
      expect(todoFindings.length).toBeGreaterThanOrEqual(1);
      expect(todoFindings[0].severity).toBe('info');
    });
  });

  // ── Additional: console.warn and console.error also trigger no-console ────

  describe('review: console.warn and console.error', () => {
    it('should flag console.warn in a non-test file', async () => {
      const reviewer = new CodeReviewAgent();
      const code = "console.warn('low disk space');";

      const raw = await reviewer.perform({ action: 'review', content: code, file: 'monitor.ts' });
      const result = JSON.parse(raw);

      const consoleFindings = result.review.findings.filter(
        (f: { rule: string }) => f.rule === 'no-console'
      );
      expect(consoleFindings.length).toBeGreaterThanOrEqual(1);
    });

    it('should flag console.error in a non-test file', async () => {
      const reviewer = new CodeReviewAgent();
      const code = "console.error('something failed');";

      const raw = await reviewer.perform({ action: 'review', content: code, file: 'handler.ts' });
      const result = JSON.parse(raw);

      const consoleFindings = result.review.findings.filter(
        (f: { rule: string }) => f.rule === 'no-console'
      );
      expect(consoleFindings.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Additional: exported function WITH explicit return type is clean ───────

  describe('review: explicit-return-type not triggered when type present', () => {
    it('should NOT produce an explicit-return-type finding when return type is declared', async () => {
      const reviewer = new CodeReviewAgent();
      const code = ['export function bar(): string {', "  return 'hello';", '}'].join('\n');

      const raw = await reviewer.perform({ action: 'review', content: code, file: 'bar.ts' });
      const result = JSON.parse(raw);

      const returnTypeFindings = result.review.findings.filter(
        (f: { rule: string }) => f.rule === 'explicit-return-type'
      );
      expect(returnTypeFindings).toHaveLength(0);
    });
  });
});
