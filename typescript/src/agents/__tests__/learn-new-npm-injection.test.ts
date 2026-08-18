import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isValidNpmPackageName } from '../LearnNewAgent.js';

const SOURCE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'LearnNewAgent.ts'),
  'utf-8',
);

/**
 * LearnNewAgent asks a model to write agent code, scans that code for imports,
 * then installs them. The import specifier is therefore model-authored,
 * untrusted input on a path to a command line.
 *
 * Before the fix, `npm install --save ${pkg}` ran through a shell, so
 * `import x from 'lodash; touch pwned'` executed an arbitrary command.
 */
describe('LearnNewAgent dependency install is not shell-injectable', () => {
  // The extraction in detectMissingImports, replicated so the test states the
  // threat in terms of what the product actually parses.
  function extractPackages(code: string): string[] {
    const pattern = /import\s+(?:.*?\s+from\s+)?['"]([^'"./][^'"]*)['"]/g;
    const found: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(code)) !== null) {
      const pkg = m[1];
      found.push(pkg.startsWith('@') ? pkg.split('/').slice(0, 2).join('/') : pkg.split('/')[0]);
    }
    return found;
  }

  it('extracts a package name carrying shell metacharacters from generated code', () => {
    // Documents that the taint is real: the regex permits spaces and `;`, and
    // split('/') does not remove them. This is the input the fix must survive.
    const [pkg] = extractPackages(`import x from 'lodash; touch pwned-marker'`);
    expect(pkg).toBe('lodash; touch pwned-marker');
  });

  it('rejects every extracted name that is not a valid npm package name', () => {
    const payloads = [
      "lodash; touch pwned-marker",
      "lodash && curl evil.example",
      "lodash | sh",
      "lodash`whoami`",
      "lodash$(whoami)",
      "lodash\nrm -rf .",
      "../../etc/passwd",
      "lodash ; :",
    ];
    for (const payload of payloads) {
      const [extracted] = extractPackages(`import x from '${payload}'`);
      const candidate = extracted ?? payload;
      expect(isValidNpmPackageName(candidate), `should reject ${JSON.stringify(candidate)}`).toBe(false);
    }
  });

  it('still accepts the package names real generated code imports', () => {
    for (const good of ['lodash', 'axios', 'node-fetch', '@scope/pkg', 'left-pad', 'p-queue', 'rxjs']) {
      expect(isValidNpmPackageName(good), `should accept ${good}`).toBe(true);
    }
  });

  it('installs through an argument vector, never a shell command string', () => {
    // The structural half: even a valid name must not be interpolated into a
    // command line, so that a future validator change cannot reopen the hole.
    expect(SOURCE).not.toMatch(/exec(?:Async|Sync)?\(\s*`npm install/);
    expect(SOURCE).toMatch(/execFileAsync\(\s*'npm',\s*\['install',\s*'--save',\s*pkg\]/);
  });

  it('does not retain a shell-capable exec helper in this module', () => {
    expect(SOURCE).not.toMatch(/promisify\(exec\)/);
  });
});
