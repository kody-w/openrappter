/**
 * Tailscale Integration
 * Remote access via Tailscale Serve/Funnel
 */

import { exec, execSync, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface TailscaleStatus {
  version: string;
  backendState: string;
  selfNodeKey: string;
  selfDNSName: string;
  tailscaleIPs: string[];
  peers: TailscalePeer[];
}

export interface TailscalePeer {
  nodeKey: string;
  dnsName: string;
  hostName: string;
  os: string;
  userID: number;
  tailscaleIPs: string[];
  online: boolean;
  lastSeen?: string;
}

export interface ServeConfig {
  port: number;
  path?: string;
  https?: boolean;
  funnel?: boolean;
}

export class TailscaleClient {
  private cliPath: string;
  private serveProcess: ChildProcess | null = null;
  private funnelProcess: ChildProcess | null = null;

  constructor(cliPath?: string) {
    this.cliPath = cliPath ?? 'tailscale';
  }

  /**
   * Check if Tailscale CLI is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      await execAsync(`${this.cliPath} version`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get Tailscale version
   */
  async getVersion(): Promise<string> {
    const { stdout } = await execAsync(`${this.cliPath} version`);
    return stdout.trim().split('\n')[0];
  }

  /**
   * Get Tailscale status
   */
  async getStatus(): Promise<TailscaleStatus | null> {
    try {
      const { stdout } = await execAsync(`${this.cliPath} status --json`);
      const status = JSON.parse(stdout);

      return {
        version: status.Version,
        backendState: status.BackendState,
        selfNodeKey: status.Self?.NodeKey,
        selfDNSName: status.Self?.DNSName,
        tailscaleIPs: status.Self?.TailscaleIPs ?? [],
        peers: Object.values(status.Peer ?? {}).map((peer: unknown) => {
          const p = peer as Record<string, unknown>;
          return {
            nodeKey: p.NodeKey as string,
            dnsName: p.DNSName as string,
            hostName: p.HostName as string,
            os: p.OS as string,
            userID: p.UserID as number,
            tailscaleIPs: (p.TailscaleIPs as string[]) ?? [],
            online: p.Online as boolean,
            lastSeen: p.LastSeen as string | undefined,
          };
        }),
      };
    } catch {
      return null;
    }
  }

  /**
   * Check if connected to Tailscale network
   */
  async isConnected(): Promise<boolean> {
    const status = await this.getStatus();
    return status?.backendState === 'Running';
  }

  /**
   * Get Tailscale IP addresses
   */
  async getIPs(): Promise<string[]> {
    try {
      const { stdout } = await execAsync(`${this.cliPath} ip`);
      return stdout.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Get Tailscale DNS name
   */
  async getDNSName(): Promise<string | null> {
    const status = await this.getStatus();
    return status?.selfDNSName ?? null;
  }

  /**
   * Start Tailscale Serve (expose local port)
   */
  async startServe(config: ServeConfig): Promise<string> {
    // Stop existing serve
    await this.stopServe();

    const args = ['serve'];

    if (config.https) {
      args.push('--https', String(config.port));
    } else {
      args.push('--http', String(config.port));
    }

    if (config.path) {
      args.push(config.path);
    }

    // Get the serve URL
    const dnsName = await this.getDNSName();
    if (!dnsName) {
      throw new Error('Tailscale not connected');
    }

    const protocol = config.https ? 'https' : 'http';
    const url = `${protocol}://${dnsName.replace(/\.$/, '')}${config.path ?? ''}`;

    // Start serve in background
    this.serveProcess = spawn(this.cliPath, args, {
      stdio: 'ignore',
      detached: true,
    });

    this.serveProcess.unref();

    return url;
  }

  /**
   * Stop Tailscale Serve
   */
  async stopServe(): Promise<void> {
    if (this.serveProcess) {
      this.serveProcess.kill();
      this.serveProcess = null;
    }

    try {
      await execAsync(`${this.cliPath} serve status`);
      await execAsync(`${this.cliPath} serve off`);
    } catch {
      // Serve might not be running
    }
  }

  /**
   * Start Tailscale Funnel (expose to internet)
   */
  async startFunnel(config: ServeConfig): Promise<string> {
    // Stop existing funnel
    await this.stopFunnel();

    const args = ['funnel'];

    args.push('--https', String(config.port));

    if (config.path) {
      args.push(config.path);
    }

    // Get the funnel URL
    const dnsName = await this.getDNSName();
    if (!dnsName) {
      throw new Error('Tailscale not connected');
    }

    // Funnel always uses HTTPS and .ts.net domain
    const hostname = dnsName.replace(/\..*$/, '');
    const url = `https://${hostname}.ts.net${config.path ?? ''}`;

    // Start funnel in background
    this.funnelProcess = spawn(this.cliPath, args, {
      stdio: 'ignore',
      detached: true,
    });

    this.funnelProcess.unref();

    return url;
  }

  /**
   * Stop Tailscale Funnel
   */
  async stopFunnel(): Promise<void> {
    if (this.funnelProcess) {
      this.funnelProcess.kill();
      this.funnelProcess = null;
    }

    try {
      await execAsync(`${this.cliPath} funnel status`);
      await execAsync(`${this.cliPath} funnel off`);
    } catch {
      // Funnel might not be running
    }
  }

  /**
   * Get serve status
   */
  async getServeStatus(): Promise<{ running: boolean; config?: Record<string, unknown> }> {
    try {
      const { stdout } = await execAsync(`${this.cliPath} serve status --json`);
      const config = JSON.parse(stdout);
      return { running: true, config };
    } catch {
      return { running: false };
    }
  }

  /**
   * Get funnel status
   */
  async getFunnelStatus(): Promise<{ running: boolean; url?: string }> {
    try {
      const { stdout } = await execAsync(`${this.cliPath} funnel status --json`);
      const config = JSON.parse(stdout);
      const dnsName = await this.getDNSName();
      const hostname = dnsName?.replace(/\..*$/, '');
      return {
        running: true,
        url: hostname ? `https://${hostname}.ts.net` : undefined,
      };
    } catch {
      return { running: false };
    }
  }

  /**
   * Ping a peer
   */
  async ping(target: string): Promise<{ reachable: boolean; latency?: number }> {
    try {
      const { stdout } = await execAsync(`${this.cliPath} ping --c 1 ${target}`);
      const match = stdout.match(/in ([\d.]+) ?ms/);
      return {
        reachable: true,
        latency: match ? parseFloat(match[1]) : undefined,
      };
    } catch {
      return { reachable: false };
    }
  }

  /**
   * Get online peers
   */
  async getOnlinePeers(): Promise<TailscalePeer[]> {
    const status = await this.getStatus();
    return status?.peers.filter((p) => p.online) ?? [];
  }

  /**
   * Find peer by hostname
   */
  async findPeer(hostname: string): Promise<TailscalePeer | null> {
    const status = await this.getStatus();
    return (
      status?.peers.find(
        (p) =>
          p.hostName.toLowerCase() === hostname.toLowerCase() ||
          p.dnsName.toLowerCase().startsWith(hostname.toLowerCase())
      ) ?? null
    );
  }
}

export function createTailscaleClient(cliPath?: string): TailscaleClient {
  return new TailscaleClient(cliPath);
}
