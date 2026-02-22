/**
 * CodeReviewAgent - Deterministic heuristic code review agent.
 *
 * Performs static code analysis using pattern matching (no LLM).
 * Checks for common code quality issues and produces a scored review.
 *
 * Actions: review, suggest, diff_review
 *
 * Mirrors Python agents/code_review_agent.py
 */

import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';

// ── Type Definitions ────────────────────────────────────────────────

export interface ReviewFinding {
  severity: 'error' | 'warning' | 'info';
  rule: string;
  message: string;
  line?: number;
}

export interface ReviewResult {
  file?: string;
  findings: ReviewFinding[];
  summary: string;
  score: number;     // 0-100
  status: 'clean' | 'issues' | 'critical';
}

// ── CodeReviewAgent ─────────────────────────────────────────────────

export class CodeReviewAgent extends BasicAgent {
  private maxLineLength: number;

  constructor(options?: { maxLineLength?: number }) {
    const metadata: AgentMetadata = {
      name: 'CodeReview',
      description:
        'Deterministic heuristic code review agent. Checks for common quality issues like long lines, TODO comments, console.log usage, excessive any types, duplicate imports, and missing return types.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'The review action to perform.',
            enum: ['review', 'suggest', 'diff_review'],
          },
          content: {
            type: 'string',
            description: 'Source code content to review.',
          },
          file: {
            type: 'string',
            description: 'File name (used for context, e.g. test detection).',
          },
          diff: {
            type: 'string',
            description: 'Git diff content for diff_review action.',
          },
          maxLineLength: {
            type: 'number',
            description: 'Maximum line length (default: 120).',
          },
        },
        required: [],
      },
    };
    super('CodeReview', metadata);
    this.maxLineLength = options?.maxLineLength ?? 120;
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const action = kwargs.action as string | undefined;

    if (!action) {
      return JSON.stringify({
        status: 'error',
        message: 'No action specified. Use: review, suggest, or diff_review',
      });
    }

    try {
      switch (action) {
        case 'review':
          return this.reviewCode(kwargs);
        case 'suggest':
          return this.suggestFixes(kwargs);
        case 'diff_review':
          return this.diffReview(kwargs);
        default:
          return JSON.stringify({
            status: 'error',
            message: `Unknown action: ${action}`,
          });
      }
    } catch (error) {
      return JSON.stringify({
        status: 'error',
        action,
        message: (error as Error).message,
      });
    }
  }

  // ── review ──────────────────────────────────────────────────────

  private reviewCode(kwargs: Record<string, unknown>): string {
    const content = kwargs.content as string | undefined;
    const file = kwargs.file as string | undefined;
    const maxLen = (kwargs.maxLineLength as number) ?? this.maxLineLength;

    if (!content) {
      return JSON.stringify({
        status: 'error',
        message: 'content is required for review',
      });
    }

    const findings = this.analyzeCode(content, file, maxLen);
    const result = this.buildReviewResult(findings, file);

    const dataSlush = this.slushOut({
      signals: {
        score: result.score,
        finding_count: findings.length,
        review_status: result.status,
      },
    });

    return JSON.stringify({
      status: 'success',
      action: 'review',
      review: result,
      data_slush: dataSlush,
    });
  }

  // ── suggest ─────────────────────────────────────────────────────

  private suggestFixes(kwargs: Record<string, unknown>): string {
    const content = kwargs.content as string | undefined;
    const file = kwargs.file as string | undefined;
    const maxLen = (kwargs.maxLineLength as number) ?? this.maxLineLength;

    if (!content) {
      return JSON.stringify({
        status: 'error',
        message: 'content is required for suggest',
      });
    }

    const findings = this.analyzeCode(content, file, maxLen);
    const suggestions = findings.map(f => ({
      ...f,
      suggestion: this.getSuggestion(f),
    }));

    const result = this.buildReviewResult(findings, file);

    const dataSlush = this.slushOut({
      signals: {
        score: result.score,
        suggestion_count: suggestions.length,
      },
    });

    return JSON.stringify({
      status: 'success',
      action: 'suggest',
      review: result,
      suggestions,
      data_slush: dataSlush,
    });
  }

  // ── diff_review ─────────────────────────────────────────────────

  private diffReview(kwargs: Record<string, unknown>): string {
    const diff = kwargs.diff as string | undefined;
    const maxLen = (kwargs.maxLineLength as number) ?? this.maxLineLength;

    if (!diff) {
      return JSON.stringify({
        status: 'error',
        message: 'diff is required for diff_review',
      });
    }

    // Parse diff: only review added lines
    const addedLines: string[] = [];
    const lines = diff.split('\n');
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        addedLines.push(line.substring(1));
      }
    }

    const content = addedLines.join('\n');
    const findings = this.analyzeCode(content, undefined, maxLen);
    const result = this.buildReviewResult(findings);

    const dataSlush = this.slushOut({
      signals: {
        score: result.score,
        added_lines: addedLines.length,
        finding_count: findings.length,
      },
    });

    return JSON.stringify({
      status: 'success',
      action: 'diff_review',
      review: result,
      addedLineCount: addedLines.length,
      data_slush: dataSlush,
    });
  }

  // ── Analysis Checks ─────────────────────────────────────────────

  private analyzeCode(content: string, file?: string, maxLen?: number): ReviewFinding[] {
    const findings: ReviewFinding[] = [];
    const lines = content.split('\n');
    const effectiveMaxLen = maxLen ?? this.maxLineLength;
    const isTestFile = file ? /\.(test|spec)\.(ts|js|tsx|jsx)$/.test(file) : false;

    // Check 1: Line length
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > effectiveMaxLen) {
        findings.push({
          severity: 'warning',
          rule: 'line-length',
          message: `Line exceeds ${effectiveMaxLen} characters (${lines[i].length})`,
          line: i + 1,
        });
      }
    }

    // Check 2: TODO/FIXME/HACK comments
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/\b(TODO|FIXME|HACK)\b/);
      if (match) {
        findings.push({
          severity: 'info',
          rule: 'todo-comment',
          message: `${match[1]} comment found`,
          line: i + 1,
        });
      }
    }

    // Check 3: console.log/warn/error in non-test files
    if (!isTestFile) {
      for (let i = 0; i < lines.length; i++) {
        if (/\bconsole\.(log|warn|error)\b/.test(lines[i])) {
          findings.push({
            severity: 'warning',
            rule: 'no-console',
            message: 'console statement found in non-test file',
            line: i + 1,
          });
        }
      }
    }

    // Check 4: Excessive `any` types
    let anyCount = 0;
    for (let i = 0; i < lines.length; i++) {
      const anyMatches = lines[i].match(/:\s*any\b/g);
      if (anyMatches) {
        anyCount += anyMatches.length;
      }
    }
    if (anyCount > 5) {
      findings.push({
        severity: 'warning',
        rule: 'no-excessive-any',
        message: `Excessive use of 'any' type (${anyCount} occurrences)`,
      });
    }

    // Check 5: Duplicate imports
    const imports = new Map<string, number[]>();
    for (let i = 0; i < lines.length; i++) {
      const importMatch = lines[i].match(/^import\s+.*from\s+['"]([^'"]+)['"]/);
      if (importMatch) {
        const source = importMatch[1];
        if (!imports.has(source)) {
          imports.set(source, []);
        }
        imports.get(source)!.push(i + 1);
      }
    }
    for (const [source, lineNums] of imports) {
      if (lineNums.length > 1) {
        findings.push({
          severity: 'warning',
          rule: 'no-duplicate-imports',
          message: `Duplicate import from '${source}' on lines ${lineNums.join(', ')}`,
          line: lineNums[1],
        });
      }
    }

    // Check 6: Missing explicit return types on exports
    for (let i = 0; i < lines.length; i++) {
      const exportFnMatch = lines[i].match(/^export\s+(async\s+)?function\s+\w+\([^)]*\)\s*\{/);
      if (exportFnMatch && !lines[i].includes(':') || (exportFnMatch && !lines[i].match(/\)\s*:\s*\S/))) {
        // Check if there's a return type annotation after the closing paren
        if (exportFnMatch && !lines[i].match(/\)\s*:\s*\S+/)) {
          findings.push({
            severity: 'info',
            rule: 'explicit-return-type',
            message: 'Exported function missing explicit return type',
            line: i + 1,
          });
        }
      }
    }

    return findings;
  }

  // ── Scoring ─────────────────────────────────────────────────────

  private buildReviewResult(findings: ReviewFinding[], file?: string): ReviewResult {
    const errors = findings.filter(f => f.severity === 'error').length;
    const warnings = findings.filter(f => f.severity === 'warning').length;
    const infos = findings.filter(f => f.severity === 'info').length;

    const score = Math.max(0, 100 - (errors * 20) - (warnings * 5) - (infos * 1));

    let status: 'clean' | 'issues' | 'critical';
    if (errors > 0) {
      status = 'critical';
    } else if (warnings > 0) {
      status = 'issues';
    } else {
      status = 'clean';
    }

    const summary = findings.length === 0
      ? 'No issues found'
      : `Found ${findings.length} issue(s): ${errors} error(s), ${warnings} warning(s), ${infos} info(s)`;

    return {
      file,
      findings,
      summary,
      score,
      status,
    };
  }

  // ── Suggestions ─────────────────────────────────────────────────

  private getSuggestion(finding: ReviewFinding): string {
    switch (finding.rule) {
      case 'line-length':
        return 'Break the line into multiple lines or extract into a variable';
      case 'todo-comment':
        return 'Address the TODO/FIXME/HACK or create a tracking issue';
      case 'no-console':
        return 'Remove console statement or replace with a proper logger';
      case 'no-excessive-any':
        return 'Replace any with specific types or use unknown';
      case 'no-duplicate-imports':
        return 'Merge duplicate imports into a single import statement';
      case 'explicit-return-type':
        return 'Add an explicit return type annotation to the exported function';
      default:
        return 'Review and fix the issue';
    }
  }
}
