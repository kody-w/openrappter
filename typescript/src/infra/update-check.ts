export interface UpdateCheckResult {
  hasUpdate: boolean;
  latestVersion: string;
  currentVersion: string;
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

    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

    return {
      hasUpdate,
      latestVersion,
      currentVersion,
    };
  } catch (error) {
    // On error, assume no update
    return {
      hasUpdate: false,
      latestVersion: currentVersion,
      currentVersion,
    };
  }
}
