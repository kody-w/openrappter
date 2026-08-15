import { z } from 'zod';

import type { LLMProvider } from '../providers/types.js';
import { chatWithFlightRecorder } from '../providers/recorded-chat.js';
import { sanitizeShowAndTellText } from './privacy.js';
import type { ShowAndTellStore } from './store.js';
import {
  SHOW_AND_TELL_ANALYSIS_SCHEMA,
  type ShowAndTellAnalysis,
  type ShowAndTellConfidence,
  type ShowAndTellEvent,
  type ShowAndTellSession,
  type ShowAndTellStep,
} from './types.js';

const StepSchema = z.object({
  id: z.string().min(1).max(32),
  title: z.string().min(1).max(160),
  detail: z.string().min(1).max(1200),
  kind: z.enum(['calculation', 'action']).default('action'),
  tool: z.string().max(120).default(''),
  app: z.string().max(160).default(''),
  url: z.string().max(1000).default(''),
  evidence: z.array(z.string().max(240)).max(20).default([]),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
});

const SubmissionSchema = z.object({
  title: z.string().min(1).max(160),
  intent: z.string().min(1).max(1200),
  intentRationale: z.string().min(1).max(2000),
  intentConfidence: z.enum(['high', 'medium', 'low']),
  steps: z.array(StepSchema).min(1).max(60),
});

function titleFromIntent(intent: string): string {
  return intent
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join(' ') || 'Recorded workflow';
}

function toolFor(app: string, url: string, action = ''): string {
  if (url) return 'Browser or Web';
  if (/\b(?:terminal|iterm|powershell|command prompt|console)\b/i.test(app)) {
    return 'Shell';
  }
  if (/\b(?:finder|explorer|files)\b/i.test(app)) return 'Shell or filesystem';
  if (action === 'read_screen' || action === 'screenshot') return 'ComputerUse';
  return app ? 'Native app tool, otherwise ComputerUse' : 'Best available native tool';
}

function step(
  id: number,
  title: string,
  detail: string,
  event: ShowAndTellEvent,
  options: Partial<ShowAndTellStep> = {},
): ShowAndTellStep {
  return StepSchema.parse({
    id: `s${id}`,
    title,
    detail,
    kind: options.kind ?? 'action',
    tool: options.tool ?? '',
    app: options.app ?? '',
    url: options.url ?? '',
    evidence: options.evidence ?? [`event:${event.sequence}:${event.type}`],
    confidence: options.confidence ?? 'medium',
  });
}

