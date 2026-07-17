import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

export interface JsonStore<T> {
  load(): Promise<T | null>;
  save(value: T): Promise<void>;
}

export class PrivateJsonFileStore<T> implements JsonStore<T> {
  constructor(readonly filePath: string) {}

  async load(): Promise<T | null> {
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      await this.secureParentAndFile();
      return JSON.parse(content) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async save(value: T): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);

    const temporaryPath = path.join(
      directory,
      `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );

    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await fs.chmod(temporaryPath, 0o600);
      await fs.rename(temporaryPath, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } finally {
      await fs.unlink(temporaryPath).catch(() => undefined);
    }
  }

  private async secureParentAndFile(): Promise<void> {
    await Promise.all([
      fs.chmod(path.dirname(this.filePath), 0o700),
      fs.chmod(this.filePath, 0o600),
    ]);
  }
}
