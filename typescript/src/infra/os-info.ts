import { platform, arch, hostname, cpus, totalmem, uptime } from 'os';

export interface SystemInfo {
  platform: string;
  arch: string;
  nodeVersion: string;
  hostname: string;
  cpus: number;
  memoryMb: number;
  uptime: number;
}

export function getSystemInfo(): SystemInfo {
  return {
    platform: platform(),
    arch: arch(),
    nodeVersion: process.version,
    hostname: hostname(),
    cpus: cpus().length,
    memoryMb: Math.round(totalmem() / 1024 / 1024),
    uptime: uptime(),
  };
}
