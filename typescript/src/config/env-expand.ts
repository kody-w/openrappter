/**
 * Environment variable expansion with defaults
 */

export function expandEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)(?::-(.*?))?\}/g, (_, key, defaultVal) => {
    return process.env[key] ?? defaultVal ?? '';
  });
}

export function expandEnvDeep(obj: unknown): unknown {
  if (typeof obj === 'string') return expandEnvVars(obj);
  if (Array.isArray(obj)) return obj.map(expandEnvDeep);
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = expandEnvDeep(val);
    }
    return result;
  }
  return obj;
}
