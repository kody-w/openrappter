/**
 * Auth RPC methods — GitHub account login, switch, and removal
 *
 * Methods:
 *   auth.status    — Read the shared typed Copilot auth state
 *   auth.check     — Re-verify the active account's Copilot access
 *   auth.profiles  — List all saved GitHub auth profiles
 *   auth.active    — Get the current active profile
 *   auth.login     — Start device code flow (returns user_code + URL)
 *   auth.poll      — Poll device flow and entitlement verification
 *   auth.cancel    — Cancel a pending device code flow
 *   auth.switch    — Set a different profile as default
 *   auth.remove    — Remove a saved profile
 */

import {
  AuthProfileStore,
  type AuthProfile,
} from '../../auth/profiles.js';
import {
  requestDeviceCode,
  pollForAccessToken,
} from '../../providers/copilot-auth.js';
import {
  CopilotAuthUnavailableError,
  CopilotAuthStateService,
  type CopilotAuthState,
} from '../../auth/copilot-auth-state.js';
import {
  resolveVerifiedGitHubIdentity,
  type VerifiedGitHubIdentity,
} from '../../auth/github-identity.js';
import { CopilotTokenError } from '../../providers/copilot-token.js';
import path from 'path';
import { openrappterHome } from '../../infra/openrappter-home.js';
import { retireMatchingLegacyCredentialCopies } from '../../auth/legacy-credential-migration.js';

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
}

interface ProfileInfo {
  id: string;
  provider: string;
  type: string;
  username?: string;
  default: boolean;
  createdAt: string;
}

interface LoginFlowDescriptor {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
}

interface PendingLoginFlow extends LoginFlowDescriptor {
  expiresAt: number;
  intervalMs: number;
  resolved: boolean;
  controller: AbortController;
  persisted?: boolean;
  username?: string;
  authState?: CopilotAuthState;
}

interface CredentialContext {
  generation: number;
  authGeneration: number;
  signal: AbortSignal;
}

