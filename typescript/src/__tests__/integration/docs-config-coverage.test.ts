import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';

import { openRappterConfigSchema } from '../../config/schema.js';
import { parseConfigContent } from '../../config/loader.js';

/**
 * A configuration example has to be one the runtime would actually read.
 *
 * Unknown keys are stripped rather than rejected, which makes a wrong example
 * indistinguishable from a right one at the point a reader tries it: the file
 * validates, the process starts, and nothing they asked for happens. Six
 * separate config surfaces on the docs site turned out to be like this —
 * `shell.allowlist`, `gateway.host`/`secret`, `logging.audit`, `provider.*`,
 * per-channel credentials, and the file format itself, which was shown as YAML
 * throughout when neither runtime has ever parsed YAML.
 *
 * Each of those was found by hand. This finds them mechanically:
 *
 *   1. a config example must parse the way the loader parses (JSON5), and
 *   2. every key in it must survive the schema.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const docsDir = path.join(repoRoot, 'docs');

interface Example {
  file: string;
  line: number;
  body: string;
}

function stripTags(html: string): string {
  return html
    .replace(/<span[^>]*>/g, '')
    .replace(/<\/span>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');
}

/**
 * Every `<pre>` block that presents itself as the config file.
 *
 * The marker is the filename in the first line, which is how these examples are
 * already written. A block that shows a shell session or a snippet of code is
 * not claiming to be loadable and is left alone.
 */
function configExamples(): Example[] {
  const found: Example[] = [];
  for (const name of fs.readdirSync(docsDir).filter((f) => f.endsWith('.html'))) {
    const file = path.join(docsDir, name);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/<pre>/.test(lines[i])) continue;
      const first = stripTags(lines[i]);
      if (!/config\.(json5|yaml|yml)/.test(first)) continue;

      const collected: string[] = [];
      let j = i;
      let cursor = lines[j].slice(lines[j].indexOf('<pre>') + 5);
      for (;;) {
        const end = cursor.indexOf('</pre>');
        if (end >= 0) {
          collected.push(cursor.slice(0, end));
          break;
        }
        collected.push(cursor);
        j++;
        if (j >= lines.length) break;
        cursor = lines[j];
      }
      found.push({
        file: path.relative(repoRoot, file),
        line: i + 1,
        body: stripTags(collected.join('\n')),
      });
      i = j;
    }
  }
  return found;
}

/** Key paths present in the example but absent after the schema has seen it. */
function droppedKeys(input: unknown, output: unknown, trail: string[] = []): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const here = [...trail, key];
    const kept = output && typeof output === 'object'
      ? (output as Record<string, unknown>)[key]
      : undefined;
    if (kept === undefined) {
      dropped.push(here.join('.'));
      continue;
    }
    dropped.push(...droppedKeys(value, kept, here));
  }
  return dropped;
}

describe('documented configuration is configuration that loads', () => {
  const examples = configExamples();

  it('finds the config examples on the docs site', () => {
    // Guards the extractor rather than the docs: a regex that quietly matched
    // nothing would make the two tests below pass over an empty list.
    expect(examples.length).toBeGreaterThanOrEqual(3);
    const bodies = examples.map((e) => e.body).join('\n');
    expect(bodies).toContain('models');
    expect(bodies).toContain('gateway');
  });

  it('parses every example the way the loader parses config', () => {
    const unparseable: string[] = [];
    for (const example of examples) {
      // The first line names the file; the rest is the file.
      const body = example.body.split('\n').slice(1).join('\n').trim();
      if (!body) continue;
      try {
        parseConfigContent(body);
      } catch (err) {
        unparseable.push(
          `  ${example.file}:${example.line}\n    ${(err as Error).message.split('\n')[0]}`,
        );
      }
    }
    expect(
      unparseable,
      unparseable.length
        ? 'A config example the loader cannot parse is one a reader cannot use.\n' +
          'The loader is JSON5; YAML has never been read by either runtime.\n\n' +
          `${unparseable.join('\n\n')}\n`
        : '',
    ).toEqual([]);
  });

  it('keeps every key the examples set', () => {
    const problems: string[] = [];
    for (const example of examples) {
      const body = example.body.split('\n').slice(1).join('\n').trim();
      if (!body) continue;
      let parsed: unknown;
      try {
        parsed = JSON5.parse(body);
      } catch {
        continue; // reported by the test above
      }
      const result = openRappterConfigSchema.safeParse(parsed);
      if (!result.success) {
        problems.push(`  ${example.file}:${example.line}\n    rejected: ${result.error.issues[0]?.message}`);
        continue;
      }
      const dropped = droppedKeys(parsed, result.data);
      if (dropped.length) {
        problems.push(`  ${example.file}:${example.line}\n    silently discarded: ${dropped.join(', ')}`);
      }
    }
    expect(
      problems,
      problems.length
        ? 'These examples validate cleanly and configure nothing.\n' +
          'Unknown keys are stripped, so a reader gets no error and no effect.\n\n' +
          `${problems.join('\n\n')}\n`
        : '',
    ).toEqual([]);
  });
});
