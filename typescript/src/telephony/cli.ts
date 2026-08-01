/**
 * `openrappter call` — give the agent your phone line from the terminal.
 *
 * The `--rehearse` flag runs the whole thing against a scripted callee instead
 * of a real number. That is not a toy: it is how you check what the agent would
 * agree to *before* you point it at a real business, and it needs no provider,
 * no account and no money.
 */

import chalk from 'chalk';
import type { Command } from 'commander';

import { CallAgent } from './call-agent.js';
import { SecondBrain } from './brain.js';
import { HotlineGate } from './hotline.js';
import { parseConstraints, parseLocalIso } from './constraints.js';
import { SimulationProvider } from './providers/simulation.js';
import { RetellProvider } from './providers/retell.js';
import { TwilioProvider } from './providers/twilio.js';
import type { CallObjective, CallProvider, Offer } from './types.js';

const PHONE = '☎️ ';

function resolveProvider(name: string, rehearsalReplies?: string[]): CallProvider {
  switch (name) {
    case 'retell':
      return new RetellProvider();
    case 'twilio':
      return new TwilioProvider();
    case 'simulation':
      return new SimulationProvider({
        peers: [{ number: '*', replies: rehearsalReplies ?? ['Let me check... I could do 7:45.'] }],
      });
    default:
      throw new Error(`unknown provider ${name} (try: simulation, retell, twilio)`);
  }
}

/** Build the objective, refusing to dial if a stated limit could not be understood. */
function buildObjective(options: { objective?: string; constraint?: string[]; at?: string; party?: string }): {
  objective: CallObjective;
  date?: string;
} {
  const { constraints, unparsed } = parseConstraints(options.constraint ?? []);

  if (unparsed.length > 0) {
    throw new Error(
      `could not understand ${unparsed.map((c) => `"${c}"`).join(', ')}.\n` +
        '  Refusing to dial: negotiating without one of your limits is worse than not calling.\n' +
        '  Try shapes like "no later than 8pm", "not before 6pm", "party size exactly 2", "budget under 400".',
    );
  }

  const ideal: Offer = {};
  if (options.at) ideal.start = options.at;
  if (options.party) ideal.partySize = Number(options.party);

  return {
    objective: {
      goal: options.objective ?? 'Make an enquiry',
      constraints,
      ideal: Object.keys(ideal).length > 0 ? ideal : undefined,
    },
    date: options.at ? parseLocalIso(options.at).date : undefined,
  };
}

