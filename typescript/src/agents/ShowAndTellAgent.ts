import { existsSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';
import type { LLMProvider } from '../providers/types.js';
import { getFlightRecorder } from '../flight-recorder/index.js';
import {
  analyzeShowAndTellSession,
  assertContextCaptureAvailable,
  buildShowAndTellArtifacts,
  captureExplicitFrame,
  isPrivateContext,
  privacyReducedUrl,
  readActiveContext,
  replayPlan,
  reviseAnalysis,
  sanitizeShowAndTellText,
  showAndTellRoot,
  ShowAndTellStore,
  spawnShowAndTellCollector,
  testShowAndTellArtifacts,
  type SpawnedCollector,
  type ShowAndTellSession,
} from '../show-and-tell/index.js';

export const __manifest__ = {
  schema: 'rapp-agent/1.0',
  name: '@openrappter/show-and-tell',
  version: '1.0.0',
  display_name: 'Show and Tell',
  description:
    'Records a demonstrated workflow, reconstructs its intent and steps, and builds a reusable skill or automation.',
  author: 'Kody Wildfeuer',
  ring: 'ga',
  capabilities: ['filesystem-write', 'process-exec'],
  tags: ['openrappter', 'show-and-tell', 'automation', 'skills'],
  category: 'meta',
  quality_tier: 'official',
  requires_env: [],
} as const;

type SpawnCollector = (
  root: string,
  sessionId: string,
  ownerPid?: number,
) => SpawnedCollector | Promise<SpawnedCollector>;

interface ShowAndTellAgentOptions {
  root?: string;
  store?: ShowAndTellStore;
  localSurface?: boolean;
  spawnCollector?: SpawnCollector;
  captureFrame?: typeof captureExplicitFrame;
  readContext?: typeof readActiveContext;
  checkCapture?: typeof assertContextCaptureAvailable;
  provider?: LLMProvider | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class ShowAndTellAgent extends BasicAgent {
  private readonly store: ShowAndTellStore;
  private readonly spawnCollector: SpawnCollector;
  private readonly captureFrame: typeof captureExplicitFrame;
  private readonly readContext: typeof readActiveContext;
  private readonly checkCapture: typeof assertContextCaptureAvailable;
  private provider: LLMProvider | null;
  private readonly localSurface: boolean;

  constructor(options: ShowAndTellAgentOptions = {}) {
    const metadata: AgentMetadata = {
      name: 'ShowAndTell',
      description:
        'Learns a reusable workflow from a local demonstration. Start through the interactive CLI, add notes or explicit screenshots, stop, analyze, approve, then build a SKILL.md or disabled automation.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'start',
              'status',
              'note',
              'capture',
              'observe',
              'stop',
              'analyze',
              'review',
              'build',
              'replay',
              'test',
              'list',
              'delete',
            ],
            description: 'Show-and-Tell lifecycle action.',
          },
          session_id: {
            type: 'string',
            description: 'Session id. Defaults to the active or latest session.',
          },
          title: {
            type: 'string',
            description: 'Short session, analysis, observation, or artifact title.',
          },
          intent: {
            type: 'string',
            description: 'The goal being demonstrated, or an edited analysis intent.',
          },
          note: {
            type: 'string',
            description: 'A narration note explaining what you are doing and why.',
          },
          detail: {
            type: 'string',
            description: 'Description of a manually observed workflow step.',
          },
          app: {
            type: 'string',
            description: 'Application involved in a manual observation.',
          },
          url: {
            type: 'string',
            description: 'Privacy-reduced URL involved in a manual observation.',
          },
          steps_json: {
            type: 'string',
            description: 'Edited analysis steps as a JSON array.',
          },
          feedback: {
            type: 'string',
            description: 'Review feedback retained with the analysis.',
          },
          approve: {
            type: 'boolean',
            description: 'Approve the reviewed analysis. Requires a local consent token.',
          },
          enhance: {
            type: 'boolean',
            description:
              'Send only the privacy-safe textual summary (never frames) to Copilot for refinement. Requires local consent.',
          },
          consent_token: {
            type: 'string',
            description: 'Short-lived token issued only by an interactive local CLI.',
          },
          target: {
            type: 'string',
            enum: ['skill', 'automation', 'all'],
            description: 'Artifact to build from an approved analysis.',
          },
          poll_interval_ms: {
            type: 'integer',
            description: 'Context polling interval, from 500 to 60000 ms.',
          },
          max_duration_ms: {
            type: 'integer',
            description: 'Maximum recording duration, capped at eight hours.',
          },
          query: {
            type: 'string',
            description: 'Natural-language fallback used as a note or detail.',
          },
        },
        required: [],
      },
    };
    super('ShowAndTell', metadata);
    this.store =
      options.store ??
      new ShowAndTellStore(options.root ?? showAndTellRoot());
    this.spawnCollector = options.spawnCollector ?? spawnShowAndTellCollector;
    this.captureFrame = options.captureFrame ?? captureExplicitFrame;
    this.readContext = options.readContext ?? readActiveContext;
    this.checkCapture =
      options.checkCapture ??
      (options.spawnCollector
        ? async () => undefined
        : assertContextCaptureAvailable);
    this.provider = options.provider ?? null;
    this.localSurface =
      options.localSurface ?? options.root !== undefined;
  }

  setProvider(provider: LLMProvider | null): void {
    this.provider = provider;
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const action = typeof kwargs.action === 'string' ? kwargs.action : 'status';
    if (
      !this.localSurface &&
      action !== 'status' &&
      action !== 'list'
    ) {
      return JSON.stringify({
        status: 'error',
        action,
        code: 'local_surface_required',
        message:
          'Use the interactive Show-and-Tell CLI or the Electron DesktopControl surface for this action.',
      });
    }
    try {
      await this.store.initialize();
      let result: Record<string, unknown>;
      switch (action) {
        case 'start':
          result = await this.start(kwargs);
          break;
        case 'status':
          result = await this.status(kwargs);
          break;
        case 'note':
          result = await this.note(kwargs);
          break;
        case 'capture':
          result = await this.capture(kwargs);
          break;
        case 'observe':
          result = await this.observe(kwargs);
          break;
        case 'stop':
          result = await this.stop(kwargs);
          break;
        case 'analyze':
          result = await this.analyze(kwargs);
          break;
        case 'review':
          result = await this.review(kwargs);
          break;
        case 'build':
          result = await this.build(kwargs);
          break;
        case 'replay':
          result = await this.replay(kwargs);
          break;
        case 'test':
          result = await this.test(kwargs);
          break;
        case 'list':
          result = await this.list();
          break;
        case 'delete':
          result = await this.delete(kwargs);
          break;
        default:
          return JSON.stringify({
            status: 'error',
            action,
            message: `Unknown Show-and-Tell action: ${action}`,
          });
      }
      return JSON.stringify(result);
    } catch (error) {
      await getFlightRecorder().record({
        kind: 'show-and-tell.failed',
        source: 'show-and-tell',
        status: 'error',
        agentName: this.name,
        metadata: { action, error: errorMessage(error) },
      });
      return JSON.stringify({
        status: 'error',
        action,
        message: errorMessage(error),
      });
    }
  }

  private async start(kwargs: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!(await this.store.consumeConsent(kwargs.consent_token, 'start'))) {
      return {
        status: 'error',
        action: 'start',
        code: 'local_consent_required',
        message:
          'Recording can start only through the interactive local command `openrappter show-and-tell start`.',
      };
    }
    await this.checkCapture();
    const session = await this.store.createSession({
      title: sanitizeShowAndTellText(kwargs.title, 160),
      intentHint: sanitizeShowAndTellText(kwargs.intent ?? kwargs.query, 1000),
      pollIntervalMs:
        typeof kwargs.poll_interval_ms === 'number'
          ? kwargs.poll_interval_ms
          : undefined,
      maxDurationMs:
        typeof kwargs.max_duration_ms === 'number'
          ? kwargs.max_duration_ms
          : undefined,
    });
    await this.store.appendEvent(session.id, 'session.started', 'show-and-tell', {
      captureMode: 'context',
      screenshots: 'explicit-only',
    });
    try {
      const ownerPid =
        typeof kwargs._desktop_owner_pid === 'number' &&
        Number.isSafeInteger(kwargs._desktop_owner_pid) &&
        kwargs._desktop_owner_pid > 0
          ? kwargs._desktop_owner_pid
          : undefined;
      const collector = await this.spawnCollector(
        this.store.root,
        session.id,
        ownerPid,
      );
      if (
        (collector as { verify?: boolean }).verify !== false &&
        !(await this.waitForCollector(session.id, collector.nonce, 8_000))
      ) {
        await this.store.finishSession(session.id, 'failed', {
          error: 'Collector process did not attach to the session.',
        });
        throw new Error('Show-and-Tell collector did not start correctly.');
      }
      await getFlightRecorder().record({
        kind: 'show-and-tell.started',
        source: 'show-and-tell',
        status: 'success',
        agentName: this.name,
        metadata: { sessionId: session.id, collectorPid: collector.pid },
      });
      return {
        status: 'success',
        action: 'start',
        session,
        collector_pid: collector.pid,
        message:
          'Show-and-Tell is recording app/window context. Use `show-and-tell note` while narrating and `show-and-tell capture` for explicit reference frames.',
        data_slush: {
          source_agent: this.name,
          session_id: session.id,
          recording: true,
        },
      };
    } catch (error) {
      await this.store.finishSession(session.id, 'failed', {
        error: errorMessage(error),
      });
      throw error;
    }
  }

  private async status(kwargs: Record<string, unknown>): Promise<Record<string, unknown>> {
    const session = await this.recoverSession(kwargs.session_id);
    if (!session) {
      return {
        status: 'success',
        action: 'status',
        recording: false,
        session: null,
      };
    }
    const events = await this.store.events(session.id);
    const analysis = await this.store.getAnalysis(session.id);
    const artifacts = await this.store.artifacts(session.id);
    if (!this.localSurface) {
      return {
        status: 'success',
        action: 'status',
        recording: session.state === 'recording' || session.state === 'stopping',
        session: {
          id: session.id,
          state: session.state,
          startedAt: session.startedAt,
          stoppedAt: session.stoppedAt,
        },
        event_count: events.length,
        analysis: analysis
          ? {
              revision: analysis.revision,
              approved: analysis.approved,
              step_count: analysis.steps.length,
            }
          : null,
        artifact_count: artifacts.length,
      };
    }
    const lastContextAt = events
      .filter((event) => event.type === 'app.activate')
      .at(-1)?.timestamp ?? null;
    const heartbeatAgeMs = session.collectorHeartbeatAt
      ? Date.now() - session.collectorHeartbeatAt
      : null;
    const contextAgeMs = lastContextAt ? Date.now() - lastContextAt : null;
    return {
      status: 'success',
      action: 'status',
      recording: session.state === 'recording' || session.state === 'stopping',
      session,
      event_count: events.length,
      analysis: analysis
        ? {
            revision: analysis.revision,
            approved: analysis.approved,
            step_count: analysis.steps.length,
          }
        : null,
      analysis_detail: analysis,
      artifacts,
      collector_healthy:
        !['recording', 'stopping'].includes(session.state) ||
        (heartbeatAgeMs !== null &&
          heartbeatAgeMs <= Math.max(30_000, session.pollIntervalMs * 5)),
      heartbeat_age_ms: heartbeatAgeMs,
      context_age_ms: contextAgeMs,
    };
  }

  private async note(kwargs: Record<string, unknown>): Promise<Record<string, unknown>> {
    const session = await this.requireRecordingSession(kwargs.session_id);
    const note = sanitizeShowAndTellText(kwargs.note ?? kwargs.query, 2000);
    if (!note) throw new Error('A Show-and-Tell note is required.');
    const event = await this.store.appendEvent(
      session.id,
      'session.note',
      'user-narration',
      { note },
    );
    return { status: 'success', action: 'note', session_id: session.id, event };
  }

  private async observe(kwargs: Record<string, unknown>): Promise<Record<string, unknown>> {
    const session = await this.requireRecordingSession(kwargs.session_id);
    const detail = sanitizeShowAndTellText(kwargs.detail ?? kwargs.query, 1200);
    if (!detail) throw new Error('A manual observation detail is required.');
    const event = await this.store.appendEvent(
      session.id,
      'manual.observation',
      'user-observation',
      {
        title: sanitizeShowAndTellText(kwargs.title, 160),
        detail,
        app: sanitizeShowAndTellText(kwargs.app, 160),
        url: privacyReducedUrl(kwargs.url),
      },
    );
    return { status: 'success', action: 'observe', session_id: session.id, event };
  }

  private async capture(kwargs: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!(await this.store.consumeConsent(kwargs.consent_token, 'capture'))) {
      return {
        status: 'error',
        action: 'capture',
        code: 'local_capture_consent_required',
        message:
          'Screenshot capture requires the interactive local command `openrappter show-and-tell capture`.',
      };
    }
    const session = await this.requireRecordingSession(kwargs.session_id);
    const context = await this.readContext();
    if (
      isPrivateContext(context.app, context.window, context.url) ||
      context.privateContext
    ) {
      return {
        status: 'error',
        action: 'capture',
        code: 'private_context',
        message:
          'The active window looks credential- or sign-in-related. Show-and-Tell refused the screenshot.',
      };
    }
    const filename = `frame-${Date.now()}-${randomUUID().slice(0, 8)}.png`;
    const file = path.join(this.store.framesDir(session.id), filename);
    let committed = false;
    try {
      await this.captureFrame(file, context);
      if (!existsSync(file)) throw new Error('The screenshot command did not create a frame.');
      const after = await this.readContext();
      if (
        after.privateContext ||
        isPrivateContext(after.app, after.window, after.url)
      ) {
        return {
          status: 'error',
          action: 'capture',
          code: 'private_context',
          message:
            'The active window became credential- or sign-in-related during capture, so the frame was deleted.',
        };
      }
      if (
        after.app !== context.app ||
        after.window !== context.window ||
        (context.windowId && after.windowId !== context.windowId)
      ) {
        return {
          status: 'error',
          action: 'capture',
          code: 'window_changed',
          message:
            'The active window changed during capture, so the frame was deleted.',
        };
      }
      this.store.hardenFile(file);
      await this.store.appendEvent(
        session.id,
        'frame.captured',
        'explicit-capture',
        {
          file: path.posix.join('frames', filename),
          label: sanitizeShowAndTellText(kwargs.title ?? kwargs.note, 160),
          app: context.app,
          window: context.window,
        },
      );
      committed = true;
      return {
        status: 'success',
        action: 'capture',
        session_id: session.id,
        captured: true,
        label: sanitizeShowAndTellText(kwargs.title ?? kwargs.note, 160),
      };
    } finally {
      if (!committed && existsSync(file)) {
        try {
          unlinkSync(file);
        } catch {
          // The result already reports failure; leave no success-shaped claim.
        }
      }
    }
  }

  private async stop(kwargs: Record<string, unknown>): Promise<Record<string, unknown>> {
    const session = await this.recoverSession(kwargs.session_id);
    if (!session) throw new Error('There is no Show-and-Tell session to stop.');
    if (session.state === 'stopped' || session.state === 'failed') {
      return { status: 'success', action: 'stop', session };
    }
    await this.store.requestStop(session.id);
    await this.store.appendEvent(
      session.id,
      'session.stop.requested',
      'show-and-tell',
      {},
    );
    const stopped = await this.waitForStop(session.id, 8_000);
    if (!stopped) {
      const recovered = await this.recoverSession(session.id);
      if (recovered?.state === 'failed') {
        return {
          status: 'error',
          action: 'stop',
          code: 'collector_failed',
          session: recovered,
          message: recovered.lastError ?? 'The Show-and-Tell collector failed.',
        };
      }
      return {
        status: 'error',
        action: 'stop',
        code: 'collector_stop_timeout',
        session: await this.store.getSession(session.id),
        message:
          'The collector did not acknowledge shutdown. Its ownership metadata was preserved; retry stop or inspect status.',
      };
    }
    if (stopped.state === 'failed') {
      return {
        status: 'error',
        action: 'stop',
        code: 'collector_failed',
        session: stopped,
        message: stopped.lastError ?? 'The Show-and-Tell collector failed.',
      };
    }
    const final = await this.store.getSession(session.id);
    await this.store.appendEvent(
      session.id,
      'session.stopped',
      'show-and-tell',
      {},
    );
    await getFlightRecorder().record({
      kind: 'show-and-tell.stopped',
      source: 'show-and-tell',
      status: 'success',
      agentName: this.name,
      metadata: { sessionId: session.id },
    });
    return {
      status: 'success',
      action: 'stop',
      session: final,
      message: 'Recording stopped. Analyze it next.',
      data_slush: {
        source_agent: this.name,
        session_id: session.id,
        recording: false,
      },
    };
  }

  private async recoverSession(
    requestedId: unknown,
  ): Promise<ShowAndTellSession | null> {
    await this.store.recoverStaleSessions();
    let session = await this.resolveSession(requestedId);
    if (
      session &&
      ['recording', 'stopping'].includes(session.state) &&
      session.collectorPid &&
      !processIsAlive(session.collectorPid)
    ) {
      await this.store.finishSession(session.id, 'failed', {
        ...(session.collectorNonce ? { nonce: session.collectorNonce } : {}),
        error: 'Collector process exited before the session was finalized.',
      });
      session = await this.store.getSession(session.id);
    }
    return session;
  }

  private async analyze(kwargs: Record<string, unknown>): Promise<Record<string, unknown>> {
    const session = await this.requireCompletedSession(kwargs.session_id);
    const enhance = kwargs.enhance === true;
    if (
      enhance &&
      !(await this.store.consumeConsent(kwargs.consent_token, 'analyze'))
    ) {
      return {
        status: 'error',
        action: 'analyze',
        code: 'local_analysis_consent_required',
        message:
          'Copilot enhancement requires the interactive local command `openrappter show-and-tell analyze --enhance`.',
      };
    }
    if (enhance && !this.provider) {
      return {
        status: 'error',
        action: 'analyze',
        code: 'model_unavailable',
        message:
          'No working Copilot backend is connected. Run without --enhance or reconnect Copilot.',
      };
    }
    const result = await analyzeShowAndTellSession(
      this.store,
      session,
      enhance ? this.provider : null,
    );
    await getFlightRecorder().record({
      kind: 'show-and-tell.analyzed',
      source: 'show-and-tell',
      status: 'success',
      agentName: this.name,
      metadata: {
        sessionId: session.id,
        revision: result.analysis.revision,
        enhanced: result.enhanced,
        stepCount: result.analysis.steps.length,
      },
    });
    return {
      status: 'success',
      action: 'analyze',
      analysis: result.analysis,
      enhanced: result.enhanced,
      ...(result.warning ? { warning: result.warning } : {}),
    };
  }

  private async review(kwargs: Record<string, unknown>): Promise<Record<string, unknown>> {
    const session = await this.requireCompletedSession(kwargs.session_id);
    const current = await this.store.getAnalysis(session.id);
    if (!current) throw new Error('Analyze the Show-and-Tell session before reviewing it.');
    if (
      kwargs.approve === true &&
      !(await this.store.consumeConsent(kwargs.consent_token, 'approve'))
    ) {
      return {
        status: 'error',
        action: 'review',
        code: 'local_approval_required',
        message:
          'Approval requires the interactive local command `openrappter show-and-tell approve`.',
      };
    }
    const revised = reviseAnalysis(current, {
      title: kwargs.title,
      intent: kwargs.intent,
      stepsJson: kwargs.steps_json,
      feedback: kwargs.feedback ?? kwargs.query,
      approve: kwargs.approve === true,
    });
    await this.store.saveAnalysis(revised);
    return {
      status: 'success',
      action: 'review',
      analysis: revised,
      message: revised.approved
        ? 'Analysis approved. It can now build a skill or automation.'
        : 'Draft analysis updated but not approved.',
    };
  }

  private async build(kwargs: Record<string, unknown>): Promise<Record<string, unknown>> {
    const session = await this.requireCompletedSession(kwargs.session_id);
    const analysis = await this.store.getAnalysis(session.id);
    if (!analysis) throw new Error('Analyze and approve the session before building.');
    const target =
      kwargs.target === 'automation' || kwargs.target === 'all'
        ? kwargs.target
        : 'skill';
    const artifacts = await buildShowAndTellArtifacts(
      this.store,
      analysis,
      target,
    );
    await getFlightRecorder().record({
      kind: 'show-and-tell.built',
      source: 'show-and-tell',
      status: 'success',
      agentName: this.name,
      metadata: {
        sessionId: session.id,
        targets: artifacts.map((artifact) => artifact.kind),
      },
    });
    return {
      status: 'success',
      action: 'build',
      session_id: session.id,
      artifacts,
      message: `Built ${artifacts.map((artifact) => artifact.kind).join(' and ')}.`,
      data_slush: {
        source_agent: this.name,
        session_id: session.id,
        artifact_paths: artifacts.map((artifact) => artifact.path),
      },
    };
  }

  private async replay(kwargs: Record<string, unknown>): Promise<Record<string, unknown>> {
    const session = await this.requireCompletedSession(kwargs.session_id);
    const analysis = await this.store.getAnalysis(session.id);
    if (!analysis?.approved) {
      throw new Error('Approve the analysis before previewing replay.');
    }
    return {
      status: 'success',
      action: 'replay',
      session_id: session.id,
      replay: replayPlan(analysis),
    };
  }

  private async test(kwargs: Record<string, unknown>): Promise<Record<string, unknown>> {
    const session = await this.requireCompletedSession(kwargs.session_id);
    const result = await testShowAndTellArtifacts(this.store, session.id);
    return {
      status: result.ok ? 'success' : 'error',
      action: 'test',
      session_id: session.id,
      ...result,
    };
  }

  private async list(): Promise<Record<string, unknown>> {
    const sessions = await this.store.listSessions();
    return {
      status: 'success',
      action: 'list',
      sessions: this.localSurface
        ? sessions
        : sessions.map((session) => ({
            id: session.id,
            state: session.state,
            startedAt: session.startedAt,
            stoppedAt: session.stoppedAt,
          })),
      count: sessions.length,
    };
  }

  private async delete(kwargs: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!(await this.store.consumeConsent(kwargs.consent_token, 'delete'))) {
      return {
        status: 'error',
        action: 'delete',
        code: 'local_consent_required',
        message:
          'Deletion requires the interactive local command `openrappter show-and-tell delete`.',
      };
    }
    const session = await this.resolveSession(kwargs.session_id);
    if (!session) throw new Error('Show-and-Tell session not found.');
    const deleted = await this.store.deleteSession(session.id);
    return { status: 'success', action: 'delete', session_id: session.id, deleted };
  }

  private async resolveSession(sessionId: unknown): Promise<ShowAndTellSession | null> {
    if (typeof sessionId === 'string' && sessionId.trim()) {
      return this.store.getSession(sessionId.trim());
    }
    return (await this.store.activeSession()) ?? this.store.latestSession();
  }

  private async requireRecordingSession(sessionId: unknown): Promise<ShowAndTellSession> {
    const session = await this.resolveSession(sessionId);
    if (!session) throw new Error('Start a Show-and-Tell session first.');
    if (session.state !== 'recording') {
      throw new Error(`Show-and-Tell session ${session.id} is ${session.state}.`);
    }
    return session;
  }

  private async requireCompletedSession(sessionId: unknown): Promise<ShowAndTellSession> {
    const session = await this.resolveSession(sessionId);
    if (!session) throw new Error('Show-and-Tell session not found.');
    if (session.state === 'recording' || session.state === 'stopping') {
      throw new Error('Stop the Show-and-Tell recording before continuing.');
    }
    return session;
  }

  private async waitForStop(
    sessionId: string,
    timeoutMs: number,
  ): Promise<ShowAndTellSession | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const session = await this.store.getSession(sessionId);
      if (!session || session.state === 'stopped' || session.state === 'failed') {
        return session;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  private async waitForCollector(
    sessionId: string,
    nonce: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const session = await this.store.getSession(sessionId);
      const events = await this.store.events(sessionId);
      if (
        session?.collectorNonce === nonce &&
        session.collectorPid !== null &&
        session.collectorHeartbeatAt !== null &&
        events.some((event) => event.type === 'app.activate')
      ) {
        return true;
      }
      if (!session || session.state === 'failed') return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }
}
