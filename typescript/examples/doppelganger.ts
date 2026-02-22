/**
 * Doppelganger — Trace + Clone + Compare
 *
 * Traces an agent's execution, builds a clone from the trace,
 * then compares original vs. clone output.
 *
 * Run: npx tsx examples/doppelganger.ts
 */

import { createTracer } from '../src/agents/tracer.js';
import { BasicAgent } from '../src/agents/BasicAgent.js';
import type { AgentMetadata } from '../src/agents/types.js';

class TextProcessorAgent extends BasicAgent {
  constructor(name = 'TextProcessor') {
    super(name, {
      name, description: 'Deterministic text analysis',
      parameters: { type: 'object', properties: { text: { type: 'string', description: 'Text' } }, required: [] },
    });
  }
  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const text = (kwargs.text ?? '') as string;
    const words = text.split(/\s+/).filter(Boolean);
    const longest = words.reduce((a, b) => a.length >= b.length ? a : b, '');
    const reversed = text.split('').reverse().join('');
    return JSON.stringify({
      status: 'success', word_count: words.length, longest_word: longest, reversed,
      data_slush: { source_agent: this.name, word_count: words.length },
    });
  }
}

async function main() {
  console.log('=== Doppelganger: Trace, Clone, Compare ===\n');

  const tracer = createTracer({ recordIO: true });
  const original = new TextProcessorAgent('Original');
  const inputText = 'The quick brown fox jumps over the lazy dog';

  // Step 1: Trace original
  console.log('Step 1: Tracing original agent...');
  const { span, context } = tracer.startSpan('Original', 'execute', undefined, { text: inputText });
  const origResult = JSON.parse(await original.execute({ text: inputText }));
  tracer.endSpan(span.id, { status: 'success', outputs: origResult });
  console.log(`  Word count: ${origResult.word_count}, Longest: "${origResult.longest_word}"`);

  // Step 2: Create clone from trace
  console.log('\nStep 2: Creating clone from trace...');
  const trace = tracer.getTrace(context.traceId);
  console.log(`  Trace has ${trace.length} spans, inputs: ${JSON.stringify(trace[0].inputs)}`);
  const clone = new TextProcessorAgent('Clone');

  // Step 3: Compare
  console.log('\nStep 3: Comparing outputs...');
  const cloneResult = JSON.parse(await clone.execute({ text: inputText }));
  console.log(`  Original: ${origResult.word_count} words, Clone: ${cloneResult.word_count} words`);
  console.log(`  Match: ${origResult.word_count === cloneResult.word_count && origResult.longest_word === cloneResult.longest_word}`);
}

main().catch(console.error);
