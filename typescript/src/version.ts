import fs from 'node:fs';

interface PackageMetadata {
  version?: unknown;
}

function loadPackageVersion(): string {
  const metadata = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as PackageMetadata;

  if (typeof metadata.version !== 'string' || metadata.version.length === 0) {
    throw new Error('package.json does not contain a valid version');
  }

  return metadata.version;
}

export const VERSION = loadPackageVersion();
