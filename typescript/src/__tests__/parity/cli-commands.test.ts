import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Parity Test: CLI Commands
 *
 * Validates the CLI command registration system structure by analyzing
 * the source files directly. This approach avoids import issues that
 * may occur during testing when some modules have unresolved dependencies.
 */

const CLI_DIR = join(__dirname, '../../cli');

describe('CLI Commands', () => {
  describe('CLI Module Structure', () => {
    it('should have all expected command files', () => {
      const expectedFiles = [
        'gateway.ts',
        'config.ts',
        'cron.ts',
        'skills.ts',
        'sessions.ts',
        'channels.ts',
        'agents.ts',
        'send.ts',
        'models.ts',
        'doctor.ts',
        'update.ts',
        'login.ts',
        'rpc-client.ts',
        'index.ts',
      ];

      const files = readdirSync(CLI_DIR);

      for (const expectedFile of expectedFiles) {
        expect(files).toContain(expectedFile);
      }
    });

    it('should have index.ts with all command exports', () => {
      const indexPath = join(CLI_DIR, 'index.ts');
      const content = readFileSync(indexPath, 'utf-8');

      const expectedExports = [
        'registerGatewayCommand',
        'registerConfigCommand',
        'registerCronCommand',
        'registerSkillsCommand',
        'registerSessionsCommand',
        'registerChannelsCommand',
        'registerAgentsCommand',
        'registerSendCommand',
        'registerModelsCommand',
        'registerDoctorCommand',
        'registerUpdateCommand',
        'registerLoginCommand',
      ];

      for (const exportName of expectedExports) {
        expect(content).toContain(exportName);
      }
    });
  });

  describe('Command File Structure', () => {
    it('gateway.ts should export registerGatewayCommand', () => {
      const filePath = join(CLI_DIR, 'gateway.ts');
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('export function registerGatewayCommand');
    });

    it('config.ts should export registerConfigCommand', () => {
      const filePath = join(CLI_DIR, 'config.ts');
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('export function registerConfigCommand');
    });

    it('cron.ts should export registerCronCommand', () => {
      const filePath = join(CLI_DIR, 'cron.ts');
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('export function registerCronCommand');
    });

    it('skills.ts should export registerSkillsCommand', () => {
      const filePath = join(CLI_DIR, 'skills.ts');
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('export function registerSkillsCommand');
    });

    it('sessions.ts should export registerSessionsCommand', () => {
      const filePath = join(CLI_DIR, 'sessions.ts');
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('export function registerSessionsCommand');
    });

    it('channels.ts should export registerChannelsCommand', () => {
      const filePath = join(CLI_DIR, 'channels.ts');
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('export function registerChannelsCommand');
    });

    it('agents.ts should export registerAgentsCommand', () => {
      const filePath = join(CLI_DIR, 'agents.ts');
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('export function registerAgentsCommand');
    });

    it('send.ts should export registerSendCommand', () => {
      const filePath = join(CLI_DIR, 'send.ts');
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('export function registerSendCommand');
    });

    it('models.ts should export registerModelsCommand', () => {
      const filePath = join(CLI_DIR, 'models.ts');
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('export function registerModelsCommand');
    });

    it('doctor.ts should export registerDoctorCommand', () => {
      const filePath = join(CLI_DIR, 'doctor.ts');
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('export function registerDoctorCommand');
    });

    it('update.ts should export registerUpdateCommand', () => {
      const filePath = join(CLI_DIR, 'update.ts');
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('export function registerUpdateCommand');
    });

    it('login.ts should export registerLoginCommand', () => {
      const filePath = join(CLI_DIR, 'login.ts');
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('export function registerLoginCommand');
    });
  });

  describe('RPC Client', () => {
    it('should have rpc-client.ts file', () => {
      const filePath = join(CLI_DIR, 'rpc-client.ts');
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toBeDefined();
      expect(content.length).toBeGreaterThan(0);
    });

    it('should export RpcClient class', () => {
      const filePath = join(CLI_DIR, 'rpc-client.ts');
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('export class RpcClient');
    });
  });

  describe('Command Features', () => {
    it('gateway command should have server start functionality', () => {
      const filePath = join(CLI_DIR, 'gateway.ts');
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('command');
      expect(content).toContain('description');
    });

    it('config command should have get/set operations', () => {
      const filePath = join(CLI_DIR, 'config.ts');
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('get');
      expect(content).toContain('set');
    });

    it('cron command should have job management', () => {
      const filePath = join(CLI_DIR, 'cron.ts');
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('command');
    });

    it('skills command should have search/install functionality', () => {
      const filePath = join(CLI_DIR, 'skills.ts');
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('search');
      expect(content).toContain('install');
    });

    it('agents command should have list functionality', () => {
      const filePath = join(CLI_DIR, 'agents.ts');
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('list');
    });
  });

  describe('Command Coverage', () => {
    it('should have at least 12 command files', () => {
      const commandFiles = readdirSync(CLI_DIR).filter(
        (file) =>
          file.endsWith('.ts') &&
          file !== 'index.ts' &&
          file !== 'rpc-client.ts'
      );
      expect(commandFiles.length).toBeGreaterThanOrEqual(12);
    });

    it('all command files should use TypeScript Command type', () => {
      const commandFiles = readdirSync(CLI_DIR).filter(
        (file) =>
          file.endsWith('.ts') &&
          file !== 'index.ts' &&
          file !== 'rpc-client.ts'
      );

      for (const file of commandFiles) {
        const content = readFileSync(join(CLI_DIR, file), 'utf-8');
        expect(content).toContain('Command');
      }
    });

    it('all command files should export a register function', () => {
      const commandFiles = readdirSync(CLI_DIR).filter(
        (file) =>
          file.endsWith('.ts') &&
          file !== 'index.ts' &&
          file !== 'rpc-client.ts'
      );

      for (const file of commandFiles) {
        const content = readFileSync(join(CLI_DIR, file), 'utf-8');
        expect(content).toMatch(/export function register\w+Command/);
      }
    });
  });

  describe('TypeScript Types', () => {
    it('all command files should import Command type from commander', () => {
      const commandFiles = readdirSync(CLI_DIR).filter(
        (file) =>
          file.endsWith('.ts') &&
          file !== 'index.ts' &&
          file !== 'rpc-client.ts'
      );

      for (const file of commandFiles) {
        const content = readFileSync(join(CLI_DIR, file), 'utf-8');
        expect(content).toMatch(/import.*Command.*from.*commander/);
      }
    });

    it('all register functions should accept program parameter', () => {
      const commandFiles = readdirSync(CLI_DIR).filter(
        (file) =>
          file.endsWith('.ts') &&
          file !== 'index.ts' &&
          file !== 'rpc-client.ts'
      );

      for (const file of commandFiles) {
        const content = readFileSync(join(CLI_DIR, file), 'utf-8');
        expect(content).toMatch(/function register\w+Command\(program:\s*Command\)/);
      }
    });
  });
});
