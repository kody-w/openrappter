import {
  existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { normalizeMeetingOptions, validateTeamsMeetingUrl } from "./teams-meeting-policy.mjs";

export class TeamsSettings {
  constructor({ directory, safeStorage }) {
    this.directory = path.resolve(directory);
    this.file = path.join(this.directory, "meeting.secret");
    this.safeStorage = safeStorage;
  }

  read() {
    if (!existsSync(this.file)) return null;
    if (statSync(this.file).size > 32768) throw new Error("The private meeting settings are too large.");
    if (!this.safeStorage?.isEncryptionAvailable()) {
      throw new Error("Unlock secure storage to use the remembered meeting.");
    }
    const stored = JSON.parse(readFileSync(this.file, "utf8"));
    if (stored.schema !== "rapp-teams-settings/1" || typeof stored.encryptedLink !== "string") {
      throw new Error("The private meeting settings are invalid.");
    }
    const url = validateTeamsMeetingUrl(
      this.safeStorage.decryptString(Buffer.from(stored.encryptedLink, "base64")),
    );
    return normalizeMeetingOptions({ ...stored.options, url, remember: true });
  }

  write(options) {
    const normalized = normalizeMeetingOptions(options);
    if (!normalized.url) throw new Error("A meeting link is required before saving.");
    if (!normalized.remember) {
      this.forget();
      return;
    }
    if (!this.safeStorage?.isEncryptionAvailable()) {
      throw new Error("Secure storage is unavailable. Uncheck Remember to join without saving the link.");
    }
    const { url, ...preferences } = normalized;
    const encryptedLink = this.safeStorage.encryptString(url).toString("base64");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    writeFileSync(`${this.file}.tmp`, `${JSON.stringify({
      schema: "rapp-teams-settings/1",
      encryptedLink,
      options: { ...preferences, speak: false },
    })}\n`, { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }

  forget() {
    if (existsSync(this.file)) unlinkSync(this.file);
  }
}
