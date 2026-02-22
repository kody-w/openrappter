/**
 * SelfHealingCronAgent - Autonomous self-healing health check agent.
 *
 * Orchestrates WebAgent, ShellAgent, and MessageAgent into a self-healing loop:
 * schedule a health check, detect failures, run a repair command, and notify
 * on any configured channel.
 *
 * Actions: setup, check, status, history, teardown
 *
 * Flow (check action):
 *   1. WebAgent fetches the health URL (with retries)
 *   2. If unhealthy, ShellAgent runs the restart command
 *   3. WebAgent re-checks after restart
 *   4. MessageAgent sends alert (recovered or still down)
 *
 * Mirrors Python agents/self_healing_cron_agent.py
 */

import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';
import { WebAgent } from './WebAgent.js';
import { ShellAgent } from './ShellAgent.js';
import { MessageAgent } from './MessageAgent.js';

export interface JobConfig {
  name: string;
  url: string;
  schedule: string;
  restartCommand: string;
  notifyChannel: string;
  conversationId: string;
  maxRetries: number;
  timeoutMs: number;
  createdAt: string;
  cronJobId?: string;
}

export interface CheckResult {
  timestamp: string;
  healthy: boolean;
  httpStatus?: number;
  restarted: boolean;
  recovered: boolean;
  notified: boolean;
  error?: string;
}

export class SelfHealingCronAgent extends BasicAgent {
  private jobs: Map<string, JobConfig> = new Map();
  private checkHistory: Map<string, CheckResult[]> = new Map();
  private webAgent: BasicAgent;
  private shellAgent: BasicAgent;
  private messageAgent: BasicAgent;

