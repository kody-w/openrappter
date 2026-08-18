import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A documented agent has to return what `perform` is declared to return.
 *
 * `BasicAgent.perform` is `abstract perform(kwargs): Promise<string>`, and every
 * shipped agent honours it — `JSON.stringify(...)` in TypeScript, `json.dumps(...)`
 * in Python, 240 times over in the Python agents alone.
 *
 * Two of the three places that teach agent authoring had drifted from that. The
 * Agents Reference (#307) and the tutorial (#308) both returned a bare object,
 * so the TypeScript they showed did not compile and the Python disagreed with
 * every real agent. README.md had it right the whole time, which is what makes
 * this worth a test rather than a third correction: the examples are supposed to
 * agree, and nothing was checking that they did.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');

interface Block {
  file: string;
  line: number;
  body: string;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Code blocks that define an agent's `perform`, from HTML `<pre>` and fenced markdown. */
function agentExamples(): Block[] {
  const found: Block[] = [];
  const docsDir = path.join(repoRoot, 'docs');
  const files = fs.existsSync(docsDir)
    ? fs.readdirSync(docsDir)
        .filter((f) => f.endsWith('.html') || f.endsWith('.md'))
        .map((f) => path.join(docsDir, f))
    : [];
  files.push(path.join(repoRoot, 'README.md'));

  for (const file of files.filter((f) => fs.existsSync(f))) {
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n');
    const rel = path.relative(repoRoot, file);

    if (file.endsWith('.md')) {
      let open = -1;
      lines.forEach((line, i) => {
        if (!/^\s*```/.test(line)) return;
        if (open < 0) { open = i; return; }
        const body = lines.slice(open + 1, i).join('\n');
        if (/\bperform\s*\(/.test(body)) found.push({ file: rel, line: open + 1, body });
        open = -1;
      });
      continue;
    }

    for (let i = 0; i < lines.length; i++) {
      if (!/<pre>/.test(lines[i])) continue;
      let j = i;
      while (j < lines.length && !/<\/pre>/.test(lines[j])) j++;
      const body = stripTags(lines.slice(i, j + 1).join('\n'));
      if (/\bperform\s*\(/.test(body)) found.push({ file: rel, line: i + 1, body });
      i = j;
    }
  }
  return found;
}

describe('documented agents return what perform is declared to return', () => {
  const examples = agentExamples();

  it('finds the agent examples', () => {
    // Guards the extractor: matching nothing would make the test below pass
    // over an empty list, which is the failure this whole area keeps producing.
    expect(examples.length).toBeGreaterThanOrEqual(3);
    expect(examples.map((e) => e.file)).toContain('README.md');
  });

  it('returns a serialised string, never a bare object', () => {
    const problems: string[] = [];

    for (const example of examples) {
      const lines = example.body.split('\n');
      const start = lines.findIndex((l) => /\bperform\s*\(/.test(l));
      if (start < 0) continue;

      lines.slice(start).forEach((line, offset) => {
        // A return whose value opens an object literal or dict on the spot.
        if (!/^\s*return\s*\{/.test(line)) return;
        problems.push(
          `  ${example.file}:${example.line + start + offset}\n` +
          `    ${line.trim().slice(0, 72)}\n` +
          '    perform is Promise<string>: wrap it in JSON.stringify(...) or json.dumps(...)',
        );
      });
    }

    expect(
      problems,
      problems.length
        ? 'An agent example returns an object where the base class requires a string.\n' +
          'The TypeScript form does not compile; the Python form disagrees with every\n' +
          `shipped agent.\n\n${problems.join('\n\n')}\n`
        : '',
    ).toEqual([]);
  });
});
