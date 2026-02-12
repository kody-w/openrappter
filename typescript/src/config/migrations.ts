/**
 * Config migration system
 */

export interface ConfigMigration {
  version: number;
  description: string;
  migrate: (config: Record<string, unknown>) => Record<string, unknown>;
}

const migrations: ConfigMigration[] = [
  {
    version: 2,
    description: 'Add configVersion field and new sections',
    migrate: (config) => ({ ...config, configVersion: 2 }),
  },
];

export function migrateConfig(
  config: Record<string, unknown>,
  fromVersion?: number,
): { config: Record<string, unknown>; migrationsApplied: number } {
  const currentVersion = (fromVersion ?? (config.configVersion as number | undefined)) ?? 1;
  let result = { ...config };
  let applied = 0;
  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      result = migration.migrate(result);
      applied++;
    }
  }
  return { config: result, migrationsApplied: applied };
}
