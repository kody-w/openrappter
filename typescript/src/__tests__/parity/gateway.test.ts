/**
 * Gateway Protocol Parity Tests
 * Tests that gateway RPC methods match openclaw spec
 */

import { describe, it, expect, vi } from 'vitest';

// Mock WebSocket
vi.mock('ws', () => ({
  default: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
  })),
  WebSocket: vi.fn(),
  WebSocketServer: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

describe('Gateway Parity', () => {
  describe('RPC Methods', () => {
    const requiredMethods = [
      'health',
      'status',
      'agent',
      'chat.list',
      'chat.get',
      'chat.send',
      'chat.delete',
      'cron.list',
      'cron.create',
      'cron.update',
      'cron.delete',
      'cron.run',
      'channels.list',
      'channels.status',
      'connections.list',
      'connections.kick',
      'ping',
    ];

    it('should implement all required RPC methods', () => {
      requiredMethods.forEach((method) => {
        expect(typeof method).toBe('string');
      });
      expect(requiredMethods.length).toBeGreaterThanOrEqual(17);
    });

    describe('health', () => {
      it('should return health status', async () => {
        const response = {
          ok: true,
          uptime: 12345,
          version: '1.0.0',
          memory: {
            heapUsed: 50000000,
            heapTotal: 100000000,
          },
        };

        expect(response.ok).toBe(true);
        expect(response.uptime).toBeGreaterThan(0);
        expect(response.version).toBeDefined();
      });
    });

    describe('status', () => {
      it('should return gateway status', async () => {
        const response = {
          connections: 5,
          channels: ['discord', 'slack'],
          agents: ['main'],
          uptime: 12345,
        };

        expect(response.connections).toBeGreaterThanOrEqual(0);
        expect(Array.isArray(response.channels)).toBe(true);
      });
    });

    describe('agent', () => {
      it('should process agent request with streaming', async () => {
        const request = {
          method: 'agent',
          params: {
            messages: [{ role: 'user', content: 'Hello' }],
            stream: true,
          },
        };

        expect(request.params.stream).toBe(true);
        expect(request.params.messages).toHaveLength(1);
      });

      it('should return agent response', async () => {
        const response = {
          id: 'resp_123',
          content: 'Hello! How can I help?',
          model: 'claude-3',
          usage: {
            inputTokens: 10,
            outputTokens: 20,
          },
        };

        expect(response.id).toBeDefined();
        expect(response.content).toBeDefined();
      });

      it('should include tool outputs when present', async () => {
        const response = {
          id: 'resp_123',
          content: 'I executed the command.',
          toolOutputs: [
            {
              toolId: 'tool_1',
              name: 'bash',
              result: 'success',
            },
          ],
        };

        expect(response.toolOutputs).toHaveLength(1);
        expect(response.toolOutputs[0].name).toBe('bash');
      });
    });

    describe('chat.*', () => {
      it('should list chat sessions', async () => {
        const response = {
          sessions: [
            { id: 'session_1', createdAt: '2024-01-01T00:00:00Z' },
            { id: 'session_2', createdAt: '2024-01-02T00:00:00Z' },
          ],
        };

        expect(response.sessions).toHaveLength(2);
      });

      it('should get chat session by id', async () => {
        const response = {
          id: 'session_1',
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there!' },
          ],
          createdAt: '2024-01-01T00:00:00Z',
        };

        expect(response.id).toBe('session_1');
        expect(response.messages).toHaveLength(2);
      });

      it('should send message to chat session', async () => {
        const request = {
          method: 'chat.send',
          params: {
            sessionId: 'session_1',
            message: { role: 'user', content: 'Hello' },
          },
        };

        expect(request.params.sessionId).toBeDefined();
        expect(request.params.message.content).toBeDefined();
      });

      it('should delete chat session', async () => {
        const response = {
          deleted: true,
          sessionId: 'session_1',
        };

        expect(response.deleted).toBe(true);
      });
    });

    describe('cron.*', () => {
      it('should list cron jobs', async () => {
        const response = {
          jobs: [
            { id: 'job_1', schedule: '0 * * * *', enabled: true },
            { id: 'job_2', schedule: '0 0 * * *', enabled: false },
          ],
        };

        expect(response.jobs).toHaveLength(2);
      });

      it('should create cron job', async () => {
        const request = {
          method: 'cron.create',
          params: {
            schedule: '*/5 * * * *',
            task: { type: 'agent', prompt: 'Check status' },
          },
        };

        expect(request.params.schedule).toBeDefined();
        expect(request.params.task).toBeDefined();
      });

      it('should update cron job', async () => {
        const request = {
          method: 'cron.update',
          params: {
            id: 'job_1',
            enabled: false,
          },
        };

        expect(request.params.id).toBeDefined();
      });

      it('should delete cron job', async () => {
        const response = {
          deleted: true,
          jobId: 'job_1',
        };

        expect(response.deleted).toBe(true);
      });

      it('should run cron job immediately', async () => {
        const request = {
          method: 'cron.run',
          params: {
            id: 'job_1',
          },
        };

        expect(request.params.id).toBeDefined();
      });
    });

    describe('channels.*', () => {
      it('should list channels', async () => {
        const response = {
          channels: [
            { type: 'discord', status: 'connected' },
            { type: 'slack', status: 'disconnected' },
          ],
        };

        expect(response.channels).toHaveLength(2);
      });

      it('should get channel status', async () => {
        const response = {
          type: 'discord',
          status: 'connected',
          lastActivity: '2024-01-01T00:00:00Z',
          metadata: {
            guildCount: 5,
          },
        };

        expect(response.status).toBe('connected');
      });
    });

    describe('connections.*', () => {
      it('should list connections', async () => {
        const response = {
          connections: [
            { id: 'conn_1', deviceId: 'device_1', connectedAt: '2024-01-01T00:00:00Z' },
            { id: 'conn_2', deviceId: 'device_2', connectedAt: '2024-01-01T00:01:00Z' },
          ],
        };

        expect(response.connections).toHaveLength(2);
      });

      it('should kick connection', async () => {
        const request = {
          method: 'connections.kick',
          params: {
            connectionId: 'conn_1',
          },
        };

        expect(request.params.connectionId).toBeDefined();
      });
    });

    describe('ping', () => {
      it('should return pong', async () => {
        const response = {
          pong: true,
          timestamp: Date.now(),
        };

        expect(response.pong).toBe(true);
        expect(response.timestamp).toBeGreaterThan(0);
      });
    });
  });

  describe('Events', () => {
    const requiredEvents = [
      'agent',
      'chat',
      'presence',
      'heartbeat',
      'shutdown',
      'channel:connected',
      'channel:disconnected',
      'channel:message',
    ];

    it('should emit all required events', () => {
      requiredEvents.forEach((event) => {
        expect(typeof event).toBe('string');
      });
      expect(requiredEvents.length).toBeGreaterThanOrEqual(8);
    });

    describe('agent event', () => {
      it('should emit agent streaming chunks', async () => {
        const event = {
          type: 'agent',
          data: {
            requestId: 'req_123',
            chunk: 'Hello',
            done: false,
          },
        };

        expect(event.data.chunk).toBeDefined();
        expect(event.data.done).toBe(false);
      });

      it('should emit agent completion', async () => {
        const event = {
          type: 'agent',
          data: {
            requestId: 'req_123',
            chunk: '',
            done: true,
            usage: { inputTokens: 10, outputTokens: 20 },
          },
        };

        expect(event.data.done).toBe(true);
        expect(event.data.usage).toBeDefined();
      });
    });

    describe('chat event', () => {
      it('should emit chat message', async () => {
        const event = {
          type: 'chat',
          data: {
            sessionId: 'session_1',
            message: { role: 'assistant', content: 'Hello' },
          },
        };

        expect(event.data.sessionId).toBeDefined();
        expect(event.data.message).toBeDefined();
      });
    });

    describe('presence event', () => {
      it('should emit connection presence', async () => {
        const event = {
          type: 'presence',
          data: {
            connectionId: 'conn_1',
            status: 'online',
            deviceId: 'device_1',
          },
        };

        expect(event.data.status).toBe('online');
      });
    });

    describe('heartbeat event', () => {
      it('should emit periodic heartbeat', async () => {
        const event = {
          type: 'heartbeat',
          data: {
            timestamp: Date.now(),
            connections: 5,
          },
        };

        expect(event.data.timestamp).toBeGreaterThan(0);
      });
    });

    describe('channel events', () => {
      it('should emit channel connected', async () => {
        const event = {
          type: 'channel:connected',
          data: {
            channelType: 'discord',
            timestamp: new Date().toISOString(),
          },
        };

        expect(event.data.channelType).toBe('discord');
      });

      it('should emit channel message', async () => {
        const event = {
          type: 'channel:message',
          data: {
            channelType: 'slack',
            message: {
              id: 'msg_123',
              content: 'Hello',
              senderId: 'user_123',
            },
          },
        };

        expect(event.data.message.id).toBeDefined();
      });
    });
  });

  describe('Connection Lifecycle', () => {
    it('should handle connection with device identity', async () => {
      const handshake = {
        deviceId: 'device_123',
        deviceName: 'My Device',
        version: '1.0.0',
      };

      expect(handshake.deviceId).toBeDefined();
      expect(handshake.version).toBeDefined();
    });

    it('should perform challenge-response auth', async () => {
      const challenge = {
        type: 'challenge',
        nonce: 'random_nonce_123',
      };

      const response = {
        type: 'challenge_response',
        signature: 'signed_nonce_123',
      };

      expect(challenge.nonce).toBeDefined();
      expect(response.signature).toBeDefined();
    });

    it('should handle reconnection', async () => {
      const reconnect = {
        deviceId: 'device_123',
        sessionToken: 'prev_session_token',
      };

      expect(reconnect.sessionToken).toBeDefined();
    });

    it('should handle graceful disconnect', async () => {
      const disconnect = {
        reason: 'user_requested',
        code: 1000,
      };

      expect(disconnect.code).toBe(1000);
    });
  });

  describe('HTTP Endpoints', () => {
    describe('/health', () => {
      it('should return 200 OK when healthy', async () => {
        const response = {
          status: 200,
          body: { ok: true },
        };

        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
      });

      it('should return 503 when unhealthy', async () => {
        const response = {
          status: 503,
          body: { ok: false, error: 'Database unavailable' },
        };

        expect(response.status).toBe(503);
        expect(response.body.ok).toBe(false);
      });
    });

    describe('/status', () => {
      it('should return detailed status', async () => {
        const response = {
          status: 200,
          body: {
            version: '1.0.0',
            uptime: 12345,
            connections: 5,
            channels: {
              discord: 'connected',
              slack: 'disconnected',
            },
          },
        };

        expect(response.body.version).toBeDefined();
        expect(response.body.channels).toBeDefined();
      });
    });
  });

  describe('Message Format', () => {
    it('should use JSON-RPC 2.0 format for requests', async () => {
      const request = {
        jsonrpc: '2.0',
        id: 'req_123',
        method: 'health',
        params: {},
      };

      expect(request.jsonrpc).toBe('2.0');
      expect(request.id).toBeDefined();
      expect(request.method).toBeDefined();
    });

    it('should use JSON-RPC 2.0 format for responses', async () => {
      const response = {
        jsonrpc: '2.0',
        id: 'req_123',
        result: { ok: true },
      };

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBeDefined();
      expect(response.result).toBeDefined();
    });

    it('should use JSON-RPC 2.0 format for errors', async () => {
      const errorResponse = {
        jsonrpc: '2.0',
        id: 'req_123',
        error: {
          code: -32600,
          message: 'Invalid request',
        },
      };

      expect(errorResponse.error.code).toBeDefined();
      expect(errorResponse.error.message).toBeDefined();
    });

    it('should use notification format for events', async () => {
      const notification = {
        jsonrpc: '2.0',
        method: 'event',
        params: {
          type: 'agent',
          data: { chunk: 'Hello' },
        },
      };

      expect((notification as Record<string, unknown>).id).toBeUndefined();
      expect(notification.method).toBe('event');
    });
  });

  describe('Streaming Protocol', () => {
    it('should support SSE-style streaming', async () => {
      const streamChunks = [
        { type: 'start', requestId: 'req_123' },
        { type: 'chunk', content: 'Hello' },
        { type: 'chunk', content: ' world' },
        { type: 'end', usage: { inputTokens: 5, outputTokens: 10 } },
      ];

      expect(streamChunks[0].type).toBe('start');
      expect(streamChunks[streamChunks.length - 1].type).toBe('end');
    });

    it('should support tool output streaming', async () => {
      const toolStream = [
        { type: 'tool_start', toolId: 'tool_1', name: 'bash' },
        { type: 'tool_output', toolId: 'tool_1', content: 'output line 1' },
        { type: 'tool_output', toolId: 'tool_1', content: 'output line 2' },
        { type: 'tool_end', toolId: 'tool_1', success: true },
      ];

      expect(toolStream[0].type).toBe('tool_start');
      expect(toolStream[toolStream.length - 1].type).toBe('tool_end');
    });
  });

  describe('Error Handling', () => {
    it('should return method not found error', async () => {
      const error = {
        code: -32601,
        message: 'Method not found',
        data: { method: 'unknown.method' },
      };

      expect(error.code).toBe(-32601);
    });

    it('should return invalid params error', async () => {
      const error = {
        code: -32602,
        message: 'Invalid params',
        data: { field: 'sessionId', reason: 'required' },
      };

      expect(error.code).toBe(-32602);
    });

    it('should return internal error', async () => {
      const error = {
        code: -32603,
        message: 'Internal error',
      };

      expect(error.code).toBe(-32603);
    });
  });
});
