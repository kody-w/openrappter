import { describe, expect, it } from "vitest";
import { APP_URL } from "../src/contract.js";
import { allowsMicrophone } from "../src/permissions.js";

describe("foreground app-document microphone permission", () => {
  const owned = { mainFrame: { url: APP_URL } };
  const details = { isMainFrame: true, requestingUrl: APP_URL, mediaTypes: ["audio"] };
  it("permits only an audio request or check in the owned foreground document", () => {
    expect(allowsMicrophone(owned, owned, "media", details, true)).toBe(true);
    expect(allowsMicrophone(owned, owned, "media", { ...details, mediaTypes: undefined, mediaType: "audio" }, true)).toBe(true);
  });
  it("denies frames, foreign windows, background, remote origins and missing document details", () => {
    expect(allowsMicrophone({}, owned, "media", details, true)).toBe(false);
    expect(allowsMicrophone(owned, null, "media", details, true)).toBe(false);
    expect(allowsMicrophone(owned, owned, "media", details, false)).toBe(false);
    for (const overrides of [
      { isMainFrame: false }, { requestingUrl: undefined }, { requestingUrl: "https://example.invalid/index.html" },
      { requestingUrl: "rapp-work://app/other.html" }, { requestingUrl: "rapp-work://user@app/index.html" },
    ]) expect(allowsMicrophone(owned, owned, "media", { ...details, ...overrides }, true)).toBe(false);
    const navigated = { mainFrame: { url: "https://example.invalid/" } };
    expect(allowsMicrophone(navigated, navigated, "media", details, true)).toBe(false);
  });
  it("never grants camera, display capture, unspecified media, or other browser privileges", () => {
    for (const permission of ["display-capture", "geolocation", "notifications", "clipboard-read", "unknown"])
      expect(allowsMicrophone(owned, owned, permission, details, true)).toBe(false);
    for (const mediaTypes of [[], ["video"], ["audio", "video"], ["audio", "audio"]])
      expect(allowsMicrophone(owned, owned, "media", { ...details, mediaTypes }, true)).toBe(false);
    for (const mediaType of ["video", "unknown", undefined])
      expect(allowsMicrophone(owned, owned, "media", { ...details, mediaTypes: undefined, mediaType }, true)).toBe(false);
  });
});
