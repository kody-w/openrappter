/**
 * Plugin Manifest
 *
 * Zod schema for plugin manifests. A manifest describes what a plugin
 * provides and how to load it. It can come from either a manifest.json
 * file or the "openrappter" key inside a plugin's package.json.
 *
 * Fields:
 *   name         - Unique plugin identifier (npm-style, kebab-case)
 *   version      - Semver string (major.minor.patch)
 *   description  - Human-readable description
 *   author       - Author name or contact
 *   entry        - Main entry point file (relative to plugin root)
 *   capabilities - Which extension points this plugin provides
 *   dependencies - npm dependency map { "pkg": "^version" }
 *   configSchema - JSON-Schema-style config declaration for user settings
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Config schema property types
// ---------------------------------------------------------------------------

const ConfigPropertySchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'array', 'object']),
  description: z.string().optional(),
  default: z.unknown().optional(),
  enum: z.array(z.unknown()).optional(),
});

const ConfigSchemaSchema = z.object({
  type: z.literal('object'),
  properties: z.record(z.string(), ConfigPropertySchema),
  required: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Capabilities — which extension points this plugin declares
// ---------------------------------------------------------------------------

const CapabilitiesSchema = z.object({
  /** Plugin adds one or more messaging channels */
  channels: z.boolean().optional(),
  /** Plugin adds a custom memory backend */
  memory: z.boolean().optional(),
  /** Plugin adds agent tools */
  tools: z.boolean().optional(),
  /** Plugin registers lifecycle hooks */
  hooks: z.boolean().optional(),
  /** Plugin adds HTTP route handlers */
  routes: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Semver regex — major.minor.patch (with optional pre-release / build meta)
// ---------------------------------------------------------------------------

const SEMVER_RE =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

// ---------------------------------------------------------------------------
// Main manifest schema
// ---------------------------------------------------------------------------

export const PluginManifestSchema = z.object({
  /** Unique plugin name, e.g. "openrappter-my-plugin" */
  name: z.string().min(1),

  /** Semver version string */
  version: z.string().regex(SEMVER_RE, {
    message: 'version must be a valid semver string (e.g. 1.0.0)',
  }),

  /** Short human-readable description */
  description: z.string().optional(),

  /** Author name / email */
  author: z.string().optional(),

  /** Path to main entry file, relative to plugin root */
  entry: z.string().min(1),

  /** Which extension points this plugin registers */
  capabilities: CapabilitiesSchema.default({}),

  /** npm dependency map — installed automatically before loading */
  dependencies: z.record(z.string(), z.string()).optional(),

  /** Declarative config schema used to validate user-provided config */
  configSchema: ConfigSchemaSchema.optional(),
});

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type PluginCapabilities = z.infer<typeof CapabilitiesSchema>;
export type PluginConfigSchema = z.infer<typeof ConfigSchemaSchema>;
export type PluginConfigProperty = z.infer<typeof ConfigPropertySchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to extract a PluginManifest from a parsed package.json object.
 *
 * Looks for an "openrappter" metadata key inside package.json. This lets
 * plugin authors ship everything in their normal package.json without a
 * separate manifest.json file.
 *
 * Returns null if the package.json has no "openrappter" key or if the
 * resulting manifest does not pass schema validation.
 *
 * @example
 * // package.json
 * {
 *   "name": "my-plugin",
 *   "version": "1.2.3",
 *   "openrappter": {
 *     "entry": "dist/index.js",
 *     "description": "Adds Redis memory backend",
 *     "capabilities": { "memory": true }
 *   }
 * }
 */
export function extractManifestFromPackageJson(
  pkg: Record<string, unknown>
): PluginManifest | null {
  const openrappterKey = pkg['openrappter'];
  if (!openrappterKey || typeof openrappterKey !== 'object') {
    return null;
  }

  const candidate = {
    name: pkg['name'],
    version: pkg['version'],
    ...(openrappterKey as Record<string, unknown>),
  };

  const result = PluginManifestSchema.safeParse(candidate);
  return result.success ? result.data : null;
}

/**
 * Parse and validate a raw manifest object. Throws a ZodError on failure.
 */
export function parseManifest(raw: unknown): PluginManifest {
  return PluginManifestSchema.parse(raw);
}

/**
 * Safely parse a raw manifest object. Returns a discriminated union.
 */
export function safeParseManifest(
  raw: unknown
): { success: true; data: PluginManifest } | { success: false; error: z.ZodError } {
  const result = PluginManifestSchema.safeParse(raw);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
