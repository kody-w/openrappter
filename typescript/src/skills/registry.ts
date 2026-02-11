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

const CLAWHUB_API = 'https://clawhub.dev/api';
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
   * Search for skills on ClawHub
   */
  async search(query: string): Promise<SkillSearchResult[]> {
    try {
      const response = await fetch(
        `${CLAWHUB_API}/skills/search?q=${encodeURIComponent(query)}`
      );

      if (!response.ok) {
        throw new Error(`Search failed: ${response.statusText}`);
      }

      const data = (await response.json()) as { skills: SkillSearchResult[] };
      return data.skills;
    } catch (error) {
      console.error('Failed to search ClawHub:', error);
      return [];
    }
  }

  /**
   * Install a skill from ClawHub
   */
  async install(skillId: string, version?: string): Promise<InstalledSkill | null> {
    try {
      // Fetch skill info
      const infoUrl = version
        ? `${CLAWHUB_API}/skills/${skillId}/${version}`
        : `${CLAWHUB_API}/skills/${skillId}/latest`;

      const infoResponse = await fetch(infoUrl);
      if (!infoResponse.ok) {
        throw new Error(`Skill not found: ${skillId}`);
      }

      const manifest = (await infoResponse.json()) as SkillManifest;

      // Download skill files
      const downloadUrl = `${CLAWHUB_API}/skills/${skillId}/${manifest.version}/download`;
      const downloadResponse = await fetch(downloadUrl);
      if (!downloadResponse.ok) {
        throw new Error('Failed to download skill');
      }

      // Extract to skills directory
      const skillPath = join(this.skillsDir, skillId);
      await mkdir(skillPath, { recursive: true });

      // Save manifest
      await writeFile(
        join(skillPath, 'manifest.json'),
        JSON.stringify(manifest, null, 2)
      );

      // Save skill content (assuming JSON response with files)
      const content = await downloadResponse.json();
      if (content.files) {
        for (const [filename, data] of Object.entries(content.files)) {
          await writeFile(join(skillPath, filename), data as string);
        }
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

      console.log(`Installed skill: ${manifest.name} v${manifest.version}`);
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
        if (frontmatter.tools) skill.tools = frontmatter.tools;
        if (frontmatter.prompts) skill.prompts = frontmatter.prompts;
        if (frontmatter.examples) skill.examples = frontmatter.examples;
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
