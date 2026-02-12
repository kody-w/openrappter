import { TuiGatewayClient } from './gateway-client.js';
import { ChatView } from './chat-view.js';
import { InputBar } from './input-bar.js';
import { StatusBar } from './status-bar.js';
import { executeSlashCommand, parseSlashCommand } from './slash-commands.js';

export interface TuiOptions {
  port?: number;
  token?: string;
}

export async function startTUI(options: TuiOptions = {}): Promise<void> {
  const port = options.port ?? 18790;
  const client = new TuiGatewayClient();
  const chatView = new ChatView();
  const inputBar = new InputBar();
  const statusBar = new StatusBar();

  let blessed: any;
  try {
    blessed = await import('blessed');
  } catch {
    console.error('blessed not installed. Run: npm install blessed');
    console.error('Falling back to simple readline mode...');
    await simpleFallback(client, port, options.token);
    return;
  }

  const screen = blessed.screen({ smartCSR: true, title: 'OpenRappter TUI' });

  const chatBox = blessed.log({
    top: 0, left: 0, width: '100%', height: '100%-3',
    scrollable: true, alwaysScroll: true,
    border: { type: 'line' },
    label: ' OpenRappter Chat ',
    style: { border: { fg: 'gray' } },
  });

  const inputBox = blessed.textbox({
    bottom: 1, left: 0, width: '100%', height: 3,
    border: { type: 'line' },
    label: ' Message ',
    style: { border: { fg: 'gray' }, focus: { border: { fg: 'cyan' } } },
    inputOnFocus: true,
  });

  const statusBox = blessed.box({
    bottom: 0, left: 0, width: '100%', height: 1,
    style: { bg: 'blue', fg: 'white' },
  });

  screen.append(chatBox);
  screen.append(inputBox);
  screen.append(statusBox);

  chatView.setWidget(chatBox);
  inputBar.setWidget(inputBox);
  statusBar.setWidget(statusBox);

  // Handle input
  inputBar.on('submit', async (text: string) => {
    if (parseSlashCommand(text)) {
      const { result, isQuit } = await executeSlashCommand(text, client);
      if (isQuit) { client.disconnect(); process.exit(0); }
      if (result) chatView.appendMessage('system', result);
    } else {
      chatView.appendMessage('user', text);
      try {
        const response = await client.call('chat.send', { message: text }) as Record<string, unknown>;
        statusBar.update({ session: (response.sessionKey as string) || 'default' });
      } catch (err) {
        chatView.appendMessage('system', `Error: ${(err as Error).message}`);
      }
    }
    screen.render();
  });

  // Handle chat events
  client.on('chat', (payload: any) => {
    if (payload.state === 'final' && payload.message) {
      const content = payload.message.content?.[0]?.text ?? payload.message.content ?? '';
      chatView.appendMessage('assistant', content);
      screen.render();
    }
  });

  screen.key(['C-c', 'q'], () => { client.disconnect(); process.exit(0); });
  screen.key(['escape'], () => { inputBox.focus(); screen.render(); });

  // Connect to gateway
  statusBar.update({ connected: false });
  screen.render();

  try {
    await client.connect(`ws://127.0.0.1:${port}`, options.token);
    await client.subscribe(['chat', 'agent', 'presence']);
    statusBar.update({ connected: true });
    chatView.appendMessage('system', `Connected to gateway on port ${port}`);
  } catch (err) {
    chatView.appendMessage('system', `Failed to connect: ${(err as Error).message}`);
    statusBar.update({ connected: false });
  }

  inputBox.focus();
  screen.render();
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
