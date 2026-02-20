import { TuiGatewayClient } from './gateway-client.js';

export interface TuiOptions {
  port?: number;
  token?: string;
}

/**
 * Start TUI in gateway-connected mode (for --daemon usage).
 * Uses readline-based chat connected via WebSocket.
 */
export async function startTUI(options: TuiOptions = {}): Promise<void> {
  const port = options.port ?? 18790;
  const client = new TuiGatewayClient();
  await simpleFallback(client, port, options.token);
}

async function simpleFallback(client: TuiGatewayClient, port: number, token?: string): Promise<void> {
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    await client.connect(`ws://127.0.0.1:${port}`, token);
    await client.subscribe(['chat']);
    console.log(`Connected to gateway on port ${port}`);
  } catch (err) {
    console.error(`Failed to connect: ${(err as Error).message}`);
    process.exit(1);
  }

  client.on('chat', (payload: any) => {
    if (payload.state === 'final' && payload.message) {
      const content = payload.message.content?.[0]?.text ?? payload.message.content ?? '';
      console.log(`\nAssistant: ${content}\n`);
    }
  });

  const prompt = (): void => {
    rl.question('You: ', async (input) => {
      const trimmed = input.trim();
      if (!trimmed) { prompt(); return; }
      if (trimmed === '/quit') { client.disconnect(); rl.close(); return; }
      try { await client.call('chat.send', { message: trimmed }); } catch (err) { console.error(`Error: ${(err as Error).message}`); }
      prompt();
    });
  };
  prompt();
}
