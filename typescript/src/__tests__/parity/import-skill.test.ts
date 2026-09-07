/**
 * import_skill / SkillAgent Parity Tests
 *
 * Tests the TypeScript port of LearnNewAgent's `import_skill` action and the
 * native SkillAgent runner, mirroring:
 *   python/tests/test_import_skill.py
 *   python/openrappter/agents/skill_agent.py
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

async function writeDemoSkill(base: string, withScript = true): Promise<string> {
  const skillDir = path.join(base, 'demo-skill');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: DemoEcho',
      'description: A demo skill that echoes input.',
      '---',
      '',
      '# Demo Echo Skill',
      '',
      'This skill echoes back whatever you send it.',
      '',
    ].join('\n'),
  );
  if (withScript) {
    const scriptsDir = path.join(skillDir, 'scripts');
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(
      path.join(scriptsDir, 'run.js'),
      "const [, , input] = process.argv;\nconsole.log(JSON.stringify({ status: 'success', echoed: input || '' }));\n",
    );
  }
  return skillDir;
}

describe('LearnNewAgent import_skill', () => {
  let LearnNewAgentClass: typeof import('../../agents/LearnNewAgent.js').LearnNewAgent;
  let tmpDir: string;
  let agentsDir: string;

  beforeEach(async () => {
    const mod = await import('../../agents/LearnNewAgent.js');
    LearnNewAgentClass = mod.LearnNewAgent;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'import-skill-test-'));
    agentsDir = path.join(tmpDir, 'agents_out');
    await fs.mkdir(agentsDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('exposes import_skill in the action enum', () => {
    const agent = new LearnNewAgentClass(agentsDir);
    expect(agent.metadata.parameters.properties.action.enum).toContain('import_skill');
  });

  it('errors when skill_path is missing', async () => {
    const agent = new LearnNewAgentClass(agentsDir);
    const result = JSON.parse(await agent.perform({ action: 'import_skill' }));
    expect(result.status).toBe('error');
  });

  it('errors when no SKILL.md exists at the path', async () => {
    const agent = new LearnNewAgentClass(agentsDir);
    const result = JSON.parse(
      await agent.perform({ action: 'import_skill', skill_path: path.join(tmpDir, 'nope') }),
    );
    expect(result.status).toBe('error');
    expect(result.message).toContain('No SKILL.md found');
  });

  it('generates a loadable agent from a skill directory', async () => {
    const skillDir = await writeDemoSkill(tmpDir);
    const agent = new LearnNewAgentClass(agentsDir);
    const result = JSON.parse(await agent.perform({ action: 'import_skill', skill_path: skillDir }));

    expect(result.status).toBe('success');
    expect(result.agent_name).toBe('DemoEcho');
    expect(result.hot_loaded).toBe(true);
    expect(result.implementation).toBe('skill_import');

    const filePath: string = result.file_path;
    const stat = await fs.stat(filePath);
    expect(stat.isFile()).toBe(true);

    const fileUrl = `file://${filePath}?t=${Date.now()}`;
    const generated = await import(fileUrl);
    const { BasicAgent } = await import('../../agents/BasicAgent.js');
    const AgentClass = generated.createAgent(BasicAgent);
    const instance = new AgentClass();
    expect(instance.name).toBe('DemoEcho');

    const runResult = JSON.parse(await instance.perform({ query: 'hello world' }));
    const inner = JSON.parse(runResult.output);
    expect(inner.echoed).toBe('hello world');
  });

  it('accepts a direct SKILL.md path and a name override', async () => {
    const skillDir = await writeDemoSkill(tmpDir);
    const agent = new LearnNewAgentClass(agentsDir);
    const result = JSON.parse(
      await agent.perform({
        action: 'import_skill',
        skill_path: path.join(skillDir, 'SKILL.md'),
        name: 'Other',
      }),
    );
    expect(result.status).toBe('success');
    expect(result.agent_name).toBe('Other');
  });

  it('errors on duplicate agent name', async () => {
    const skillDir = await writeDemoSkill(tmpDir);
    const agent = new LearnNewAgentClass(agentsDir);
    const first = JSON.parse(await agent.perform({ action: 'import_skill', skill_path: skillDir }));
    expect(first.status).toBe('success');
    const second = JSON.parse(await agent.perform({ action: 'import_skill', skill_path: skillDir }));
    expect(second.status).toBe('error');
    expect(second.message).toContain('already exists');
  });

  it('falls back to instructions when the skill has no scripts', async () => {
    const skillDir = await writeDemoSkill(tmpDir, false);
    const agent = new LearnNewAgentClass(agentsDir);
    const result = JSON.parse(await agent.perform({ action: 'import_skill', skill_path: skillDir }));
    expect(result.status).toBe('success');

    const filePath: string = result.file_path;
    const fileUrl = `file://${filePath}?t=${Date.now()}`;
    const generated = await import(fileUrl);
    const { BasicAgent } = await import('../../agents/BasicAgent.js');
    const AgentClass = generated.createAgent(BasicAgent);
    const instance = new AgentClass();

    const runResult = JSON.parse(await instance.perform({ query: 'anything' }));
    expect(runResult.status).toBe('info');
    expect(runResult.instructions).toContain('echoes back');
  });

  it('protects SkillAgent core files from listing and deletion', async () => {
    await fs.writeFile(path.join(agentsDir, 'skill_agent.js'), '// core');
    const agent = new LearnNewAgentClass(agentsDir);

    const listed = JSON.parse(await agent.perform({ action: 'list' }));
    expect(listed.count).toBe(0);

    const deleted = JSON.parse(await agent.perform({ action: 'delete', name: 'skill' }));
    expect(deleted.status).toBe('error');
  });
});

describe('SkillAgent', () => {
  let SkillAgentClass: typeof import('../../agents/SkillAgent.js').SkillAgent;
  let tmpDir: string;

  beforeEach(async () => {
    const mod = await import('../../agents/SkillAgent.js');
    SkillAgentClass = mod.SkillAgent;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-agent-test-'));
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('lists discoverable skills', async () => {
    await writeDemoSkill(tmpDir);
    const agent = new SkillAgentClass(tmpDir);
    const result = JSON.parse(await agent.perform({ action: 'list' }));
    expect(result.status).toBe('success');
    expect(result.count).toBe(1);
    expect(result.skills[0].name).toBe('DemoEcho');
  });

  it('runs a skill by name, executing its script', async () => {
    await writeDemoSkill(tmpDir);
    const agent = new SkillAgentClass(tmpDir);
    const result = JSON.parse(await agent.perform({ action: 'run', skill: 'demo-skill', query: 'hi there' }));
    const inner = JSON.parse(result.output);
    expect(inner.echoed).toBe('hi there');
  });

  it('runs a skill via an explicit path', async () => {
    const skillDir = await writeDemoSkill(tmpDir);
    const agent = new SkillAgentClass(tmpDir);
    const result = JSON.parse(await agent.perform({ action: 'run', skill_path: skillDir, query: 'direct' }));
    const inner = JSON.parse(result.output);
    expect(inner.echoed).toBe('direct');
  });

  it('returns full instructions for action=info', async () => {
    await writeDemoSkill(tmpDir);
    const agent = new SkillAgentClass(tmpDir);
    const result = JSON.parse(await agent.perform({ action: 'info', skill: 'demo-skill' }));
    expect(result.status).toBe('success');
    expect(result.skill).toBe('DemoEcho');
    expect(result.instructions).toContain('echoes back');
  });

  it('errors when the named skill does not exist', async () => {
    const agent = new SkillAgentClass(tmpDir);
    const result = JSON.parse(await agent.perform({ action: 'run', skill: 'nope' }));
    expect(result.status).toBe('error');
  });

  it('errors when no skill identifier is given', async () => {
    const agent = new SkillAgentClass(tmpDir);
    const result = JSON.parse(await agent.perform({ action: 'run' }));
    expect(result.status).toBe('error');
  });
});
