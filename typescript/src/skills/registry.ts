/**
 * Skills Registry
 * Manages skill discovery, installation, and loading from ClawHub
 */

import { readdir, readFile, writeFile, mkdir, stat, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';

export interface Skill {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  tags?: string[];
  tools?: SkillTool[];
  prompts?: SkillPrompt[];
  examples?: SkillExample[];
  config?: SkillConfig;
}

export interface SkillTool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface SkillPrompt {
  id: string;
  template: string;
  variables?: string[];
}

export interface SkillExample {
  input: string;
  output: string;
}

export interface SkillConfig {
  type: 'object';
  properties: Record<string, unknown>;
}

export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  tags?: string[];
  homepage?: string;
  repository?: string;
  license?: string;
}

export interface InstalledSkill {
  manifest: SkillManifest;
  path: string;
  installedAt: string;
  enabled: boolean;
}

export interface SkillSearchResult {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  downloads?: number;
  rating?: number;
}

// Skills are public GitHub repos with skill.json + skill.md at their root
const GITHUB_RAW = 'https://raw.githubusercontent.com';
const GITHUB_API = 'https://api.github.com';
const DEFAULT_SKILLS_DIR = join(homedir(), '.openrappter', 'skills');

export class SkillsRegistry {
  private skillsDir: string;
  private installed = new Map<string, InstalledSkill>();
  private loaded = new Map<string, Skill>();

  constructor(skillsDir?: string) {
    this.skillsDir = skillsDir ?? DEFAULT_SKILLS_DIR;
  }

  /**
   * Initialize the registry
   */
  async initialize(): Promise<void> {
    // Ensure skills directory exists
    await mkdir(this.skillsDir, { recursive: true });

    // Load installed skills
    await this.loadInstalledSkills();
  }

