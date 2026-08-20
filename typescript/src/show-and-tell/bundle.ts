/**
 * Deterministic segmentation of a recorded session.
 *
 * A demonstration is not a clean list of steps. People switch apps, answer a
 * message, come back, capture a frame they never explain, and work in silence
 * for a minute. Segmenting first — and counting what the recording could *not*
 * account for — keeps that visible instead of letting a confident-sounding
 * step list imply the recording explained everything.
 *
 * Everything here is a pure function of the session and its events: no clock
 * reads, no randomness, no model. The same events always produce the same
 * bundle, in TypeScript and in Python.
 */

import { sanitizeShowAndTellText } from './privacy.js';
import {
  SHOW_AND_TELL_BUNDLE_SCHEMA,
  type ShowAndTellBundleStats,
  type ShowAndTellEvent,
  type ShowAndTellSegment,
  type ShowAndTellSession,
  type ShowAndTellSessionBundle,
} from './types.js';

/** Collector bookkeeping. Real, but not evidence of what the user did. */
const LIFECYCLE_TYPES = new Set([
  'session.started',
  'session.stopped',
  'session.stop.requested',
  'collector.started',
  'collector.heartbeat',
  'collector.stopped',
  'collector.error',
]);

const NARRATION_TYPES = new Set(['session.note', 'narration.transcribed']);
const ACTION_TYPES = new Set(['computer.action', 'manual.observation']);

/** A pause longer than this starts a new segment. */
export const SEGMENT_GAP_MS = 30_000;
/** An unexplained context-only hop shorter than this reads as a detour. */
export const DETOUR_MAX_MS = 15_000;

function eventElapsed(
  event: ShowAndTellEvent,
  session: ShowAndTellSession,
): { elapsedMs: number; estimated: boolean } {
  if (typeof event.elapsedMs === 'number') {
    return { elapsedMs: Math.max(0, Math.trunc(event.elapsedMs)), estimated: false };
  }
  return {
    elapsedMs: Math.max(0, Math.trunc(event.timestamp - session.startedAt)),
    estimated: true,
  };
}

function host(url: string): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function eventApp(event: ShowAndTellEvent): string {
  return sanitizeShowAndTellText(event.data.app, 160);
}

function eventUrl(event: ShowAndTellEvent): string {
  return sanitizeShowAndTellText(event.data.url, 1000);
}

interface WorkingSegment {
  index: number;
  app: string;
  url: string;
  startSequence: number;
  endSequence: number;
  startElapsedMs: number;
  endElapsedMs: number;
  events: ShowAndTellEvent[];
  narrated: boolean;
  observed: boolean;
  frames: ShowAndTellEvent[];
  actions: number;
  reason: string;
}

function isUnexplainedFrame(
  frame: ShowAndTellEvent,
  segment: WorkingSegment,
): boolean {
  const label = sanitizeShowAndTellText(frame.data.label, 160);
  return !label && !segment.narrated && !segment.observed;
}

/**
 * A detour is a stretch the user did not explain and did not act in.
 *
 * Two shapes count. The first is leaving an app and coming back to it — the
 * message answered mid-task. The second is a short unexplained hop with
 * nothing in it but context changes. Anything else stays `work`, because
 * silence alone is not proof that a step was irrelevant.
 */
function classify(
  segments: WorkingSegment[],
): Array<{ segment: WorkingSegment; kind: 'work' | 'detour'; reason: string }> {
  return segments.map((segment, index) => {
    const explained = segment.narrated || segment.observed;
    const acted = segment.actions > 0 || segment.frames.length > 0;
    if (explained || acted) {
      return {
        segment,
        kind: 'work' as const,
        reason: explained
          ? 'Narrated or explicitly observed.'
          : 'Contains recorded actions or explicit frames.',
      };
    }
    const previous = segments[index - 1];
    const next = segments[index + 1];
    if (
      previous &&
      next &&
      previous.app &&
      previous.app === next.app &&
      previous.app !== segment.app
    ) {
      return {
        segment,
        kind: 'detour' as const,
        reason: `Left ${previous.app} for ${segment.app || 'another app'} and returned without explaining it.`,
      };
    }
    if (segment.endElapsedMs - segment.startElapsedMs <= DETOUR_MAX_MS) {
      return {
        segment,
        kind: 'detour' as const,
        reason: 'Short unexplained context change with no recorded action.',
      };
    }
    return {
      segment,
      kind: 'work' as const,
      reason: 'Unexplained, but too long to dismiss as a detour.',
    };
  });
}

