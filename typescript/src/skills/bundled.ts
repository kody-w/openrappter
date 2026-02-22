/**
 * Built-in Skills Loader
 * Discovers and loads bundled SKILL.md files shipped with openrappter.
 */

import { readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  resolveSkillMetadata,
  checkSkillEligibility,
  getSkillInstallInstructions,
  type SkillMetadata,
  type EligibilityResult,
  type SkillInstallSpec,
} from './eligibility.js';
import { parseSkillFile, type ClawHubSkill } from '../clawhub.js';

export interface BundledSkillInfo {
  name: string;
  description: string;
  metadata: SkillMetadata | null;
  eligibility: EligibilityResult;
  installInstructions: SkillInstallSpec[];
  path: string;
  category: string;
}

/**
 * Skill category mapping
 */
const SKILL_CATEGORIES: Record<string, string> = {
  '1password': 'passwords',
  'apple-notes': 'notes',
  'apple-reminders': 'tasks',
  'bear-notes': 'notes',
  'bird': 'social',
  'blogwatcher': 'media',
  'blucli': 'smart-home',
  'bluebubbles': 'communication',
  'camsnap': 'media',
  'canvas': 'media',
  'clawhub': 'meta',
  'coding-agent': 'development',
  'eightctl': 'smart-home',
  'gemini': 'ai',
  'gifgrep': 'media',
  'github': 'development',
  'gog': 'workspace',
  'goplaces': 'workspace',
  'healthcheck': 'meta',
  'himalaya': 'workspace',
  'imsg': 'communication',
  'local-places': 'workspace',
  'mcporter': 'development',
  'model-usage': 'meta',
  'nano-banana-pro': 'ai',
  'nano-pdf': 'notes',
  'notion': 'notes',
  'obsidian': 'notes',
  'openai-image-gen': 'ai',
  'openai-whisper': 'ai',
  'openai-whisper-api': 'ai',
  'openhue': 'smart-home',
  'oracle': 'ai',
  'ordercli': 'food',
  'peekaboo': 'automation',
  'sag': 'ai',
  'session-logs': 'development',
  'sherpa-onnx-tts': 'ai',
  'skill-creator': 'meta',
  'slack': 'communication',
  'songsee': 'media',
  'sonoscli': 'smart-home',
  'spotify-player': 'smart-home',
  'summarize': 'ai',
  'things-mac': 'tasks',
  'tmux': 'development',
  'trello': 'tasks',
  'video-frames': 'media',
  'voice-call': 'communication',
  'wacli': 'communication',
  'weather': 'weather',
};

/**
 * Resolve the path to the bundled skills directory.
 * Skills are located at `typescript/skills/` relative to the package.
 */
export function getBundledSkillsDir(): string {
  // In ESM, resolve relative to this file: src/skills/bundled.ts → ../../skills/
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return join(thisDir, '..', '..', 'skills');
}

/**
 * Discover all bundled SKILL.md files from the skills directory.
 */
export async function loadBundledSkills(
  skillsDir?: string
): Promise<ClawHubSkill[]> {
  const dir = skillsDir ?? getBundledSkillsDir();
  const skills: ClawHubSkill[] = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillMdPath = join(dir, entry.name, 'SKILL.md');
      try {
        const skill = await parseSkillFile(skillMdPath);
        if (skill) {
          skills.push(skill);
        }
      } catch {
        // Skip directories without valid SKILL.md
      }
    }
  } catch {
    // Skills directory doesn't exist
  }

  return skills;
}

/**
 * List all bundled skills with their eligibility status.
 */
export async function listBundledSkills(
  skillsDir?: string,
  config?: Record<string, unknown>
): Promise<BundledSkillInfo[]> {
  const dir = skillsDir ?? getBundledSkillsDir();
  const skills = await loadBundledSkills(dir);
  const results: BundledSkillInfo[] = [];

  for (const skill of skills) {
    const metadata = resolveSkillMetadata({
      metadata: skill.metadata,
    });
    const eligibility = checkSkillEligibility(metadata, config);
    const installInstructions = getSkillInstallInstructions(metadata);

    results.push({
      name: skill.name,
      description: skill.description,
      metadata,
      eligibility,
      installInstructions,
      path: skill.path ?? '',
      category: SKILL_CATEGORIES[skill.name] ?? 'other',
    });
  }

  return results;
}

/**
 * Parse SKILL.md frontmatter directly from file content.
 * Used for testing and direct file access.
 */
export function parseBundledFrontmatter(
  content: string
): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const frontmatterText = match[1];
  const body = match[2];
  const frontmatter: Record<string, unknown> = {};

  for (const line of frontmatterText.split('\n')) {
    const kvMatch = line.match(/^(\w+):\s*(.+)$/);
    if (kvMatch) {
      const [, key, value] = kvMatch;
      if (key === 'metadata') {
        try {
          frontmatter[key] = JSON.parse(value);
        } catch {
          frontmatter[key] = value;
        }
      } else {
        frontmatter[key] = value.replace(/^["']|["']$/g, '');
      }
    }
  }

  return { frontmatter, body };
}
