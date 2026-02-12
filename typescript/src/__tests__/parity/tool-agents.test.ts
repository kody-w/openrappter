/**
 * Tool Agents Parity Tests
 * Tests for 7 new agent tool classes that extend BasicAgent
 */

import { describe, it, expect } from 'vitest';
import { BrowserAgent } from '../../agents/BrowserAgent.js';
import { WebAgent } from '../../agents/WebAgent.js';
import { MessageAgent } from '../../agents/MessageAgent.js';
import { TTSAgent } from '../../agents/TTSAgent.js';
import { SessionsAgent } from '../../agents/SessionsAgent.js';
import { CronAgent } from '../../agents/CronAgent.js';
import { ImageAgent } from '../../agents/ImageAgent.js';

describe('Tool Agents Parity', () => {
  describe('BrowserAgent', () => {
    it('should have name property', () => {
      const agent = new BrowserAgent();
      expect(agent.name).toBe('Browser');
    });

    it('should have metadata with name, description, and parameters', () => {
      const agent = new BrowserAgent();
      expect(agent.metadata).toBeDefined();
      expect(agent.metadata.name).toBe('Browser');
      expect(agent.metadata.description).toBeDefined();
      expect(agent.metadata.parameters).toBeDefined();
    });

    it('should have parameters with type object and action enum', () => {
      const agent = new BrowserAgent();
      expect(agent.metadata.parameters.type).toBe('object');
      expect(agent.metadata.parameters.properties).toBeDefined();
      expect(agent.metadata.parameters.properties.action).toBeDefined();
      expect(agent.metadata.parameters.properties.action.enum).toBeInstanceOf(Array);
    });

    it('should include correct actions in enum', () => {
      const agent = new BrowserAgent();
      const actions = agent.metadata.parameters.properties.action.enum;
      expect(actions).toContain('navigate');
      expect(actions).toContain('screenshot');
      expect(actions).toContain('click');
      expect(actions).toContain('fill');
      expect(actions).toContain('extract');
      expect(actions).toContain('close');
      expect(actions).toContain('pages');
    });

    it('should return error when perform called without action', async () => {
      const agent = new BrowserAgent();
      const result = await agent.perform({});
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
    });

    it('should return error for unknown action', async () => {
      const agent = new BrowserAgent();
      const result = await agent.perform({ action: 'unknown_action' });
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
    });
  });

  describe('WebAgent', () => {
    it('should have name property', () => {
      const agent = new WebAgent();
      expect(agent.name).toBe('Web');
    });

    it('should have metadata with name, description, and parameters', () => {
      const agent = new WebAgent();
      expect(agent.metadata).toBeDefined();
      expect(agent.metadata.name).toBe('Web');
      expect(agent.metadata.description).toBeDefined();
      expect(agent.metadata.parameters).toBeDefined();
    });

    it('should have parameters with type object and action enum', () => {
      const agent = new WebAgent();
      expect(agent.metadata.parameters.type).toBe('object');
      expect(agent.metadata.parameters.properties).toBeDefined();
      expect(agent.metadata.parameters.properties.action).toBeDefined();
      expect(agent.metadata.parameters.properties.action.enum).toBeInstanceOf(Array);
    });

    it('should include correct actions in enum', () => {
      const agent = new WebAgent();
      const actions = agent.metadata.parameters.properties.action.enum;
      expect(actions).toContain('fetch');
      expect(actions).toContain('search');
    });

    it('should return error when perform called without action', async () => {
      const agent = new WebAgent();
      const result = await agent.perform({});
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
    });
  });

  describe('MessageAgent', () => {
    it('should have name property', () => {
      const agent = new MessageAgent();
      expect(agent.name).toBe('Message');
    });

    it('should have metadata with name, description, and parameters', () => {
      const agent = new MessageAgent();
      expect(agent.metadata).toBeDefined();
      expect(agent.metadata.name).toBe('Message');
      expect(agent.metadata.description).toBeDefined();
      expect(agent.metadata.parameters).toBeDefined();
    });

    it('should have parameters with type object and action enum', () => {
      const agent = new MessageAgent();
      expect(agent.metadata.parameters.type).toBe('object');
      expect(agent.metadata.parameters.properties).toBeDefined();
      expect(agent.metadata.parameters.properties.action).toBeDefined();
      expect(agent.metadata.parameters.properties.action.enum).toBeInstanceOf(Array);
    });

    it('should include correct actions in enum', () => {
      const agent = new MessageAgent();
      const actions = agent.metadata.parameters.properties.action.enum;
      expect(actions).toContain('send');
      expect(actions).toContain('list_channels');
      expect(actions).toContain('channel_status');
    });

    it('should return error when perform called without action', async () => {
      const agent = new MessageAgent();
      const result = await agent.perform({});
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
    });
  });

  describe('TTSAgent', () => {
    it('should have name property', () => {
      const agent = new TTSAgent();
      expect(agent.name).toBe('TTS');
    });

    it('should have metadata with name, description, and parameters', () => {
      const agent = new TTSAgent();
      expect(agent.metadata).toBeDefined();
      expect(agent.metadata.name).toBe('TTS');
      expect(agent.metadata.description).toBeDefined();
      expect(agent.metadata.parameters).toBeDefined();
    });

    it('should have parameters with type object and action enum', () => {
      const agent = new TTSAgent();
      expect(agent.metadata.parameters.type).toBe('object');
      expect(agent.metadata.parameters.properties).toBeDefined();
      expect(agent.metadata.parameters.properties.action).toBeDefined();
      expect(agent.metadata.parameters.properties.action.enum).toBeInstanceOf(Array);
    });

    it('should include correct actions in enum', () => {
      const agent = new TTSAgent();
      const actions = agent.metadata.parameters.properties.action.enum;
      expect(actions).toContain('speak');
      expect(actions).toContain('voices');
      expect(actions).toContain('status');
    });

    it('should return error when perform called without action', async () => {
      const agent = new TTSAgent();
      const result = await agent.perform({});
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
    });
  });

  describe('SessionsAgent', () => {
    it('should have name property', () => {
      const agent = new SessionsAgent();
      expect(agent.name).toBe('Sessions');
    });

    it('should have metadata with name, description, and parameters', () => {
      const agent = new SessionsAgent();
      expect(agent.metadata).toBeDefined();
      expect(agent.metadata.name).toBe('Sessions');
      expect(agent.metadata.description).toBeDefined();
      expect(agent.metadata.parameters).toBeDefined();
    });

    it('should have parameters with type object and action enum', () => {
      const agent = new SessionsAgent();
      expect(agent.metadata.parameters.type).toBe('object');
      expect(agent.metadata.parameters.properties).toBeDefined();
      expect(agent.metadata.parameters.properties.action).toBeDefined();
      expect(agent.metadata.parameters.properties.action.enum).toBeInstanceOf(Array);
    });

    it('should include correct actions in enum', () => {
      const agent = new SessionsAgent();
      const actions = agent.metadata.parameters.properties.action.enum;
      expect(actions).toContain('list');
      expect(actions).toContain('history');
      expect(actions).toContain('send');
      expect(actions).toContain('delete');
      expect(actions).toContain('reset');
    });

    it('should return error when perform called without action', async () => {
      const agent = new SessionsAgent();
      const result = await agent.perform({});
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
    });
  });

  describe('CronAgent', () => {
    it('should have name property', () => {
      const agent = new CronAgent();
      expect(agent.name).toBe('Cron');
    });

    it('should have metadata with name, description, and parameters', () => {
      const agent = new CronAgent();
      expect(agent.metadata).toBeDefined();
      expect(agent.metadata.name).toBe('Cron');
      expect(agent.metadata.description).toBeDefined();
      expect(agent.metadata.parameters).toBeDefined();
    });

    it('should have parameters with type object and action enum', () => {
      const agent = new CronAgent();
      expect(agent.metadata.parameters.type).toBe('object');
      expect(agent.metadata.parameters.properties).toBeDefined();
      expect(agent.metadata.parameters.properties.action).toBeDefined();
      expect(agent.metadata.parameters.properties.action.enum).toBeInstanceOf(Array);
    });

    it('should include correct actions in enum', () => {
      const agent = new CronAgent();
      const actions = agent.metadata.parameters.properties.action.enum;
      expect(actions).toContain('list');
      expect(actions).toContain('add');
      expect(actions).toContain('remove');
      expect(actions).toContain('run');
      expect(actions).toContain('enable');
      expect(actions).toContain('disable');
      expect(actions).toContain('status');
      expect(actions).toContain('logs');
    });

    it('should return error when perform called without action', async () => {
      const agent = new CronAgent();
      const result = await agent.perform({});
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
    });
  });

  describe('ImageAgent', () => {
    it('should have name property', () => {
      const agent = new ImageAgent();
      expect(agent.name).toBe('Image');
    });

    it('should have metadata with name, description, and parameters', () => {
      const agent = new ImageAgent();
      expect(agent.metadata).toBeDefined();
      expect(agent.metadata.name).toBe('Image');
      expect(agent.metadata.description).toBeDefined();
      expect(agent.metadata.parameters).toBeDefined();
    });

    it('should have parameters with type object and action enum', () => {
      const agent = new ImageAgent();
      expect(agent.metadata.parameters.type).toBe('object');
      expect(agent.metadata.parameters.properties).toBeDefined();
      expect(agent.metadata.parameters.properties.action).toBeDefined();
      expect(agent.metadata.parameters.properties.action.enum).toBeInstanceOf(Array);
    });

    it('should include correct actions in enum', () => {
      const agent = new ImageAgent();
      const actions = agent.metadata.parameters.properties.action.enum;
      expect(actions).toContain('analyze');
      expect(actions).toContain('process_url');
    });

    it('should return error when perform called without action', async () => {
      const agent = new ImageAgent();
      const result = await agent.perform({});
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('error');
    });
  });
});