export function registerAuthMethods(
  server: MethodRegistrar,
  _deps?: Record<string, unknown>
): void {
  const dataDir =
    (_deps?.dataDir as string | undefined) ?? openrappterHome();
  const store = (
    _deps?.authProfileStore ?? new AuthProfileStore(dataDir)
  ) as AuthProfileStore;
  const requestDeviceCodeImpl = (
    _deps?.requestDeviceCode ?? requestDeviceCode
  ) as typeof requestDeviceCode;
  const pollForAccessTokenImpl = (
    _deps?.pollForAccessToken ?? pollForAccessToken
  ) as typeof pollForAccessToken;
  const resolveGitHubIdentityImpl = (
    _deps?.resolveGitHubIdentity ?? resolveVerifiedGitHubIdentity
  ) as (
    token: string,
    fetchImpl?: typeof fetch,
    signal?: AbortSignal,
  ) => Promise<VerifiedGitHubIdentity>;
  const authStateService = (
    _deps?.copilotAuthStateService ?? new CopilotAuthStateService()
  ) as CopilotAuthStateService;
  const retireLegacyCopies = (
    _deps?.retireLegacyCopies
    ?? ((token: string) => retireMatchingLegacyCredentialCopies({
      token,
      legacyPath: path.join(dataDir, 'credentials', 'github-token.json'),
      envPath: path.join(dataDir, '.env'),
    }))
  ) as (token: string) => unknown;
  const pendingFlows = new Map<string, PendingLoginFlow>();
  let pendingFlowCreation: Promise<LoginFlowDescriptor> | undefined;
  let credentialGeneration = 0;
  let credentialController = new AbortController();
  const captureCredentialContext = (): CredentialContext => ({
    generation: credentialGeneration,
    authGeneration: authStateService.captureGeneration(),
    signal: credentialController.signal,
  });
  const advanceCredentialGeneration = (): CredentialContext => {
    credentialGeneration += 1;
    credentialController.abort();
    for (const flow of pendingFlows.values()) flow.controller.abort();
    credentialController = new AbortController();
    authStateService.advanceGeneration();
    return captureCredentialContext();
  };
  const credentialContextIsCurrent = (
    context: CredentialContext,
  ): boolean =>
    context.generation === credentialGeneration
    && context.authGeneration === authStateService.captureGeneration()
    && !context.signal.aborted;

  // If a profile already exists, notify the caller so the provider can use it
  const onTokenUpdate = _deps?.onAuthTokenUpdate as (
    (token: string | null) => void
  ) | undefined;
  const verifyStoredProfile = async (
    profile: AuthProfile | undefined,
    context: CredentialContext,
  ): Promise<CopilotAuthState> => {
    if (!profile?.token) {
      return authStateService.needsSignIn(
        'COPILOT_SIGN_IN_REQUIRED',
        false,
      );
    }
    authStateService.checking(context.authGeneration);
    try {
      const identity = await resolveGitHubIdentityImpl(
        profile.token,
        undefined,
        context.signal,
      );
      if (!credentialContextIsCurrent(context)) {
        return authStateService.current();
      }
      if (identity.login !== profile.id) {
        throw new CopilotTokenError('exchange-error');
      }
      const state = await authStateService.check(profile.token, identity.login, {
        generation: context.authGeneration,
        signal: context.signal,
      });
      if (state.status === 'ready' && credentialContextIsCurrent(context)) {
        retireLegacyCopies(profile.token);
      }
      return state;
    } catch (error) {
      return credentialContextIsCurrent(context)
        ? authStateService.reportFailure(error, context.authGeneration)
        : authStateService.current();
    }
  };
  const existingProfile = store.get('copilot');
  if (existingProfile?.token) {
    const context = captureCredentialContext();
    void verifyStoredProfile(existingProfile, context)
      .then((state) => {
        if (
          state.status === 'ready'
          && credentialContextIsCurrent(context)
          && store.get('copilot')?.id === existingProfile.id
        ) {
          onTokenUpdate?.(existingProfile.token!);
        } else if (credentialContextIsCurrent(context)) {
          onTokenUpdate?.(null);
        }
      });
  } else if (store.hasPersistedState()) {
    advanceCredentialGeneration();
    authStateService.needsSignIn('COPILOT_SIGN_IN_REQUIRED', false);
    onTokenUpdate?.(null);
  }

  server.registerMethod<void, CopilotAuthState>('auth.status', async () =>
    authStateService.current()
  );

  server.registerMethod<void, CopilotAuthState>('auth.check', async () => {
    const context = captureCredentialContext();
    const profile = store.get('copilot');
    const state = await verifyStoredProfile(profile, context);
    if (
      state.status === 'ready'
      && profile?.token
      && credentialContextIsCurrent(context)
      && store.get('copilot')?.id === profile.id
    ) {
      onTokenUpdate?.(profile.token);
    }
    return state;
  });

  // ── auth.profiles — list all saved profiles ────────────────────────────────
  server.registerMethod<void, ProfileInfo[]>('auth.profiles', async () => {
    const profiles = store.list('copilot');
    return profiles.map((p) => ({
      id: p.id,
      provider: p.provider,
      type: p.type,
      username: p.id, // profile id IS the username
      default: !!p.default,
      createdAt: p.createdAt,
    }));
  });

  // ── auth.active — get the current default profile ─────────────────────────
  server.registerMethod<void, ProfileInfo | null>('auth.active', async () => {
    const profile = store.get('copilot');
    if (!profile) return null;
    return {
      id: profile.id,
      provider: profile.provider,
      type: profile.type,
      username: profile.id,
      default: !!profile.default,
      createdAt: profile.createdAt,
    };
  });

  const createDeviceFlow = (): Promise<LoginFlowDescriptor> => {
    if (pendingFlowCreation) return pendingFlowCreation;
    const creation = (async (): Promise<LoginFlowDescriptor> => {
      const context = advanceCredentialGeneration();
      authStateService.checking(context.authGeneration);
      let device;
      try {
        device = await requestDeviceCodeImpl();
      } catch (error) {
        throw new CopilotAuthUnavailableError(
          authStateService.reportFailure(error, context.authGeneration),
        );
      }
      const expiresAt = Date.now() + device.expires_in * 1000;
      const intervalMs = Math.max(1000, device.interval * 1000);
      const controller = new AbortController();
      const flow: PendingLoginFlow = {
        deviceCode: device.device_code,
        expiresAt,
        intervalMs,
        resolved: false,
        controller,
        userCode: device.user_code,
        verificationUri: device.verification_uri,
      };
      pendingFlows.set(device.device_code, flow);

      void pollForAccessTokenImpl({
        deviceCode: device.device_code,
        intervalMs,
        expiresAt,
        signal: controller.signal,
      })
        .then(async (token) => {
          if (pendingFlows.get(device.device_code) !== flow) return;
          const identity = await resolveGitHubIdentityImpl(
            token,
            undefined,
            context.signal,
          );
          if (
            pendingFlows.get(device.device_code) !== flow
            || !credentialContextIsCurrent(context)
          ) return;
          const state = await authStateService.check(
            token,
            identity.login,
            {
              generation: context.authGeneration,
              signal: context.signal,
            },
          );
          if (
            pendingFlows.get(device.device_code) !== flow
            || !credentialContextIsCurrent(context)
          ) return;
          flow.username = identity.login;
          flow.authState = state;
          flow.resolved = true;

          if (state.status === 'ready') {
            try {
              const replacingActive =
                store.get('copilot')?.id === identity.login;
              if (replacingActive) {
                advanceCredentialGeneration();
                authStateService.needsSignIn(
                  'COPILOT_SIGN_IN_REQUIRED',
                  false,
                );
                onTokenUpdate?.(null);
                store.remove('copilot', identity.login, {
                  promoteReplacement: false,
                });
              }
              const persistedContext = advanceCredentialGeneration();
              authStateService.checking(persistedContext.authGeneration);
              store.add({
                id: identity.login,
                provider: 'copilot',
                type: 'device-code',
                token,
                default: true,
              });
              authStateService.markReady(
                identity.login,
                persistedContext.authGeneration,
              );
              flow.persisted = true;
              flow.authState = authStateService.current();
              onTokenUpdate?.(token);
            } catch (error) {
              flow.authState = authStateService.reportFailure(error);
            }
          } else if (state.status === 'no-entitlement') {
            try {
              if (store.get('copilot', identity.login)) {
                advanceCredentialGeneration();
                store.remove('copilot', identity.login, {
                  promoteReplacement: false,
                });
              }
              advanceCredentialGeneration();
              store.add({
                id: identity.login,
                provider: 'copilot',
                type: 'device-code',
                token,
                default: false,
              }, { autoDefault: false });
              flow.persisted = true;
            } catch (error) {
              flow.authState = authStateService.reportFailure(error);
            }
          }
        })
        .catch((error) => {
          if (pendingFlows.get(device.device_code) !== flow) return;
          flow.authState = credentialContextIsCurrent(context)
            ? authStateService.reportFailure(
              error,
              context.authGeneration,
            )
            : authStateService.current();
          flow.resolved = true;
        });

      return {
        userCode: device.user_code,
        verificationUri: device.verification_uri,
        deviceCode: device.device_code,
      };
    })();
    pendingFlowCreation = creation;
    void creation.finally(() => {
      if (pendingFlowCreation === creation) pendingFlowCreation = undefined;
    }).catch(() => undefined);
    return creation;
  };

  // ── auth.login — start device code flow ────────────────────────────────────
  server.registerMethod<void, LoginFlowDescriptor>(
    'auth.login',
    async () => {
      const activeFlow = Array.from(pendingFlows.values()).find(
        (flow) => !flow.resolved && Date.now() <= flow.expiresAt,
      );
      if (activeFlow) {
        return {
          userCode: activeFlow.userCode,
          verificationUri: activeFlow.verificationUri,
          deviceCode: activeFlow.deviceCode,
        };
      }
      return createDeviceFlow();
    }
  );

  // ── auth.pollLogin — check if a pending login completed ────────────────────
  server.registerMethod<
    { deviceCode: string },
    {
      status: 'pending' | 'success' | 'error';
      username?: string;
      error?: string;
      auth: CopilotAuthState;
    }
  >(
    'auth.poll',
    async (params) => {
      const flow = pendingFlows.get(params.deviceCode);
      if (!flow) {
        const auth = authStateService.current();
        return { status: 'error', error: auth.message, auth };
      }

      if (!flow.resolved) {
        if (Date.now() > flow.expiresAt) {
          pendingFlows.delete(params.deviceCode);
          flow.controller.abort();
          const context = captureCredentialContext();
          const auth = authStateService.reportFailure(
            new Error('Device code expired'),
            context.authGeneration,
          );
          return { status: 'error', error: auth.message, auth };
        }
        return { status: 'pending', auth: authStateService.current() };
      }

      // Flow completed
      pendingFlows.delete(params.deviceCode);

      if (flow.authState?.status !== 'ready') {
        const auth = flow.authState ?? authStateService.current();
        return { status: 'error', error: auth.message, auth };
      }

      // Determine the username that was saved
      return {
        status: 'success',
        username: flow.username ?? 'unknown',
        auth: flow.authState,
      };
    }
  );

  // ── auth.cancel — stop a pending login flow ────────────────────────────────
  server.registerMethod<
    { deviceCode: string },
    { ok: boolean; status: 'cancelled' | 'completed' | 'missing' }
  >(
    'auth.cancel',
    async (params) => {
      const flow = pendingFlows.get(params.deviceCode);
      if (!flow) return { ok: false, status: 'missing' };
      pendingFlows.delete(params.deviceCode);
      if (flow.resolved && flow.persisted) {
        return { ok: false, status: 'completed' };
      }
      flow.controller.abort();
      advanceCredentialGeneration();
      authStateService.needsSignIn('COPILOT_AUTH_CANCELLED', false);
      return { ok: true, status: 'cancelled' };
    }
  );

  // ── auth.switch — set a profile as default ─────────────────────────────────
  server.registerMethod<{ id: string }, { ok: boolean }>(
    'auth.switch',
    async (params) => {
      const profile = store.get('copilot', params.id);
      if (!profile?.token) return { ok: false };
      const context = advanceCredentialGeneration();
      const state = await verifyStoredProfile(profile, context);
      if (
        state.status !== 'ready'
        || !credentialContextIsCurrent(context)
        || !store.get('copilot', profile.id)
      ) return { ok: false };
      const persistedContext = advanceCredentialGeneration();
      authStateService.checking(persistedContext.authGeneration);
      let ok: boolean;
      try {
        ok = store.setDefault('copilot', params.id);
      } catch (error) {
        authStateService.reportFailure(
          error,
          persistedContext.authGeneration,
        );
        throw error;
      }
      if (ok) {
        authStateService.markReady(
          profile.id,
          persistedContext.authGeneration,
        );
        onTokenUpdate?.(profile.token);
      }
      return { ok };
    }
  );

  // ── auth.remove — delete a saved profile ───────────────────────────────────
  server.registerMethod<{ id: string }, { ok: boolean }>(
    'auth.remove',
    async (params) => {
      const activeProfile = store.get('copilot');
      const removingActive = activeProfile?.id === params.id;
      advanceCredentialGeneration();
      if (removingActive) {
        authStateService.needsSignIn(
          'COPILOT_SIGN_IN_REQUIRED',
          false,
        );
        onTokenUpdate?.(null);
      }
      const ok = store.remove('copilot', params.id, {
        promoteReplacement: false,
      });
      if (!ok) return { ok: false };

      if (removingActive) {
        authStateService.needsSignIn('COPILOT_SIGN_IN_REQUIRED', false);
        const replacement = store.list('copilot').find(
          (profile) => typeof profile.token === 'string' && profile.token.length > 0,
        );
        if (!replacement?.token) {
          return { ok: true };
        }

        const context = captureCredentialContext();
        const state = await verifyStoredProfile(replacement, context);
        if (
          state.status === 'ready'
          && credentialContextIsCurrent(context)
          && store.get('copilot', replacement.id)
        ) {
          const persistedContext = advanceCredentialGeneration();
          authStateService.checking(persistedContext.authGeneration);
          try {
            store.setDefault('copilot', replacement.id);
          } catch (error) {
            authStateService.reportFailure(
              error,
              persistedContext.authGeneration,
            );
            throw error;
          }
          authStateService.markReady(
            replacement.id,
            persistedContext.authGeneration,
          );
          onTokenUpdate?.(replacement.token);
        }
      }
      return { ok: true };
    }
  );
}
