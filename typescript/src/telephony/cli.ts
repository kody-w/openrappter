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
import { resolveProvider as resolveLadder } from './providers/resolve.js';
import { smsSpeaker } from './providers/google-voice.js';
import type { CallObjective, CallProvider, Offer } from './types.js';

const PHONE = '☎️ ';

/** Named backend, for `callback` where the caller knows what it wants. */
function namedProvider(name: string): CallProvider {
  switch (name) {
    case 'retell':
      return new RetellProvider();
    case 'twilio':
      return new TwilioProvider();
    case 'simulation':
      return new SimulationProvider({ peers: [{ number: '*', replies: ['Yes, go ahead.'] }] });
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
    .option('-p, --provider <name>', 'auto | retell | twilio | google-voice | macos-native', 'auto')
    .option('--on-device', 'refuse anything that would involve a third party')
    .option('--owner <number>', 'Your number, for the approval callback')
    .option('--rehearse <reply...>', 'Scripted replies to practise against, no real call')
    .option('--hint <when>', 'Bias bare numbers: evening | morning | none', 'none')
    .action(async (number: string, options) => {
      try {
        const { objective, date } = buildObjective(options);

        const resolution = await resolveLadder({
          rehearse: options.rehearse,
          prefer: options.provider === 'auto' ? undefined : options.provider,
          requireOnDevice: options.onDevice,
        });
        const { provider, capability, notice } = resolution;

        const brain = new SecondBrain({ actor: 'openrappter-call' });
        if (!(await brain.isAvailable())) {
          console.error(chalk.yellow('\n  RAPP Second Brain not found — the call will not be recorded.'));
          console.error(
            chalk.dim(
              '  curl -fsSL https://raw.githubusercontent.com/kody-w/rapp-secondbrain/main/install.sh | bash\n',
            ),
          );
        }

        console.log(`\n${PHONE} ${chalk.bold(provider.name)} → ${number}`);
        console.log(chalk.dim(`   ${notice}`));
        console.log(chalk.dim(`   goal: ${objective.goal}`));
        for (const constraint of objective.constraints) {
          console.log(chalk.dim(`   limit: ${constraint.label ?? constraint.kind}`));
        }
        console.log('');

        if (capability.modality === 'handoff') {
          const handle = await provider.dial({ to: number, objective });
          console.log(chalk.yellow('\n   I cannot speak on this line, so I have dialled and connected you.'));
          console.log(`   What you want: ${objective.goal}`);
          for (const constraint of objective.constraints) {
            console.log(chalk.dim(`   Your limit: ${constraint.label ?? constraint.kind}`));
          }
          console.log(chalk.dim(`\n   call ${handle.id}\n`));
          return;
        }

        const agent = new CallAgent({
          provider,
          brain,
          ownerNumber: options.owner,
          speaker: capability.modality === 'sms' ? (smsSpeaker as never) : undefined,
        });
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
      const provider = namedProvider(options.provider);
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

  call
    .command('google-voice')
    .description('Check the free, on-device phone layer: your own Google Voice, in your own browser')
    .option('--port <n>', 'Chrome DevTools port', '9222')
    .option('--account <email>', 'The Google account the session must be')
    .option('--send <number>', 'Compose a message to this number without sending it')
    .option('--text <message>', 'What to compose', 'openrappter dry run — this was never sent.')
    .action(async (options) => {
      const { ChromeSession } = await import('./providers/chrome-cdp.js');
      const { connectGoogleVoice } = await import('./providers/google-voice-browser.js');
      const port = Number(options.port);

      const line = (ok: boolean, label: string, detail?: string) => {
        console.log(
          `  ${ok ? chalk.green('[ok]') : chalk.yellow('[--]')} ${label}` +
            (detail ? chalk.dim(` — ${detail}`) : ''),
        );
      };

      console.log(`\n${PHONE} Google Voice — the rung that costs nothing\n`);

      const session = new ChromeSession({ port });
      if (!(await session.isAvailable())) {
        line(false, `Chrome DevTools on :${port}`, 'not listening');
        console.log(
          chalk.dim(
            '\n  openrappter will not restart your browser to open one.\n' +
              '  Quit Chrome, then start it once with:\n' +
              chalk.reset(`    open -a "Google Chrome" --args --remote-debugging-port=${port}\n`) +
              chalk.dim('  Your profile, and the Google Voice session in it, are unchanged.\n'),
          ),
        );
        process.exit(1);
      }
      line(true, `Chrome DevTools on :${port}`, 'listening');

      const driver = await connectGoogleVoice({
        port,
        account: options.account,
        dryRun: true,
      });
      if (!driver) {
        line(false, 'Google Voice tab', 'could not attach');
        process.exit(1);
      }
      line(true, 'Google Voice tab', 'attached');

      try {
        const signedIn = await driver.isSignedIn();
        line(signedIn, 'signed in', signedIn ? (options.account ?? 'session active') : 'not signed in');
        if (!signedIn) {
          console.log(chalk.dim('\n  Sign in at voice.google.com, then run this again.\n'));
          process.exit(1);
        }

        if (options.send) {
          // Always a dry run here. This command diagnoses; it does not text people.
          const thread = await driver.sendSms(options.send, options.text);
          line(true, 'composed a message', `${options.send} — NOT sent (${thread})`);
        }

        console.log(
          chalk.dim(
            '\n  Ready. This rung negotiates by text through your own number:\n' +
              '  no API key, no per-minute billing, nothing leaving the machine\n' +
              '  except the message itself.\n',
          ),
        );
      } catch (error) {
        line(false, 'check failed', (error as Error).message);
        console.log('');
        process.exit(1);
      }
    });
}