  /**
   * Search for skills on GitHub
   * Searches public repos that contain a skill.json file
   */
  async search(query: string): Promise<SkillSearchResult[]> {
    try {
      const response = await fetch(
        `${GITHUB_API}/search/repositories?q=${encodeURIComponent(query)}+topic:openrappter-skill&sort=stars&order=desc`,
        { headers: { Accept: 'application/vnd.github.v3+json' } }
      );

      if (!response.ok) {
        throw new Error(`Search failed: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        items: Array<{
          full_name: string;
          name: string;
          description: string;
          owner: { login: string };
          stargazers_count: number;
        }>;
      };

      return data.items.map((repo) => ({
        id: repo.full_name,
        name: repo.name,
        version: 'latest',
        description: repo.description ?? '',
        author: repo.owner.login,
        rating: repo.stargazers_count,
      }));
    } catch (error) {
      console.error('Failed to search GitHub:', error);
      return [];
    }
  }

  /**
   * Install a skill from a public GitHub repo
   * @param skillId - GitHub repo in "owner/repo" format (e.g., "kody-w/rappterverse")
   */
  async install(skillId: string, version?: string): Promise<InstalledSkill | null> {
    try {
      const branch = version ?? 'main';

      // Fetch skill.json from the repo
      const skillJsonUrl = `${GITHUB_RAW}/${skillId}/${branch}/skill.json`;
      const infoResponse = await fetch(skillJsonUrl);
      if (!infoResponse.ok) {
        throw new Error(`Skill not found: ${skillId} (no skill.json at ${skillJsonUrl})`);
      }

      const skillJson = (await infoResponse.json()) as {
        name: string;
        version?: string;
        description: string;
        author?: string;
        tags?: string[];
        homepage?: string;
        repository?: string;
      };

      const manifest: SkillManifest = {
        id: skillId,
        name: skillJson.name,
        version: skillJson.version ?? '1.0.0',
        description: skillJson.description,
        author: skillJson.author,
        tags: skillJson.tags,
        homepage: skillJson.homepage,
        repository: skillJson.repository ?? skillId,
      };

      // Create skill directory (flatten owner/repo to owner--repo for filesystem)
      const safeDirName = skillId.replace('/', '--');
      const skillPath = join(this.skillsDir, safeDirName);
      await mkdir(skillPath, { recursive: true });

      // Save manifest
      await writeFile(
        join(skillPath, 'manifest.json'),
        JSON.stringify(manifest, null, 2)
      );

      // Save the full skill.json
      await writeFile(
        join(skillPath, 'skill.json'),
        JSON.stringify(skillJson, null, 2)
      );

      // Fetch and save skill.md if it exists
      try {
        const skillMdUrl = `${GITHUB_RAW}/${skillId}/${branch}/skill.md`;
        const mdResponse = await fetch(skillMdUrl);
        if (mdResponse.ok) {
          const mdContent = await mdResponse.text();
          await writeFile(join(skillPath, 'SKILL.md'), mdContent);
        }
      } catch {
        // skill.md is optional
      }

      // Register installed skill
      const installed: InstalledSkill = {
        manifest,
        path: skillPath,
        installedAt: new Date().toISOString(),
        enabled: true,
      };

      this.installed.set(skillId, installed);
      await this.saveLockFile();

      console.log(`Installed skill: ${manifest.name} v${manifest.version} from ${skillId}`);
      return installed;
    } catch (error) {
      console.error(`Failed to install skill ${skillId}:`, error);
      return null;
    }
  }

  /**
   * Uninstall a skill
   */
  async uninstall(skillId: string): Promise<boolean> {
    const installed = this.installed.get(skillId);
    if (!installed) {
      return false;
    }

    try {
      // Remove skill directory
      await rm(installed.path, { recursive: true, force: true });

      // Update registry
      this.installed.delete(skillId);
      this.loaded.delete(skillId);
      await this.saveLockFile();

      console.log(`Uninstalled skill: ${skillId}`);
      return true;
    } catch (error) {
      console.error(`Failed to uninstall skill ${skillId}:`, error);
      return false;
    }
  }

  /**
   * Load a skill
   */
  async loadSkill(skillId: string): Promise<Skill | null> {
    const installed = this.installed.get(skillId);
    if (!installed) {
      return null;
    }

    if (this.loaded.has(skillId)) {
      return this.loaded.get(skillId)!;
    }

    try {
      // Read SKILL.md if exists
      const skillMdPath = join(installed.path, 'SKILL.md');
      let skillContent: string | null = null;
      try {
        skillContent = await readFile(skillMdPath, 'utf8');
      } catch {
        // No SKILL.md
      }

      // Parse skill from SKILL.md or manifest
      const skill: Skill = {
        id: installed.manifest.id,
        name: installed.manifest.name,
        version: installed.manifest.version,
        description: installed.manifest.description,
        author: installed.manifest.author,
        tags: installed.manifest.tags,
        tools: [],
        prompts: [],
        examples: [],
      };

      if (skillContent) {
        // Parse YAML frontmatter
        const frontmatter = this.parseFrontmatter(skillContent);
        if (frontmatter.tools) skill.tools = frontmatter.tools as SkillTool[];
        if (frontmatter.prompts) skill.prompts = frontmatter.prompts as SkillPrompt[];
        if (frontmatter.examples) skill.examples = frontmatter.examples as SkillExample[];
      }

      this.loaded.set(skillId, skill);
      return skill;
    } catch (error) {
      console.error(`Failed to load skill ${skillId}:`, error);
      return null;
    }
  }

  /**
   * Enable a skill
   */
  async enableSkill(skillId: string): Promise<boolean> {
    const installed = this.installed.get(skillId);
    if (!installed) return false;

    installed.enabled = true;
    await this.saveLockFile();
    return true;
  }

  /**
   * Disable a skill
   */
  async disableSkill(skillId: string): Promise<boolean> {
    const installed = this.installed.get(skillId);
    if (!installed) return false;

    installed.enabled = false;
    await this.saveLockFile();
    return true;
  }

  /**
   * Get all installed skills
   */
  getInstalled(): InstalledSkill[] {
    return Array.from(this.installed.values());
  }

  /**
   * Get all enabled skills
   */
  getEnabled(): InstalledSkill[] {
    return this.getInstalled().filter((s) => s.enabled);
  }

  /**
   * Get a loaded skill
   */
  getSkill(skillId: string): Skill | undefined {
    return this.loaded.get(skillId);
  }

  /**
   * Get all loaded skills
   */
  getLoadedSkills(): Skill[] {
    return Array.from(this.loaded.values());
  }

  /**
   * Load all enabled skills
   */
  async loadEnabled(): Promise<Skill[]> {
    const skills: Skill[] = [];
    for (const installed of this.getEnabled()) {
      const skill = await this.loadSkill(installed.manifest.id);
      if (skill) {
        skills.push(skill);
      }
    }
    return skills;
  }

  // Private methods

  private async loadInstalledSkills(): Promise<void> {
    // Load from lock file
    const lockPath = join(this.skillsDir, 'openrappter-skills.lock');
    try {
      const lockData = await readFile(lockPath, 'utf8');
      const lock = JSON.parse(lockData) as { skills: InstalledSkill[] };
      for (const skill of lock.skills) {
        this.installed.set(skill.manifest.id, skill);
      }
    } catch {
      // No lock file, scan directory
      await this.scanSkillsDirectory();
    }
  }

  private async scanSkillsDirectory(): Promise<void> {
    try {
      const entries = await readdir(this.skillsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const manifestPath = join(this.skillsDir, entry.name, 'manifest.json');
          try {
            const manifestData = await readFile(manifestPath, 'utf8');
            const manifest = JSON.parse(manifestData) as SkillManifest;

            const installed: InstalledSkill = {
              manifest,
              path: join(this.skillsDir, entry.name),
              installedAt: new Date().toISOString(),
              enabled: true,
            };

            this.installed.set(manifest.id, installed);
          } catch {
            // Invalid skill directory
          }
        }
      }

      await this.saveLockFile();
    } catch {
      // Skills directory doesn't exist
    }
  }

  private async saveLockFile(): Promise<void> {
    const lockPath = join(this.skillsDir, 'openrappter-skills.lock');
    const lock = {
      skills: Array.from(this.installed.values()),
    };
    await writeFile(lockPath, JSON.stringify(lock, null, 2));
  }

  private parseFrontmatter(content: string): Record<string, unknown> {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};

    try {
      // Simple YAML parsing for common cases
      const yaml = match[1];
      const result: Record<string, unknown> = {};

      const lines = yaml.split('\n');
      let currentKey: string | null = null;
      let currentValue: unknown[] | null = null;

      for (const line of lines) {
        const keyMatch = line.match(/^(\w+):\s*(.*)$/);
        if (keyMatch) {
          if (currentKey && currentValue) {
            result[currentKey] = currentValue;
          }
          currentKey = keyMatch[1];
          const value = keyMatch[2].trim();
          if (value) {
            result[currentKey] = value;
            currentKey = null;
            currentValue = null;
          } else {
            currentValue = [];
          }
        } else if (currentValue && line.startsWith('  - ')) {
          currentValue.push(line.slice(4).trim());
        }
      }

      if (currentKey && currentValue) {
        result[currentKey] = currentValue;
      }

      return result;
    } catch {
      return {};
    }
  }
}

export function createSkillsRegistry(skillsDir?: string): SkillsRegistry {
  return new SkillsRegistry(skillsDir);
}
