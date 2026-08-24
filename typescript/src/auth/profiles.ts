import { openrappterHome } from '../infra/openrappter-home.js';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface AuthProfile {
  id: string;
  provider: string;
  type: 'api-key' | 'oauth' | 'device-code';
  token?: string;
  refreshToken?: string;
  expiresAt?: number;
  default?: boolean;
  createdAt: string;
}

export class AuthProfileStore {
  private profilesPath: string;
  private profiles: AuthProfile[] = [];

  constructor(configDir = openrappterHome()) {
    this.profilesPath = path.join(configDir, 'auth-profiles.json');
    this.ensureConfigDir();
    this.load();
  }

  private ensureConfigDir(): void {
    const configDir = path.dirname(this.profilesPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }
  }

  add(
    profile: Omit<AuthProfile, 'createdAt'>,
    options: { autoDefault?: boolean } = {},
  ): AuthProfile {
    const newProfile: AuthProfile = {
      ...profile,
      createdAt: new Date().toISOString(),
    };

    // If this is marked as default, unset other defaults for this provider
    if (newProfile.default) {
      this.profiles.forEach((p) => {
        if (p.provider === newProfile.provider) {
          p.default = false;
        }
      });
    }

    // If this is the first profile for this provider, make it default
    const existingForProvider = this.profiles.filter(
      (p) => p.provider === newProfile.provider
    );
    if (existingForProvider.length === 0 && options.autoDefault !== false) {
      newProfile.default = true;
    }

    this.profiles.push(newProfile);
    this.save();
    return newProfile;
  }

  get(provider: string, id?: string): AuthProfile | undefined {
    if (id) {
      return this.profiles.find((p) => p.provider === provider && p.id === id);
    }
    // Return default profile for provider
    return this.profiles.find((p) => p.provider === provider && p.default);
  }

  list(provider?: string): AuthProfile[] {
    if (provider) {
      return this.profiles.filter((p) => p.provider === provider);
    }

    return [...this.profiles];
  }

  hasPersistedState(): boolean {
    return fs.existsSync(this.profilesPath);
  }

  setDefault(provider: string, id: string): boolean {
    const profile = this.profiles.find(
      (p) => p.provider === provider && p.id === id
    );
    if (!profile) {
      return false;
    }

    // Unset all defaults for this provider
    this.profiles.forEach((p) => {
      if (p.provider === provider) {
        p.default = false;
      }
    });

    // Set new default
    profile.default = true;
    this.save();
    return true;
  }

  remove(
    provider: string,
    id: string,
    options: { promoteReplacement?: boolean } = {},
  ): boolean {
    const index = this.profiles.findIndex(
      (p) => p.provider === provider && p.id === id
    );
    if (index === -1) {
      return false;
    }

    const wasDefault = this.profiles[index].default;
    this.profiles.splice(index, 1);

    // If we removed the default, make the first remaining profile default
    if (wasDefault && options.promoteReplacement !== false) {
      const remaining = this.profiles.filter((p) => p.provider === provider);
      if (remaining.length > 0) {
        remaining[0].default = true;
      }
    }

    this.save();
    return true;
  }

  load(): void {
    try {
      if (fs.existsSync(this.profilesPath)) {
        const data = fs.readFileSync(this.profilesPath, 'utf-8');
        this.profiles = JSON.parse(data);
      } else {
        this.profiles = [];
      }
    } catch (error) {
      console.error('Failed to load auth profiles:', error);
      this.profiles = [];
    }
    this.secureExistingFile();
  }

  save(): void {
    const temporary = `${this.profilesPath}.${process.pid}.${randomUUID()}.tmp`;
    const backup = `${this.profilesPath}.${process.pid}.${randomUUID()}.bak`;
    try {
      fs.writeFileSync(
        temporary,
        JSON.stringify(this.profiles, null, 2),
        { encoding: 'utf-8', mode: 0o600 }
      );
      fs.chmodSync(temporary, 0o600);
      if (process.platform === 'win32' && fs.existsSync(this.profilesPath)) {
        fs.renameSync(this.profilesPath, backup);
        try {
          fs.renameSync(temporary, this.profilesPath);
          fs.unlinkSync(backup);
        } catch (error) {
          try {
            if (fs.existsSync(this.profilesPath)) {
              fs.unlinkSync(this.profilesPath);
            }
          } catch {
            // Restoration below will surface if the destination remains.
          }
          fs.renameSync(backup, this.profilesPath);
          throw error;
        }
      } else {
        fs.renameSync(temporary, this.profilesPath);
      }
      fs.chmodSync(this.profilesPath, 0o600);
    } catch (error) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // The temporary file may not have been created.
      }
      try {
        if (
          fs.existsSync(backup)
          && !fs.existsSync(this.profilesPath)
        ) fs.renameSync(backup, this.profilesPath);
      } catch {
        // The original store is already intact or cannot be restored here.
      }
      console.error('Failed to save auth profiles:', error);
    }
  }

  /**
   * Repair permissions on an existing store without waiting for a write.
   *
   * Called at load time because the dangerous window is "the file already
   * exists and nobody has saved since" - exactly the state a long-lived
   * install sits in.
   */
  private secureExistingFile(): void {
    try {
      if (fs.existsSync(this.profilesPath)) {
        const mode = fs.statSync(this.profilesPath).mode & 0o777;
        if (mode !== 0o600) fs.chmodSync(this.profilesPath, 0o600);
      }
    } catch {
      // Best effort: a store we cannot chmod is still a store we can read.
    }
  }
}
