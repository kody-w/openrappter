/**
 * Security Auditor
 * Performs security checks and returns findings
 */

import { statSync, existsSync, lstatSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface AuditFinding {
  checkId: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  detail: string;
  remediation?: string;
}

export class SecurityAuditor {
  /**
   * Check filesystem permissions for ~/.openrappter
   */
  checkFilesystemPerms(): AuditFinding[] {
    const findings: AuditFinding[] = [];
    const openrappterDir = join(homedir(), '.openrappter');

    // Check if directory exists
    if (!existsSync(openrappterDir)) {
      findings.push({
        checkId: 'fs-001',
        severity: 'info',
        title: 'OpenRappter directory does not exist',
        detail: `~/.openrappter directory not found at ${openrappterDir}`,
        remediation: 'Directory will be created on first run',
      });
      return findings;
    }

    // Check directory permissions
    try {
      const stats = statSync(openrappterDir);
      const mode = stats.mode & 0o777;

      // Warn if world-readable (mode & 0o004)
      if (mode & 0o004) {
        findings.push({
          checkId: 'fs-002',
          severity: 'medium',
          title: 'OpenRappter directory is world-readable',
          detail: `Directory ${openrappterDir} has mode ${mode.toString(8)}, allowing read access to all users`,
          remediation: 'Run: chmod 700 ~/.openrappter',
        });
      }

      // Warn if world-writable (mode & 0o002)
      if (mode & 0o002) {
        findings.push({
          checkId: 'fs-003',
          severity: 'high',
          title: 'OpenRappter directory is world-writable',
          detail: `Directory ${openrappterDir} has mode ${mode.toString(8)}, allowing write access to all users`,
          remediation: 'Run: chmod 700 ~/.openrappter',
        });
      }

      // Check for symlinks
      const lstat = lstatSync(openrappterDir);
      if (lstat.isSymbolicLink()) {
        findings.push({
          checkId: 'fs-004',
          severity: 'medium',
          title: 'OpenRappter directory is a symlink',
          detail: `${openrappterDir} is a symbolic link, which may pose security risks`,
          remediation: 'Use a regular directory instead of a symlink',
        });
      }
    } catch (error) {
      findings.push({
        checkId: 'fs-000',
        severity: 'high',
        title: 'Failed to check filesystem permissions',
        detail: `Error: ${(error as Error).message}`,
      });
    }

    return findings;
  }

  /**
   * Check gateway configuration security
   */
  checkGatewayConfig(): AuditFinding[] {
    const findings: AuditFinding[] = [];
    const configPath = join(homedir(), '.openrappter', 'config.yml');

    if (!existsSync(configPath)) {
      return findings; // No config yet
    }

    try {
      const configContent = readFileSync(configPath, 'utf8');

      // Check for auth mode 'none' with bind 'all'
      const authNoneMatch = /auth:\s*none/i.test(configContent);
      const bindAllMatch = /bind:\s*['"]?0\.0\.0\.0|all['"]?/i.test(configContent);

      if (authNoneMatch && bindAllMatch) {
        findings.push({
          checkId: 'gw-001',
          severity: 'critical',
          title: 'Gateway exposed without authentication',
          detail: 'Gateway is configured to bind to all interfaces (0.0.0.0) with auth mode "none"',
          remediation: 'Enable token-based authentication or bind to 127.0.0.1 only',
        });
      }

      // Check token length if token auth is used
      const tokenMatch = configContent.match(/token:\s*['"]?([^'"\n\s]+)['"]?/);
      if (tokenMatch && tokenMatch[1]) {
        const token = tokenMatch[1];
        if (token.length < 32) {
          findings.push({
            checkId: 'gw-002',
            severity: 'high',
            title: 'Gateway token is too short',
            detail: `Token length is ${token.length} characters, recommended minimum is 32`,
            remediation: 'Generate a longer token using: openssl rand -hex 32',
          });
        }
      }
    } catch (error) {
      findings.push({
        checkId: 'gw-000',
        severity: 'medium',
        title: 'Failed to check gateway configuration',
        detail: `Error: ${(error as Error).message}`,
      });
    }

    return findings;
  }

  /**
   * Check channel security settings
   */
  checkChannelSecurity(): AuditFinding[] {
    const findings: AuditFinding[] = [];
    const configPath = join(homedir(), '.openrappter', 'config.yml');

    if (!existsSync(configPath)) {
      return findings;
    }

    try {
      const configContent = readFileSync(configPath, 'utf8');

      // Placeholder: Check for DM-only policies
      // Future: Parse YAML and check channel-specific security settings
      const dmOnlyMatch = /dmOnly:\s*false/i.test(configContent);
      if (dmOnlyMatch) {
        findings.push({
          checkId: 'ch-001',
          severity: 'info',
          title: 'Public channel access enabled',
          detail: 'One or more channels allow public (non-DM) access',
          remediation: 'Review channel configuration and enable dmOnly where appropriate',
        });
      }
    } catch (error) {
      findings.push({
        checkId: 'ch-000',
        severity: 'low',
        title: 'Failed to check channel security',
        detail: `Error: ${(error as Error).message}`,
      });
    }

    return findings;
  }

  /**
   * Check config for exposed secrets
   */
  checkConfigSecrets(): AuditFinding[] {
    const findings: AuditFinding[] = [];
    const configPath = join(homedir(), '.openrappter', 'config.yml');

    if (!existsSync(configPath)) {
      return findings;
    }

    try {
      const configContent = readFileSync(configPath, 'utf8');

      // Patterns for common API keys
      const patterns = [
        { id: 'sec-001', name: 'OpenAI API key', pattern: /sk-[a-zA-Z0-9]{20,}/ },
        { id: 'sec-002', name: 'Slack token', pattern: /xoxb-[a-zA-Z0-9-]+/ },
        { id: 'sec-003', name: 'Slack webhook', pattern: /hooks\.slack\.com\/services\/[A-Z0-9/]+/ },
        { id: 'sec-004', name: 'Discord token', pattern: /[MN][a-zA-Z\d]{23,25}\.[a-zA-Z\d-_]{6}\.[a-zA-Z\d-_]{27,}/ },
        { id: 'sec-005', name: 'GitHub token', pattern: /ghp_[a-zA-Z0-9]{36,}/ },
        { id: 'sec-006', name: 'AWS access key', pattern: /AKIA[0-9A-Z]{16}/ },
      ];

      for (const { id, name, pattern } of patterns) {
        if (pattern.test(configContent)) {
          findings.push({
            checkId: id,
            severity: 'info',
            title: `${name} detected in config`,
            detail: `Config file contains what appears to be a ${name}`,
            remediation: 'Ensure config file permissions are restrictive (chmod 600)',
          });
        }
      }

      // Check config file permissions
      const stats = statSync(configPath);
      const mode = stats.mode & 0o777;

      if (mode & 0o044) {
        findings.push({
          checkId: 'sec-007',
          severity: 'high',
          title: 'Config file is readable by others',
          detail: `Config file has mode ${mode.toString(8)}, allowing read access beyond owner`,
          remediation: 'Run: chmod 600 ~/.openrappter/config.yml',
        });
      }
    } catch (error) {
      findings.push({
        checkId: 'sec-000',
        severity: 'medium',
        title: 'Failed to check config secrets',
        detail: `Error: ${(error as Error).message}`,
      });
    }

    return findings;
  }

  /**
   * Check browser/CDP security
   */
  checkBrowserSecurity(): AuditFinding[] {
    const findings: AuditFinding[] = [];
    const configPath = join(homedir(), '.openrappter', 'config.yml');

    if (!existsSync(configPath)) {
      return findings;
    }

    try {
      const configContent = readFileSync(configPath, 'utf8');

      // Check for remote CDP exposure
      const cdpRemoteMatch = /cdp.*host:\s*['"]?0\.0\.0\.0|all['"]?/i.test(configContent);
      if (cdpRemoteMatch) {
        findings.push({
          checkId: 'br-001',
          severity: 'critical',
          title: 'Chrome DevTools Protocol exposed remotely',
          detail: 'CDP is configured to accept remote connections without authentication',
          remediation: 'Bind CDP to localhost only or use authentication',
        });
      }

      // Check for headless mode disabled (can leak screen content)
      const headlessMatch = /headless:\s*false/i.test(configContent);
      if (headlessMatch) {
        findings.push({
          checkId: 'br-002',
          severity: 'low',
          title: 'Browser running in headed mode',
          detail: 'Browser is configured to display UI, which may expose screen content',
          remediation: 'Consider enabling headless mode for automated tasks',
        });
      }
    } catch (error) {
      findings.push({
        checkId: 'br-000',
        severity: 'low',
        title: 'Failed to check browser security',
        detail: `Error: ${(error as Error).message}`,
      });
    }

    return findings;
  }

  /**
   * Run all security checks
   */
  async runAll(): Promise<AuditFinding[]> {
    const findings: AuditFinding[] = [];

    findings.push(...this.checkFilesystemPerms());
    findings.push(...this.checkGatewayConfig());
    findings.push(...this.checkChannelSecurity());
    findings.push(...this.checkConfigSecrets());
    findings.push(...this.checkBrowserSecurity());

    return findings;
  }
}