  constructor(options?: {
    webAgent?: BasicAgent;
    shellAgent?: BasicAgent;
    messageAgent?: BasicAgent;
  }) {
    const metadata: AgentMetadata = {
      name: 'SelfHealingCron',
      description:
        'Autonomous self-healing health check agent. Schedules health checks, detects failures, runs repair commands, and sends notifications.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'The action to perform.',
            enum: ['setup', 'check', 'status', 'history', 'teardown'],
          },
          name: {
            type: 'string',
            description: 'Job name (e.g. "api-health").',
          },
          url: {
            type: 'string',
            description: 'Health check endpoint URL.',
          },
          schedule: {
            type: 'string',
            description: 'Cron expression (default: "*/5 * * * *").',
          },
          restartCommand: {
            type: 'string',
            description: 'Shell command to run on failure.',
          },
          notifyChannel: {
            type: 'string',
            description: 'Channel ID for alerts (e.g. "slack").',
          },
          conversationId: {
            type: 'string',
            description: 'Conversation/room ID for the channel.',
          },
          maxRetries: {
            type: 'number',
            description: 'Retry fetch attempts before declaring failure (default: 2).',
          },
          timeoutMs: {
            type: 'number',
            description: 'Fetch timeout per attempt in ms (default: 5000).',
          },
        },
        required: [],
      },
    };
    super('SelfHealingCron', metadata);
    this.webAgent = options?.webAgent ?? new WebAgent();
    this.shellAgent = options?.shellAgent ?? new ShellAgent();
    this.messageAgent = options?.messageAgent ?? new MessageAgent();
  }

  /**
   * Replace sub-agents for testing.
   */
  setAgents(options: {
    webAgent?: BasicAgent;
    shellAgent?: BasicAgent;
    messageAgent?: BasicAgent;
  }): void {
    if (options.webAgent) this.webAgent = options.webAgent;
    if (options.shellAgent) this.shellAgent = options.shellAgent;
    if (options.messageAgent) this.messageAgent = options.messageAgent;
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const action = kwargs.action as string | undefined;

    if (!action) {
      return JSON.stringify({
        status: 'error',
        message: 'No action specified. Use: setup, check, status, history, or teardown',
      });
    }

    try {
      switch (action) {
        case 'setup':
          return this.setupJob(kwargs);
        case 'check':
          return await this.runCheck(kwargs);
        case 'status':
          return this.getStatus(kwargs);
        case 'history':
          return this.getHistory(kwargs);
        case 'teardown':
          return this.teardownJob(kwargs);
        default:
          return JSON.stringify({
            status: 'error',
            message: `Unknown action: ${action}`,
          });
      }
    } catch (error) {
      return JSON.stringify({
        status: 'error',
        action,
        message: (error as Error).message,
      });
    }
  }

  private setupJob(kwargs: Record<string, unknown>): string {
    const name = kwargs.name as string | undefined;
    const url = kwargs.url as string | undefined;
    const restartCommand = kwargs.restartCommand as string | undefined;

    if (!name || !url || !restartCommand) {
      return JSON.stringify({
        status: 'error',
        message: 'name, url, and restartCommand are required for setup',
      });
    }

    const config: JobConfig = {
      name,
      url,
      schedule: (kwargs.schedule as string) || '*/5 * * * *',
      restartCommand,
      notifyChannel: (kwargs.notifyChannel as string) || '',
      conversationId: (kwargs.conversationId as string) || '',
      maxRetries: (kwargs.maxRetries as number) ?? 2,
      timeoutMs: (kwargs.timeoutMs as number) ?? 5000,
      createdAt: new Date().toISOString(),
    };

    this.jobs.set(name, config);
    this.checkHistory.set(name, []);

    const dataSlush = this.slushOut({
      signals: { job_name: name, job_url: url },
      action: 'setup',
    });

    return JSON.stringify({
      status: 'success',
      action: 'setup',
      job: config,
      message: `Job "${name}" configured`,
      data_slush: dataSlush,
    });
  }

  private async runCheck(kwargs: Record<string, unknown>): Promise<string> {
    const name = kwargs.name as string | undefined;
    if (!name) {
      return JSON.stringify({ status: 'error', message: 'name is required for check' });
    }

    const job = this.jobs.get(name);
    if (!job) {
      return JSON.stringify({ status: 'error', message: `Job not found: ${name}` });
    }

    const checkResult: CheckResult = {
      timestamp: new Date().toISOString(),
      healthy: false,
      restarted: false,
      recovered: false,
      notified: false,
    };

    // Step 1: Health check with retries
    let healthy = false;
    let httpStatus: number | undefined;

    for (let attempt = 0; attempt <= job.maxRetries; attempt++) {
      const fetchResult = await this.webAgent.execute({
        action: 'fetch',
        url: job.url,
      });

      try {
        const parsed = JSON.parse(fetchResult);
        if (parsed.status === 'success') {
          healthy = true;
          httpStatus = 200;
          break;
        }
        // Extract HTTP status from error message if available
        const statusMatch = parsed.message?.match(/HTTP (\d+)/);
        if (statusMatch) {
          httpStatus = parseInt(statusMatch[1], 10);
        }
      } catch {
        // fetch returned non-JSON, treat as unhealthy
      }
    }

    checkResult.httpStatus = httpStatus;

    // Step 2: If healthy, log and return
    if (healthy) {
      checkResult.healthy = true;
      this.pushCheckResult(name, checkResult);

      const dataSlush = this.slushOut({
        signals: { job_name: name, health_status: 'healthy' },
        action: 'check',
        health_status: 'healthy',
        action_taken: 'none',
      });

      return JSON.stringify({
        status: 'success',
        action: 'check',
        job: name,
        healthy: true,
        check: checkResult,
        data_slush: dataSlush,
      });
    }

    // Step 3: Unhealthy — run restart command
    checkResult.restarted = true;
    let restartSuccess = false;

    try {
      const shellResult = await this.shellAgent.execute({
        action: 'bash',
        command: job.restartCommand,
      });
      const shellParsed = JSON.parse(shellResult);
      restartSuccess = shellParsed.status === 'success';
    } catch {
      // restart command failed
    }

    // Step 4: Re-check after restart (single attempt)
    let recoveredHealthy = false;
    try {
      const recheckResult = await this.webAgent.execute({
        action: 'fetch',
        url: job.url,
      });
      const recheckParsed = JSON.parse(recheckResult);
      if (recheckParsed.status === 'success') {
        recoveredHealthy = true;
      }
    } catch {
      // still down
    }

    checkResult.recovered = recoveredHealthy;
    checkResult.healthy = recoveredHealthy;

    // Step 5: Send notification
    let alertMessage: string;
    if (recoveredHealthy) {
      alertMessage = `Service "${name}" recovered after restart`;
    } else {
      alertMessage = `Service "${name}" is DOWN — restart failed`;
    }

    if (job.notifyChannel && job.conversationId) {
      try {
        await this.messageAgent.execute({
          action: 'send',
          channelId: job.notifyChannel,
          conversationId: job.conversationId,
          content: alertMessage,
        });
        checkResult.notified = true;
      } catch {
        // notification failed, still record the check
      }
    }

    this.pushCheckResult(name, checkResult);

    const actionTaken = recoveredHealthy ? 'restarted_recovered' : 'restarted_still_down';
    const dataSlush = this.slushOut({
      signals: {
        job_name: name,
        health_status: recoveredHealthy ? 'recovered' : 'down',
        restart_success: restartSuccess,
      },
      action: 'check',
      health_status: recoveredHealthy ? 'recovered' : 'down',
      action_taken: actionTaken,
    });

    return JSON.stringify({
      status: 'success',
      action: 'check',
      job: name,
      healthy: recoveredHealthy,
      check: checkResult,
      alert: alertMessage,
      data_slush: dataSlush,
    });
  }

  private getStatus(kwargs: Record<string, unknown>): string {
    const name = kwargs.name as string | undefined;
    if (!name) {
      return JSON.stringify({ status: 'error', message: 'name is required for status' });
    }

    const job = this.jobs.get(name);
    if (!job) {
      return JSON.stringify({ status: 'error', message: `Job not found: ${name}` });
    }

    const history = this.checkHistory.get(name) || [];
    const lastCheck = history.length > 0 ? history[history.length - 1] : null;
    const totalChecks = history.length;
    const healthyChecks = history.filter((c) => c.healthy).length;
    const uptimePercent = totalChecks > 0 ? Math.round((healthyChecks / totalChecks) * 100) : 100;

    return JSON.stringify({
      status: 'success',
      action: 'status',
      job,
      lastCheck,
      stats: {
        totalChecks,
        healthyChecks,
        uptimePercent,
      },
    });
  }

  private getHistory(kwargs: Record<string, unknown>): string {
    const name = kwargs.name as string | undefined;
    if (!name) {
      return JSON.stringify({ status: 'error', message: 'name is required for history' });
    }

    const job = this.jobs.get(name);
    if (!job) {
      return JSON.stringify({ status: 'error', message: `Job not found: ${name}` });
    }

    const history = this.checkHistory.get(name) || [];

    return JSON.stringify({
      status: 'success',
      action: 'history',
      job: name,
      checks: history,
      count: history.length,
    });
  }

  private teardownJob(kwargs: Record<string, unknown>): string {
    const name = kwargs.name as string | undefined;
    if (!name) {
      return JSON.stringify({ status: 'error', message: 'name is required for teardown' });
    }

    if (!this.jobs.has(name)) {
      return JSON.stringify({ status: 'error', message: `Job not found: ${name}` });
    }

    this.jobs.delete(name);
    this.checkHistory.delete(name);

    return JSON.stringify({
      status: 'success',
      action: 'teardown',
      job: name,
      message: `Job "${name}" removed`,
    });
  }

  private pushCheckResult(name: string, result: CheckResult): void {
    const history = this.checkHistory.get(name);
    if (history) {
      history.push(result);
    }
  }
}
