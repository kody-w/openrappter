/**
 * Skills management RPC methods
 */

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
}

interface SkillRegistry {
  install(name: string, source?: string): Promise<{
    name: string;
    version: string;
    installed: boolean;
  }>;
  update(names?: string[]): Promise<
    Array<{
      name: string;
      oldVersion: string;
      newVersion: string;
      updated: boolean;
    }>
  >;
  list(): Array<{
    name: string;
    version: string;
    enabled: boolean;
    source: string;
  }>;
}

interface SkillsMethodsDeps {
  skillRegistry?: SkillRegistry;
}

export function registerSkillsMethods(
  server: MethodRegistrar,
  deps?: SkillsMethodsDeps
): void {
  server.registerMethod<
    { name: string; source?: string },
    { name: string; version: string; installed: boolean }
  >('skills.install', async (params) => {
    const registry = deps?.skillRegistry;

    if (!registry) {
      throw new Error('Skill registry not available');
    }

    return registry.install(params.name, params.source);
  });

  server.registerMethod<
    { names?: string[] },
    {
      updates: Array<{
        name: string;
        oldVersion: string;
        newVersion: string;
        updated: boolean;
      }>;
    }
  >('skills.update', async (params) => {
    const registry = deps?.skillRegistry;

    if (!registry) {
      throw new Error('Skill registry not available');
    }

    const updates = await registry.update(params.names);

    return { updates };
  });
}