function deterministicSteps(events: ShowAndTellEvent[]): ShowAndTellStep[] {
  const steps: ShowAndTellStep[] = [];
  let currentApp = '';
  for (const event of events) {
    const data = event.data;
    let candidate: ShowAndTellStep | null = null;
    if (event.type === 'manual.observation') {
      const title = sanitizeShowAndTellText(data.title, 160) || 'Completed a demonstrated step';
      const detail = sanitizeShowAndTellText(data.detail, 1200) || title;
      const app = sanitizeShowAndTellText(data.app, 160) || currentApp;
      const url = sanitizeShowAndTellText(data.url, 1000);
      candidate = step(steps.length + 1, title, detail, event, {
        app,
        url,
        tool: toolFor(app, url),
        confidence: 'high',
      });
    } else if (event.type === 'computer.action') {
      if (data.status === 'error') continue;
      const action = sanitizeShowAndTellText(data.action, 80) || 'action';
      const app = sanitizeShowAndTellText(data.app, 160) || currentApp;
      const label = action.replace(/_/g, ' ');
      candidate = step(
        steps.length + 1,
        `${label.charAt(0).toUpperCase()}${label.slice(1)}`,
        `Used ${label}${app ? ` in ${app}` : ''}.`,
        event,
        { app, tool: toolFor(app, '', action), confidence: 'high' },
      );
    } else if (event.type === 'browser.url') {
      const url = sanitizeShowAndTellText(data.url, 1000);
      const app = sanitizeShowAndTellText(data.app, 160) || currentApp;
      if (url) {
        candidate = step(
          steps.length + 1,
          'Opened a browser destination',
          `Navigated to ${url}.`,
          event,
          { app, url, tool: toolFor(app, url), confidence: 'high' },
        );
      }
    } else if (event.type === 'app.activate') {
      const app = sanitizeShowAndTellText(data.app, 160);
      const window = sanitizeShowAndTellText(data.window, 240);
      currentApp = app || currentApp;
      if (app && !data.privateContext) {
        candidate = step(
          steps.length + 1,
          `Worked in ${app}`,
          window ? `Opened or focused "${window}" in ${app}.` : `Opened or focused ${app}.`,
          event,
          { app, tool: toolFor(app, ''), confidence: 'medium' },
        );
      }
    } else if (event.type === 'frame.captured') {
      const label = sanitizeShowAndTellText(data.label, 160);
      if (label) {
        candidate = step(
          steps.length + 1,
          label,
          'Captured an explicit local reference frame for this point in the workflow.',
          event,
          {
            app: currentApp,
            tool: toolFor(currentApp, '', 'screenshot'),
            confidence: 'medium',
          },
        );
      }
    } else if (event.type === 'session.note') {
      const note = sanitizeShowAndTellText(data.note, 1200);
      if (note) {
        const previous = steps.at(-1);
        if (previous) {
          previous.detail = sanitizeShowAndTellText(
            `${previous.detail} Narration: ${note}`,
            1200,
          );
          previous.evidence.push(`event:${event.sequence}:${event.type}`);
          if (previous.confidence === 'low') previous.confidence = 'medium';
          continue;
        }
        candidate = step(
          steps.length + 1,
          'Follow the narrated instruction',
          note,
          event,
          {
            app: currentApp,
            tool: toolFor(currentApp, ''),
            confidence: 'medium',
          },
        );
      }
    }

    if (!candidate) continue;
    const previous = steps.at(-1);
    if (
      previous &&
      previous.title === candidate.title &&
      previous.app === candidate.app &&
      previous.url === candidate.url
    ) {
      previous.evidence.push(...candidate.evidence);
      continue;
    }
    steps.push(candidate);
    if (steps.length >= 60) break;
  }

  if (steps.length === 0) {
    const event = events[0] ?? {
      id: 'none',
      sessionId: '',
      sequence: 0,
      timestamp: Date.now(),
      type: 'session.started',
      source: 'show-and-tell',
      data: {},
    };
    steps.push(
      step(
        1,
        'Repeat the demonstrated task',
        'Use the session notes and explicit observations to reproduce the demonstrated outcome.',
        event,
        { tool: 'Best available native tool', confidence: 'low' },
      ),
    );
  }
  return steps;
}

