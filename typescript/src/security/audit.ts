import { openrappterHome } from '../infra/openrappter-home.js';
import { getConfigPath, loadConfig } from '../config/loader.js';
/**
 * Security Auditor
 * Performs security checks and returns findings
 */

import { statSync, existsSync, lstatSync, readFileSync } from 'fs';

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
    const openrappterDir = openrappterHome();

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
    const configPath = getConfigPath();

    if (!existsSync(configPath)) {
      return findings; // No config yet
    }

    try {
      // Parsed, not pattern-matched. The previous version tested
      // `/auth:\s*none/i` and `/bind:\s*['"]?0\.0\.0\.0|all['"]?/i` against raw
      // text: both are YAML-shaped and the product writes JSON5, where the
      // same settings read `auth: { mode: 'none' }`. The second pattern was
      // also mis-parenthesised -- the alternation binds as
      // `bind:\s*['"]?0\.0\.0\.0` OR `all['"]?`, so the bare substring "all"
      // anywhere in the file set it, including in `allowlists` or `install`.
      const config = loadConfig({ path: configPath });
      const gateway = config.gateway;

      if (gateway?.bind === 'all' && (gateway.auth?.mode ?? 'none') === 'none') {
        findings.push({
          checkId: 'gw-001',
          severity: 'critical',
          title: 'Gateway exposed without authentication',
          detail: 'Gateway is configured to bind to all interfaces (0.0.0.0) with auth mode "none"',
          remediation: 'Enable token-based authentication or bind to 127.0.0.1 only',
        });
      }

      // `gatewayConfigSchema` has no `token` field -- the secret is
      // `gateway.auth.password` -- so the previous regex could never match
      // anything the product writes.
      const password = gateway?.auth?.password;
      if (gateway?.auth?.mode === 'password' && password && password.length < 32) {
        findings.push({
          checkId: 'gw-002',
          severity: 'high',
          title: 'Gateway password is too short',
          detail: `Password length is ${password.length} characters, recommended minimum is 32`,
          remediation: 'Generate a longer secret using: openssl rand -hex 32',
        });
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
    const configPath = getConfigPath();

    if (!existsSync(configPath)) {
      return findings;
    }

    try {
      const configContent = readFileSync(configPath, 'utf8');

      // Placeholder: Check for DM-only policies
      // Future: Parse YAML and check channel-specific security settings
      // `dmOnly` appears nowhere in this product's configuration -- not in
      // `channelConfigSchema`, not anywhere outside this file -- so
      // `/dmOnly:\s*false/i` could never match anything the loader writes.
      // Kept as a raw-text check *only* because a user may hand-write it, and
      // reported at a lower confidence than a parsed setting would be.
      if (/\bdmOnly\s*:\s*false\b/i.test(configContent)) {
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
    const configPath = getConfigPath();

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
          remediation: `Run: chmod 600 ${getConfigPath()}`,
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
    const configPath = getConfigPath();

    if (!existsSync(configPath)) {
      return findings;
    }

    try {
      const configContent = readFileSync(configPath, 'utf8');

      // Check for remote CDP exposure
      // The CDP check that used to live here is gone. It tested
      // `/cdp.*host:\s*['"]?0\.0\.0\.0|all['"]?/i`, which carries the same
      // mis-parenthesised alternation as the old gateway check -- the bare
      // substring "all" anywhere in the file matched -- and `cdp` is not a
      // setting this product has: `browserConfigSchema` declares only
      // `headless`, `profile`, `timeout` and `viewport`. Pointed at the real
      // config it reported "Chrome DevTools Protocol exposed remotely" at
      // CRITICAL against a machine with no such setting. A check for a
      // setting that cannot exist is not a check.
      // `OpenRappterConfig` declares 7 sections while the schema validates 21,
      // so `browser` is invisible to the type even though the loader returns
      // it. Narrowed here rather than widened globally, which is its own
      // change -- and part of why config.security and config.network are
      // unread (#219, #235): nothing can see them without doing this.
      const config = loadConfig({ path: configPath }) as { browser?: { headless?: boolean } };
      if (config.browser?.headless === false) {
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
