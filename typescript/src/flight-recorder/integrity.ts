import { createHash, createHmac } from "node:crypto";
import type { FlightEvent } from "./types.js";

function normalizeUnicodeScalars(value: string): string {
  let normalized = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        normalized += value[index] + value[index + 1];
        index += 1;
      } else {
        normalized += "\ufffd";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      normalized += "\ufffd";
    } else {
      normalized += value[index];
    }
  }
  return normalized;
}

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    // ECMAScript compares strings by UTF-16 code units. Python mirrors this
    // exact order so non-BMP keys hash identically across runtimes.
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

/** SHA-256 over the canonical event body, excluding the hash itself. */
export function computeFlightEventHash(
  event: Omit<FlightEvent, "contentHash"> | FlightEvent,
): string {
  const body = { ...event } as Partial<FlightEvent>;
  delete body.contentHash;
  return createHash("sha256").update(canonical(body)).digest("hex");
}

export function verifyFlightEventHash(event: FlightEvent): boolean {
  return (
    /^[0-9a-f]{64}$/.test(event.contentHash) &&
    computeFlightEventHash(event) === event.contentHash
  );
}

/**
 * Convert an absolute filesystem path into a stable, non-reversible scope ID.
 *
 * Workspace identity is useful for filtering, but persisting `/Users/alice/...`
 * bypasses payload redaction and leaks both the operator name and project
 * location. Already-opaque IDs are preserved.
 */
export function normalizeFlightWorkspaceId(
  value: string | undefined,
): string | undefined {
  if (!value) return value;
  const normalizedValue = normalizeUnicodeScalars(value);
  if (/^workspace:[0-9a-f]{24}$/.test(normalizedValue))
    return normalizedValue;

  const candidates = [normalizedValue];
  let decoded = normalizedValue;
  let stabilized = false;
  for (let pass = 0; pass < 32; pass += 1) {
    const next = decoded.replace(/(?:%[0-9a-f]{2})+/gi, (encoded) => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return new TextDecoder().decode(
          Uint8Array.from(
            [...encoded.matchAll(/%([0-9a-f]{2})/gi)],
            (match) => Number.parseInt(match[1], 16),
          ),
        );
      }
    });
    if (next === decoded) {
      stabilized = true;
      break;
    }
    decoded = next;
  }
  if (!stabilized) {
    return `workspace:${createHash("sha256")
      .update(normalizedValue)
      .digest("hex")
      .slice(0, 24)}`;
  }
  if (decoded !== normalizedValue) candidates.push(decoded);
  const pathLike = candidates.some((candidate) => {
    if (
      /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(candidate) ||
      /^file:/i.test(candidate) ||
      /^workspace:/i.test(candidate)
    ) {
      return true;
    }
    if (
      candidate.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(candidate) ||
      candidate.startsWith("\\\\")
    ) {
      return true;
    }
    const namespaced = /^[A-Za-z][A-Za-z0-9+.-]*:(.*)$/.exec(candidate);
    if (!namespaced || candidate.includes("://")) return false;
    const suffix = namespaced[1];
    return (
      suffix.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(suffix) ||
      suffix.startsWith("\\\\")
    );
  });
  if (!pathLike) return normalizedValue;
  return `workspace:${createHash("sha256").update(normalizedValue).digest("hex").slice(0, 24)}`;
}

/**
 * Convert conversation identifiers into stable opaque IDs.
 *
 * Channel session keys can contain phone numbers, email addresses, chat GUIDs,
 * or other counterparty identifiers. Hash every raw value at the recorder
 * boundary so correlation remains possible without persisting that identity.
 */
export function normalizeFlightSessionId(
  value: string | undefined,
  identityKey: string,
  redactedValues: readonly string[] = [],
): string | undefined {
  if (!value) return value;
  const normalizedValue = normalizeUnicodeScalars(value);
  const exactSecret = redactedValues.some(
    (candidate) =>
      candidate.length > 0 &&
      (/^[0-9a-f]{64}$/i.test(candidate)
        ? normalizedValue.toLowerCase() === candidate.toLowerCase()
        : normalizedValue === candidate),
  );
  if (
    /^session:[0-9a-f]{24}$/.test(normalizedValue) &&
    !exactSecret
  ) return normalizedValue;
  if (!/^[0-9a-f]{64}$/i.test(identityKey)) {
    throw new Error("Flight Recorder identity key must be 32-byte hexadecimal.");
  }
  return `session:${createHmac("sha256", Buffer.from(identityKey, "hex"))
    .update(normalizedValue)
    .digest("hex")
    .slice(0, 24)}`;
}

/** `"auto"` is a routing policy, not the identity of the model that answered. */
export function normalizeFlightModelId(
  value: string | undefined,
): string | undefined {
  const model = value?.trim();
  return model && model.toLowerCase() !== "auto" ? model : undefined;
}
