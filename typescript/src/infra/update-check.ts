export interface UpdateCheckResult {
  hasUpdate: boolean;
  latestVersion: string;
  currentVersion: string;
  /**
   * Whether the registry was actually reached.
   *
   * The catch below used to return `hasUpdate: false, latestVersion:
   * currentVersion` for a DNS failure, a 500, and a genuinely current install
   * alike. Every caller then said "you are using the latest version" — the one
   * sentence a user offline on a version with a security fix must not be told.
   */
  checked: boolean;
  /** Why the check could not be made, when `checked` is false. */
  error?: string;
}

function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map((n) => parseInt(n, 10));
  const parts2 = v2.split('.').map((n) => parseInt(n, 10));

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const num1 = parts1[i] || 0;
    const num2 = parts2[i] || 0;

    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }

  return 0;
}

export async function checkForUpdate(
  currentVersion: string
): Promise<UpdateCheckResult> {
  try {
    const response = await fetch('https://registry.npmjs.org/openrappter/latest');
    if (!response.ok) {
      throw new Error(`Failed to fetch latest version: ${response.statusText}`);
    }

    const data = (await response.json()) as { version: string };
    const latestVersion = data.version;
    if (typeof latestVersion !== 'string' || !latestVersion) {
      throw new Error('Registry response contained no version');
    }

    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

    return {
      hasUpdate,
      latestVersion,
      currentVersion,
      checked: true,
    };
  } catch (error) {
    return {
      hasUpdate: false,
      latestVersion: currentVersion,
      currentVersion,
      checked: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
