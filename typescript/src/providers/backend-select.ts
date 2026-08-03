/**
 * Pick a provider that can actually answer, and say so when none can.
 *
 * THE DEFECT THIS EXISTS FOR
 *
 * openrappter defaulted to the Copilot **SDK**, which needs a GitHub token
 * carrying Copilot API access. On a machine where that token is missing, fake,
 * or unentitled, every message came back as:
 *
 *     GitHub token does not have Copilot API access (HTTP 401/403).
 *
 * …while a fully working GitHub Copilot **CLI** sat on the same disk, holding
 * its own credential and answering fine. The product had a path that worked and
 * was choosing one that did not, then reporting the failure as if nothing could
 * be done. That is the opposite of local-first degradation.
 *
 * It also proceeded past a credential it had already observed to be bad — the
 * daemon logged `Stored Copilot profile is stale` and then carried on to fail
 * on the next request. A known-bad credential is a decision point, not a
 * warning to print.
 *
 * WHAT THIS DOES
 *
 * Probes the ladder once at startup, cheaply, and picks the first rung that
 * actually works:
 *
 *   1. an explicit `OPENRAPPTER_AI_BACKEND` — the operator's choice always wins
 *   2. the Copilot SDK, but only if its token really exchanges for a Copilot
 *      API token; a token that merely EXISTS is not evidence it works
 *   3. the Copilot CLI, if the binary is present and authenticated
 *   4. nothing — and in that case the reason is carried, in words that name the
 *      action a person can take
 *
 * Rung 4 matters as much as the others. When no provider can answer, the UI has
 * to say "your Copilot sign-in expired — reconnect", not echo a command line.
 */

import { CopilotProvider } from './copilot.js';
import { CopilotCliDirectProvider } from './copilot-cli-direct.js';
import type { LLMProvider } from './types.js';

export type BackendKind = 'copilot-sdk' | 'copilot-cli' | 'none';

export interface BackendChoice {
  kind: BackendKind;
  provider: LLMProvider | null;
  /**
   * The model that will actually answer.
   *
   * PARITY §2.4 requires the envelope to report this, and to report it honestly:
   * clients attribute answers by it, so a rung that resolves its own model must
   * say which one rather than echoing the request.
   */
  model?: string;
  /** Why this rung was chosen — for the startup log. */
  reason: string;
  /**
   * Present only when `kind === 'none'`. Written for a person, not a log:
   * it names what is wrong and what to do about it.
   */
  remedy?: {
    title: string;
    detail: string;
    /** A concrete action the UI can offer as a button. */
    action: 'reconnect-github' | 'install-copilot-cli';
  };
}

export interface SelectBackendOptions {
  githubToken?: string;
  model?: string;
  /** Override for tests; defaults to reading the real environment. */
  env?: NodeJS.ProcessEnv;
  /** Injected so selection can be tested without network or a CLI on disk. */
  probeSdk?: (token: string) => Promise<boolean>;
  probeCli?: () => Promise<boolean>;
}

/** Does this GitHub token really exchange for a Copilot API token? */
async function defaultProbeSdk(githubToken: string): Promise<boolean> {
  if (!githubToken) return false;
  try {
    const { resolveCopilotApiToken } = await import('./copilot-token.js');
    await resolveCopilotApiToken({ githubToken });
    return true;
  } catch {
    return false;
  }
}

/** Is the Copilot CLI present and already signed in? */
async function defaultProbeCli(): Promise<boolean> {
  const path = CopilotCliDirectProvider.findCLI();
  if (!path) return false;
  try {
    return await new CopilotCliDirectProvider({ cliPath: path }).isAvailable();
  } catch {
    return false;
  }
}

export async function selectBackend(options: SelectBackendOptions = {}): Promise<BackendChoice> {
  const env = options.env ?? process.env;
  const probeSdk = options.probeSdk ?? defaultProbeSdk;
  const probeCli = options.probeCli ?? defaultProbeCli;
  const model = options.model;

  // 1. An explicit choice is honoured without probing. If an operator pins a
  //    backend, silently using a different one would be worse than failing.
  const pinned = env.OPENRAPPTER_AI_BACKEND;
  if (pinned === 'copilot-cli') {
    return {
      kind: 'copilot-cli',
      // exposeAgents: without it the CLI runs with an empty tool allow-list
      // and cannot invoke a single agent, which makes hot-loading pointless.
      provider: new CopilotCliDirectProvider({ model, exposeAgents: true }),
      model: model ?? 'auto',
      reason: 'OPENRAPPTER_AI_BACKEND=copilot-cli',
    };
  }
  if (pinned === 'copilot-sdk' || pinned === 'copilot') {
    return {
      kind: 'copilot-sdk',
      provider: new CopilotProvider({ githubToken: options.githubToken }),
      reason: 'OPENRAPPTER_AI_BACKEND=copilot-sdk',
    };
  }

  // 2. The SDK, but only on proof. Holding a token is not the same as the token
  //    working — that assumption is exactly what produced the 401 on every
  //    message while a usable CLI sat unused on the same disk.
  const token = options.githubToken ?? env.GITHUB_TOKEN ?? env.GH_TOKEN ?? '';
  if (token && (await probeSdk(token))) {
    return {
      kind: 'copilot-sdk',
      provider: new CopilotProvider({ githubToken: token }),
      reason: 'GitHub token has Copilot API access',
    };
  }

  // 3. The local rung. The CLI owns its own credential and refresh, so it keeps
  //    working when the GitHub token does not.
  if (await probeCli()) {
    return {
      kind: 'copilot-cli',
      // exposeAgents: without it the CLI runs with an empty tool allow-list
      // and cannot invoke a single agent, which makes hot-loading pointless.
      provider: new CopilotCliDirectProvider({ model, exposeAgents: true }),
      model: model ?? 'auto',
      reason: token
        ? 'GitHub token has no Copilot access — fell back to the Copilot CLI'
        : 'no GitHub token — using the Copilot CLI, which holds its own sign-in',
    };
  }

  // 4. Nothing works. Say what to do, not what failed.
  return {
    kind: 'none',
    provider: null,
    reason: 'no working AI backend',
    remedy: token
      ? {
          title: 'Your Copilot sign-in needs reconnecting',
          detail:
            'The stored GitHub account does not have Copilot access, and the Copilot CLI '
            + 'is not signed in on this machine. Reconnect with a GitHub account that has '
            + 'Copilot enabled, or run `copilot` once in a terminal to sign the CLI in.',
          action: 'reconnect-github',
        }
      : {
          title: 'Connect GitHub Copilot',
          detail:
            'No GitHub token is stored and the Copilot CLI is not available. Connect a '
            + 'GitHub account with Copilot enabled, or install the Copilot CLI.',
          action: 'install-copilot-cli',
        },
  };
}
