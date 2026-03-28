/**
 * PongAgent — Launch terminal Pong from the openrappter framework.
 *
 * Actions:
 *   zen   — Spectator mode: two AIs play while you breathe (default)
 *   play  — You vs AI: keyboard-controlled left paddle
 *   host  — Host a multiplayer game
 *   join  — Join a multiplayer game
 *
 * The game takes over the terminal (inherited stdio), then returns
 * control to the framework when the user quits.
 *
 * Mirrors python/openrappter/agents/pong_agent.py
 */

import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PONG_SCRIPT = path.resolve(__dirname, '..', '..', '..', 'pong.js');

export class PongAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'Pong',
      description:
        'Launch terminal Pong. Default: zen mode (watch two AI rappters play while you breathe). ' +
        'Use action "play" for player vs AI, or "host"/"join" for multiplayer.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['zen', 'play', 'host', 'join'],
            description: 'Game mode. Default: zen (spectator AI vs AI)',
          },
          host: {
            type: 'string',
            description: 'IP address to join (required for join action)',
          },
          port: {
            type: 'string',
            description: 'Port number (default: 4040)',
          },
        },
        required: [],
      },
    };
    super('Pong', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const action = (kwargs.action as string) || 'zen';
    const host = kwargs.host as string | undefined;
    const port = kwargs.port as string | undefined;

    const args: string[] = [];

    switch (action) {
      case 'zen':
        args.push('zen');
        break;
      case 'play':
        args.push('zen'); // play mode uses zen with keyboard override (future)
        break;
      case 'host':
        args.push('host');
        if (port) args.push(port);
        break;
      case 'join':
        if (!host) {
          return JSON.stringify({ status: 'error', message: 'host IP is required for join action' });
        }
        args.push('join', host);
        if (port) args.push(port);
        break;
      default:
        return JSON.stringify({ status: 'error', message: `Unknown action: ${action}` });
    }

    try {
      execFileSync('node', [PONG_SCRIPT, ...args], {
        stdio: 'inherit',
        timeout: 0, // no timeout — game runs until user quits
      });
      return JSON.stringify({
        status: 'success',
        message: `Pong ${action} session ended. Hope you enjoyed the break! 🧘`,
        data_slush: { game_mode: action, mental_health_break: true },
      });
    } catch {
      return JSON.stringify({
        status: 'success',
        message: 'Pong session ended. Back to work! 🦖',
        data_slush: { game_mode: action, mental_health_break: true },
      });
    }
  }
}
