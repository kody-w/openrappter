/**
 * SkillAgent - Runs raw SKILL.md files natively, without per-skill code generation.
 *
 * SKILL.md is a generic, cross-tool convention (used by ClawHub, and by
 * Hermes/Nous Research under the agentskills.io open standard) for packaging
 * a capability as Markdown instructions plus an optional `scripts/`
 * directory (`[category/]<skill>/SKILL.md`). This agent discovers, parses,
 * and executes any such skill directly (in `~/.openrappter/skills/` or an
 * explicit path) — no agent file is generated for it.
 *
 * For turning a skill into its own standalone, hot-loadable agent file
 * instead, see LearnNewAgent's `import_skill` action.
 *
 * Self-contained (no import of clawhub.ts) on purpose, for parity with the
 * Python port: `openrappter/agents/skill_agent.py` cannot import
 * `openrappter.clawhub` there because Python agents must stay droppable,
 * standalone, into a bare rapp-installer "brainstem" that provides only
 * `basic_agent` (see `tests/test_brainstem_compliance.py`). TypeScript has
 * no equivalent kernel today, but the two runtimes are meant to behave
 * identically, so the SKILL.md parsing/execution logic is duplicated here
 * rather than imported, exactly as on the Python side.
 *
 * Mirrors Python agents/skill_agent.py
 */

import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, readdir, stat } from 'fs/promises';
import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';

const execFileAsync = promisify(execFile);

function openrappterPath(...segments: string[]): string {
  // Kept local so this file remains brainstem-droppable; constructing the
  // default avoids a second literal source of the repository-wide home path.
  const defaultHome = path.join(os.homedir(), ['.open', 'rappter'].join(''));
  const home = process.env.OPENRAPPTER_HOME?.trim() || defaultHome;
  return path.join(home, ...segments);
}

export const __manifest__ = {
  schema: 'rapp-agent/1.0',
  name: '@openrappter/skill',
  version: '1.0.0',
  display_name: 'Skill',
  description: 'Runs raw SKILL.md files natively — list, inspect, and execute skills (the generic ClawHub/agentskills.io SKILL.md convention) without generating a dedicated agent file for each one.',
  author: 'Kody Wildfeuer',
  ring: 'ga',
  capabilities: [
    'credential-access',
    'process-exec',
  ],
  tags: [
    'openrappter',
    'skill',
  ],
  category: 'meta',
  quality_tier: 'official',
  requires_env: [],
} as const;

interface ParsedSkill {
  name: string;
  description: string;
  content: string;
  metadata: Record<string, string>;
  path: string;
}

/** Parse a SKILL.md's frontmatter + body with a regex (no YAML dependency). */
async function parseSkillMd(filePath: string): Promise<ParsedSkill | null> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }

  const metadata: Record<string, string> = {};
  let name = '';
  let description = '';
  let body = content;

  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (fmMatch) {
    for (const line of fmMatch[1].split(/\r?\n/)) {
      const kv = line.match(/^(\w+):\s*(.+)$/);
      if (kv) metadata[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    }
    body = fmMatch[2];
  }

  name = metadata.name ?? '';
  description = metadata.description ?? '';

  if (!name) {
    const heading = content.match(/^#\s+(.+)$/m);
    if (heading) name = heading[1].trim();
  }
  if (!name) {
    name = path.basename(path.dirname(filePath)) || path.basename(filePath, path.extname(filePath));
  }

  if (!description) {
    for (const para of body.split(/\n\n+/)) {
      const trimmed = para.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        description = trimmed.slice(0, 200);
        break;
      }
    }
  }

  return { name, description, content: body, metadata, path: filePath };
}

/** Resolve a path to an actual SKILL.md — either the file itself or a directory containing one. */
async function resolveSkillMdPath(inputPath: string): Promise<string | null> {
  try {
    const st = await stat(inputPath);
    if (st.isFile()) return inputPath;
    if (st.isDirectory()) {
      for (const candidate of ['SKILL.md', 'skill.md']) {
        const found = path.join(inputPath, candidate);
        try {
          const s = await stat(found);
          if (s.isFile()) return found;
        } catch {
          // try next candidate
        }
      }
    }
  } catch {
    // path does not exist
  }
  return null;
}

