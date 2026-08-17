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
 * A read of the bundled skills directory, including whether it was there.
 *
 * #165 shipped 52 skills that the published tarball had never carried, and
 * recorded why nobody noticed: `loadBundledSkills` catches a missing directory
 * and returns an empty list, so "this install shipped no skills" and "this
 * install legitimately has none" are the same answer. That silent swallow is
 * deliberate and stays — a caller with no skills directory is a legitimate
 * case. But a caller that needs to tell the two apart had no way to ask.
 *
 * `directoryPresent` is the missing bit. It is false only when the directory
 * could not be read at all; a readable but empty directory is present with
 * zero skills, which is the honest distinction.
 */
export interface BundledSkillsRead<T> {
  /** The directory that was read. */
  directory: string;
  /** The directory existed and could be listed. */
  directoryPresent: boolean;
  skills: T[];
}

/**
 * Discover all bundled SKILL.md files, reporting whether the directory existed.
 */
export async function readBundledSkills(
  skillsDir?: string
): Promise<BundledSkillsRead<ClawHubSkill>> {
  const dir = skillsDir ?? getBundledSkillsDir();
  const skills: ClawHubSkill[] = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // Skills directory doesn't exist
    return { directory: dir, directoryPresent: false, skills };
  }

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

  return { directory: dir, directoryPresent: true, skills };
}

/**
 * Discover all bundled SKILL.md files from the skills directory.
 *
 * Returns an empty list when the directory is absent. Callers that must not
 * mistake a missing install for an empty one want `readBundledSkills`.
 */
export async function loadBundledSkills(
  skillsDir?: string
): Promise<ClawHubSkill[]> {
  return (await readBundledSkills(skillsDir)).skills;
}

/**
 * List all bundled skills with their eligibility, reporting whether the
 * bundled skills directory existed at all.
 */
export async function readBundledSkillInfo(
  skillsDir?: string,
  config?: Record<string, unknown>
): Promise<BundledSkillsRead<BundledSkillInfo>> {
  const dir = skillsDir ?? getBundledSkillsDir();
  const read = await readBundledSkills(dir);
  const results: BundledSkillInfo[] = [];

  for (const skill of read.skills) {
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

  return { directory: read.directory, directoryPresent: read.directoryPresent, skills: results };
}

/**
 * List all bundled skills with their eligibility status.
 */
export async function listBundledSkills(
  skillsDir?: string,
  config?: Record<string, unknown>
): Promise<BundledSkillInfo[]> {
  return (await readBundledSkillInfo(skillsDir, config)).skills;
}

/**
 * Parse SKILL.md frontmatter directly from file content.
 * Used for testing and direct file access.
 */
export function parseBundledFrontmatter(
  content: string
): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const frontmatterText = match[1];
  const body = match[2];
  const frontmatter: Record<string, unknown> = {};

  for (const line of frontmatterText.split('\n')) {
    const cleaned = line.replace(/\r$/, '');
    const kvMatch = cleaned.match(/^(\w+):\s*(.+)$/);
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
