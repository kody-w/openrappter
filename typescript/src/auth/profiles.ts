import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { openrappterHome } from '../infra/openrappter-home.js';

export interface AuthProfile {
  id: string;
  provider: string;
  type: 'api-key' | 'oauth' | 'device-code';
  token?: string;
  refreshToken?: string;
  expiresAt?: number;
  default?: boolean;
  model?: string;
  previousModel?: string;
  modelUpdatedAt?: string;
  createdAt: string;
}

export interface AuthProfileStoreFs {
  chmodSync: typeof fs.chmodSync;
  closeSync: typeof fs.closeSync;
  existsSync: typeof fs.existsSync;
  fsyncSync: typeof fs.fsyncSync;
  mkdirSync: typeof fs.mkdirSync;
  openSync: typeof fs.openSync;
  readFileSync: typeof fs.readFileSync;
  renameSync: typeof fs.renameSync;
  statSync: typeof fs.statSync;
  unlinkSync: typeof fs.unlinkSync;
  writeFileSync: typeof fs.writeFileSync;
}

export class AuthProfileStore {
  private readonly profilesPath: string;
  private profiles: AuthProfile[] = [];

  constructor(
    configDir = openrappterHome(),
    private readonly io: AuthProfileStoreFs = fs,
  ) {
    this.profilesPath = path.join(configDir, 'auth-profiles.json');
    this.ensureConfigDir();
    this.load();
  }

  add(
    profile: Omit<AuthProfile, 'createdAt'>,
    options: { autoDefault?: boolean } = {},
  ): AuthProfile {
    const newProfile: AuthProfile = {
      ...profile,
      createdAt: new Date().toISOString(),
    };
    const next = this.snapshot();
    if (newProfile.default) {
      next.forEach((candidate) => {
        if (candidate.provider === newProfile.provider) {
          candidate.default = false;
        }
      });
    }
    if (
      !next.some((candidate) => candidate.provider === newProfile.provider)
      && options.autoDefault !== false
    ) {
      newProfile.default = true;
    }
    next.push(newProfile);
    this.commit(next);
    return { ...newProfile };
  }

  get(provider: string, id?: string): AuthProfile | undefined {
    const profile = id
      ? this.profiles.find((candidate) =>
        candidate.provider === provider && candidate.id === id
      )
      : this.profiles.find((candidate) =>
        candidate.provider === provider && candidate.default
      );
    return profile ? { ...profile } : undefined;
  }

  list(provider?: string): AuthProfile[] {
    return this.profiles
      .filter((profile) => !provider || profile.provider === provider)
      .map((profile) => ({ ...profile }));
  }

  hasPersistedState(): boolean {
    return this.io.existsSync(this.profilesPath);
  }

  setDefault(provider: string, id: string): boolean {
    const next = this.snapshot();
    const profile = next.find((candidate) =>
      candidate.provider === provider && candidate.id === id
    );
    if (!profile) return false;
    next.forEach((candidate) => {
      if (candidate.provider === provider) candidate.default = false;
    });
    profile.default = true;
    this.commit(next);
    return true;
  }

  updateModel(
    provider: string,
    id: string,
    model: string,
    previousModel?: string,
  ): boolean {
    const next = this.snapshot();
    const profile = next.find((candidate) =>
      candidate.provider === provider && candidate.id === id
    );
    if (!profile) return false;
    profile.previousModel = profile.model ?? previousModel;
    profile.model = model;
    profile.modelUpdatedAt = new Date().toISOString();
    this.commit(next);
    return true;
  }

  remove(
    provider: string,
    id: string,
    options: { promoteReplacement?: boolean } = {},
  ): boolean {
    const next = this.snapshot();
    const index = next.findIndex((profile) =>
      profile.provider === provider && profile.id === id
    );
    if (index === -1) return false;
    const wasDefault = next[index].default;
    next.splice(index, 1);
    if (wasDefault && options.promoteReplacement !== false) {
      const replacement = next.find((profile) => profile.provider === provider);
      if (replacement) replacement.default = true;
    }
    this.commit(next);
    return true;
  }

  private snapshot(): AuthProfile[] {
    return this.profiles.map((profile) => ({ ...profile }));
  }

  private ensureConfigDir(): void {
    const configDir = path.dirname(this.profilesPath);
    if (!this.io.existsSync(configDir)) {
      this.io.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }
  }

  private load(): void {
    if (!this.io.existsSync(this.profilesPath)) {
      this.profiles = [];
      return;
    }
    const data = this.io.readFileSync(this.profilesPath, 'utf-8');
    const parsed = JSON.parse(data) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('Auth profile store is invalid.');
    }
    this.profiles = parsed as AuthProfile[];
    this.secureExistingFile();
  }

  private commit(next: AuthProfile[]): void {
    const content = `${JSON.stringify(next, null, 2)}\n`;
    this.atomicDurableWrite(content);
    this.profiles = next;
  }

  private atomicDurableWrite(content: string): void {
    const directory = path.dirname(this.profilesPath);
    const temporary =
      `${this.profilesPath}.${process.pid}.${randomUUID()}.tmp`;
    const previous = this.io.existsSync(this.profilesPath)
      ? this.io.readFileSync(this.profilesPath)
      : undefined;
    let renamed = false;
    try {
      this.writeAndSync(temporary, content);
      this.io.renameSync(temporary, this.profilesPath);
      renamed = true;
      this.syncParent(directory);
      this.io.chmodSync(this.profilesPath, 0o600);
    } catch (cause) {
      try {
        if (this.io.existsSync(temporary)) this.io.unlinkSync(temporary);
      } catch {
        // The original error remains authoritative.
      }
      if (renamed) {
        let rollback: string | undefined;
        try {
          if (previous === undefined) {
            if (this.io.existsSync(this.profilesPath)) {
              this.io.unlinkSync(this.profilesPath);
            }
            this.syncParent(directory);
          } else {
            rollback =
              `${this.profilesPath}.${process.pid}.${randomUUID()}.rollback`;
            this.writeAndSync(rollback, previous);
            this.io.renameSync(rollback, this.profilesPath);
            this.syncParent(directory);
          }
        } catch {
          // The write still fails closed and the caller receives an error.
        } finally {
          try {
            if (rollback && this.io.existsSync(rollback)) {
              this.io.unlinkSync(rollback);
            }
          } catch {
            // The original write failure remains authoritative.
          }
        }
      }
      throw new Error('Auth profile store write failed.', { cause });
    }
  }

  private writeAndSync(
    target: string,
    content: string | Uint8Array,
  ): void {
    const descriptor = this.io.openSync(target, 'wx', 0o600);
    try {
      this.io.writeFileSync(descriptor, content);
      this.io.fsyncSync(descriptor);
    } finally {
      this.io.closeSync(descriptor);
    }
  }

  private syncParent(directory: string): void {
    if (process.platform === 'win32') return;
    const descriptor = this.io.openSync(directory, 'r');
    try {
      this.io.fsyncSync(descriptor);
    } finally {
      this.io.closeSync(descriptor);
    }
  }

  private secureExistingFile(): void {
    const mode = this.io.statSync(this.profilesPath).mode & 0o777;
    if (mode !== 0o600) this.io.chmodSync(this.profilesPath, 0o600);
  }
}
