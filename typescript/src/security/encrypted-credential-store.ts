import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';

export interface SecureStringCipher {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface CredentialMetadata {
  verifiedAt: string;
  provider: string;
}

export interface EncryptedCredentialStoreOptions {
  filePath: string;
  cipher: SecureStringCipher;
  allowInsideRepoForTests?: boolean;
}

interface StoredCredential {
  ciphertext: string;
  metadata: CredentialMetadata;
}

interface StoreFile {
  schema: 'openrappter-secure-credentials/1.0';
  credentials: Record<string, StoredCredential>;
}

function enclosingRepository(start: string): string | null {
  let current = resolve(start);
  for (;;) {
    if (existsSync(`${current}/.git`)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export class EncryptedCredentialStore {
  private readonly filePath: string;
  private readonly cipher: SecureStringCipher;
  private readonly allowInsideRepoForTests: boolean;

  constructor(options: EncryptedCredentialStoreOptions) {
    this.filePath = resolve(options.filePath);
    this.cipher = options.cipher;
    this.allowInsideRepoForTests = options.allowInsideRepoForTests ?? false;
  }

  set(name: string, value: string, metadata: CredentialMetadata): void {
    this.assertName(name);
    this.assertSafe();
    if (!this.cipher.isEncryptionAvailable()) {
      throw new Error('OS secure credential storage is unavailable.');
    }
    if (!value || value.length > 512) throw new Error('Invalid credential value.');
    const file = this.read();
    file.credentials[name] = {
      ciphertext: this.cipher.encryptString(value).toString('base64'),
      metadata: { ...metadata },
    };
    this.write(file);
  }

  get(name: string): string | null {
    this.assertName(name);
    const stored = this.read().credentials[name];
    if (!stored) return null;
    if (!this.cipher.isEncryptionAvailable()) {
      throw new Error('OS secure credential storage is unavailable.');
    }
    try {
      return this.cipher.decryptString(Buffer.from(stored.ciphertext, 'base64'));
    } catch {
      throw new Error('The secure credential could not be decrypted on this device.');
    }
  }

  describe(name: string): {
    present: boolean;
    masked?: string;
    verifiedAt?: string;
    provider?: string;
  } {
    this.assertName(name);
    const stored = this.read().credentials[name];
    if (!stored) return { present: false };
    return {
      present: true,
      masked: '••••••••',
      verifiedAt: stored.metadata.verifiedAt,
      provider: stored.metadata.provider,
    };
  }

  delete(name: string): boolean {
    this.assertName(name);
    this.assertSafe();
    const file = this.read();
    if (!file.credentials[name]) return false;
    delete file.credentials[name];
    this.write(file);
    return true;
  }

  private assertName(name: string): void {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(name)) {
      throw new Error('Invalid credential name.');
    }
  }

  private assertSafe(): void {
    if (this.allowInsideRepoForTests) return;
    const repository = enclosingRepository(dirname(this.filePath));
    if (repository) {
      throw new Error('Refusing to store a credential inside a git repository.');
    }
  }

  private read(): StoreFile {
    if (!existsSync(this.filePath)) {
      return {
        schema: 'openrappter-secure-credentials/1.0',
        credentials: {},
      };
    }
    const stat = lstatSync(this.filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Secure credential path is not a regular file.');
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as StoreFile;
      if (
        parsed.schema !== 'openrappter-secure-credentials/1.0'
        || !parsed.credentials
        || typeof parsed.credentials !== 'object'
      ) {
        throw new Error('schema');
      }
      return parsed;
    } catch {
      throw new Error('Secure credential store is unreadable.');
    }
  }

  private write(file: StoreFile): void {
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Windows and some mounted filesystems do not expose POSIX modes.
    }
    const next = `${this.filePath}.${process.pid}.${randomBytes(8).toString('hex')}.next`;
    writeFileSync(next, `${JSON.stringify(file)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(next, this.filePath);
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // Best effort on non-POSIX filesystems.
    }
  }
}
