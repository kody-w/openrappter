import {
  EstateBuddyClient,
  type EstateBuddyChatInput,
  type EstateBuddyCreateInput,
} from "../estate-buddy-client.js";
import type {
  EstateBuddyEvidenceDraft,
  EstateBuddyEvidenceInput,
} from "../estate-buddy-evidence-types.js";

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean },
  ): void;
}

interface EstateBuddyMethodsOptions {
  client?: EstateBuddyClient;
  analyzer?: (
    input: EstateBuddyEvidenceInput,
  ) => Promise<EstateBuddyEvidenceDraft>;
}

export function registerEstateBuddyMethods(
  server: MethodRegistrar,
  options: EstateBuddyMethodsOptions = {},
): void {
  const client = options.client ?? new EstateBuddyClient();
  const analyzer = options.analyzer;

  server.registerMethod("estate.buddies.list", async () => client.list(), {
    requiresAuth: true,
  });
  server.registerMethod<
    EstateBuddyChatInput,
    Awaited<ReturnType<EstateBuddyClient["chat"]>>
  >("estate.buddies.chat", async (params) => client.chat(params), {
    requiresAuth: true,
  });
  server.registerMethod<
    EstateBuddyCreateInput,
    Awaited<ReturnType<EstateBuddyClient["create"]>>
  >("estate.buddies.create", async (params) => client.create(params), {
    requiresAuth: true,
  });
  server.registerMethod<EstateBuddyEvidenceInput, EstateBuddyEvidenceDraft>(
    "estate.buddies.analyze",
    async (params) => {
      if (!analyzer) {
        throw new Error("Estate buddy evidence analysis is not configured");
      }
      return analyzer(params);
    },
    { requiresAuth: true },
  );
}
