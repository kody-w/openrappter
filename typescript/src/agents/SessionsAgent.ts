/**
 * SessionsAgent - Chat session management agent.
 *
 * Manages conversation sessions including listing, retrieving history,
 * sending messages, and session cleanup.
 *
 * Actions: list, history, send, delete, reset
 */

import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';

export class SessionsAgent extends BasicAgent {
  private sessionAccessor: any = null;

  constructor(sessionAccessor?: any) {
    const metadata: AgentMetadata = {
      name: 'Sessions',
      description: 'Manage chat sessions. List sessions, retrieve message history, send messages, and clean up old conversations.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'The session action to perform.',
            enum: ['list', 'history', 'send', 'delete', 'reset'],
          },
          sessionId: {
            type: 'string',
            description: "Session ID (for 'history', 'send', 'delete', 'reset' actions).",
          },
          message: {
            type: 'string',
            description: "Message content to send (for 'send' action).",
          },
          limit: {
            type: 'number',
            description: "Maximum number of messages to return (for 'history' action).",
          },
        },
        required: [],
      },
    };
    super('Sessions', metadata);
    this.sessionAccessor = sessionAccessor;
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const action = kwargs.action as string | undefined;
    const sessionId = kwargs.sessionId as string | undefined;
    const message = kwargs.message as string | undefined;
    const limit = (kwargs.limit as number | undefined) || 50;

    if (!action) {
      return JSON.stringify({
        status: 'error',
        message: 'No action specified. Use: list, history, send, delete, or reset',
      });
    }

    try {
      switch (action) {
        case 'list':
          return await this.listSessions();

        case 'history':
          if (!sessionId) {
            return JSON.stringify({ status: 'error', message: 'sessionId required for history action' });
          }
          return await this.getHistory(sessionId, limit);

        case 'send':
          if (!sessionId || !message) {
            return JSON.stringify({ status: 'error', message: 'sessionId and message required for send action' });
          }
          return await this.sendMessage(sessionId, message);

        case 'delete':
          if (!sessionId) {
            return JSON.stringify({ status: 'error', message: 'sessionId required for delete action' });
          }
          return await this.deleteSession(sessionId);

        case 'reset':
          if (!sessionId) {
            return JSON.stringify({ status: 'error', message: 'sessionId required for reset action' });
          }
          return await this.resetSession(sessionId);

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

  private async listSessions(): Promise<string> {
    if (!this.sessionAccessor) {
      return JSON.stringify({
        status: 'error',
        message: 'Session accessor not available',
      });
    }

    const sessions = await this.sessionAccessor.listSessions();

    return JSON.stringify({
      status: 'success',
      action: 'list',
      sessions,
      count: sessions.length,
    });
  }

  private async getHistory(sessionId: string, limit: number): Promise<string> {
    if (!this.sessionAccessor) {
      return JSON.stringify({
        status: 'error',
        message: 'Session accessor not available',
      });
    }

    const session = await this.sessionAccessor.getSession(sessionId);
    if (!session) {
      return JSON.stringify({
        status: 'error',
        message: `Session not found: ${sessionId}`,
      });
    }

    const messages = session.messages || [];
    const limitedMessages = messages.slice(-limit);

    return JSON.stringify({
      status: 'success',
      action: 'history',
      sessionId,
      messages: limitedMessages,
      count: limitedMessages.length,
      total: messages.length,
    });
  }

  private async sendMessage(sessionId: string, message: string): Promise<string> {
    if (!this.sessionAccessor) {
      return JSON.stringify({
        status: 'error',
        message: 'Session accessor not available',
      });
    }

    const session = await this.sessionAccessor.getSession(sessionId);
    if (!session) {
      return JSON.stringify({
        status: 'error',
        message: `Session not found: ${sessionId}`,
      });
    }

    await this.sessionAccessor.addMessage(sessionId, {
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    });

    return JSON.stringify({
      status: 'success',
      action: 'send',
      sessionId,
      message: 'Message added to session',
    });
  }

  private async deleteSession(sessionId: string): Promise<string> {
    if (!this.sessionAccessor) {
      return JSON.stringify({
        status: 'error',
        message: 'Session accessor not available',
      });
    }

    await this.sessionAccessor.deleteSession(sessionId);

    return JSON.stringify({
      status: 'success',
      action: 'delete',
      sessionId,
      message: 'Session deleted',
    });
  }

  private async resetSession(sessionId: string): Promise<string> {
    if (!this.sessionAccessor) {
      return JSON.stringify({
        status: 'error',
        message: 'Session accessor not available',
      });
    }

    const session = await this.sessionAccessor.getSession(sessionId);
    if (!session) {
      return JSON.stringify({
        status: 'error',
        message: `Session not found: ${sessionId}`,
      });
    }

    await this.sessionAccessor.resetSession(sessionId);

    return JSON.stringify({
      status: 'success',
      action: 'reset',
      sessionId,
      message: 'Session messages cleared',
    });
  }
}