export function buildDeterministicAnalysis(
  session: ShowAndTellSession,
  events: ShowAndTellEvent[],
  previous?: ShowAndTellAnalysis | null,
): ShowAndTellAnalysis {
  const note = events
    .filter((event) => event.type === 'session.note')
    .map((event) => sanitizeShowAndTellText(event.data.note, 1000))
    .find(Boolean);
  const intent =
    sanitizeShowAndTellText(session.intentHint, 1200) ||
    note ||
    'Repeat the demonstrated workflow';
  const steps = deterministicSteps(events);
  const highEvidence = steps.filter((candidate) => candidate.confidence === 'high').length;
  const confidence: ShowAndTellConfidence =
    highEvidence >= 2 ? 'high' : steps.length >= 2 ? 'medium' : 'low';
  const now = Date.now();
  return {
    schema: SHOW_AND_TELL_ANALYSIS_SCHEMA,
    sessionId: session.id,
    revision: (previous?.revision ?? 0) + 1,
    title: session.title || titleFromIntent(intent),
    intent,
    intentRationale:
      `Reconstructed from ${events.length} local event(s), including ` +
      `${steps.length} distinct workflow step(s).`,
    intentConfidence: confidence,
    steps,
    feedbackLog: previous?.feedbackLog ?? [],
    approved: false,
    approvedAt: null,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
}

function modelPrompt(
  baseline: ShowAndTellAnalysis,
  events: ShowAndTellEvent[],
): string {
  const summaries = events.slice(0, 120).map((event) => ({
    sequence: event.sequence,
    type: event.type,
    source: event.source,
    data:
      event.type === 'frame.captured'
        ? { label: event.data.label, frameAvailableLocally: true }
        : event.data,
  }));
  return `You are reconstructing a user-demonstrated workflow.

Return ONLY JSON with: title, intent, intentRationale, intentConfidence
(high|medium|low), and ordered steps. Each step must contain id, title, detail,
kind (calculation|action), tool, app, url, evidence[], confidence.

Generalize the goal, preserve evidence, prefer native APIs/CLI/browser tools over
pixel replay, and never invent credentials or content not present below. Raw
screenshots are intentionally not provided.

Deterministic baseline:
${JSON.stringify(baseline)}

Privacy-safe event summary:
${JSON.stringify(summaries)}`;
}

function parseModelJson(content: string): unknown {
  const trimmed = content.trim();
  const unfenced = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed;
  return JSON.parse(unfenced);
}

export async function analyzeShowAndTellSession(
  store: ShowAndTellStore,
  session: ShowAndTellSession,
  provider?: LLMProvider | null,
): Promise<{ analysis: ShowAndTellAnalysis; enhanced: boolean; warning?: string }> {
  const events = await store.events(session.id);
  const previous = await store.getAnalysis(session.id);
  const baseline = buildDeterministicAnalysis(session, events, previous);
  if (!provider) {
    await store.saveAnalysis(baseline);
    return { analysis: baseline, enhanced: false };
  }

  try {
    const response = await chatWithFlightRecorder({
      provider,
      messages: [{ role: 'user', content: modelPrompt(baseline, events) }],
      options: {
        model: process.env.OPENRAPPTER_MODEL,
        temperature: 0.1,
        max_tokens: 4_000,
      },
      source: 'show-and-tell',
      scope: { sessionId: session.id },
      attributes: { phase: 'analysis' },
    });
    if (!response.content) throw new Error('The model returned no analysis.');
    const submission = SubmissionSchema.parse(parseModelJson(response.content));
    const analysis: ShowAndTellAnalysis = {
      ...baseline,
      title: submission.title,
      intent: submission.intent,
      intentRationale: submission.intentRationale,
      intentConfidence: submission.intentConfidence,
      steps: submission.steps,
      updatedAt: Date.now(),
    };
    await store.saveAnalysis(analysis);
    return { analysis, enhanced: true };
  } catch (error) {
    await store.saveAnalysis(baseline);
    return {
      analysis: baseline,
      enhanced: false,
      warning:
        `Model refinement was rejected; using deterministic analysis: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function reviseAnalysis(
  current: ShowAndTellAnalysis,
  input: {
    intent?: unknown;
    title?: unknown;
    stepsJson?: unknown;
    feedback?: unknown;
    approve?: boolean;
  },
): ShowAndTellAnalysis {
  let steps = current.steps;
  if (typeof input.stepsJson === 'string' && input.stepsJson.trim()) {
    const parsed = JSON.parse(input.stepsJson) as unknown;
    steps = z.array(StepSchema).min(1).max(60).parse(parsed);
  }
  const feedback = sanitizeShowAndTellText(input.feedback, 2000);
  const now = Date.now();
  return {
    ...current,
    revision: current.revision + 1,
    title: sanitizeShowAndTellText(input.title, 160) || current.title,
    intent: sanitizeShowAndTellText(input.intent, 1200) || current.intent,
    steps,
    feedbackLog: feedback
      ? [...current.feedbackLog, { at: now, feedback }]
      : current.feedbackLog,
    approved: input.approve === true,
    approvedAt: input.approve === true ? now : null,
    updatedAt: now,
  };
}
