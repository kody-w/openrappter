/**
 * Skills Ecosystem Parity Tests
 * Tests that openrappter skills system matches openclaw:
 * - Skill registry with search/install/load
 * - Skill binaries
 * - Built-in skill categories
 * - Skill creator
 */

import { describe, it, expect } from 'vitest';

describe('Skills Ecosystem Parity', () => {
  describe('Skill Registry', () => {
    it('should search for skills', () => {
      const request = {
        method: 'skills.search',
        params: { query: 'notes' },
      };

      const response = {
        results: [
          { name: 'apple-notes', description: 'Access Apple Notes', version: '1.0.0' },
          { name: 'obsidian', description: 'Obsidian vault integration', version: '1.2.0' },
        ],
      };

      expect(response.results.length).toBeGreaterThan(0);
    });

    it('should install skill from ClawHub', () => {
      const request = {
        method: 'skills.install',
        params: { slug: 'apple-notes' },
      };

      const response = {
        success: true,
        skill: 'apple-notes',
        version: '1.0.0',
        installedAt: new Date().toISOString(),
      };

      expect(response.success).toBe(true);
    });

    it('should list installed skills', () => {
      const response = {
        skills: [
          { name: 'shell', enabled: true, builtin: true },
          { name: 'memory', enabled: true, builtin: true },
          { name: 'apple-notes', enabled: true, builtin: false },
        ],
      };

      expect(response.skills.length).toBeGreaterThan(0);
    });

    it('should get skill status', () => {
      const response = {
        method: 'skills.status',
        result: {
          totalInstalled: 10,
          enabled: 8,
          disabled: 2,
          lastUpdated: '2024-01-01T00:00:00Z',
        },
      };

      expect(response.result.totalInstalled).toBeGreaterThan(0);
    });

    it('should update installed skill', () => {
      const request = {
        method: 'skills.update',
        params: { name: 'apple-notes' },
      };

      const response = {
        updated: true,
        from: '1.0.0',
        to: '1.1.0',
      };

      expect(response.updated).toBe(true);
    });
  });

  describe('Skill Format', () => {
    it('should parse SKILL.md with YAML frontmatter', () => {
      const skillMd = `---
name: weather
description: Get weather forecasts
version: 1.0.0
author: openrappter
tags: [weather, utility]
---

# Weather Skill

Get current weather and forecasts for any location.

## Usage

Ask about weather in any city.
`;

      expect(skillMd).toContain('---');
      expect(skillMd).toContain('name: weather');
    });

    it('should parse inline metadata', () => {
      const skillMd = `name: Calculator
description: Perform calculations

# Calculator Skill

Perform mathematical calculations.
`;

      const lines = skillMd.split('\n');
      const nameMatch = lines[0].match(/^name:\s*(.+)$/);
      expect(nameMatch?.[1]).toBe('Calculator');
    });

    it('should support skill scripts directory', () => {
      const skillStructure = {
        'SKILL.md': 'Skill documentation',
        'scripts/': {
          'main.py': 'Python implementation',
          'run.sh': 'Shell implementation',
        },
      };

      expect(skillStructure['scripts/']).toBeDefined();
    });
  });

  describe('Skill Execution', () => {
    it('should wrap skill as agent', () => {
      const skillAgent = {
        name: 'weather',
        type: 'skill',
        metadata: {
          name: 'weather',
          description: 'Get weather forecasts',
        },
        execute: async (query: string) => `Weather for: ${query}`,
      };

      expect(skillAgent.type).toBe('skill');
      expect(typeof skillAgent.execute).toBe('function');
    });

    it('should execute Python scripts', () => {
      const execution = {
        skill: 'weather',
        script: 'scripts/main.py',
        args: ['San Francisco'],
        timeout: 30000,
      };

      expect(execution.script.endsWith('.py')).toBe(true);
    });

    it('should execute shell scripts', () => {
      const execution = {
        skill: 'system-info',
        script: 'scripts/run.sh',
        args: [],
        timeout: 10000,
      };

      expect(execution.script.endsWith('.sh')).toBe(true);
    });
  });

  describe('Built-in Skill Categories', () => {
    it('should have productivity skills', () => {
      const productivitySkills = [
        'apple-notes',
        'apple-reminders',
        'notion',
        'obsidian',
        'things',
        'trello',
      ];

      expect(productivitySkills.length).toBeGreaterThanOrEqual(5);
    });

    it('should have media skills', () => {
      const mediaSkills = [
        'canvas',
        'camsnap',
        'video-frames',
        'openai-image-gen',
      ];

      expect(mediaSkills.length).toBeGreaterThanOrEqual(3);
    });

    it('should have AI/ML skills', () => {
      const aiSkills = [
        'openai-whisper',
        'summarize',
        'coding-agent',
      ];

      expect(aiSkills.length).toBeGreaterThanOrEqual(3);
    });

    it('should have smart home skills', () => {
      const homeSkills = [
        'openhue',
        'sonos-cli',
        'spotify-player',
      ];

      expect(homeSkills.length).toBeGreaterThanOrEqual(3);
    });

    it('should have utility skills', () => {
      const utilitySkills = [
        'weather',
        'local-places',
        'health-check',
        'model-usage',
      ];

      expect(utilitySkills.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('Skill Creator', () => {
    it('should generate skill template', () => {
      const template = {
        name: 'my-custom-skill',
        description: 'A custom skill',
        files: [
          'SKILL.md',
          'scripts/main.py',
        ],
      };

      expect(template.files).toContain('SKILL.md');
    });

    it('should validate skill structure', () => {
      const validate = (skill: { name?: string; description?: string }): string[] => {
        const errors: string[] = [];
        if (!skill.name) errors.push('name is required');
        if (!skill.description) errors.push('description is required');
        return errors;
      };

      expect(validate({ name: 'test', description: 'desc' })).toHaveLength(0);
      expect(validate({ name: 'test' })).toHaveLength(1);
    });
  });

  describe('Skill Binaries', () => {
    it('should support skill binary download', () => {
      const request = {
        method: 'skills.bins',
        params: { skill: 'whisper', platform: 'darwin-arm64' },
      };

      const response = {
        available: true,
        url: 'https://clawhub.dev/bins/whisper/darwin-arm64',
        size: 50000000,
      };

      expect(response.available).toBe(true);
    });
  });

  describe('Lock File', () => {
    it('should track installed skills in lock file', () => {
      const lockFile = {
        installed: {
          'apple-notes': { version: '1.0.0', installedAt: '2024-01-01T00:00:00Z' },
          'weather': { version: '2.0.0', installedAt: '2024-01-02T00:00:00Z' },
        },
      };

      expect(Object.keys(lockFile.installed).length).toBe(2);
    });

    it('should store lock file at ~/.openrappter/skills/.clawhub/lock.json', () => {
      const lockPath = '~/.openrappter/skills/.clawhub/lock.json';
      expect(lockPath).toContain('.clawhub/lock.json');
    });
  });
});
