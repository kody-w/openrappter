/**
 * Plugin Provider Registry
 * Manages authentication providers contributed by plugins
 */

export interface PluginAuthProvider {
  id: string;
  name: string;
  authenticate(
    credentials: Record<string, string>
  ): Promise<{ token: string; expiresAt?: number }>;
  validate(token: string): Promise<boolean>;
  revoke?(token: string): Promise<void>;
}

export class PluginProviderRegistry {
  private providers = new Map<string, PluginAuthProvider>();

  /**
   * Register an auth provider
   */
  register(provider: PluginAuthProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider ${provider.id} is already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  /**
   * Get a provider by ID
   */
  get(id: string): PluginAuthProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * List all registered providers
   */
  list(): PluginAuthProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Authenticate using a specific provider
   */
  async authenticate(
    providerId: string,
    credentials: Record<string, string>
  ): Promise<{ token: string; expiresAt?: number }> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Provider ${providerId} not found`);
    }
    return await provider.authenticate(credentials);
  }

  /**
   * Validate a token using a specific provider
   */
  async validate(providerId: string, token: string): Promise<boolean> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Provider ${providerId} not found`);
    }
    return await provider.validate(token);
  }
}
