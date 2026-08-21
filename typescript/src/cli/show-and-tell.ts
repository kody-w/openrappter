import { readFile } from 'node:fs/promises';
import process from 'node:process';

import type { Command } from 'commander';

import { ShowAndTellAgent } from '../agents/ShowAndTellAgent.js';
import {
  hasAuthProfileAuthority,
  resolveCopilotAuth,
  resolveGithubToken,
} from '../copilot-check.js';
import { selectBackend } from '../providers/backend-select.js';
import {
  ShowAndTellStore,
  requestInteractiveShowAndTellConsent,
  showAndTellRoot,
} from '../show-and-tell/index.js';

function printResult(raw: string): void {
  try {
    const parsed = JSON.parse(raw) as { status?: unknown };
    console.log(JSON.stringify(parsed, null, 2));
    if (parsed.status === 'error') process.exitCode = 1;
  } catch {
    console.log(raw);
  }
}

async function connectAnalysisProvider(agent: ShowAndTellAgent): Promise<void> {
  let token = await resolveGithubToken();
  let backend = await selectBackend({
    githubToken: token ?? undefined,
    model: process.env.OPENRAPPTER_MODEL,
    allowIndependentCli: !hasAuthProfileAuthority(),
    allowAmbientCredentials: !hasAuthProfileAuthority(),
  });
  if (!backend.provider) {
    const auth = await resolveCopilotAuth();
    token = auth.status === 'authenticated' ? auth.token : null;
    backend = await selectBackend({
      githubToken: token ?? undefined,
      model: process.env.OPENRAPPTER_MODEL,
      allowIndependentCli: !hasAuthProfileAuthority(),
      allowAmbientCredentials: !hasAuthProfileAuthority(),
    });
  }
  if (!backend.provider) {
    throw new Error(
      backend.remedy?.detail ?? 'No working Copilot backend is available.',
    );
  }
  agent.setProvider(backend.provider);
}

