/**
 * Analysis -> reviewable plan -> (only then) build.
 *
 * The analysis answers "what happened". This file answers "what would be
 * built, and on what terms": which literals from the single demonstration are
 * editable inputs rather than universal truths, which steps refuse to run
 * unattended, and which parts of the recording nothing explained.
 *
 * A plan is a proposal. It is never built from until someone approves it, and
 * approval is a separate, consent-gated turn.
 *
 * Mirrored in `python/openrappter/show_and_tell_skill.py`.
 */

import { detourEvidence } from './bundle.js';
import {
  compareStrings,
  hasSecretFindings,
  maskSensitivePayload,
  maskSensitiveText,
  privacyReducedPath,
  privacyReducedUrl,
  sanitizeShowAndTellText,
  scanSensitivePayload,
  SENSITIVE_MASK,
  type SensitiveFinding,
} from './privacy.js';
import {
  SHOW_AND_TELL_PLAN_SCHEMA,
  type ShowAndTellAnalysis,
  type ShowAndTellPlanStep,
  type ShowAndTellRiskCategory,
  type ShowAndTellSessionBundle,
  type ShowAndTellSkillPlan,
  type ShowAndTellStep,
  type ShowAndTellValue,
  type ShowAndTellValueKind,
} from './types.js';

interface ValueRule {
  kind: ShowAndTellValueKind;
  pattern: RegExp;
}

/**
 * Ordered most specific first so a URL is lifted as a URL before the number
 * rule can claim the port out of it.
 */
const VALUE_RULES: readonly ValueRule[] = [
  { kind: 'url', pattern: /https?:\/\/[^\s"'<>)\]]+/g },
  {
    kind: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g,
  },
  { kind: 'path', pattern: /(?:[A-Za-z]:\\|~\/|\/)[A-Za-z0-9._~\-/\\]{2,}/g },
  {
    kind: 'date',
    pattern:
      /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})\b/g,
  },
  {
    kind: 'amount',
    pattern:
      /(?:[$£€]\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|EUR|GBP)\b)/g,
  },
  {
    kind: 'identifier',
    pattern: /(?:\b[A-Z][A-Z0-9]*[-_]\d{2,}\b|#\d{2,}\b)/g,
  },
  { kind: 'text', pattern: /"[^"\n]{1,80}"/g },
  { kind: 'number', pattern: /\b\d[\d,]*(?:\.\d+)?\b/g },
];

const RISK_RULES: ReadonlyArray<{
  category: ShowAndTellRiskCategory;
  pattern: RegExp;
}> = [
  {
    category: 'destructive',
    pattern:
      /\b(?:delete|deletes|deleted|remove|removes|removed|drop|erase|wipe|truncate|revoke|terminate|uninstall|rm\s+-rf)\b/i,
  },
  {
    category: 'financial',
    pattern:
      /\b(?:pay|pays|paid|payment|refund|refunds|invoice|charge|charges|purchase|checkout|transfer|wire|billing|payroll|reimburse)\b/i,
  },
  {
    category: 'publishing',
    pattern:
      /\b(?:publish|publishes|deploy|deploys|release|releases|merge|merges|ship|tag\s+the\s+release|force[-\s]push)\b/i,
  },
  {
    category: 'messaging',
    pattern:
      /\b(?:send|sends|sent|email|emails|message|messages|post|posts|reply|replies|notify|broadcast|share\s+with)\b/i,
  },
  {
    category: 'credential',
    pattern:
      /\b(?:password|passphrase|token|secret|credential|api\s+key|sign[-\s]?in|log[-\s]?in|two[-\s]factor|mfa|otp)\b/i,
  },
];

const VALUE_LABELS: Record<ShowAndTellValueKind, string> = {
  url: 'Destination',
  email: 'Email address',
  path: 'File or folder path',
  date: 'Date',
  amount: 'Amount',
  identifier: 'Record identifier',
  text: 'Quoted text',
  number: 'Number',
};

const MAX_VALUES = 40;

/** Union of two finding lists, summed per path and kind, deterministically. */
function mergeFindings(
  left: readonly SensitiveFinding[],
  right: readonly SensitiveFinding[],
): SensitiveFinding[] {
  const merged = new Map<string, SensitiveFinding>();
  for (const finding of [...left, ...right]) {
    const key = `${finding.path}\u0000${finding.kind}`;
    const existing = merged.get(key);
    if (existing) existing.count += finding.count;
    else merged.set(key, { ...finding });
  }
  return [...merged.values()].sort(
    (first, second) =>
      compareStrings(first.path, second.path) ||
      compareStrings(first.kind, second.kind),
  );
}

