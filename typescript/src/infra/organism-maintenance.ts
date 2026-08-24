import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hardenPrivatePath } from '../flight-recorder/permissions.js';

function maintenanceRoot(home: string): string {
  return path.join(path.dirname(path.resolve(home)), `.${path.basename(home)}.maintenance`);
}

export async function withOrganismSnapshotFence<T>(
  home: string,
  operation: () => Promise<T>,
): Promise<T> {
  const root = maintenanceRoot(home);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  hardenPrivatePath(root, true);
  const exclusive = path.join(root, 'snapshot-exclusive');
  fs.mkdirSync(exclusive, { mode: 0o700 });
  hardenPrivatePath(exclusive, true);
  try {
    const deadline = Date.now() + 15_000;
    while (fs.readdirSync(root).some((name) => name.startsWith('writer-'))) {
      if (Date.now() >= deadline) throw new Error('Timed out quiescing organism writers');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return await operation();
  } finally {
    fs.rmSync(exclusive, { recursive: true, force: true });
  }
}

export function withOrganismWriteAccessSync<T>(
  home: string,
  operation: () => T,
): T {
  const root = maintenanceRoot(home);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 15_000;
  while (true) {
    const writer = path.join(root, `writer-${process.pid}-${randomUUID()}`);
    fs.writeFileSync(writer, '', { flag: 'wx', mode: 0o600 });
    if (!fs.existsSync(path.join(root, 'snapshot-exclusive'))) {
      try {
        return operation();
      } finally {
        fs.rmSync(writer, { force: true });
      }
    }
    fs.rmSync(writer, { force: true });
    if (Date.now() >= deadline) throw new Error('Timed out waiting for organism maintenance');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}