export function registerTelephonyCommands(program: Command): void {
  const call = program.command('call').description('Place and manage phone calls the agent makes on your behalf');

  call
    .command('place <number>')
    .description('Call a number with a goal and hard limits')
    .option('-o, --objective <text>', 'What the agent is trying to achieve')
    .option('-c, --constraint <rule...>', 'A hard limit, repeatable (e.g. "no later than 8pm")')
    .option('--at <iso>', 'The time you actually want, e.g. 2026-08-07T19:00')
    .option('--party <n>', 'Party size you actually want')
    .option('-p, --provider <name>', 'simulation | retell | twilio', 'simulation')
    .option('--owner <number>', 'Your number, for the approval callback')
    .option('--rehearse <reply...>', 'Scripted replies to practise against, no real call')
    .option('--hint <when>', 'Bias bare numbers: evening | morning | none', 'none')
    .action(async (number: string, options) => {
      try {
        const { objective, date } = buildObjective(options);
        const providerName = options.rehearse ? 'simulation' : options.provider;
        const provider = resolveProvider(providerName, options.rehearse);

        if (!(await provider.isAvailable())) {
          console.error(chalk.red(`\n  ${providerName} is not configured.`));
          console.error(chalk.dim('  Set the provider credentials, or use --rehearse to practise offline.\n'));
          process.exit(1);
        }

        const brain = new SecondBrain({ actor: 'openrappter-call' });
        if (!(await brain.isAvailable())) {
          console.error(chalk.yellow('\n  RAPP Second Brain not found — the call will not be recorded.'));
          console.error(
            chalk.dim(
              '  curl -fsSL https://raw.githubusercontent.com/kody-w/rapp-secondbrain/main/install.sh | bash\n',
            ),
          );
        }

        console.log(`\n${PHONE} ${chalk.bold(providerName)} → ${number}`);
        console.log(chalk.dim(`   goal: ${objective.goal}`));
        for (const constraint of objective.constraints) {
          console.log(chalk.dim(`   limit: ${constraint.label ?? constraint.kind}`));
        }
        console.log('');

        const agent = new CallAgent({ provider, brain, ownerNumber: options.owner });
        const result = await agent.placeCall({
          to: number,
          objective,
          date,
          hint: options.hint,
          appointmentTitle: objective.goal,
        });

        for (const turn of result.transcript) {
          const label = turn.role === 'agent' ? chalk.cyan('agent') : chalk.magenta(turn.role.padEnd(5));
          console.log(`   ${label}  ${turn.text}`);
        }

        console.log('');
        const badge =
          result.outcome === 'agreed'
            ? chalk.green('agreed')
            : result.outcome === 'escalated'
              ? chalk.yellow('needs your approval')
              : chalk.red(result.outcome);
        console.log(`   ${badge} — ${result.summary}`);

        if (result.approvalId) {
          console.log('');
          console.log(chalk.yellow(`   Nothing has been booked.`));
          console.log(`   ${chalk.bold(result.decision?.question ?? 'Approve?')}`);
          console.log('');
          console.log(chalk.dim(`     openrappter call approve ${result.approvalId}`));
          console.log(chalk.dim(`     openrappter call deny    ${result.approvalId}`));
          if (options.owner) {
            console.log(chalk.dim(`     openrappter call callback ${result.approvalId} --to ${options.owner}`));
          }
        }
        console.log('');
      } catch (error) {
        console.error(chalk.red(`\n  ${(error as Error).message}\n`));
        process.exit(1);
      }
    });

  call
    .command('callback <approvalId>')
    .description('Ring the owner and put the decision to them')
    .option('--to <number>', 'Number to call')
    .option('-q, --question <text>', 'What to ask')
    .option('-p, --provider <name>', 'simulation | retell | twilio', 'retell')
    .option('--appointment <id>', 'Appointment the answer applies to')
    .action(async (approvalId: string, options) => {
      const provider = resolveProvider(options.provider);
      const brain = new SecondBrain({ actor: 'openrappter-callback' });
      const agent = new CallAgent({ provider, brain, ownerNumber: options.to });

      const result = await agent.callBackForApproval({
        approvalId,
        question: options.question ?? 'I need your approval to proceed. Is that a yes?',
        appointmentId: options.appointment,
        to: options.to,
      });

      console.log(result.approved ? chalk.green('\n  Approved.\n') : chalk.yellow('\n  Not approved.\n'));
    });

  for (const decision of ['approve', 'deny'] as const) {
    call
      .command(`${decision} <approvalId>`)
      .description(`Record your ${decision === 'approve' ? 'yes' : 'no'} without a call`)
      .option('--note <text>')
      .action(async (approvalId: string, options) => {
        const brain = new SecondBrain({ actor: 'openrappter-cli' });
        const ok = await brain.decideApproval(approvalId, decision, 'cli', options.note);
        console.log(ok ? chalk.green(`\n  ${decision}d ${approvalId}\n`) : chalk.red(`\n  could not ${decision}\n`));
        if (!ok) process.exit(1);
      });
  }

  call
    .command('pending')
    .description('Decisions the agent is waiting on')
    .action(async () => {
      const approvals = await new SecondBrain().pendingApprovals();
      if (approvals.length === 0) {
        console.log(chalk.dim('\n  Nothing waiting on you.\n'));
        return;
      }
      console.log('');
      for (const approval of approvals) {
        console.log(`  ${chalk.yellow('?')} ${approval.subject as string}`);
        console.log(chalk.dim(`    ${approval.id as string}`));
      }
      console.log('');
    });

  call
    .command('brief')
    .description("What the agent knows right now (the Second Brain's view)")
    .action(async () => {
      const brain = new SecondBrain();
      if (!(await brain.isAvailable())) {
        console.error(chalk.red('\n  RAPP Second Brain is not installed.'));
        console.error(
          chalk.dim('  curl -fsSL https://raw.githubusercontent.com/kody-w/rapp-secondbrain/main/install.sh | bash\n'),
        );
        process.exit(1);
      }
      console.log(JSON.stringify(await brain.brief(), null, 2));
    });

  call
    .command('hotline')
    .description('Check the inbound PIN gate for your agent’s own number')
    .requiredOption('--pin <digits>', '4-12 digit access code')
    .option('--trust <number...>', 'Numbers that skip the challenge')
    .option('--from <number>', 'Simulate a caller', '+15559998888')
    .option('--attempt <digits>', 'Simulate a PIN entry')
    .action((options) => {
      try {
        const gate = new HotlineGate({ pin: options.pin, trustedNumbers: options.trust });
        const admit = gate.admit(options.from);
        console.log(`\n  ${chalk.bold(options.from)} → ${admit.outcome}`);
        console.log(chalk.dim(`  agent says: "${admit.say}"`));

        if (admit.outcome === 'challenge' && options.attempt) {
          const submitted = gate.submit(options.from, options.attempt);
          console.log(`\n  entered ${options.attempt} → ${submitted.outcome}`);
          console.log(chalk.dim(`  agent says: "${submitted.say}"`));
        }
        console.log('');
      } catch (error) {
        console.error(chalk.red(`\n  ${(error as Error).message}\n`));
        process.exit(1);
      }
    });
}
