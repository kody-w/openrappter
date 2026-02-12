/**
 * RFC 7396 JSON Merge Patch implementation
 */

export function mergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return patch;
  }
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    target = {};
  }
  const result = { ...(target as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null) {
      delete result[key];
    } else {
      result[key] = mergePatch(result[key], value);
    }
  }
  return result;
}
