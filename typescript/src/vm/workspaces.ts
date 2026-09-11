import fs from 'node:fs/promises';
import path from 'node:path';
import { GUEST_WORKSPACE_ROOT, vmIdentitySchema } from './config.js';
import { VmError, type VmWorkspace, type VmWorkspaceIdentity, type VmWorkspaces } from './types.js';
import type { RappFrame } from '../rapp/frame.js';
import { VmRappEvidence, vmDataHash, vmFrameReference } from './rapp-evidence.js';

export function guestWorkspacePath(identity: VmWorkspaceIdentity): string {
  const parsed = vmIdentitySchema.safeParse(identity);
  if (!parsed.success) throw new VmError('invalid_request', 'Invalid agent/workspace identity.');
  return `${GUEST_WORKSPACE_ROOT}/${parsed.data.agentId}/${parsed.data.workspaceId}`;
}

/** Separate host workspaces; this foundation deliberately does not mount them. */
export class HostVmWorkspaces implements VmWorkspaces {
  private readonly registrations: Set<string>;
  private readonly root: string;

  constructor(
    dataDir: string,
    identities: readonly VmWorkspaceIdentity[],
    private readonly evidence = new VmRappEvidence(),
    private readonly vmName = 'rapp-work-omarchy',
  ) {
    this.root = path.resolve(dataDir, 'workspaces');
    this.registrations = new Set(identities.map((identity) => guestWorkspacePath(identity)));
  }

  async resolve(identity: VmWorkspaceIdentity, cause?: RappFrame): Promise<VmWorkspace> {
    const guestPath = guestWorkspacePath(identity);
    if (!this.registrations.has(guestPath)) {
      throw new VmError('workspace_denied', 'This agent/workspace pair is not registered by the host.');
    }
    const hostPath = path.join(this.root, identity.agentId, identity.workspaceId);
    const requested = await this.evidence.record(this.vmName, 'workspace.requested', {
      agent_id: identity.agentId, workspace_id: identity.workspaceId, guest_path: guestPath,
      cause: cause ? vmFrameReference(cause) : null,
    });
    try {
      await this.ensureDirectories(hostPath);
      const workspace = { ...identity, hostPath, guestPath };
      await this.evidence.record(this.vmName, 'workspace.resolved', {
        agent_id: identity.agentId, workspace_id: identity.workspaceId, guest_path: guestPath,
        host_path_hash: vmDataHash({ hostPath }), request_frame: vmFrameReference(requested),
      });
      return workspace;
    } catch (error) {
      if (this.evidence.healthy) {
        await this.evidence.record(this.vmName, 'workspace.failed', {
          request_frame: vmFrameReference(requested),
          error_code: error instanceof VmError ? error.code : 'workspace_io_failed',
        });
      }
      throw error;
    }
  }

  private async ensureDirectories(hostPath: string): Promise<void> {
    // Check each level before descending: mkdir({recursive:true}) alone would
    // follow a workspace symlink into some other host directory.
    await fs.mkdir(path.dirname(this.root), { recursive: true, mode: 0o700 });
    const parent = await fs.realpath(path.dirname(this.root));
    if (parent !== path.dirname(this.root)) {
      throw new VmError('workspace_denied', 'The host workspace parent must not be symlinked.');
    }
    for (const directory of [this.root, path.dirname(hostPath), hostPath]) {
      try {
        await fs.mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) {
        throw new VmError('workspace_denied', 'Host workspace directories must not be symlinked.');
      }
    }
  }
}
