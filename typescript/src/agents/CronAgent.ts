/**
 * CronAgent - Scheduled job management agent.
 *
 * Manages cron-style scheduled jobs for recurring agent tasks.
 * Supports listing, adding, removing, running, enabling/disabling jobs.
 *
 * Actions: list, add, remove, run, enable, disable, status, logs
 */

import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';

export class CronAgent extends BasicAgent {
  private cronService: any = null;

  constructor() {
    const metadata: AgentMetadata = {
      name: 'Cron',
      description: 'Manage scheduled jobs. Add, remove, run, enable/disable recurring agent tasks with cron-style scheduling.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'The cron action to perform.',
            enum: ['list', 'add', 'remove', 'run', 'enable', 'disable', 'status', 'logs'],
          },
          jobId: {
            type: 'string',
            description: "Job ID (for 'remove', 'run', 'enable', 'disable', 'status', 'logs' actions).",
          },
          name: {
            type: 'string',
            description: "Job name (for 'add' action).",
          },
          schedule: {
            type: 'string',
            description: "Cron schedule expression (for 'add' action).",
          },
          agentId: {
            type: 'string',
            description: "Agent ID to execute (for 'add' action).",
          },
          message: {
            type: 'string',
            description: "Message to send to agent (for 'add' action).",
          },
          enabled: {
            type: 'boolean',
            description: "Whether job is enabled (for 'add' action).",
          },
        },
        required: [],
      },
    };
    super('Cron', metadata);
  }

  private async getCronService() {
    if (!this.cronService) {
      const { CronService } = await import('../cron/service.js');
      this.cronService = new CronService();
    }
    return this.cronService;
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const action = kwargs.action as string | undefined;
    const jobId = kwargs.jobId as string | undefined;
    const name = kwargs.name as string | undefined;
    const schedule = kwargs.schedule as string | undefined;
    const agentId = kwargs.agentId as string | undefined;
    const message = kwargs.message as string | undefined;
    const enabled = (kwargs.enabled as boolean | undefined) ?? true;

    if (!action) {
      return JSON.stringify({
        status: 'error',
        message: 'No action specified. Use: list, add, remove, run, enable, disable, status, or logs',
      });
    }

    try {
      const cron = await this.getCronService();

      switch (action) {
        case 'list':
          const jobs = await cron.listJobs();
          return JSON.stringify({
            status: 'success',
            action: 'list',
            jobs,
            count: jobs.length,
          });

        case 'add':
          if (!name || !schedule || !agentId) {
            return JSON.stringify({
              status: 'error',
              message: 'name, schedule, and agentId required for add action',
            });
          }
          const newJobId = await cron.addJob({
            name,
            schedule,
            agentId,
            message,
            enabled,
          });
          return JSON.stringify({
            status: 'success',
            action: 'add',
            jobId: newJobId,
            name,
            message: `Job ${name} added successfully`,
          });

        case 'remove':
          if (!jobId) {
            return JSON.stringify({ status: 'error', message: 'jobId required for remove action' });
          }
          await cron.removeJob(jobId);
          return JSON.stringify({
            status: 'success',
            action: 'remove',
            jobId,
            message: 'Job removed',
          });

        case 'run':
          if (!jobId) {
            return JSON.stringify({ status: 'error', message: 'jobId required for run action' });
          }
          const result = await cron.runJob(jobId);
          return JSON.stringify({
            status: 'success',
            action: 'run',
            jobId,
            result,
            message: 'Job executed',
          });

        case 'enable':
          if (!jobId) {
            return JSON.stringify({ status: 'error', message: 'jobId required for enable action' });
          }
          await cron.enableJob(jobId);
          return JSON.stringify({
            status: 'success',
            action: 'enable',
            jobId,
            message: 'Job enabled',
          });

        case 'disable':
          if (!jobId) {
            return JSON.stringify({ status: 'error', message: 'jobId required for disable action' });
          }
          await cron.disableJob(jobId);
          return JSON.stringify({
            status: 'success',
            action: 'disable',
            jobId,
            message: 'Job disabled',
          });

        case 'status':
          if (!jobId) {
            return JSON.stringify({ status: 'error', message: 'jobId required for status action' });
          }
          const job = await cron.getJob(jobId);
          if (!job) {
            return JSON.stringify({ status: 'error', message: `Job not found: ${jobId}` });
          }
          return JSON.stringify({
            status: 'success',
            action: 'status',
            job,
          });

        case 'logs':
          if (!jobId) {
            return JSON.stringify({ status: 'error', message: 'jobId required for logs action' });
          }
          const logs = await cron.getJobLogs(jobId);
          return JSON.stringify({
            status: 'success',
            action: 'logs',
            jobId,
            logs,
            count: logs.length,
          });

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
}
