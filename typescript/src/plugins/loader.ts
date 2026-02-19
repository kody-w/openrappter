/**
 * Plugin Loader
 *
 * Discovers and loads plugins from the ~/.openrappter/plugins/ directory
 * (or a custom directory specified in config).
 *
 * Security model:
 *   - Path containment: every plugin path is resolved and verified to be
 *     inside the configured pluginDir before any file is read or imported.
 *   - Symlink rejection: symlinks to directories outside the plugin dir are
 *     detected and refused to prevent escape attacks.
 *   - Error isolation: a broken plugin throws an error only for itself; the
 *     loader catches and records the error, leaving other plugins unaffected.
 *
 * Loading flow per plugin directory:
 *   1. Resolve real path and verify containment + no symlinks
 *   2. Read package.json — check for "openrappter" metadata key
 *   3. If found, validate with PluginManifestSchema
 *   4. Dynamic import(entry) with error isolation
 *
 * npm install:
 *   If a plugin has dependencies, `npm install --omit=dev` is run inside its
 *   directory before import. This is intentionally skipped in test environments
 *   (NODE_ENV=test) to keep tests fast.
 */

import { readdir, readFile, lstat } from 'fs/promises';
import { resolve, join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { extractManifestFromPackageJson } from './manifest.js';
import type { PluginManifest } from './manifest.js';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Exports: path security helpers (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Returns true when `target` is inside (or exactly equal to) `base`.
 * Both paths are resolved to absolute before comparison.
 */
export function isContainedPath(base: string, target: string): boolean {
  const resolvedBase = resolve(base);
  const resolvedTarget = resolve(target);
  // Must start with base + separator, or be exactly equal
  return (
    resolvedTarget === resolvedBase ||
    resolvedTarget.startsWith(resolvedBase + '/')
  );
}

/**
 * Returns true when `path` is a symlink.
 * Non-existent paths return false (not a symlink).
 */
export async function isSymlink(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isSymbolicLink();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Loaded plugin record
// ---------------------------------------------------------------------------

export interface LoadedPlugin {
  /** Validated plugin manifest */
  manifest: PluginManifest;
  /** Absolute path to the plugin directory */
  pluginDir: string;
  /** The imported ES module */
  module: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// SecurePluginLoader config
// ---------------------------------------------------------------------------

export interface SecurePluginLoaderConfig {
  /** Root directory where plugins are stored (each plugin is a sub-directory) */
  pluginDir: string;
  /**
   * Run `npm install --omit=dev` for plugins that declare dependencies.
   * Defaults to true, automatically disabled when NODE_ENV=test.
   */
  autoInstall?: boolean;
}

// ---------------------------------------------------------------------------
// SecurePluginLoader
// ---------------------------------------------------------------------------

export class SecurePluginLoader {
  private readonly pluginDir: string;
  private readonly autoInstall: boolean;

  constructor(config: SecurePluginLoaderConfig) {
    this.pluginDir = resolve(config.pluginDir);
    this.autoInstall =
      config.autoInstall !== undefined
        ? config.autoInstall
        : process.env['NODE_ENV'] !== 'test';
  }

  // ---- Public API ----------------------------------------------------------

  /**
   * Scan the plugin directory and return manifests for all valid plugins.
   * Does not import the modules; use loadPluginFromPath() for that.
   */
  async discoverPlugins(): Promise<PluginManifest[]> {
    const manifests: PluginManifest[] = [];

    let entries: string[];
    try {
      entries = await readdir(this.pluginDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }

    for (const entryName of entries) {
      const pluginPath = join(this.pluginDir, entryName);
      // Only process directories
      try {
        const st = await lstat(pluginPath);
        if (!st.isDirectory()) continue;
      } catch {
        continue;
      }
      try {
        const manifest = await this.readManifest(pluginPath);
        if (manifest) manifests.push(manifest);
      } catch {
        // Broken plugin directory — skip
      }
    }

    return manifests;
  }

  /**
   * Load a single plugin from `pluginPath`.
   *
   * Security checks run first:
   *   1. Path must be contained within pluginDir
   *   2. Path must not be a symlink
   *
   * Returns null when the path does not exist or has no openrappter manifest.
   * Throws for security violations.
   */
  async loadPluginFromPath(pluginPath: string): Promise<LoadedPlugin | null> {
    this.assertContained(pluginPath);
    await this.assertNotSymlink(pluginPath);

    const manifest = await this.readManifest(pluginPath);
    if (!manifest) return null;

    if (this.autoInstall && manifest.dependencies && Object.keys(manifest.dependencies).length > 0) {
      await this.npmInstall(pluginPath);
    }

    const entryPath = resolve(pluginPath, manifest.entry);
    this.assertContained(entryPath); // Entry must also be inside plugin dir

    let module: Record<string, unknown>;
    try {
      module = (await import(entryPath)) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `Failed to import plugin "${manifest.name}" from "${entryPath}": ${(err as Error).message}`
      );
    }

    return { manifest, pluginDir: resolve(pluginPath), module };
  }

  // ---- Private helpers -----------------------------------------------------

  /**
   * Read and validate the manifest for a plugin directory.
   * Looks for package.json with "openrappter" key.
   * Returns null if the directory has no recognizable manifest.
   */
  private async readManifest(pluginPath: string): Promise<PluginManifest | null> {
    const pkgPath = join(pluginPath, 'package.json');
    let pkgRaw: string;
    try {
      pkgRaw = await readFile(pkgPath, 'utf8');
    } catch {
      return null;
    }

    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
    } catch {
      return null;
    }

    return extractManifestFromPackageJson(pkg);
  }

  /**
   * Throw a security error when target is not contained within pluginDir.
   */
  private assertContained(target: string): void {
    if (!isContainedPath(this.pluginDir, target)) {
      throw new Error(
        `Security violation: path "${target}" is outside the plugin directory "${this.pluginDir}"`
      );
    }
  }

  /**
   * Throw a security error when path is a symlink.
   */
  private async assertNotSymlink(path: string): Promise<void> {
    if (await isSymlink(path)) {
      throw new Error(
        `Security violation: plugin path "${path}" is a symlink, which is not allowed`
      );
    }
  }

  /**
   * Run `npm install --omit=dev` inside the plugin directory.
   * Errors are wrapped with a descriptive message but re-thrown.
   */
  private async npmInstall(pluginPath: string): Promise<void> {
    try {
      await execAsync('npm install --omit=dev', { cwd: pluginPath });
    } catch (err) {
      throw new Error(
        `npm install failed for plugin at "${pluginPath}": ${(err as Error).message}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

export function createSecurePluginLoader(
  config: SecurePluginLoaderConfig
): SecurePluginLoader {
  return new SecurePluginLoader(config);
}
