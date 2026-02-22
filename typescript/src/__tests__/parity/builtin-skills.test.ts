/**
 * Built-in Skills Parity Tests
 * Tests the full 50+ bundled skills system:
 * - SKILL.md parsing (frontmatter, metadata, requires)
 * - Eligibility checking (OS, bins, env, config)
 * - Binary detection (hasBinary)
 * - Install specs format
 * - Skill categories and counts
 * - Built-in loader discovery
 * - RappterHub integration
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  hasBinary,
  resolveSkillMetadata,
  checkSkillEligibility,
  getSkillInstallInstructions,
  type SkillMetadata,
} from '../../skills/eligibility.js';

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills');

// All expected bundled skill names
const EXPECTED_SKILLS = [
  '1password', 'apple-notes', 'apple-reminders', 'bear-notes', 'bird',
  'blogwatcher', 'blucli', 'bluebubbles', 'camsnap', 'canvas',
  'clawhub', 'coding-agent', 'eightctl', 'gemini', 'gifgrep',
  'github', 'gog', 'goplaces', 'healthcheck', 'himalaya',
  'imsg', 'local-places', 'mcporter', 'model-usage', 'nano-banana-pro',
  'nano-pdf', 'notion', 'obsidian', 'openai-image-gen', 'openai-whisper',
  'openai-whisper-api', 'openhue', 'oracle', 'ordercli', 'peekaboo',
  'sag', 'session-logs', 'sherpa-onnx-tts', 'skill-creator', 'slack',
  'songsee', 'sonoscli', 'spotify-player', 'summarize', 'things-mac',
  'tmux', 'trello', 'video-frames', 'voice-call', 'wacli', 'weather',
];

// Skill category mapping (mirrors bundled.ts)
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
 * Simple frontmatter parser for tests (avoids importing bundled.ts → clawhub.ts → agents)
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
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

describe('Built-in Skills', () => {
  describe('Skill Discovery', () => {
    it('should have at least 50 bundled skills', () => {
      const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      expect(dirs.length).toBeGreaterThanOrEqual(50);
    });

    it('should include all expected skill directories', () => {
      const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

      for (const skill of EXPECTED_SKILLS) {
        expect(dirs, `Missing skill directory: ${skill}`).toContain(skill);
      }
    });

    it('should have a SKILL.md in each skill directory', () => {
      const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

      for (const dir of dirs) {
        const skillMdPath = join(SKILLS_DIR, dir, 'SKILL.md');
        const content = readFileSync(skillMdPath, 'utf8');
        expect(content.length, `Empty SKILL.md in ${dir}`).toBeGreaterThan(0);
      }
    });
  });

  describe('SKILL.md Parsing', () => {
    it('should parse YAML frontmatter from all skills', () => {
      for (const skill of EXPECTED_SKILLS) {
        const content = readFileSync(join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8');
        const { frontmatter } = parseFrontmatter(content);
        expect(frontmatter.name, `Missing name in ${skill}`).toBe(skill);
        expect(frontmatter.description, `Missing description in ${skill}`).toBeTruthy();
      }
    });

    it('should have metadata with openclaw key in all skills', () => {
      for (const skill of EXPECTED_SKILLS) {
        const content = readFileSync(join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8');
        const { frontmatter } = parseFrontmatter(content);
        expect(frontmatter.metadata, `Missing metadata in ${skill}`).toBeTruthy();

        const meta = resolveSkillMetadata(frontmatter);
        expect(meta, `Failed to resolve metadata in ${skill}`).not.toBeNull();
      }
    });

    it('should have emoji in all skill metadata', () => {
      for (const skill of EXPECTED_SKILLS) {
        const content = readFileSync(join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8');
        const { frontmatter } = parseFrontmatter(content);
        const meta = resolveSkillMetadata(frontmatter);
        expect(meta?.emoji, `Missing emoji in ${skill}`).toBeTruthy();
      }
    });

    it('should have body content after frontmatter', () => {
      for (const skill of EXPECTED_SKILLS) {
        const content = readFileSync(join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8');
        const { body } = parseFrontmatter(content);
        expect(body.trim().length, `Empty body in ${skill}`).toBeGreaterThan(0);
      }
    });

    it('should start body with markdown heading', () => {
      for (const skill of EXPECTED_SKILLS) {
        const content = readFileSync(join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8');
        const { body } = parseFrontmatter(content);
        const trimmed = body.trim();
        expect(trimmed.startsWith('#'), `Body should start with heading in ${skill}`).toBe(true);
      }
    });
  });

  describe('Metadata Requirements', () => {
    it('should parse bins requirements', () => {
      const content = readFileSync(join(SKILLS_DIR, '1password', 'SKILL.md'), 'utf8');
      const { frontmatter } = parseFrontmatter(content);
      const meta = resolveSkillMetadata(frontmatter);

      expect(meta?.requires?.bins).toContain('op');
    });

    it('should parse anyBins requirements', () => {
      const content = readFileSync(join(SKILLS_DIR, 'coding-agent', 'SKILL.md'), 'utf8');
      const { frontmatter } = parseFrontmatter(content);
      const meta = resolveSkillMetadata(frontmatter);

      expect(meta?.requires?.anyBins).toBeDefined();
      expect(meta?.requires?.anyBins).toContain('claude');
      expect(meta?.requires?.anyBins).toContain('codex');
    });

    it('should parse env requirements', () => {
      const content = readFileSync(join(SKILLS_DIR, 'notion', 'SKILL.md'), 'utf8');
      const { frontmatter } = parseFrontmatter(content);
      const meta = resolveSkillMetadata(frontmatter);

      expect(meta?.requires?.env).toContain('NOTION_API_KEY');
    });

    it('should parse config requirements', () => {
      const content = readFileSync(join(SKILLS_DIR, 'slack', 'SKILL.md'), 'utf8');
      const { frontmatter } = parseFrontmatter(content);
      const meta = resolveSkillMetadata(frontmatter);

      expect(meta?.requires?.config).toContain('channels.slack');
    });

    it('should parse OS requirements', () => {
      const content = readFileSync(join(SKILLS_DIR, 'tmux', 'SKILL.md'), 'utf8');
      const { frontmatter } = parseFrontmatter(content);
      const meta = resolveSkillMetadata(frontmatter);

      expect(meta?.os).toBeDefined();
      expect(meta?.os).toContain('darwin');
      expect(meta?.os).toContain('linux');
    });

    it('should parse combined bins and env requirements', () => {
      const content = readFileSync(join(SKILLS_DIR, 'trello', 'SKILL.md'), 'utf8');
      const { frontmatter } = parseFrontmatter(content);
      const meta = resolveSkillMetadata(frontmatter);

      expect(meta?.requires?.bins).toContain('jq');
      expect(meta?.requires?.env).toContain('TRELLO_API_KEY');
      expect(meta?.requires?.env).toContain('TRELLO_TOKEN');
    });

    it('should have install specs for skills that need them', () => {
      const content = readFileSync(join(SKILLS_DIR, '1password', 'SKILL.md'), 'utf8');
      const { frontmatter } = parseFrontmatter(content);
      const meta = resolveSkillMetadata(frontmatter);
      const installs = getSkillInstallInstructions(meta);

      expect(installs.length).toBeGreaterThan(0);
      expect(installs[0].id).toBe('brew');
      expect(installs[0].kind).toBe('brew');
      expect(installs[0].formula).toBe('1password-cli');
      expect(installs[0].bins).toContain('op');
    });
  });

  describe('Eligibility System', () => {
    describe('hasBinary', () => {
      it('should find common system binaries', () => {
        expect(hasBinary('ls')).toBe(true);
      });

      it('should return false for non-existent binaries', () => {
        expect(hasBinary('nonexistent_binary_xyz_12345')).toBe(false);
      });

      it('should find node binary', () => {
        expect(hasBinary('node')).toBe(true);
      });
    });

    describe('checkSkillEligibility', () => {
      it('should return eligible when no metadata', () => {
        const result = checkSkillEligibility(null);
        expect(result.eligible).toBe('eligible');
        expect(result.blocked).toBe(false);
        expect(result.missing).toHaveLength(0);
      });

      it('should return eligible when no requirements', () => {
        const meta: SkillMetadata = { emoji: '🎯' };
        const result = checkSkillEligibility(meta);
        expect(result.eligible).toBe('eligible');
        expect(result.blocked).toBe(false);
      });

      it('should block when required bin is missing', () => {
        const meta: SkillMetadata = {
          emoji: '🔧',
          requires: { bins: ['nonexistent_tool_xyz'] },
        };
        const result = checkSkillEligibility(meta);
        expect(result.eligible).toBe('blocked');
        expect(result.blocked).toBe(true);
        expect(result.missing).toContain('bin:nonexistent_tool_xyz');
      });

      it('should pass when required bin exists', () => {
        const meta: SkillMetadata = {
          emoji: '🔧',
          requires: { bins: ['node'] },
        };
        const result = checkSkillEligibility(meta);
        expect(result.eligible).toBe('eligible');
        expect(result.blocked).toBe(false);
      });

      it('should handle anyBins — eligible when at least one exists', () => {
        const meta: SkillMetadata = {
          emoji: '🔧',
          requires: { anyBins: ['nonexistent_xyz', 'node'] },
        };
        const result = checkSkillEligibility(meta);
        expect(result.eligible).toBe('eligible');
      });

      it('should handle anyBins — blocked when none exist', () => {
        const meta: SkillMetadata = {
          emoji: '🔧',
          requires: { anyBins: ['nonexistent_a', 'nonexistent_b'] },
        };
        const result = checkSkillEligibility(meta);
        expect(result.eligible).toBe('blocked');
        expect(result.missing[0]).toContain('anyBin:');
      });

      it('should block when env var is missing', () => {
        const meta: SkillMetadata = {
          emoji: '🔧',
          requires: { env: ['TOTALLY_FAKE_ENV_VAR_XYZ'] },
        };
        const result = checkSkillEligibility(meta);
        expect(result.eligible).toBe('blocked');
        expect(result.missing).toContain('env:TOTALLY_FAKE_ENV_VAR_XYZ');
      });

      it('should pass when env var exists', () => {
        const meta: SkillMetadata = {
          emoji: '🔧',
          requires: { env: ['PATH'] },
        };
        const result = checkSkillEligibility(meta);
        expect(result.eligible).toBe('eligible');
      });

      it('should block when config path is missing', () => {
        const meta: SkillMetadata = {
          emoji: '🔧',
          requires: { config: ['channels.slack'] },
        };
        const result = checkSkillEligibility(meta, {});
        expect(result.eligible).toBe('blocked');
        expect(result.missing).toContain('config:channels.slack');
      });

      it('should pass when config path exists', () => {
        const meta: SkillMetadata = {
          emoji: '🔧',
          requires: { config: ['channels.slack'] },
        };
        const config = { channels: { slack: { token: 'xoxb-...' } } };
        const result = checkSkillEligibility(meta, config);
        expect(result.eligible).toBe('eligible');
      });

      it('should block when OS does not match', () => {
        const meta: SkillMetadata = {
          emoji: '🔧',
          os: ['win32'],
        };
        const result = checkSkillEligibility(meta);
        if (process.platform !== 'win32') {
          expect(result.eligible).toBe('blocked');
          expect(result.missing[0]).toContain('os:');
        }
      });

      it('should pass when OS matches current platform', () => {
        const meta: SkillMetadata = {
          emoji: '🔧',
          os: [process.platform],
        };
        const result = checkSkillEligibility(meta);
        expect(result.eligible).toBe('eligible');
      });

      it('should aggregate multiple missing requirements', () => {
        const meta: SkillMetadata = {
          emoji: '🔧',
          requires: {
            bins: ['fake_bin_1', 'fake_bin_2'],
            env: ['FAKE_ENV_1'],
          },
        };
        const result = checkSkillEligibility(meta);
        expect(result.missing.length).toBeGreaterThanOrEqual(3);
      });
    });

    describe('resolveSkillMetadata', () => {
      it('should parse pre-parsed object metadata', () => {
        const frontmatter = {
          metadata: { openclaw: { emoji: '🔥', requires: { bins: ['git'] } } },
        };
        const meta = resolveSkillMetadata(frontmatter);
        expect(meta?.emoji).toBe('🔥');
        expect(meta?.requires?.bins).toContain('git');
      });

      it('should parse JSON string metadata', () => {
        const frontmatter = {
          metadata: '{"openclaw":{"emoji":"🌤️","requires":{"bins":["curl"]}}}',
        };
        const meta = resolveSkillMetadata(frontmatter);
        expect(meta?.emoji).toBe('🌤️');
        expect(meta?.requires?.bins).toContain('curl');
      });

      it('should return null for missing metadata', () => {
        const meta = resolveSkillMetadata({});
        expect(meta).toBeNull();
      });

      it('should handle openrappter key as alternative to openclaw', () => {
        const frontmatter = {
          metadata: { openrappter: { emoji: '🚀', requires: { bins: ['npm'] } } },
        };
        const meta = resolveSkillMetadata(frontmatter);
        expect(meta?.emoji).toBe('🚀');
      });
    });

    describe('getSkillInstallInstructions', () => {
      it('should return empty array for no metadata', () => {
        expect(getSkillInstallInstructions(null)).toHaveLength(0);
      });

      it('should return empty array for metadata without install', () => {
        const meta: SkillMetadata = { emoji: '🎯' };
        expect(getSkillInstallInstructions(meta)).toHaveLength(0);
      });

      it('should return install specs when present', () => {
        const meta: SkillMetadata = {
          emoji: '🎯',
          install: [
            { id: 'brew', kind: 'brew', formula: 'test-tool', bins: ['test'], label: 'Install test (brew)' },
          ],
        };
        const installs = getSkillInstallInstructions(meta);
        expect(installs).toHaveLength(1);
        expect(installs[0].kind).toBe('brew');
      });
    });
  });

  describe('Skill Eligibility for All Bundled Skills', () => {
    it('should check eligibility for every bundled skill', () => {
      for (const skill of EXPECTED_SKILLS) {
        const content = readFileSync(join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8');
        const { frontmatter } = parseFrontmatter(content);
        const meta = resolveSkillMetadata(frontmatter);
        const result = checkSkillEligibility(meta);

        expect(result.eligible, `Invalid eligibility for ${skill}`).toMatch(/^(eligible|blocked)$/);
        expect(typeof result.blocked).toBe('boolean');
        expect(Array.isArray(result.missing)).toBe(true);
      }
    });

    it('should make skills with no requirements eligible', () => {
      const noReqSkills = ['canvas', 'healthcheck', 'oracle', 'summarize', 'skill-creator', 'model-usage', 'obsidian'];

      for (const name of noReqSkills) {
        const content = readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
        const { frontmatter } = parseFrontmatter(content);
        const meta = resolveSkillMetadata(frontmatter);
        const result = checkSkillEligibility(meta);
        // These skills have no bins/env/config requirements, but may have OS checks
        // On macOS, they should be eligible
        if (!meta?.os || meta.os.includes(process.platform)) {
          expect(result.eligible, `${name} should be eligible`).toBe('eligible');
        }
      }
    });
  });

  describe('Skill Categories', () => {
    it('should assign categories to all expected skills', () => {
      for (const skill of EXPECTED_SKILLS) {
        expect(SKILL_CATEGORIES[skill], `No category for ${skill}`).toBeTruthy();
        expect(SKILL_CATEGORIES[skill]).not.toBe('other');
      }
    });

    it('should have expected category distribution', () => {
      const categories: Record<string, number> = {};
      for (const skill of EXPECTED_SKILLS) {
        const cat = SKILL_CATEGORIES[skill];
        categories[cat] = (categories[cat] ?? 0) + 1;
      }

      expect(categories['ai']).toBeGreaterThanOrEqual(5);
      expect(categories['communication']).toBeGreaterThanOrEqual(4);
      expect(categories['development']).toBeGreaterThanOrEqual(4);
      expect(categories['notes']).toBeGreaterThanOrEqual(4);
      expect(categories['smart-home']).toBeGreaterThanOrEqual(4);
      expect(categories['media']).toBeGreaterThanOrEqual(4);
    });

    it('should categorize specific skills correctly', () => {
      expect(SKILL_CATEGORIES['weather']).toBe('weather');
      expect(SKILL_CATEGORIES['github']).toBe('development');
      expect(SKILL_CATEGORIES['slack']).toBe('communication');
      expect(SKILL_CATEGORIES['openhue']).toBe('smart-home');
      expect(SKILL_CATEGORIES['gemini']).toBe('ai');
      expect(SKILL_CATEGORIES['notion']).toBe('notes');
      expect(SKILL_CATEGORIES['trello']).toBe('tasks');
      expect(SKILL_CATEGORIES['ordercli']).toBe('food');
      expect(SKILL_CATEGORIES['peekaboo']).toBe('automation');
    });
  });

  describe('Skill Requirement Types', () => {
    it('should identify skills requiring only bins', () => {
      const binOnlySkills = ['1password', 'github', 'weather', 'sag'];

      for (const name of binOnlySkills) {
        const content = readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
        const { frontmatter } = parseFrontmatter(content);
        const meta = resolveSkillMetadata(frontmatter);
        expect(meta?.requires?.bins?.length, `${name} should have bins`).toBeGreaterThan(0);
      }
    });

    it('should identify skills requiring env vars', () => {
      const envSkills = ['notion', 'gemini', 'gifgrep', 'bird'];

      for (const name of envSkills) {
        const content = readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
        const { frontmatter } = parseFrontmatter(content);
        const meta = resolveSkillMetadata(frontmatter);
        expect(meta?.requires?.env?.length, `${name} should have env reqs`).toBeGreaterThan(0);
      }
    });

    it('should identify skills requiring config paths', () => {
      const configSkills = ['slack', 'bluebubbles', 'voice-call'];

      for (const name of configSkills) {
        const content = readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
        const { frontmatter } = parseFrontmatter(content);
        const meta = resolveSkillMetadata(frontmatter);
        expect(meta?.requires?.config?.length, `${name} should have config reqs`).toBeGreaterThan(0);
      }
    });

    it('should identify macOS-only skills', () => {
      const darwinSkills = ['apple-notes', 'apple-reminders', 'imsg', 'peekaboo', 'things-mac'];

      for (const name of darwinSkills) {
        const content = readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
        const { frontmatter } = parseFrontmatter(content);
        const meta = resolveSkillMetadata(frontmatter);
        expect(meta?.os, `${name} should have os restriction`).toBeDefined();
        expect(meta?.os).toContain('darwin');
      }
    });

    it('should identify skills with no requirements', () => {
      const noReqSkills = ['canvas', 'healthcheck', 'oracle', 'summarize', 'skill-creator', 'model-usage', 'obsidian'];

      for (const name of noReqSkills) {
        const content = readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
        const { frontmatter } = parseFrontmatter(content);
        const meta = resolveSkillMetadata(frontmatter);
        const req = meta?.requires;
        const hasRequirements = (req?.bins?.length ?? 0) > 0
          || (req?.anyBins?.length ?? 0) > 0
          || (req?.env?.length ?? 0) > 0
          || (req?.config?.length ?? 0) > 0;
        expect(hasRequirements, `${name} should have no requirements`).toBe(false);
      }
    });
  });

  describe('Install Specs', () => {
    it('should have brew install specs', () => {
      const brewSkills = ['1password', 'himalaya', 'openhue', 'camsnap'];

      for (const name of brewSkills) {
        const content = readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
        const { frontmatter } = parseFrontmatter(content);
        const meta = resolveSkillMetadata(frontmatter);
        const installs = getSkillInstallInstructions(meta);
        const brew = installs.find((i) => i.kind === 'brew');
        expect(brew, `${name} should have brew install`).toBeDefined();
        expect(brew?.formula).toBeTruthy();
      }
    });

    it('should have go install specs', () => {
      const goSkills = ['eightctl', 'ordercli', 'wacli'];

      for (const name of goSkills) {
        const content = readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
        const { frontmatter } = parseFrontmatter(content);
        const meta = resolveSkillMetadata(frontmatter);
        const installs = getSkillInstallInstructions(meta);
        const goInstall = installs.find((i) => i.kind === 'go');
        expect(goInstall, `${name} should have go install`).toBeDefined();
        expect(goInstall?.module).toBeTruthy();
      }
    });

    it('should have pip install specs', () => {
      const pipSkills = ['openai-whisper', 'sherpa-onnx-tts'];

      for (const name of pipSkills) {
        const content = readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
        const { frontmatter } = parseFrontmatter(content);
        const meta = resolveSkillMetadata(frontmatter);
        const installs = getSkillInstallInstructions(meta);
        const pip = installs.find((i) => i.kind === 'pip');
        expect(pip, `${name} should have pip install`).toBeDefined();
        expect(pip?.module).toBeTruthy();
      }
    });

    it('should include bins in install specs', () => {
      const content = readFileSync(join(SKILLS_DIR, '1password', 'SKILL.md'), 'utf8');
      const { frontmatter } = parseFrontmatter(content);
      const meta = resolveSkillMetadata(frontmatter);
      const installs = getSkillInstallInstructions(meta);

      for (const spec of installs) {
        expect(spec.bins?.length, 'Install spec should list bins').toBeGreaterThan(0);
        expect(spec.label).toBeTruthy();
      }
    });
  });

  describe('Frontmatter Format Compatibility', () => {
    it('should have standard frontmatter delimiters in all skills', () => {
      for (const skill of EXPECTED_SKILLS) {
        const content = readFileSync(join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8');
        expect(content.startsWith('---\n'), `${skill} should start with ---`).toBe(true);
        expect(content.includes('\n---\n'), `${skill} should have closing ---`).toBe(true);
      }
    });

    it('should have valid JSON metadata in all skills', () => {
      for (const skill of EXPECTED_SKILLS) {
        const content = readFileSync(join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8');
        const metadataLine = content.split('\n').find((l) => l.startsWith('metadata:'));
        expect(metadataLine, `${skill} should have metadata line`).toBeTruthy();

        const jsonStr = metadataLine!.replace(/^metadata:\s*/, '');
        let parsed: unknown;
        try {
          parsed = JSON.parse(jsonStr);
        } catch {
          // Some skills use multiline metadata; that's OK
          parsed = null;
        }

        // If it's a single-line JSON, it should be parseable
        if (!jsonStr.includes('\n') && jsonStr.startsWith('{')) {
          expect(parsed, `${skill} metadata should be valid JSON`).not.toBeNull();
        }
      }
    });
  });
});
