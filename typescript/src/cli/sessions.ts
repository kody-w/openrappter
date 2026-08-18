/**
 * Inspect and manage chat sessions from the terminal.
 *
 * Every subcommand here was broken, in two different ways (#206):
 *
 *   - `sessions.list`, `sessions.get` and `sessions.delete` are **not
 *     registered by the gateway at all**. The chat-session methods are named
 *     `chat.*`. All three failed with method-not-found.
 *   - `sessions.reset` *is* registered, but reads `sessionId`/`sessionKey`
 *     (via `resolveSessionId`), while this module sent `{ id }` -- so it threw
 *     `sessionKey required` on every invocation.
 *
 * `show` deliberately uses `chat.messages` rather than `chat.session`. The
 * latter is `getOrCreateSession`: asking it to display a session that does not
 * exist would silently create one, so a typo'd id would report an empty
 * session into existence instead of saying it is not there.
 *
 * `chat.delete` and `sessions.reset` require auth; `withClient` forwards
 * `OPENRAPPTER_TOKEN`.
 */
import type { Command } from 'commander';
import { withClient } from './with-client.js';

interface SessionSummary {
  id: string;
  agentId?: string;
  messageCount: number;
  createdAt?: string;
  updatedAt?: string;
}

interface ChatMessage {
  role?: string;
  content?: string;
  timestamp?: string;
}

export function registerSessionsCommand(program: Command): void {
  const sessions = program.command('sessions').description('Inspect and manage chat sessions');

  sessions
    .command('list', { isDefault: true })
    .description('List chat sessions')
    .option('--json', 'Print the raw response')
    .action(async (options: { json?: boolean }) => {
      await withClient(async (client) => {
        const result = (await client.call('chat.list')) as SessionSummary[] | undefined;
        const list = Array.isArray(result) ? result : [];

        if (options.json) {
          console.log(JSON.stringify(list, null, 2));
          return;
        }
        if (list.length === 0) {
          console.log('No chat sessions yet.');
          return;
        }
        for (const session of list) {
          console.log(`\n  ${session.id}`);
          if (session.agentId) console.log(`    agent:    ${session.agentId}`);
          console.log(`    messages: ${session.messageCount}`);
          if (session.updatedAt) console.log(`    updated:  ${session.updatedAt}`);
        }
        console.log(`\n  ${list.length} session${list.length === 1 ? '' : 's'}.`);
      });
    });

  sessions
    .command('show <id>')
    .description('Show the messages in a session')
    .option('--limit <n>', 'Only the last n messages')
    .option('--json', 'Print the raw response')
    .action(async (id: string, options: { limit?: string; json?: boolean }) => {
      await withClient(async (client) => {
        const limit = options.limit ? Number.parseInt(options.limit, 10) : undefined;
        if (options.limit !== undefined && (!Number.isFinite(limit) || limit! <= 0)) {
          console.error(`\n  --limit must be a positive number, got "${options.limit}"\n`);
          process.exitCode = 1;
          return;
        }

        const result = (await client.call('chat.messages', {
          sessionId: id,
          ...(limit ? { limit } : {}),
        })) as ChatMessage[] | undefined;
        const messages = Array.isArray(result) ? result : [];

        if (options.json) {
          console.log(JSON.stringify(messages, null, 2));
          return;
        }
        if (messages.length === 0) {
          console.log(`Session ${id} has no messages.`);
          return;
        }
        for (const message of messages) {
          console.log(`\n  ${message.role ?? 'unknown'}${message.timestamp ? `  ${message.timestamp}` : ''}`);
          console.log(`    ${message.content ?? ''}`);
        }
      });
    });

  sessions
    .command('delete <id>')
    .description('Delete a session and abort anything it is running')
    .action(async (id: string) => {
      await withClient(async (client) => {
        const result = (await client.call('chat.delete', { sessionId: id })) as
          | { deleted?: boolean }
          | undefined;

        // The gateway reports whether it actually deleted anything. Printing
        // "Deleted" regardless -- as this module used to -- tells someone who
        // mistyped an id that their session is gone when it is still there.
        if (result?.deleted) {
          console.log(`Deleted session: ${id}`);
        } else {
          console.log(`No session named ${id}; nothing was deleted.`);
          process.exitCode = 1;
        }
      });
    });

  sessions
    .command('reset <id>')
    .description('Empty a session without deleting it')
    .action(async (id: string) => {
      await withClient(async (client) => {
        const result = (await client.call('sessions.reset', { sessionId: id })) as
          | { clearedMessages?: number }
          | undefined;
        const cleared = result?.clearedMessages ?? 0;
        console.log(`Reset session ${id}: cleared ${cleared} message${cleared === 1 ? '' : 's'}.`);
      });
    });
}
