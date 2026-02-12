import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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

  constructor() {
    const configDir = path.join(os.homedir(), '.openrappter');
    this.profilesPath = path.join(configDir, 'auth-profiles.json');
    this.ensureConfigDir();
    this.load();
  }

  private ensureConfigDir(): void {
    const configDir = path.dirname(this.profilesPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
  }

  add(profile: Omit<AuthProfile, 'createdAt'>): AuthProfile {
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
    if (existingForProvider.length === 0) {
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

  remove(provider: string, id: string): boolean {
    const index = this.profiles.findIndex(
      (p) => p.provider === provider && p.id === id
    );
    if (index === -1) {
      return false;
    }

    const wasDefault = this.profiles[index].default;
    this.profiles.splice(index, 1);

    // If we removed the default, make the first remaining profile default
    if (wasDefault) {
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
  }

  save(): void {
    try {
      fs.writeFileSync(
        this.profilesPath,
        JSON.stringify(this.profiles, null, 2),
        'utf-8'
      );
    } catch (error) {
      console.error('Failed to save auth profiles:', error);
    }
  }
}
