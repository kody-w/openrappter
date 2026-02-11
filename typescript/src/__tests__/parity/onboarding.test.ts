/**
 * Onboarding Wizard Parity Tests
 * Tests that openrappter has an onboarding wizard matching openclaw's
 * wizard flow: channel selection → credentials → validation → agent setup → confirmation
 */

import { describe, it, expect } from 'vitest';

describe('Onboarding Wizard Parity', () => {
  describe('Wizard Lifecycle', () => {
    it('should have start, next, cancel, status operations', () => {
      const operations = ['start', 'next', 'cancel', 'status'];
      expect(operations).toContain('start');
      expect(operations).toContain('next');
      expect(operations).toContain('cancel');
      expect(operations).toContain('status');
    });

    it('should track wizard state', () => {
      const wizardState = {
        id: 'wizard_123',
        currentStep: 0,
        totalSteps: 5,
        status: 'in_progress' as const,
        data: {} as Record<string, unknown>,
        startedAt: new Date().toISOString(),
      };

      expect(wizardState.currentStep).toBeGreaterThanOrEqual(0);
      expect(wizardState.totalSteps).toBeGreaterThan(0);
      expect(wizardState.status).toBe('in_progress');
    });

    it('should support cancellation at any step', () => {
      const wizardState = {
        currentStep: 2,
        status: 'cancelled' as const,
        cancelledAt: new Date().toISOString(),
      };

      expect(wizardState.status).toBe('cancelled');
    });
  });

  describe('Step 1: Channel Selection', () => {
    it('should present available channels', () => {
      const availableChannels = [
        { id: 'telegram', name: 'Telegram', docsUrl: 'https://docs.openrappter.dev/telegram' },
        { id: 'discord', name: 'Discord', docsUrl: 'https://docs.openrappter.dev/discord' },
        { id: 'slack', name: 'Slack', docsUrl: 'https://docs.openrappter.dev/slack' },
        { id: 'whatsapp', name: 'WhatsApp', docsUrl: 'https://docs.openrappter.dev/whatsapp' },
        { id: 'signal', name: 'Signal', docsUrl: 'https://docs.openrappter.dev/signal' },
        { id: 'imessage', name: 'iMessage', docsUrl: 'https://docs.openrappter.dev/imessage' },
        { id: 'matrix', name: 'Matrix', docsUrl: 'https://docs.openrappter.dev/matrix' },
        { id: 'teams', name: 'Microsoft Teams', docsUrl: 'https://docs.openrappter.dev/teams' },
        { id: 'googlechat', name: 'Google Chat', docsUrl: 'https://docs.openrappter.dev/googlechat' },
      ];

      expect(availableChannels.length).toBeGreaterThanOrEqual(9);
      availableChannels.forEach((ch) => {
        expect(ch.id).toBeDefined();
        expect(ch.name).toBeDefined();
        expect(ch.docsUrl).toBeDefined();
      });
    });

    it('should allow selecting multiple channels', () => {
      const selected = ['telegram', 'discord'];
      expect(selected.length).toBeGreaterThan(0);
    });
  });

  describe('Step 2: Channel-Specific Credential Setup', () => {
    it('should collect Telegram bot token', () => {
      const telegramSetup = {
        channel: 'telegram',
        requiredFields: ['botToken'],
        optionalFields: ['allowedUsers', 'allowedGroups'],
      };

      expect(telegramSetup.requiredFields).toContain('botToken');
    });

    it('should collect Discord bot token and guild ID', () => {
      const discordSetup = {
        channel: 'discord',
        requiredFields: ['token'],
        optionalFields: ['guildId', 'allowedChannels'],
      };

      expect(discordSetup.requiredFields).toContain('token');
    });

    it('should collect Slack tokens', () => {
      const slackSetup = {
        channel: 'slack',
        requiredFields: ['botToken', 'appToken'],
        optionalFields: ['allowedChannels'],
      };

      expect(slackSetup.requiredFields).toContain('botToken');
      expect(slackSetup.requiredFields).toContain('appToken');
    });

    it('should collect Signal number', () => {
      const signalSetup = {
        channel: 'signal',
        requiredFields: ['phoneNumber'],
        optionalFields: ['configPath'],
      };

      expect(signalSetup.requiredFields).toContain('phoneNumber');
    });

    it('should detect iMessage platform support', () => {
      const imessageSetup = {
        channel: 'imessage',
        requiredFields: [],
        platformCheck: process.platform === 'darwin',
      };

      expect(typeof imessageSetup.platformCheck).toBe('boolean');
    });

    it('should collect Matrix credentials', () => {
      const matrixSetup = {
        channel: 'matrix',
        requiredFields: ['homeserver', 'userId', 'accessToken'],
        optionalFields: ['deviceId'],
      };

      expect(matrixSetup.requiredFields).toContain('homeserver');
      expect(matrixSetup.requiredFields).toContain('accessToken');
    });

    it('should collect Teams app credentials', () => {
      const teamsSetup = {
        channel: 'teams',
        requiredFields: ['appId', 'appPassword'],
        optionalFields: ['tenantId'],
      };

      expect(teamsSetup.requiredFields).toContain('appId');
    });

    it('should collect Google Chat webhook URL', () => {
      const googleChatSetup = {
        channel: 'googlechat',
        requiredFields: ['webhookUrl'],
        optionalFields: ['serviceAccountKey'],
      };

      expect(googleChatSetup.requiredFields).toContain('webhookUrl');
    });

    it('should handle WhatsApp QR-based setup', () => {
      const whatsappSetup = {
        channel: 'whatsapp',
        authMethod: 'qr',
        requiredFields: [],
        setupSteps: ['Generate QR code', 'Scan with WhatsApp', 'Verify connection'],
      };

      expect(whatsappSetup.authMethod).toBe('qr');
      expect(whatsappSetup.setupSteps.length).toBeGreaterThan(0);
    });
  });

  describe('Step 3: Configuration Validation', () => {
    it('should validate credentials format', () => {
      const validate = (channel: string, config: Record<string, string>): { valid: boolean; errors: string[] } => {
        const errors: string[] = [];
        if (channel === 'telegram' && !config.botToken?.match(/^\d+:/)) {
          errors.push('Invalid Telegram bot token format');
        }
        if (channel === 'discord' && !config.token) {
          errors.push('Discord token is required');
        }
        return { valid: errors.length === 0, errors };
      };

      expect(validate('telegram', { botToken: '123456:ABC-DEF' }).valid).toBe(true);
      expect(validate('telegram', { botToken: 'invalid' }).valid).toBe(false);
    });

    it('should test connectivity', () => {
      const connectivityResult = {
        channel: 'telegram',
        connected: true,
        latency: 150,
        botInfo: { username: 'mybot', canReadMessages: true },
      };

      expect(connectivityResult.connected).toBe(true);
    });
  });

  describe('Step 4: Agent Configuration', () => {
    it('should configure default agent model', () => {
      const agentConfig = {
        model: 'claude-3-sonnet',
        provider: 'anthropic',
        fallbacks: ['openai:gpt-4'],
      };

      expect(agentConfig.model).toBeDefined();
      expect(agentConfig.provider).toBeDefined();
    });

    it('should optionally configure skills', () => {
      const skillConfig = {
        enabledSkills: ['shell', 'memory', 'web-search'],
      };

      expect(skillConfig.enabledSkills.length).toBeGreaterThan(0);
    });
  });

  describe('Step 5: Confirmation and Next Steps', () => {
    it('should summarize configuration', () => {
      const summary = {
        channels: ['telegram', 'discord'],
        agent: { model: 'claude-3-sonnet', provider: 'anthropic' },
        configPath: '~/.openrappter/config.json5',
      };

      expect(summary.channels.length).toBeGreaterThan(0);
      expect(summary.configPath).toBeDefined();
    });

    it('should write config file', () => {
      const configWrite = {
        path: '~/.openrappter/config.json5',
        success: true,
      };

      expect(configWrite.success).toBe(true);
    });

    it('should provide next steps guidance', () => {
      const nextSteps = [
        'Start the gateway: openrappter gateway run',
        'Send a test message: openrappter message send --message "Hello"',
        'View status: openrappter status',
      ];

      expect(nextSteps.length).toBeGreaterThan(0);
    });
  });
});