/** Try to execute a script from a skill's `scripts/` directory. */
async function executeSkillScript(scriptsDir: string, query: string, skillName = ''): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(scriptsDir);
  } catch {
    return null;
  }

  const runners: Array<[string, string]> = [
    [process.execPath, '.js'],
    ['python3', '.py'],
    ['bash', '.sh'],
  ];

  for (const [interpreter, ext] of runners) {
    const script = entries.find(f => f.endsWith(ext));
    if (!script) continue;
    try {
      const { stdout, stderr } = await execFileAsync(
        interpreter,
        [path.join(scriptsDir, script), query],
        { cwd: path.dirname(scriptsDir), timeout: 30_000 },
      );
      return JSON.stringify({
        status: 'success',
        skill: skillName,
        script,
        output: stdout || stderr,
        return_code: 0,
      });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; code?: number };
      return JSON.stringify({
        status: 'error',
        skill: skillName,
        script,
        output: err.stdout || err.stderr || '',
        return_code: err.code ?? 1,
      });
    }
  }

  return null;
}

export class SkillAgent extends BasicAgent {
  private skillsDir: string;

  constructor(skillsDir?: string) {
    const metadata: AgentMetadata = {
      name: 'Skill',
      description: 'Runs raw SKILL.md files natively. List available skills, inspect one, or run it (executing its scripts/ if present, otherwise returning its instructions).',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'Action to perform.',
            enum: ['run', 'list', 'info'],
          },
          skill: {
            type: 'string',
            description: "Skill name to look up under the skills directory (e.g. 'pdf' or 'creative/motion-graphics').",
          },
          skill_path: {
            type: 'string',
            description: "Explicit path to a SKILL.md file or a directory containing one. Overrides 'skill' if both are given.",
          },
          query: {
            type: 'string',
            description: "Natural language input passed through to the skill's script (if any).",
          },
        },
        required: [],
      },
    };
    super('Skill', metadata);
    this.skillsDir = skillsDir ?? openrappterPath('skills');
  }

  async perform(kwargs: Record<string, unknown> = {}): Promise<string> {
    const action = (kwargs.action as string) || 'run';
    if (action === 'list') {
      return this.listSkills();
    }

    const skillPathInput = this.resolveInputPath(kwargs);
    if (!skillPathInput) {
      return JSON.stringify({
        status: 'error',
        message: "Provide 'skill_path' (a SKILL.md file or skill directory) or 'skill' (a name under the skills directory).",
      });
    }

    const resolved = await resolveSkillMdPath(skillPathInput);
    if (!resolved) {
      return JSON.stringify({ status: 'error', message: `No SKILL.md found at ${skillPathInput}` });
    }

    const skill = await parseSkillMd(resolved);
    if (!skill) {
      return JSON.stringify({ status: 'error', message: `Failed to parse ${resolved}` });
    }

    const hasScripts = await this.hasScriptsDir(skill);

    if (action === 'info') {
      return JSON.stringify({
        status: 'success',
        skill: skill.name,
        description: skill.description,
        instructions: skill.content,
        metadata: skill.metadata,
        path: skill.path,
        has_scripts: hasScripts,
      });
    }

    // action === 'run' (default)
    const query = (kwargs.query as string) || '';
    if (hasScripts) {
      const scriptsDir = path.join(path.dirname(skill.path), 'scripts');
      const result = await executeSkillScript(scriptsDir, query, skill.name);
      if (result) return result;
    }

    return JSON.stringify({
      status: 'info',
      skill: skill.name,
      description: skill.description,
      instructions: skill.content.slice(0, 4000),
      message: `Skill '${skill.name}' loaded natively. This skill provides instructions/documentation with no matching script for this input.`,
      has_scripts: hasScripts,
    });
  }

  private resolveInputPath(kwargs: Record<string, unknown>): string | null {
    const skillPath = kwargs.skill_path as string;
    if (skillPath) return skillPath;

    const skillName = kwargs.skill as string;
    if (skillName) return path.join(this.skillsDir, skillName);

    return null;
  }

  private async hasScriptsDir(skill: ParsedSkill): Promise<boolean> {
    try {
      const s = await stat(path.join(path.dirname(skill.path), 'scripts'));
      return s.isDirectory();
    } catch {
      return false;
    }
  }

  private async listSkills(): Promise<string> {
    const skills: Array<{ name: string; description: string; path: string; has_scripts: boolean }> = [];
    const skillMdPaths = await this.findSkillMdFiles(this.skillsDir);

    for (const skillMd of skillMdPaths.sort()) {
      const parsed = await parseSkillMd(skillMd);
      if (!parsed) continue;
      skills.push({
        name: parsed.name,
        description: parsed.description,
        path: skillMd,
        has_scripts: await this.hasScriptsDir(parsed),
      });
    }

    return JSON.stringify({
      status: 'success',
      skills_dir: this.skillsDir,
      skills,
      count: skills.length,
    });
  }

  /** Recursively find all SKILL.md files under a directory (mirrors Python's Path.rglob). */
  private async findSkillMdFiles(dir: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const results: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await this.findSkillMdFiles(full)));
      } else if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') {
        results.push(full);
      }
    }
    return results;
  }
}