class ValueTable {
  private readonly byLiteral = new Map<string, ShowAndTellValue>();
  private readonly counters = new Map<ShowAndTellValueKind, number>();

  reference(
    literal: string,
    kind: ShowAndTellValueKind,
    occurrence: string,
  ): string | null {
    const key = `${kind}\u0000${literal}`;
    const existing = this.byLiteral.get(key);
    if (existing) {
      if (!existing.occurrences.includes(occurrence)) {
        existing.occurrences.push(occurrence);
      }
      return existing.id;
    }
    if (this.byLiteral.size >= MAX_VALUES) return null;
    const next = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, next);
    const id = `${kind}_${next}`;
    // The text reaching here is already masked, so an example can only carry
    // a mask marker, never the value behind it.
    const example =
      kind === 'url'
        ? privacyReducedUrl(literal) || literal
        : kind === 'path'
          ? privacyReducedPath(literal) || '<local-path>'
          : literal;
    this.byLiteral.set(key, {
      id,
      kind,
      label: `${VALUE_LABELS[kind]} ${next}`,
      example,
      exampleMasked: example.includes(SENSITIVE_MASK),
      required: true,
      occurrences: [occurrence],
    });
    return id;
  }

  list(): ShowAndTellValue[] {
    return [...this.byLiteral.values()];
  }
}

function templateText(
  text: string,
  table: ValueTable,
  occurrence: string,
  used: Set<string>,
): string {
  let output = text;
  for (const rule of VALUE_RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    output = output.replace(pattern, (match) => {
      const id = table.reference(match, rule.kind, occurrence);
      if (!id) return match;
      used.add(id);
      return `{{${id}}}`;
    });
  }
  return output;
}

