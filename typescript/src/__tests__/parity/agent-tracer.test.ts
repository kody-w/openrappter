/**
 * AgentTracer Parity Tests
 *
 * Tests the observability/tracing system for agent execution spans.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AgentTracer, createTracer } from '../../agents/tracer.js';

describe('AgentTracer', () => {
  let tracer: AgentTracer;

  beforeEach(() => {
    tracer = new AgentTracer();
  });

  // ── Construction ──

  describe('Construction', () => {
    it('should create a tracer with defaults', () => {
      const t = new AgentTracer();
      expect(t.getActiveSpans()).toEqual([]);
      expect(t.getCompletedSpans()).toEqual([]);
    });

    it('should create via factory function', () => {
      const t = createTracer({ maxSpans: 100 });
      expect(t.getActiveSpans()).toEqual([]);
    });

    it('should accept options', () => {
      const spans: unknown[] = [];
      const t = new AgentTracer({
        maxSpans: 50,
        recordIO: false,
        onSpanComplete: (span) => spans.push(span),
      });
      expect(t.getActiveSpans()).toEqual([]);
    });
  });

  // ── Span Lifecycle ──

  describe('Span Lifecycle', () => {
    it('should start a span', () => {
      const { span, context } = tracer.startSpan('TestAgent', 'execute');

      expect(span.agentName).toBe('TestAgent');
      expect(span.operation).toBe('execute');
      expect(span.status).toBe('running');
      expect(span.startTime).toBeDefined();
      expect(span.endTime).toBeNull();
      expect(span.durationMs).toBeNull();
      expect(span.parentId).toBeNull();
      expect(context.traceId).toBe(span.traceId);
      expect(context.spanId).toBe(span.id);
    });

    it('should end a span successfully', () => {
      const { span } = tracer.startSpan('TestAgent', 'execute');
      const ended = tracer.endSpan(span.id, {
        status: 'success',
        outputs: { result: 'done' },
      });

      expect(ended).not.toBeNull();
      expect(ended!.status).toBe('success');
      expect(ended!.endTime).not.toBeNull();
      expect(ended!.durationMs).toBeGreaterThanOrEqual(0);
      expect(ended!.outputs?.result).toBe('done');
    });

    it('should end a span with error', () => {
      const { span } = tracer.startSpan('TestAgent', 'execute');
      const ended = tracer.endSpan(span.id, {
        status: 'error',
        error: 'Something went wrong',
      });

      expect(ended!.status).toBe('error');
      expect(ended!.error).toBe('Something went wrong');
    });

    it('should return null for unknown span', () => {
      const ended = tracer.endSpan('nonexistent');
      expect(ended).toBeNull();
    });

    it('should track active vs completed spans', () => {
      const { span: s1 } = tracer.startSpan('A', 'execute');
      const { span: s2 } = tracer.startSpan('B', 'execute');

      expect(tracer.getActiveSpans()).toHaveLength(2);
      expect(tracer.getCompletedSpans()).toHaveLength(0);

      tracer.endSpan(s1.id, { status: 'success' });

      expect(tracer.getActiveSpans()).toHaveLength(1);
      expect(tracer.getCompletedSpans()).toHaveLength(1);

      tracer.endSpan(s2.id, { status: 'success' });

      expect(tracer.getActiveSpans()).toHaveLength(0);
      expect(tracer.getCompletedSpans()).toHaveLength(2);
    });
  });

  // ── Context Propagation ──

  describe('Context Propagation', () => {
    it('should create child spans with parent context', () => {
      const { context: parentCtx } = tracer.startSpan('ParentAgent', 'execute');
      const { span: child } = tracer.startSpan('ChildAgent', 'execute', parentCtx);

      expect(child.parentId).toBe(parentCtx.spanId);
      expect(child.traceId).toBe(parentCtx.traceId);
    });

    it('should propagate trace ID through chain', () => {
      const { context: ctx1 } = tracer.startSpan('Agent1', 'execute');
      const { context: ctx2 } = tracer.startSpan('Agent2', 'execute', ctx1);
      const { span: span3 } = tracer.startSpan('Agent3', 'execute', ctx2);

      expect(span3.traceId).toBe(ctx1.traceId);
      expect(span3.parentId).toBe(ctx2.spanId);
    });

    it('should propagate baggage items', () => {
      const parentCtx = {
        traceId: 'trace-123',
        spanId: 'span-123',
        baggage: { user: 'test', env: 'dev' },
      };

      const { context: childCtx } = tracer.startSpan('ChildAgent', 'execute', parentCtx);
      expect(childCtx.baggage).toEqual({ user: 'test', env: 'dev' });
    });
  });

  // ── Trace Retrieval ──

  describe('Trace Retrieval', () => {
    it('should get a span by ID', () => {
      const { span } = tracer.startSpan('TestAgent', 'execute');
      const found = tracer.getSpan(span.id);
      expect(found).not.toBeNull();
      expect(found!.agentName).toBe('TestAgent');
    });

    it('should return null for unknown span ID', () => {
      expect(tracer.getSpan('nonexistent')).toBeNull();
    });

    it('should get all spans for a trace', () => {
      const { context: ctx } = tracer.startSpan('Agent1', 'execute');
      tracer.startSpan('Agent2', 'perform', ctx);
      tracer.startSpan('Agent3', 'slosh', ctx);

      const traceSpans = tracer.getTrace(ctx.traceId);
      expect(traceSpans).toHaveLength(3);
      expect(traceSpans.every(s => s.traceId === ctx.traceId)).toBe(true);
    });

    it('should return empty array for unknown trace', () => {
      expect(tracer.getTrace('nonexistent')).toEqual([]);
    });

    it('should limit completed spans', () => {
      for (let i = 0; i < 5; i++) {
        const { span } = tracer.startSpan(`Agent${i}`, 'execute');
        tracer.endSpan(span.id, { status: 'success' });
      }

      expect(tracer.getCompletedSpans(3)).toHaveLength(3);
      expect(tracer.getCompletedSpans()).toHaveLength(5);
    });
  });

  // ── Data Slush Tracking ──

  describe('Data Slush Tracking', () => {
    it('should record data slush flow', () => {
      const { span } = tracer.startSpan('TestAgent', 'execute');
      const ended = tracer.endSpan(span.id, {
        status: 'success',
        dataSlush: {
          upstream: { source: 'previous_agent' },
          downstream: { result: 'output_data' },
        },
      });

      expect(ended!.dataSlush?.upstream?.source).toBe('previous_agent');
      expect(ended!.dataSlush?.downstream?.result).toBe('output_data');
    });
  });

  // ── Input/Output Recording ──

  describe('IO Recording', () => {
    it('should record inputs when enabled', () => {
      const t = new AgentTracer({ recordIO: true });
      const { span } = t.startSpan('TestAgent', 'execute', undefined, { query: 'hello' });
      expect(span.inputs?.query).toBe('hello');
    });

    it('should skip inputs when disabled', () => {
      const t = new AgentTracer({ recordIO: false });
      const { span } = t.startSpan('TestAgent', 'execute', undefined, { query: 'hello' });
      expect(span.inputs).toBeUndefined();
    });
  });

  // ── Callbacks ──

  describe('Callbacks', () => {
    it('should call onSpanComplete when a span ends', () => {
      const completed: string[] = [];
      const t = new AgentTracer({
        onSpanComplete: (span) => completed.push(span.agentName),
      });

      const { span } = t.startSpan('TestAgent', 'execute');
      t.endSpan(span.id, { status: 'success' });

      expect(completed).toEqual(['TestAgent']);
    });
  });

  // ── Tags ──

  describe('Tags', () => {
    it('should support tags on spans', () => {
      const { span } = tracer.startSpan('TestAgent', 'execute');
      span.tags = { env: 'test', version: '1.0' };

      const found = tracer.getSpan(span.id);
      expect(found!.tags?.env).toBe('test');
    });
  });

  // ── Max Spans ──

  describe('Max Spans', () => {
    it('should enforce max completed spans', () => {
      const t = new AgentTracer({ maxSpans: 5 });

      for (let i = 0; i < 10; i++) {
        const { span } = t.startSpan(`Agent${i}`, 'execute');
        t.endSpan(span.id, { status: 'success' });
      }

      expect(t.getCompletedSpans().length).toBeLessThanOrEqual(5);
    });
  });

  // ── Clear ──

  describe('Clear', () => {
    it('should clear all spans', () => {
      tracer.startSpan('A', 'execute');
      const { span } = tracer.startSpan('B', 'execute');
      tracer.endSpan(span.id, { status: 'success' });

      tracer.clear();

      expect(tracer.getActiveSpans()).toEqual([]);
      expect(tracer.getCompletedSpans()).toEqual([]);
    });
  });

  // ── Serialization ──

  describe('Serialization', () => {
    it('should produce JSON summary', () => {
      const { span } = tracer.startSpan('TestAgent', 'execute');
      tracer.endSpan(span.id, { status: 'success' });

      const json = tracer.toJSON();
      expect(json).toHaveProperty('activeSpans');
      expect(json).toHaveProperty('completedSpans');
    });
  });
});
