/**
 * RAPP brainstem drop-in compliance for TypeScript agents.
 *
 * Every packaged `*Agent.ts` is imported in a clean Node subprocess and every
 * exported perform-capable class is constructed with zero arguments. The two
 * standalone meta agents, plus generated/drop-in files, also go through the
 * production restricted loader so only the BasicAgent/storage shims, sibling
 * drop files, and Node builtins resolve.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ts from 'typescript';
import { loadStandaloneAgentFile } from '../../brainstem.js';
import { LearnNewAgent } from '../../agents/LearnNewAgent.js';

const execFileAsync = promisify(execFile);
const SRC = fileURLToPath(new URL('../../', import.meta.url));
const AGENTS = path.join(SRC, 'agents');
const RUNNER = fileURLToPath(
  new URL('../fixtures/brainstem-compliance-runner.ts', import.meta.url),
);
const WORK = path.join(
  path.dirname(SRC),
  '.test-work',
  `brainstem-compliance-${process.pid}`,
);
const LEGACY_HOST_IMPORTS = new Set([
  'BrainstemAgent.ts:../gateway/brainstem-client.js',
  'ComputerUseAgent.ts:../show-and-tell/active.js',
  'DailyTipAgent.ts:../infra/cli-port.js',
  'DailyTipAgent.ts:../infra/openrappter-home.js',
  'DesktopControlAgent.ts:../desktop-control/index.js',
  'DreamAgent.ts:../infra/openrappter-home.js',
  'GoogleVoiceAgent.ts:../telephony/reply.js',
  'GoogleVoiceAgent.ts:../telephony/watcher.js',
  'ImageAgent.ts:../net/url-guard.js',
  'MemoryAgent.ts:../infra/openrappter-home.js',
  'MemoryAgent.ts:../memory/json-store.js',
  'OuroborosAgent.ts:../env.js',
  'OuroborosAgent.ts:../providers/recorded-chat.js',
  'PhoneAgent.ts:../telephony/brain.js',
  'PhoneAgent.ts:../telephony/call-agent.js',
  'PhoneAgent.ts:../telephony/constraints.js',
  'PhoneAgent.ts:../telephony/hotline.js',
  'PhoneAgent.ts:../telephony/providers/google-voice.js',
  'PhoneAgent.ts:../telephony/providers/resolve.js',
  'PhoneAgent.ts:../telephony/types.js',
  'QuantumRappidAgent.ts:../rappids/index.js',
  'ShellAgent.ts:../security/exec-safety.js',
  'ShowAndTellAgent.ts:../flight-recorder/index.js',
  'ShowAndTellAgent.ts:../show-and-tell/index.js',
  'UpdateAgent.ts:../infra/openrappter-home.js',
  'WebAgent.ts:../net/url-guard.js',
]);

interface ComplianceResult {
  file: string;
  agents: Array<{
    class: string;
    name: string;
    hasMetadata: boolean;
    description: string;
    hasParameters: boolean;
    performCallable: boolean;
    acceptsEmpty: boolean;
    acceptsDeclared: boolean;
    toolName?: string;
  }>;
  error: string | null;
  stack?: string;
}

async function agentFiles(): Promise<string[]> {
  return (await fs.readdir(AGENTS))
    .filter(file =>
      file.endsWith('Agent.ts')
      && file !== 'BasicAgent.ts'
      // Registry adapter, not an agent file: AgentRegistry constructs it with
      // a Python descriptor and the class explicitly carries isTemplate=true.
      && file !== 'PythonAgent.ts'
    )
    .sort()
    .map(file => path.join(AGENTS, file));
}

async function loadInSubprocess(file: string): Promise<ComplianceResult> {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ['--import', 'tsx', RUNNER, file],
    {
      cwd: path.dirname(SRC),
      timeout: 60_000,
      env: { ...process.env, OPENRAPPTER_HOME: path.join(WORK, 'home') },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  expect(stderr, `${path.basename(file)} wrote to stderr`).toBe('');
  return JSON.parse(stdout.trim().split('\n').at(-1)!) as ComplianceResult;
}

async function runtimeHostImports(): Promise<string[]> {
  const imports: string[] = [];
  for (const file of await agentFiles()) {
    const filename = path.basename(file);
    const source = ts.createSourceFile(
      filename,
      await fs.readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith('../')) continue;
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      if (
        clause
        && !clause.name
        && clause.namedBindings
        && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.every(element => element.isTypeOnly)
      ) continue;
      imports.push(`${filename}:${specifier}`);
    }
  }
  return imports.sort();
}

function assertCompliant(result: ComplianceResult): void {
  expect(result.error, result.stack ?? result.error ?? '').toBeNull();
  expect(result.agents.length, `${result.file} registered no agents`).toBeGreaterThan(0);
  for (const agent of result.agents) {
    const label = `${path.basename(result.file)} -> ${agent.class}`;
    expect(agent.name, `${label}: missing name`).not.toBe('');
    expect(agent.hasMetadata, `${label}: missing metadata`).toBe(true);
    expect(agent.description, `${label}: missing description`).not.toBe('');
    expect(agent.hasParameters, `${label}: missing parameters`).toBe(true);
    expect(agent.performCallable, `${label}: perform is not callable`).toBe(true);
    expect(agent.acceptsEmpty, `${label}: perform({}) failed`).toBe(true);
    expect(agent.acceptsDeclared, `${label}: perform(all declared keys) failed`).toBe(true);
    expect(agent.toolName, `${label}: tool name mismatch`).toBe(agent.name);
  }
}

beforeAll(async () => {
  await fs.rm(WORK, { recursive: true, force: true });
  await fs.mkdir(WORK, { recursive: true });
});

afterAll(async () => {
  await fs.rm(WORK, { recursive: true, force: true });
});

describe('packaged agent contract', async () => {
  const files = await agentFiles();

  it('discovers the complete TypeScript agent set', () => {
    expect(files.length).toBeGreaterThanOrEqual(30);
    expect(files.map(file => path.basename(file))).toContain('SkillAgent.ts');
    expect(files.map(file => path.basename(file))).toContain('LearnNewAgent.ts');
  });

  for (const file of files) {
    it(path.basename(file), async () => {
      assertCompliant(await loadInSubprocess(file));
    }, 65_000);
  }
});

describe('strict standalone import contract', () => {
  it('allows no new host-internal imports in any packaged agent', async () => {
    const imports = await runtimeHostImports();
    const newImports = imports.filter(item => !LEGACY_HOST_IMPORTS.has(item));
    expect(newImports).toEqual([]);
    expect(imports).not.toContain('SkillAgent.ts:../infra/openrappter-home.js');
    expect(imports).not.toContain('LearnNewAgent.ts:../providers/recorded-chat.js');
  });

  for (const filename of ['SkillAgent.ts', 'LearnNewAgent.ts']) {
    it(`${filename} needs only the kernel shim and Node builtins`, async () => {
      const agents = await loadStandaloneAgentFile(path.join(AGENTS, filename), {
        agentsRoot: AGENTS,
        cacheDir: path.join(WORK, 'cache'),
        home: path.join(WORK, 'home', 'brainstem'),
      });
      expect(agents.map(agent => agent.name)).toContain(
        filename === 'SkillAgent.ts' ? 'Skill' : 'LearnNew',
      );
      for (const agent of agents) {
        expect(agent.toTool?.().function.name ?? agent.name).toBe(agent.name);
      }
    });
  }

  it('rejects a package-internal import instead of leaking the package into isolation', async () => {
    const isolated = path.join(WORK, 'negative');
    await fs.mkdir(isolated, { recursive: true });
    const bad = path.join(isolated, 'BadAgent.ts');
    await fs.writeFile(bad, `
import { BasicAgent } from './BasicAgent.js';
import { anything } from '../forbidden-package-internal.js';
export class BadAgent extends BasicAgent {
  constructor() {
    super('Bad', {
      name: 'Bad',
      description: 'Must fail before this can load.',
      parameters: { type: 'object', properties: {}, required: [] },
    });
    void anything;
  }
  async perform(_kwargs = {}) { return '{}'; }
}
`);
    await expect(loadStandaloneAgentFile(bad, {
      agentsRoot: isolated,
      cacheDir: path.join(WORK, 'negative-cache'),
      home: path.join(WORK, 'home', 'brainstem'),
    })).rejects.toThrow('Package-internal import is not brainstem-compliant');
  });

  it('recursively loads co-dropped TypeScript sibling modules through the isolated cache', async () => {
    const isolated = path.join(WORK, 'siblings');
    await fs.mkdir(isolated, { recursive: true });
    await fs.writeFile(path.join(isolated, 'helper.ts'), `export const suffix = ' works';\n`);
    const agentFile = path.join(isolated, 'SiblingAgent.ts');
    await fs.writeFile(agentFile, `
import { BasicAgent } from './BasicAgent.js';
import { suffix } from './helper.js';
export class SiblingAgent extends BasicAgent {
  constructor() {
    super('Sibling', {
      name: 'Sibling',
      description: 'Uses a co-dropped sibling module.',
      parameters: { type: 'object', properties: {}, required: [] },
    });
  }
  async perform(_kwargs = {}) { return 'sibling' + suffix; }
}
`);
    const agents = await loadStandaloneAgentFile(agentFile, {
      agentsRoot: isolated,
      cacheDir: path.join(WORK, 'sibling-cache'),
      home: path.join(WORK, 'home', 'brainstem'),
    });
    expect(agents).toHaveLength(1);
    expect(await agents[0].perform({})).toBe('sibling works');
  });

  it('loads LearnNewAgent output under the same standalone contract', async () => {
    const generatedDir = path.join(WORK, 'generated');
    const generator = new LearnNewAgent(generatedDir);
    const created = JSON.parse(await generator.perform({
      action: 'create',
      description: 'count words in text',
      name: 'WordCounter',
    })) as { status: string };
    expect(created.status).toBe('success');
    const generated = (await fs.readdir(generatedDir))
      .find(file => file.endsWith('_agent.js'));
    expect(generated).toBeTruthy();
    const agents = await loadStandaloneAgentFile(path.join(generatedDir, generated!), {
      agentsRoot: generatedDir,
      cacheDir: path.join(WORK, 'generated-cache'),
      home: path.join(WORK, 'home', 'brainstem'),
    });
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('WordCounter');
    expect(agents[0].toTool?.().function.name ?? agents[0].name).toBe('WordCounter');
  });
});
