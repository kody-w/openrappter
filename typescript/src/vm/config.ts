import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { VmError } from './types.js';

export const VM_CONFIG_FILE = path.join('vm', 'omarchy.json');
export const GUEST_WORKSPACE_ROOT = '/workspaces';
export const vmIdentitySchema = z.strictObject({
  agentId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  workspaceId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
});

const absoluteFile = z.string().min(2).max(1024).refine(
  (value) => path.posix.isAbsolute(value)
    && path.posix.normalize(value) === value
    && !/[\x00-\x1f\x7f%~\\]/.test(value)
    && !value.endsWith('/'),
  'Expected a normalized absolute path without control characters or SSH expansion tokens',
);

export const omarchyVmConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/).default('rapp-work-omarchy'),
  tartBinary: absoluteFile.refine((value) => path.posix.basename(value) === 'tart')
    .default('/opt/homebrew/bin/tart'),
  image: z.strictObject({
    reference: z.string().max(512).regex(
      /^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/[a-z0-9][a-z0-9/_.-]*:[a-zA-Z0-9][a-zA-Z0-9_.-]*$/,
    ),
    version: z.string().max(64).regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][a-zA-Z0-9]+)*$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).refine((image) => image.reference.endsWith(`:${image.version}`), {
    message: 'The image reference tag must match its explicit version',
  }),
  ssh: z.strictObject({
    user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).refine((user) => user !== 'root'),
    identityFile: absoluteFile,
    knownHostsFile: absoluteFile,
  }),
  workspaces: z.array(vmIdentitySchema).max(1024).default([]).refine(
    (items) => new Set(items.map((item) => `${item.agentId}/${item.workspaceId}`)).size === items.length,
    'Workspace registrations must be unique',
  ),
  allowedExecutables: z.array(z.string().regex(/^\/(?:usr\/(?:local\/)?)?bin\/[a-zA-Z0-9][a-zA-Z0-9._+-]*$/))
    .min(1).max(64).default(['/usr/bin/pwd', '/usr/bin/ls', '/usr/bin/git']),
  readyTimeoutMs: z.number().int().min(100).max(120_000).default(60_000),
  commandTimeoutMs: z.number().int().min(100).max(30_000).default(10_000),
  execTimeoutMs: z.number().int().min(100).max(300_000).default(60_000),
  pollIntervalMs: z.number().int().min(10).max(5_000).default(500),
});

export type OmarchyVmConfig = z.infer<typeof omarchyVmConfigSchema>;

export function parseOmarchyVmConfig(input: unknown): OmarchyVmConfig {
  const parsed = omarchyVmConfigSchema.safeParse(input);
  if (!parsed.success) {
    // Never echo key paths, registry names, or untrusted input through an RPC error.
    throw new VmError('invalid_configuration', 'Invalid host Omarchy VM configuration; check the first-run guide.');
  }
  return parsed.data;
}

export function loadOmarchyVmConfig(dataDir: string): OmarchyVmConfig | undefined {
  const file = path.join(dataDir, VM_CONFIG_FILE);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024
      || (process.platform !== 'win32' && ((stat.mode & 0o022) !== 0 || stat.uid !== process.getuid?.()))) {
      throw new VmError('invalid_configuration', 'The VM configuration must be a small, owner-controlled regular file.');
    }
    return parseOmarchyVmConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof VmError) throw error;
    throw new VmError('invalid_configuration', 'Could not read the host Omarchy VM configuration.');
  }
}
