import {
  EstateBuddyClient,
  type EstateBuddyChatInput,
  type EstateBuddyCreateInput,
} from "../estate-buddy-client.js";

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean },
  ): void;
}

interface EstateBuddyMethodsOptions {
  client?: EstateBuddyClient;
}

export function registerEstateBuddyMethods(
  server: MethodRegistrar,
  options: EstateBuddyMethodsOptions = {},
): void {
  const client = options.client ?? new EstateBuddyClient();

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
}