export function registerShowAndTellCommand(program: Command): void {
  let agent: ShowAndTellAgent | undefined;
  let store: ShowAndTellStore | undefined;
  const getStore = () =>
    (store ??= new ShowAndTellStore(showAndTellRoot()));
  const getAgent = () =>
    (agent ??= new ShowAndTellAgent({
      store: getStore(),
      localSurface: true,
    }));
  const show = program
    .command('show-and-tell')
    .description('Learn a reusable skill or automation from a local demonstration');

  show
    .command('start')
    .description('Start a privacy-aware local demonstration recording')
    .option('--title <title>', 'Short session title')
    .option('--intent <intent>', 'Goal you are about to demonstrate')
    .option('--poll <ms>', 'Context polling interval in milliseconds', '2000')
    .option('--max-minutes <minutes>', 'Maximum recording duration', '480')
    .action(async (options: {
      title?: string;
      intent?: string;
      poll: string;
      maxMinutes: string;
    }) => {
      const token = await requestInteractiveShowAndTellConsent(
        getStore(),
        'start',
        'Start recording active app/window changes? Screenshots are explicit-only. Avoid passwords, tokens, and private material.',
      );
      printResult(
        await getAgent().execute({
          action: 'start',
          title: options.title,
          intent: options.intent,
          poll_interval_ms: Number(options.poll),
          max_duration_ms: Number(options.maxMinutes) * 60_000,
          consent_token: token,
        }),
      );
    });

  show
    .command('status')
    .description('Show the active or latest recording')
    .argument('[session]', 'Session id')
    .action(async (session?: string) => {
      printResult(await getAgent().execute({ action: 'status', session_id: session }));
    });

  show
    .command('note <text>')
    .description('Add narration explaining what you are doing and why')
    .option('--session <id>', 'Session id')
    .action(async (text: string, options: { session?: string }) => {
      printResult(
        await getAgent().execute({
          action: 'note',
          session_id: options.session,
          note: text,
        }),
      );
    });

  show
    .command('observe <detail>')
    .description('Record a semantic step the context collector cannot infer')
    .option('--session <id>', 'Session id')
    .option('--title <title>', 'Short step title')
    .option('--app <app>', 'Application involved')
    .option('--url <url>', 'URL involved; query and fragment are removed')
    .action(async (
      detail: string,
      options: { session?: string; title?: string; app?: string; url?: string },
    ) => {
      printResult(
        await getAgent().execute({
          action: 'observe',
          session_id: options.session,
          detail,
          title: options.title,
          app: options.app,
          url: options.url,
        }),
      );
    });

  show
    .command('capture')
    .description('Capture one explicit local reference frame')
    .option('--session <id>', 'Session id')
    .option('--label <label>', 'What this frame demonstrates')
    .action(async (options: { session?: string; label?: string }) => {
      const token = await requestInteractiveShowAndTellConsent(
        getStore(),
        'capture',
        'Capture the currently active window as a local reference frame?',
      );
      printResult(
        await getAgent().execute({
          action: 'capture',
          session_id: options.session,
          title: options.label,
          consent_token: token,
        }),
      );
    });

  show
    .command('stop')
    .description('Stop the active recording')
    .argument('[session]', 'Session id')
    .action(async (session?: string) => {
      printResult(await getAgent().execute({ action: 'stop', session_id: session }));
    });

  show
    .command('analyze')
    .description('Reconstruct intent and ordered steps from a completed recording')
    .argument('[session]', 'Session id')
    .option(
      '--enhance',
      'Send the privacy-safe text summary (never frames) to Copilot for refinement',
    )
    .action(async (
      session: string | undefined,
      options: { enhance?: boolean },
    ) => {
      let consentToken: string | undefined;
      if (options.enhance) {
        await connectAnalysisProvider(getAgent());
        consentToken = await requestInteractiveShowAndTellConsent(
          getStore(),
          'analyze',
          'Send app/window titles, privacy-reduced URLs, notes, and semantic events to GitHub Copilot for analysis? Raw screenshots are never sent.',
        );
      }
      printResult(
        await getAgent().execute({
          action: 'analyze',
          session_id: session,
          enhance: options.enhance === true,
          consent_token: consentToken,
        }),
      );
    });

  show
    .command('review')
    .description('Edit the draft analysis without approving it')
    .argument('[session]', 'Session id')
    .option('--title <title>', 'Edited analysis title')
    .option('--intent <intent>', 'Edited intent')
    .option('--feedback <feedback>', 'Review notes')
    .option('--steps <path>', 'JSON file containing the edited step array')
    .action(async (
      session: string | undefined,
      options: {
        title?: string;
        intent?: string;
        feedback?: string;
        steps?: string;
      },
    ) => {
      const stepsJson = options.steps
        ? await readFile(options.steps, 'utf8')
        : undefined;
      printResult(
        await getAgent().execute({
          action: 'review',
          session_id: session,
          title: options.title,
          intent: options.intent,
          feedback: options.feedback,
          steps_json: stepsJson,
        }),
      );
    });

  show
    .command('bundle')
    .description('Show the deterministic evidence bundle and its honesty statistics')
    .argument('[session]', 'Session id')
    .action(async (session?: string) => {
      printResult(await getAgent().execute({ action: 'bundle', session_id: session }));
    });

  show
    .command('propose')
    .description('Create one reviewable skill plan without building anything')
    .argument('[session]', 'Session id')
    .action(async (session?: string) => {
      printResult(await getAgent().execute({ action: 'propose', session_id: session }));
    });

  show
    .command('approve')
    .description('Approve the reviewed analysis in a local interactive terminal')
    .argument('[session]', 'Session id')
    .option('--title <title>', 'Final analysis title')
    .option('--intent <intent>', 'Final intent')
    .option('--feedback <feedback>', 'Final review notes')
    .option('--steps <path>', 'JSON file containing the final step array')
    .action(async (
      session: string | undefined,
      options: {
        title?: string;
        intent?: string;
        feedback?: string;
        steps?: string;
      },
    ) => {
      const token = await requestInteractiveShowAndTellConsent(
        getStore(),
        'approve',
        'Approve this analysis as the exact source for a reusable skill or automation?',
      );
      const stepsJson = options.steps
        ? await readFile(options.steps, 'utf8')
        : undefined;
      printResult(
        await getAgent().execute({
          action: 'review',
          session_id: session,
          title: options.title,
          intent: options.intent,
          feedback: options.feedback,
          steps_json: stepsJson,
          approve: true,
          consent_token: token,
        }),
      );
    });

  show
    .command('revise-plan')
    .description('Edit a proposed skill plan, or approve it in a separate turn')
    .argument('[session]', 'Session id')
    .option('--title <title>', 'Edited plan title')
    .option('--intent <intent>', 'Edited plan intent and trigger contract')
    .option('--feedback <feedback>', 'Plan review notes')
    .option('--steps <path>', 'JSON file containing the edited plan step array')
    .option('--values <path>', 'JSON file containing the edited value array')
    .option('--approve', 'Approve the unchanged plan in this local interactive turn')
    .action(async (
      session: string | undefined,
      options: {
        title?: string;
        intent?: string;
        feedback?: string;
        steps?: string;
        values?: string;
        approve?: boolean;
      },
    ) => {
      const stepsJson = options.steps
        ? await readFile(options.steps, 'utf8')
        : undefined;
      const valuesJson = options.values
        ? await readFile(options.values, 'utf8')
        : undefined;
      const consentToken = options.approve
        ? await requestInteractiveShowAndTellConsent(
            getStore(),
            'approve',
            'Approve this unchanged plan as the exact source for generated artifacts?',
          )
        : undefined;
      printResult(
        await getAgent().execute({
          action: 'revise_plan',
          session_id: session,
          title: options.title,
          intent: options.intent,
          feedback: options.feedback,
          steps_json: stepsJson,
          values_json: valuesJson,
          approve: options.approve === true,
          consent_token: consentToken,
        }),
      );
    });

  show
    .command('export')
    .description('Export an approved plan as a private marketplace package')
    .argument('[session]', 'Session id')
    .option('--marketplace-name <name>', 'Marketplace directory name')
    .option('--plugin-name <name>', 'Plugin directory name')
    .option('--skill-name <name>', 'Skill directory name')
    .action(async (
      session: string | undefined,
      options: {
        marketplaceName?: string;
        pluginName?: string;
        skillName?: string;
      },
    ) => {
      printResult(
        await getAgent().execute({
          action: 'export',
          session_id: session,
          marketplace_name: options.marketplaceName,
          plugin_name: options.pluginName,
          skill_name: options.skillName,
        }),
      );
    });

  show
    .command('build')
    .description('Build from the approved plan when present, otherwise the approved analysis')
    .argument('[session]', 'Session id')
    .option('--target <target>', 'skill, automation, all, or rappid', 'skill')
    .action(async (session: string | undefined, options: { target: string }) => {
      printResult(
        await getAgent().execute({
          action: 'build',
          session_id: session,
          target: options.target,
        }),
      );
    });

  show
    .command('replay')
    .description('Preview a safe dry-run replay plan')
    .argument('[session]', 'Session id')
    .action(async (session?: string) => {
      printResult(await getAgent().execute({ action: 'replay', session_id: session }));
    });

  show
    .command('test')
    .description('Validate built artifacts, hashes, privacy, and disabled defaults')
    .argument('[session]', 'Session id')
    .action(async (session?: string) => {
      printResult(await getAgent().execute({ action: 'test', session_id: session }));
    });

  show
    .command('list')
    .description('List recorded demonstrations')
    .action(async () => {
      printResult(await getAgent().execute({ action: 'list' }));
    });

  show
    .command('delete')
    .description('Delete a stopped local recording')
    .argument('[session]', 'Session id')
    .action(async (session?: string) => {
      const token = await requestInteractiveShowAndTellConsent(
        getStore(),
        'delete',
        `Permanently delete ${session ? `session ${session}` : 'the latest session'} and its local frames?`,
      );
      printResult(
        await getAgent().execute({
          action: 'delete',
          session_id: session,
          consent_token: token,
        }),
      );
    });
}
