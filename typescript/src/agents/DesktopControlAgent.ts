import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';
import {
  DesktopCommandQueue,
  type DesktopControlAction,
} from '../desktop-control/index.js';

export const __manifest__ = {
  schema: 'rapp-agent/1.0',
  name: '@openrappter/desktop-control',
  version: '1.0.0',
  display_name: 'Desktop Control',
  description:
    'Drives the visible OpenRappter Electron UI through typed snapshots, navigation, clicks, inputs, scrolling, and approval-gated agent installation.',
  author: 'Kody Wildfeuer',
  ring: 'ga',
  capabilities: ['filesystem-write', 'ui-control', 'dynamic-code'],
  tags: ['openrappter', 'desktop', 'ui-control', 'chat'],
  category: 'automation',
  quality_tier: 'official',
  requires_env: [],
} as const;

export class DesktopControlAgent extends BasicAgent {
  constructor(private readonly queue = new DesktopCommandQueue()) {
    const metadata: AgentMetadata = {
      name: 'DesktopControl',
      description:
        'Controls the visible OpenRappter Electron app while the user watches. Call snapshot first to receive refs, then navigate, click, input, select, scroll, or wait. install_agent stages a .py or _agent.ts file and asks the user for native approval before hot-loading it.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'snapshot',
              'navigate',
              'click',
              'input',
              'select',
              'scroll',
              'wait',
              'install_agent',
            ],
            description: 'Typed UI operation.',
          },
          view: {
            type: 'string',
            description:
              'OpenRappter view id for navigate, such as chat, show-and-tell, agents, skills, cron, config, logs, or surgeon.',
          },
          ref: {
            type: 'string',
            description: 'Element ref returned by the latest snapshot.',
          },
          value: {
            type: 'string',
            description: 'Text or option value for input/select.',
          },
          direction: {
            type: 'string',
            enum: ['up', 'down'],
            description: 'Scroll direction.',
          },
          amount: {
            type: 'integer',
            description: 'Scroll distance in pixels.',
          },
          milliseconds: {
            type: 'integer',
            description: 'Bounded wait duration.',
          },
          filename: {
            type: 'string',
            description: 'Agent filename ending in .py or _agent.ts.',
          },
          source: {
            type: 'string',
            description: 'Complete single-file agent source for install_agent.',
          },
          query: {
            type: 'string',
            description: 'Natural-language fallback.',
          },
        },
        required: [],
      },
    };
    super('DesktopControl', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const action = (
      typeof kwargs.action === 'string' ? kwargs.action : 'snapshot'
    ) as DesktopControlAction;
    const args: Record<string, unknown> = {};
    for (const key of [
      'view',
      'ref',
      'value',
      'direction',
      'amount',
      'milliseconds',
      'filename',
      'source',
    ]) {
      if (kwargs[key] !== undefined) args[key] = kwargs[key];
    }
    try {
      const response = await this.queue.execute(action, args);
      if (response.status === 'error') {
        return JSON.stringify({
          status: 'error',
          action,
          message: response.error ?? 'Desktop command failed.',
        });
      }
      return JSON.stringify({
        status: 'success',
        action,
        result: response.result,
        data_slush: {
          source_agent: this.name,
          desktop_action: action,
        },
      });
    } catch (error) {
      return JSON.stringify({
        status: 'error',
        action,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
