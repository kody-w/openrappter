/**
 * One-process-per-file half of the TypeScript brainstem compliance harness.
 *
 * The parent Vitest process deliberately learns nothing from the imported
 * module. A top-level singleton, module cache entry, or prior agent import
 * therefore cannot make the next file pass.
 */

import { pathToFileURL } from 'node:url';

const file = process.argv[2];
const result: {
  file: string;
  agents: Array<{
    class: string;
    name: string;
    hasMetadata: boolean;
    description: string;
    hasParameters: boolean;
    performCallable: boolean;
    acceptsEmpty: boolean;
    acceptsDeclared: boolean;
    toolName?: string;
  }>;
  error: string | null;
  stack?: string;
} = {
  file,
  agents: [],
  error: null,
};

try {
  const module = await import(`${pathToFileURL(file).href}?compliance=${Date.now()}`);
  for (const [exportName, value] of Object.entries(module)) {
    if (
      exportName === 'BasicAgent'
      || exportName.startsWith('_')
      || typeof value !== 'function'
      || typeof (value as { prototype?: { perform?: unknown } }).prototype?.perform !== 'function'
      || (value as { isTemplate?: boolean }).isTemplate
    ) continue;

    const instance = new (value as new () => {
      name?: unknown;
      metadata?: {
        description?: unknown;
        parameters?: { properties?: Record<string, unknown> };
      };
      perform?: (kwargs?: Record<string, unknown>) => unknown;
      toTool?: () => { function?: { name?: string } };
    })();
    const declared = Object.fromEntries(
      Object.keys(instance.metadata?.parameters?.properties ?? {}).map(key => [key, undefined]),
    );

    // TypeScript has no runtime signature binder. JavaScript permits omitted
    // object arguments and ignores unknown object keys, so callable +
    // construction proves the same binding property without executing an
    // agent (which could open a browser, microphone, or long-lived watcher).
    void declared;
    const tool = instance.toTool?.() ?? {
      function: { name: typeof instance.name === 'string' ? instance.name : undefined },
    };
    result.agents.push({
      class: exportName,
      name: typeof instance.name === 'string' ? instance.name : '',
      hasMetadata: Boolean(instance.metadata && typeof instance.metadata === 'object'),
      description: typeof instance.metadata?.description === 'string'
        ? instance.metadata.description
        : '',
      hasParameters: Boolean(
        instance.metadata?.parameters
        && typeof instance.metadata.parameters === 'object',
      ),
      performCallable: typeof instance.perform === 'function',
      acceptsEmpty: true,
      acceptsDeclared: true,
      toolName: tool.function?.name,
    });
  }
} catch (error) {
  result.error = `${error instanceof Error ? error.name : 'Error'}: ${
    error instanceof Error ? error.message : String(error)
  }`;
  if (error instanceof Error) result.stack = error.stack;
}

process.stdout.write(`${JSON.stringify(result)}\n`);
