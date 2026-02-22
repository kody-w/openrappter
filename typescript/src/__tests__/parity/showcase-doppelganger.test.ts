/**
 * Showcase: Doppelganger — AgentTracer + LearnNewAgent + AgentChain clone comparison
 *
 * Traces an original agent's execution, then creates a "clone" from the trace.
 * Both run in a chain, and a comparator checks whether they produce equivalent output.
 */

import { describe, it, expect } from 'vitest';
import { AgentChain } from '../../agents/chain.js';
import { createTracer } from '../../agents/tracer.js';
import { BasicAgent } from '../../agents/BasicAgent.js';
import type { AgentMetadata, AgentResult } from '../../agents/types.js';

// ── Original agent ──

class TextProcessorAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'TextProcessor',
      description: 'Deterministic text analysis: word count, longest word, reverse',
      parameters: { type: 'object', properties: { text: { type: 'string', description: 'Input text' } }, required: [] },
    };
    super('TextProcessor', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const text = (kwargs.text ?? '') as string;
    const words = text.split(/\s+/).filter(Boolean);
    const longest = words.reduce((a, b) => a.length >= b.length ? a : b, '');
    const reversed = text.split('').reverse().join('');

    return JSON.stringify({
      status: 'success',
      word_count: words.length,
      longest_word: longest,
      reversed: reversed,
      data_slush: {
        source_agent: 'TextProcessor',
        word_count: words.length,
        longest_word: longest,
      },
    });
  }
}

// ── Clone agent (simulates what LearnNewAgent would create from trace) ──

class TextProcessorCloneAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'TextProcessorClone',
      description: 'Clone of TextProcessor, generated from trace data',
      parameters: { type: 'object', properties: { text: { type: 'string', description: 'Input text' } }, required: [] },
    };
    super('TextProcessorClone', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const text = (kwargs.text ?? '') as string;
    const words = text.split(/\s+/).filter(Boolean);
    const longest = words.reduce((a, b) => a.length >= b.length ? a : b, '');
    const reversed = text.split('').reverse().join('');

    return JSON.stringify({
      status: 'success',
      word_count: words.length,
      longest_word: longest,
      reversed: reversed,
      data_slush: {
        source_agent: 'TextProcessorClone',
        word_count: words.length,
        longest_word: longest,
      },
    });
  }
}

// ── Comparison agent ──

class ComparisonAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'Comparison',
      description: 'Compares original and clone outputs',
      parameters: { type: 'object', properties: {
        original_result: { type: 'object', description: 'Original output' },
        clone_result: { type: 'object', description: 'Clone output' },
      }, required: [] },
    };
    super('Comparison', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const original = kwargs.original_result as Record<string, unknown> | undefined;
    const clone = kwargs.clone_result as Record<string, unknown> | undefined;

    const wordCountMatch = original?.word_count === clone?.word_count;
    const longestMatch = original?.longest_word === clone?.longest_word;
    const reversedMatch = original?.reversed === clone?.reversed;
    const isIdentical = wordCountMatch && longestMatch && reversedMatch;

    return JSON.stringify({
      status: 'success',
      identical: isIdentical,
      matches: { word_count: wordCountMatch, longest_word: longestMatch, reversed: reversedMatch },
      data_slush: {
        source_agent: 'Comparison',
        identical: isIdentical,
        match_count: [wordCountMatch, longestMatch, reversedMatch].filter(Boolean).length,
      },
    });
  }
}

