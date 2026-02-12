import type { Command } from 'commander';
import { runDiagnostics } from '../infra/diagnostic.js';

function colorStatus(status: string): string {
  switch (status) {
    case 'pass':
      return '\x1b[32m✓\x1b[0m';
    case 'fail':
      return '\x1b[31m✗\x1b[0m';
    case 'warn':
      return '\x1b[33m⚠\x1b[0m';
    default:
      return '•';
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Run system diagnostics')
    .action(async () => {
      console.log('\nRunning OpenRappter diagnostics...\n');
      const results = await runDiagnostics();

      let hasIssues = false;
      for (const result of results) {
        const status = colorStatus(result.status);
        console.log(`${status} ${result.name}`);
        if (result.message) {
          console.log(`  ${result.message}`);
        }
        if (result.status === 'error' || result.status === 'warn') {
          hasIssues = true;
        }
      }

      console.log('');
      if (hasIssues) {
        console.log('Some checks failed or have warnings. Please review the output above.');
        process.exit(1);
      } else {
        console.log('All checks passed!');
      }
    });
}