export function buildSessionBundle(
  session: ShowAndTellSession,
  events: readonly ShowAndTellEvent[],
): ShowAndTellSessionBundle {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const segments: WorkingSegment[] = [];
  let current: WorkingSegment | null = null;
  let previousElapsed: number | null = null;
  let estimatedElapsedEvents = 0;
  let meaningfulEventCount = 0;
  let longestGapMs = 0;
  let durationMs = 0;

  for (const event of ordered) {
    const { elapsedMs, estimated } = eventElapsed(event, session);
    if (estimated) estimatedElapsedEvents += 1;
    durationMs = Math.max(durationMs, elapsedMs);
    if (LIFECYCLE_TYPES.has(event.type)) continue;
    meaningfulEventCount += 1;

    const app = eventApp(event);
    const url = eventUrl(event);
    const gapMs = previousElapsed === null ? 0 : Math.max(0, elapsedMs - previousElapsed);
    longestGapMs = Math.max(longestGapMs, gapMs);
    previousElapsed = elapsedMs;

    let reason = '';
    const carriedApp: string = current ? current.app : '';
    if (!current) {
      reason = 'First recorded activity.';
    } else if (gapMs >= SEGMENT_GAP_MS) {
      reason = `Resumed after a ${Math.trunc(gapMs / 1000)}s pause.`;
    } else if (event.type === 'app.activate' && app && app !== current.app) {
      reason = `Focus moved to ${app}.`;
    } else if (url && host(url) && host(url) !== host(current.url)) {
      reason = `Destination changed to ${host(url)}.`;
    }

    if (!current || reason) {
      current = {
        index: segments.length,
        app: app || carriedApp,
        url,
        startSequence: event.sequence,
        endSequence: event.sequence,
        startElapsedMs: elapsedMs,
        endElapsedMs: elapsedMs,
        events: [],
        narrated: false,
        observed: false,
        frames: [],
        actions: 0,
        reason,
      };
      segments.push(current);
    }

    current.endSequence = event.sequence;
    current.endElapsedMs = elapsedMs;
    current.events.push(event);
    if (app && !current.app) current.app = app;
    if (url) current.url = url;
    if (NARRATION_TYPES.has(event.type)) current.narrated = true;
    if (event.type === 'manual.observation') current.observed = true;
    if (ACTION_TYPES.has(event.type)) current.actions += 1;
    if (event.type === 'frame.captured') current.frames.push(event);
  }

  const classified = classify(segments);
  let silentEvents = 0;
  let unexplainedFrames = 0;
  let narratedSegments = 0;
  let detourSegments = 0;
  let explainedEvents = 0;

  const rendered: ShowAndTellSegment[] = classified.map(
    ({ segment, kind, reason }) => {
      const explained = segment.narrated || segment.observed;
      const segmentUnexplainedFrames = segment.frames.filter((frame) =>
        isUnexplainedFrame(frame, segment),
      ).length;
      const segmentSilentEvents = explained ? 0 : segment.events.length;
      if (explained) {
        narratedSegments += 1;
        explainedEvents += segment.events.length;
      }
      if (kind === 'detour') detourSegments += 1;
      silentEvents += segmentSilentEvents;
      unexplainedFrames += segmentUnexplainedFrames;
      return {
        index: segment.index,
        kind,
        app: segment.app,
        url: segment.url,
        startSequence: segment.startSequence,
        endSequence: segment.endSequence,
        startElapsedMs: segment.startElapsedMs,
        endElapsedMs: segment.endElapsedMs,
        eventCount: segment.events.length,
        narrated: segment.narrated,
        observed: segment.observed,
        frameCount: segment.frames.length,
        unexplainedFrames: segmentUnexplainedFrames,
        silentEvents: segmentSilentEvents,
        evidence: segment.events.map(
          (event) => `event:${event.sequence}:${event.type}`,
        ),
        reason: segment.reason || reason,
      };
    },
  );

  const stats: ShowAndTellBundleStats = {
    eventCount: ordered.length,
    meaningfulEventCount,
    segmentCount: rendered.length,
    narratedSegments,
    silentSegments: rendered.length - narratedSegments,
    detourSegments,
    silentEvents,
    unexplainedFrames,
    estimatedElapsedEvents,
    longestGapMs,
    durationMs,
    explainedRatioMilli:
      meaningfulEventCount === 0
        ? 0
        : Math.floor((explainedEvents * 1000) / meaningfulEventCount),
  };

  const warnings: string[] = [];
  if (meaningfulEventCount === 0) {
    warnings.push('The recording contains no events describing the workflow.');
  }
  if (silentEvents > 0) {
    warnings.push(
      `${silentEvents} recorded event(s) have no narration or explicit observation in their segment.`,
    );
  }
  if (unexplainedFrames > 0) {
    warnings.push(
      `${unexplainedFrames} explicit frame(s) carry no label and no narration.`,
    );
  }
  if (detourSegments > 0) {
    warnings.push(
      `${detourSegments} segment(s) read as detours and are excluded from the proposed steps.`,
    );
  }
  if (estimatedElapsedEvents > 0) {
    warnings.push(
      `${estimatedElapsedEvents} event(s) predate monotonic timing, so their elapsed time is estimated from wall-clock timestamps.`,
    );
  }
  if (longestGapMs >= SEGMENT_GAP_MS) {
    warnings.push(
      `The longest unrecorded pause is ${Math.trunc(longestGapMs / 1000)}s.`,
    );
  }

  return {
    schema: SHOW_AND_TELL_BUNDLE_SCHEMA,
    sessionId: session.id,
    segments: rendered,
    stats,
    warnings,
  };
}

/** Evidence references that fall inside a detour segment. */
export function detourEvidence(bundle: ShowAndTellSessionBundle): Set<string> {
  const references = new Set<string>();
  for (const segment of bundle.segments) {
    if (segment.kind !== 'detour') continue;
    for (const reference of segment.evidence) references.add(reference);
  }
  return references;
}