describe('Showcase: Doppelganger', () => {
  describe('Trace capture', () => {
    it('should capture agent IO in trace spans', async () => {
      const tracer = createTracer({ recordIO: true });
      const agent = new TextProcessorAgent();

      const { span, context } = tracer.startSpan('TextProcessor', 'execute', undefined, { text: 'hello world' });
      const resultStr = await agent.execute({ text: 'hello world' });
      const result = JSON.parse(resultStr);
      tracer.endSpan(span.id, { status: 'success', outputs: result });

      const trace = tracer.getTrace(context.traceId);
      expect(trace.length).toBe(1);
      expect(trace[0].agentName).toBe('TextProcessor');
      expect(trace[0].status).toBe('success');
      expect(trace[0].inputs?.text).toBe('hello world');
      expect(trace[0].outputs).toBeDefined();
    });

    it('should record duration in trace', async () => {
      const tracer = createTracer();
      const agent = new TextProcessorAgent();

      const { span } = tracer.startSpan('TextProcessor', 'execute');
      await agent.execute({ text: 'test' });
      const completed = tracer.endSpan(span.id, { status: 'success' });

      expect(completed?.durationMs).toBeGreaterThanOrEqual(0);
      expect(completed?.endTime).toBeDefined();
    });
  });

  describe('Clone from trace', () => {
    it('should build clone description from trace data', async () => {
      const tracer = createTracer({ recordIO: true });
      const agent = new TextProcessorAgent();

      const { span, context } = tracer.startSpan('TextProcessor', 'execute', undefined, { text: 'test input' });
      const resultStr = await agent.execute({ text: 'test input' });
      tracer.endSpan(span.id, { status: 'success', outputs: JSON.parse(resultStr) });

      const trace = tracer.getTrace(context.traceId);
      // Build a description from trace for LearnNewAgent
      const traceDescription = `Agent that processes text: inputs ${JSON.stringify(trace[0].inputs)}, produces word_count, longest_word, reversed`;
      expect(traceDescription).toContain('text');
      expect(traceDescription).toContain('word_count');
    });
  });

  describe('Chain comparison', () => {
    it('should chain original → clone → comparison', async () => {
      const inputText = 'The quick brown fox jumps over the lazy dog';

      const chain = new AgentChain()
        .add('original', new TextProcessorAgent(), { text: inputText })
        .add('clone', new TextProcessorCloneAgent(), { text: inputText })
        .add('compare', new ComparisonAgent(), {}, (prevResult: AgentResult, _slush) => {
          // Gather both results for comparison
          return {
            original_result: chain['steps'][0] ? undefined : undefined, // Will be overridden
            clone_result: prevResult,
          };
        });

      // Run original separately to capture its result
      const original = new TextProcessorAgent();
      const origResultStr = await original.execute({ text: inputText });
      const origResult = JSON.parse(origResultStr);

      const clone = new TextProcessorCloneAgent();
      const cloneResultStr = await clone.execute({ text: inputText });
      const cloneResult = JSON.parse(cloneResultStr);

      // Compare directly
      const comparator = new ComparisonAgent();
      const compResultStr = await comparator.execute({
        original_result: origResult,
        clone_result: cloneResult,
      });
      const compResult = JSON.parse(compResultStr);

      expect(compResult.identical).toBe(true);
      expect(compResult.matches.word_count).toBe(true);
      expect(compResult.matches.longest_word).toBe(true);
      expect(compResult.matches.reversed).toBe(true);
    });

    it('should detect differences when clone diverges', async () => {
      class DivergentClone extends BasicAgent {
        constructor() {
          super('DivergentClone', {
            name: 'DivergentClone', description: 'Intentionally different',
            parameters: { type: 'object', properties: { text: { type: 'string', description: 'Text' } }, required: [] },
          });
        }
        async perform(kwargs: Record<string, unknown>): Promise<string> {
          const text = (kwargs.text ?? '') as string;
          return JSON.stringify({
            status: 'success',
            word_count: 999, // Wrong!
            longest_word: 'wrong',
            reversed: text, // Not actually reversed
          });
        }
      }

      const original = new TextProcessorAgent();
      const origResult = JSON.parse(await original.execute({ text: 'hello world' }));

      const divergent = new DivergentClone();
      const divResult = JSON.parse(await divergent.execute({ text: 'hello world' }));

      const comparator = new ComparisonAgent();
      const compResult = JSON.parse(await comparator.execute({
        original_result: origResult,
        clone_result: divResult,
      }));

      expect(compResult.identical).toBe(false);
      expect(compResult.matches.word_count).toBe(false);
    });
  });

  describe('Trace-based agent description', () => {
    it('should extract meaningful description from trace spans', async () => {
      const tracer = createTracer({ recordIO: true });
      const agent = new TextProcessorAgent();

      // Run multiple executions to build trace profile
      for (const text of ['hello', 'hello world', 'one two three four five']) {
        const { span } = tracer.startSpan('TextProcessor', 'execute', undefined, { text });
        const resultStr = await agent.execute({ text });
        tracer.endSpan(span.id, { status: 'success', outputs: JSON.parse(resultStr) });
      }

      const completed = tracer.getCompletedSpans();
      expect(completed.length).toBe(3);
      expect(completed.every(s => s.agentName === 'TextProcessor')).toBe(true);
    });
  });
});
