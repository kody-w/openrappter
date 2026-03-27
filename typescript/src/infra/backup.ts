/**
 * Backup & Restore — protects ~/.openrappter/ user data before updates.
 *
 * Before an update, `createBackup()` snapshots everything important into
 * ~/.openrappter/backups/<timestamp>/. If the update breaks something,
 * `restoreBackup()` copies it all back. Keeps the last N backups and
 * prunes older ones automatically.
 *
 * Files that are NOT backed up: gateway.pid, daemon.log, node_modules/,
 * .build/, dist/ — transient runtime artifacts.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const HOME_DIR = path.join(os.homedir(), '.openrappter');
const BACKUPS_DIR = path.join(HOME_DIR, 'backups');
const MAX_BACKUPS = 5;

// Directories and files to skip (transient / large / regenerable)
const SKIP_NAMES = new Set([
  'backups',
  'node_modules',
  '.build',
  'dist',
  'gateway.pid',
  'daemon.log',
]);

export interface BackupInfo {
  id: string;
  path: string;
  createdAt: string;
  sizeBytes: number;
  fileCount: number;
}

export interface BackupManifest {
  version: string;
  createdAt: string;
  hostname: string;
  files: string[];
  reason?: string;
}

/**
 * Create a timestamped backup of ~/.openrappter/.
 * Returns metadata about the created backup.
 */
export function createBackup(reason?: string): BackupInfo {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });

  const now = new Date();
  const id = now.toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUPS_DIR, id);
  fs.mkdirSync(backupPath, { recursive: true });

  const files: string[] = [];
  let totalSize = 0;

  // Recursively copy files
  function copyDir(src: string, dest: string, relPath: string): void {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name)) continue;

      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      const rel = path.join(relPath, entry.name);

      if (entry.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        copyDir(srcPath, destPath, rel);
      } else if (entry.isFile()) {
        fs.copyFileSync(srcPath, destPath);
        const stat = fs.statSync(srcPath);
        totalSize += stat.size;
        files.push(rel);
      }
    }
  }

  copyDir(HOME_DIR, backupPath, '');

  // Write manifest
  const manifest: BackupManifest = {
    version: '1.0',
    createdAt: now.toISOString(),
    hostname: os.hostname(),
    files,
  };
  if (reason) manifest.reason = reason;
  fs.writeFileSync(
    path.join(backupPath, '.backup-manifest.json'),
    JSON.stringify(manifest, null, 2),
  );

  // Prune old backups
  pruneBackups();

  return {
    id,
    path: backupPath,
    createdAt: now.toISOString(),
    sizeBytes: totalSize,
    fileCount: files.length,
  };
}

/**
 * Restore a backup by ID (or latest if no ID given).
 * Copies files back into ~/.openrappter/, overwriting current versions.
 * Does NOT delete files that weren't in the backup.
 */
export function restoreBackup(backupId?: string): BackupInfo {
  const backups = listBackups();
  if (backups.length === 0) {
    throw new Error('No backups found in ~/.openrappter/backups/');
  }

  const target = backupId
    ? backups.find((b) => b.id === backupId)
    : backups[0]; // most recent

  if (!target) {
    throw new Error(`Backup not found: ${backupId}`);
  }

  const manifestPath = path.join(target.path, '.backup-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Backup ${target.id} is missing its manifest`);
  }

  const manifest: BackupManifest = JSON.parse(
    fs.readFileSync(manifestPath, 'utf-8'),
  );

  let restored = 0;
  for (const relFile of manifest.files) {
    const src = path.join(target.path, relFile);
    const dest = path.join(HOME_DIR, relFile);
    if (!fs.existsSync(src)) continue;

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    restored++;
  }

  return {
    id: target.id,
    path: target.path,
    createdAt: target.createdAt,
    sizeBytes: target.sizeBytes,
    fileCount: restored,
  };
}

/**
 * List all available backups, most recent first.
 */
export function listBackups(): BackupInfo[] {
  if (!fs.existsSync(BACKUPS_DIR)) return [];

  const entries = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true });
  const backups: BackupInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const backupPath = path.join(BACKUPS_DIR, entry.name);
    const manifestPath = path.join(backupPath, '.backup-manifest.json');

    let createdAt = '';
    let fileCount = 0;
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest: BackupManifest = JSON.parse(
          fs.readFileSync(manifestPath, 'utf-8'),
        );
        createdAt = manifest.createdAt;
        fileCount = manifest.files.length;
      } catch { /* skip corrupt manifests */ }
    }

    // Calculate size
    let size = 0;
    function sumDir(dir: string): void {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, f.name);
        if (f.isFile()) size += fs.statSync(fp).size;
        else if (f.isDirectory()) sumDir(fp);
      }
    }
    sumDir(backupPath);

    backups.push({
      id: entry.name,
      path: backupPath,
      createdAt: createdAt || entry.name,
      sizeBytes: size,
      fileCount,
    });
  }

  // Most recent first
  backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return backups;
}

/**
 * Delete a specific backup by ID.
 */
export function deleteBackup(backupId: string): boolean {
  const backupPath = path.join(BACKUPS_DIR, backupId);
  if (!fs.existsSync(backupPath)) return false;
  fs.rmSync(backupPath, { recursive: true, force: true });
  return true;
}

/** Keep only the most recent MAX_BACKUPS. */
function pruneBackups(): void {
  const backups = listBackups();
  if (backups.length <= MAX_BACKUPS) return;

  for (const old of backups.slice(MAX_BACKUPS)) {
    deleteBackup(old.id);
  }
}
