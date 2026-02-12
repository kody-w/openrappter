import type { Command } from 'commander';

export function registerGatewayCommand(program: Command): void {
  program
    .command('gateway')
    .description('Start the gateway server')
    .option('-p, --port <port>', 'Port number', '18790')
    .option('-b, --bind <bind>', 'Bind address (loopback|all)', 'loopback')
    .option('--token <token>', 'Auth token')
    .action(async (options) => {
      const { GatewayServer } = await import('../gateway/server.js');
      const port = parseInt(options.port, 10);
      const token = options.token || process.env.OPENRAPPTER_TOKEN;
      const server = new GatewayServer({
        port,
        bind: options.bind as 'loopback' | 'all',
        auth: token ? { mode: 'token', tokens: [token] } : { mode: 'none' },
      });
      process.on('SIGINT', async () => {
        await server.stop();
        process.exit(0);
      });
      await server.start();
      console.log(`Gateway running on ws://127.0.0.1:${port}`);
    });
}
