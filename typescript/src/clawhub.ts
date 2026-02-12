/**
 * ClawHub Integration for openrappter (TypeScript)
 * Skills are public GitHub repos with skill.json + skill.md at their root.
 * Install by repo: "owner/repo" (e.g., "kody-w/rappterverse")
 */

import { readFile } from 'fs/promises';
import { BasicAgent, AgentMetadata } from './agents/index.js';

const GITHUB_RAW = 'https://raw.githubusercontent.com';

export interface ClawHubSkill {
  name: string;
  description: string;
  metadata?: Record<string, unknown>;
  path?: string;
  repo?: string;
}

/**
 * Parse a SKILL.md file from disk into a ClawHubSkill.
 */
export async function parseSkillFile(filePath: string): Promise<ClawHubSkill | null> {
  try {
    const content = await readFile(filePath, 'utf8');
    const frontmatter: Record<string, unknown> = {};
    let name = '';
    let description = '';

    // Parse YAML frontmatter
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (fmMatch) {
      for (const line of fmMatch[1].split('\n')) {
        const kvMatch = line.match(/^(\w+):\s*(.+)$/);
        if (kvMatch) {
          const [, key, value] = kvMatch;
          frontmatter[key] = value.replace(/^["']|["']$/g, '');
        }
      }
    }

    name = (frontmatter.name as string) ?? '';
    description = (frontmatter.description as string) ?? '';

    // Fallback: extract name from first heading
    if (!name) {
      const headingMatch = content.match(/^#\s+(.+)$/m);
      if (headingMatch) name = headingMatch[1].trim();
    }

    if (!name) return null;

    return { name, description, metadata: frontmatter, path: filePath };
  } catch {
    return null;
  }
}

export class ClawHubSkillAgent extends BasicAgent {
  skill: { name: string; description: string; path?: string; repo?: string };
  constructor(skill: { name: string; description: string; path?: string; repo?: string }) {
    const metadata: AgentMetadata = {
      name: skill.name,
      description: skill.description,
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super(skill.name, metadata);
    this.skill = skill;
  }
  async perform(): Promise<string> {
    return JSON.stringify({ status: 'info', message: 'ClawHub skill loaded', repo: this.skill.repo });
  }
}

export class ClawHubClient {
  skillsDir: string;
  constructor() { this.skillsDir = ''; }

  async search(query: string): Promise<Array<{ id: string; name: string; description: string; author?: string }>> {
    try {
      const response = await fetch(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+topic:openrappter-skill&sort=stars`,
        { headers: { Accept: 'application/vnd.github.v3+json' } }
      );
      if (!response.ok) return [];
      const data = (await response.json()) as { items: Array<{ full_name: string; name: string; description: string }> };
      return data.items.map((r) => ({ id: r.full_name, name: r.name, description: r.description ?? '', author: r.full_name.split('/')[0] }));
    } catch {
      return [];
    }
  }

  async install(repo: string): Promise<{ status: string; message: string }> {
    try {
      const res = await fetch(`${GITHUB_RAW}/${repo}/main/skill.json`);
      if (!res.ok) return { status: 'error', message: `No skill.json found in ${repo}` };
      return { status: 'success', message: `Skill found at ${repo}. Use SkillsRegistry.install("${repo}") to install.` };
    } catch {
      return { status: 'error', message: `Failed to reach ${repo}` };
    }
  }

  async listInstalled(): Promise<Array<{ name: string; description?: string }>> { return []; }

  async loadAllSkills(): Promise<ClawHubSkillAgent[]> { return []; }
}

export function getClient(): ClawHubClient { return new ClawHubClient(); }

export async function clawhubSearch(q: string): Promise<string> {
  const client = getClient();
  const results = await client.search(q);
  return JSON.stringify({ status: 'success', query: q, results });
}

export async function clawhubInstall(repo: string): Promise<string> {
  const client = getClient();
  const result = await client.install(repo);
  return JSON.stringify(result);
}

export async function clawhubList(): Promise<string> { return JSON.stringify({ status: 'success', skills: [] }); }