function riskCategories(text: string): ShowAndTellRiskCategory[] {
  return RISK_RULES.filter((rule) => rule.pattern.test(text))
    .map((rule) => rule.category)
    .sort();
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function urlHost(url: string): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function planSteps(
  steps: readonly ShowAndTellStep[],
  table: ValueTable,
): ShowAndTellPlanStep[] {
  return steps.map((step, index) => {
    const id = step.id || `s${index + 1}`;
    const used = new Set<string>();
    // Masking runs before extraction on purpose. Extracting first would slice
    // a card number into four editable "number" values and leave nothing for
    // the scanner to recognise.
    const title = templateText(
      maskSensitiveText(sanitizeShowAndTellText(step.title, 160)),
      table,
      `step:${id}:title`,
      used,
    );
    const detail = templateText(
      maskSensitiveText(sanitizeShowAndTellText(step.detail, 1200)),
      table,
      `step:${id}:detail`,
      used,
    );
    const reducedUrl = privacyReducedUrl(step.url);
    const url = reducedUrl
      ? templateText(maskSensitiveText(reducedUrl), table, `step:${id}:url`, used)
      : '';
    const categories = riskCategories(`${step.title} ${step.detail}`);
    return {
      id,
      title,
      detail,
      kind: step.kind === 'calculation' ? 'calculation' : 'action',
      tool: sanitizeShowAndTellText(step.tool, 120),
      app: sanitizeShowAndTellText(step.app, 160),
      url,
      evidence: [...step.evidence],
      confidence: step.confidence,
      values: [...used].sort(),
      requiresConfirmation: categories.length > 0,
      riskCategories: categories,
    };
  });
}

function metadataFor(
  intent: string,
  steps: readonly ShowAndTellPlanStep[],
  values: readonly ShowAndTellValue[],
): { useWhen: string[]; useFor: string[]; doNotUseWhen: string[] } {
  const apps = [...new Set(steps.map((step) => step.app).filter(Boolean))].slice(0, 3);
  const hosts = [
    ...new Set(steps.map((step) => urlHost(step.url)).filter(Boolean)),
  ].slice(0, 3);
  const useWhen = [
    `The user asks to ${lowerFirst(intent)}`,
    ...apps.map((app) => `The work happens in ${app}.`),
    ...hosts.map((host) => `The workflow targets ${host}.`),
  ];
  const useFor = [...new Set(steps.map((step) => step.title))].slice(0, 6);
  const risky = [
    ...new Set(steps.flatMap((step) => step.riskCategories)),
  ].sort();
  const doNotUseWhen = [
    'Credentials, one-time codes, or sign-in material from the demonstration would be needed.',
    'Replaying recorded screen coordinates is the only way to complete the task.',
  ];
  if (values.length > 0) {
    doNotUseWhen.push(
      `The recorded inputs (${values
        .map((value) => `{{${value.id}}}`)
        .join(', ')}) do not apply and no replacement is supplied.`,
    );
  }
  if (risky.length > 0) {
    doNotUseWhen.push(
      `Unattended execution is expected: ${risky.join(', ')} steps stop for confirmation.`,
    );
  }
  return { useWhen, useFor, doNotUseWhen };
}

export interface BuildSkillPlanOptions {
  previous?: ShowAndTellSkillPlan | null;
  now?: number;
}

export function buildSkillPlan(
  analysis: ShowAndTellAnalysis,
  bundle: ShowAndTellSessionBundle,
  options: BuildSkillPlanOptions = {},
): ShowAndTellSkillPlan {
  const now = options.now ?? Date.now();
  const previous = options.previous ?? null;
  const detours = detourEvidence(bundle);
  const openQuestions: string[] = [...bundle.warnings];

  const kept = analysis.steps.filter(
    (step) =>
      step.evidence.length === 0 ||
      !step.evidence.every((reference) => detours.has(reference)),
  );
  let considered: readonly ShowAndTellStep[] = kept;
  if (kept.length === 0) {
    considered = analysis.steps;
    if (analysis.steps.length > 0) {
      openQuestions.push(
        'Every reconstructed step sits inside a detour segment, so none were dropped. Review the order before approving.',
      );
    }
  } else if (kept.length < analysis.steps.length) {
    openQuestions.push(
      `${analysis.steps.length - kept.length} step(s) were dropped because their only evidence was in a detour.`,
    );
  }

  const table = new ValueTable();
  // What the recording carried, recorded as paths and kinds before any of it
  // is masked away, so the plan can say what it removed and from where.
  const inputFindings = mergeFindings(
    scanSensitivePayload(considered, '$.steps'),
    scanSensitivePayload(
      { title: analysis.title, intent: analysis.intent },
      '$',
    ),
  );
  const steps = planSteps(considered, table);
  const values = table.list();
  const intent =
    maskSensitiveText(sanitizeShowAndTellText(analysis.intent, 1200)) ||
    'Repeat the demonstrated workflow';
  const metadata = metadataFor(intent, steps, values);

  const lowConfidence = steps.filter((step) => step.confidence === 'low').length;
  if (lowConfidence > 0) {
    openQuestions.push(
      `${lowConfidence} step(s) are low confidence and were reconstructed from weak evidence.`,
    );
  }
  const singleUse = values.filter((value) => value.occurrences.length === 1);
  if (singleUse.length > 0) {
    openQuestions.push(
      `${singleUse.length} value(s) were seen once in one demonstration; confirm each is an input and not a constant.`,
    );
  }
  const confirmations = steps.filter((step) => step.requiresConfirmation).length;
  if (confirmations > 0) {
    openQuestions.push(
      `${confirmations} step(s) have side effects and will ask before running.`,
    );
  }

  const draft = {
    schema: SHOW_AND_TELL_PLAN_SCHEMA,
    sessionId: analysis.sessionId,
    analysisRevision: analysis.revision,
    revision: (previous?.revision ?? 0) + 1,
    title:
      maskSensitiveText(sanitizeShowAndTellText(analysis.title, 160)) ||
      'Recorded workflow',
    intent,
    ...metadata,
    steps,
    values,
    evidenceStats: bundle.stats,
    openQuestions,
  };
  const scanned = maskSensitivePayload({
    title: draft.title,
    intent: draft.intent,
    useWhen: draft.useWhen,
    useFor: draft.useFor,
    doNotUseWhen: draft.doNotUseWhen,
    steps: draft.steps,
    values: draft.values,
    openQuestions: draft.openQuestions,
  });
  const findings = mergeFindings(inputFindings, scanned.findings);
  return {
    ...draft,
    ...scanned.value,
    privacy: {
      findings,
      masked: findings.length > 0,
      rawFramesShared: false,
    },
    feedbackLog: previous?.feedbackLog ?? [],
    approved: false,
    approvedAt: null,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
}

export interface RevisePlanInput {
  title?: unknown;
  intent?: unknown;
  valuesJson?: unknown;
  stepsJson?: unknown;
  feedback?: unknown;
  approve?: boolean;
}

function parsedArray(raw: unknown, label: string): unknown[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array.`);
  }
  return parsed;
}

/**
 * Applies reviewer edits. Editing any generated or trigger-bearing text resets approval —
 * approving a plan approves the text that was read, not a later version of it.
 */
export function revisePlan(
  current: ShowAndTellSkillPlan,
  input: RevisePlanInput,
  now = Date.now(),
): ShowAndTellSkillPlan {
  let steps = current.steps;
  const rawSteps = parsedArray(input.stepsJson, 'steps_json');
  if (rawSteps.length > 0) {
    if (rawSteps.length > 60) {
      throw new Error('steps_json may not contain more than 60 steps.');
    }
    steps = rawSteps.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('Every edited step must be a JSON object.');
      }
      const record = entry as Record<string, unknown>;
      const title = maskSensitiveText(sanitizeShowAndTellText(record.title, 160));
      const detail = maskSensitiveText(
        sanitizeShowAndTellText(record.detail, 1200),
      );
      if (!title || !detail) {
        throw new Error('Every edited step requires a title and a detail.');
      }
      const previous = current.steps[index];
      const categories = riskCategories(`${title} ${detail}`);
      return {
        id: sanitizeShowAndTellText(record.id, 32) || previous?.id || `s${index + 1}`,
        title,
        detail,
        kind: record.kind === 'calculation' ? 'calculation' : 'action',
        tool: sanitizeShowAndTellText(record.tool, 120) || previous?.tool || '',
        app: sanitizeShowAndTellText(record.app, 160) || previous?.app || '',
        url: maskSensitiveText(privacyReducedUrl(record.url)) || previous?.url || '',
        evidence: previous?.evidence ?? [],
        confidence: previous?.confidence ?? 'medium',
        values: [
          ...new Set(
            [...`${title} ${detail}`.matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)].map(
              (match) => match[1],
            ),
          ),
        ].sort(),
        requiresConfirmation: categories.length > 0,
        riskCategories: categories,
      } satisfies ShowAndTellPlanStep;
    });
  }

  let values = current.values;
  const rawValues = parsedArray(input.valuesJson, 'values_json');
  if (rawValues.length > 0) {
    const known = new Map(current.values.map((value) => [value.id, value]));
    values = rawValues.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('Every edited value must be a JSON object.');
      }
      const record = entry as Record<string, unknown>;
      const id = sanitizeShowAndTellText(record.id, 32);
      const existing = known.get(id);
      if (!existing) {
        throw new Error(`Unknown Show-and-Tell value id: ${id || '(missing)'}`);
      }
      const requested =
        sanitizeShowAndTellText(record.example, 240) || existing.example;
      const example = maskSensitiveText(requested);
      return {
        ...existing,
        label: sanitizeShowAndTellText(record.label, 120) || existing.label,
        example,
        exampleMasked: example.includes(SENSITIVE_MASK),
        required: record.required === false ? false : existing.required,
      } satisfies ShowAndTellValue;
    });
  }

  const feedback = maskSensitiveText(
    sanitizeShowAndTellText(input.feedback, 2000),
  );
  const edited =
    rawSteps.length > 0
    || rawValues.length > 0
    || (typeof input.title === 'string' && input.title.trim().length > 0)
    || (typeof input.intent === 'string' && input.intent.trim().length > 0);
  if (input.approve === true && edited) {
    // Approving text nobody has re-read is not approval. Edits land first,
    // the reviewer reads the revised plan, then approves it in its own turn.
    throw new Error(
      'Show-and-Tell edits and approval must be separate turns. Apply the edits, re-read the plan, then approve it.',
    );
  }
  const draft = {
    ...current,
    title:
      maskSensitiveText(sanitizeShowAndTellText(input.title, 160)) ||
      current.title,
    intent:
      maskSensitiveText(sanitizeShowAndTellText(input.intent, 1200)) ||
      current.intent,
    steps,
    values,
  };
  // What the reviewer's own edit carried, before masking removed it, stays on
  // the record next to what the recording carried.
  const editFindings = scanSensitivePayload(
    {
      steps: rawSteps,
      values: rawValues,
      title: input.title,
      intent: input.intent,
    },
    '$.edit',
  );
  const scanned = maskSensitivePayload({
    title: draft.title,
    intent: draft.intent,
    useWhen: draft.useWhen,
    useFor: draft.useFor,
    doNotUseWhen: draft.doNotUseWhen,
    steps: draft.steps,
    values: draft.values,
    openQuestions: draft.openQuestions,
  });
  const findings = mergeFindings(editFindings, scanned.findings);
  return {
    ...draft,
    ...scanned.value,
    revision: current.revision + 1,
    privacy: {
      findings,
      masked: findings.length > 0,
      rawFramesShared: false,
    },
    feedbackLog: feedback
      ? [...current.feedbackLog, { at: now, feedback }]
      : current.feedbackLog,
    approved: input.approve === true,
    approvedAt: input.approve === true ? now : null,
    updatedAt: now,
  };
}

/** Secret-class findings that must block a build outright. */
export function planSecretFindings(
  plan: ShowAndTellSkillPlan,
): SensitiveFinding[] {
  return plan.privacy.findings.filter((finding) =>
    hasSecretFindings([finding]),
  );
}
