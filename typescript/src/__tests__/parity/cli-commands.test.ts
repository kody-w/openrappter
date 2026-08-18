import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Parity Test: CLI Commands
 *
 * Checks the *shape* of the CLI source tree: that the command modules exist
 * and export what index.ts re-exports.
 *
 * It deliberately does not tell you whether any of those commands is reachable.
 * Reading the source cannot: twelve of these modules are fully implemented,
 * exported, and never registered on the program, and every assertion here
 * passes anyway. cli-registration.test.ts asks the CLI itself.
 */

const CLI_DIR = join(__dirname, '../../cli');

/**
 * Files in `src/cli/` that are shared helpers, not command modules.
 *
 * `with-client.ts` joined this list when six identical private copies of
 * `withClient` were consolidated into it -- and with them, six copies of the
 * same missing `catch`.
 */
const HELPER_FILES = new Set(['index.ts', 'rpc-client.ts', 'bar.ts', 'with-client.ts']);

/** Every command module: the files that must export a `register*Command`. */
function commandModules(): string[] {
  return readdirSync(CLI_DIR).filter((f) => f.endsWith('.ts') && !HELPER_FILES.has(f));
}

describe('CLI Commands', () => {
  describe('CLI Module Structure', () => {
    it('should have all expected command files', () => {
      const expectedFiles = [
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
    it('hubs.ts should export registerHubCommands', () => {
      const filePath = join(CLI_DIR, 'hubs.ts');
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('export function registerHubCommands');
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
    it('hub commands should delegate to the Python runtime', () => {
      const filePath = join(CLI_DIR, 'hubs.ts');
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('openrappter.cli');
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
      const commandFiles = commandModules();
      expect(commandFiles.length).toBeGreaterThanOrEqual(12);
    });

    it('all command files should use TypeScript Command type', () => {
      const commandFiles = commandModules();

      for (const file of commandFiles) {
        const content = readFileSync(join(CLI_DIR, file), 'utf-8');
        expect(content).toContain('Command');
      }
    });

    it('all command files should export a register function', () => {
      const commandFiles = commandModules();

      for (const file of commandFiles) {
        const content = readFileSync(join(CLI_DIR, file), 'utf-8');
        expect(content).toMatch(/export function register\w+Command/);
      }
    });
  });

  describe('TypeScript Types', () => {
    it('all command files should import Command type from commander', () => {
      const commandFiles = commandModules();

      for (const file of commandFiles) {
        const content = readFileSync(join(CLI_DIR, file), 'utf-8');
        expect(content).toMatch(/import.*Command.*from.*commander/);
      }
    });

    it('all register functions should accept program parameter', () => {
      const commandFiles = commandModules();

      for (const file of commandFiles) {
        const content = readFileSync(join(CLI_DIR, file), 'utf-8');
        // `registerHubCommands` registers two, like registerTelephonyCommands does.
        expect(content).toMatch(/function register\w+Commands?\(\s*program:\s*Command/);
      }
    });
  });
});
