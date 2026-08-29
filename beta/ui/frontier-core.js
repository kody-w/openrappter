(function installFrontierCore(global) {
  "use strict";

  const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
  const AUTH_STATES = Object.freeze([
    "unknown",
    "checking",
    "ready",
    "needs-sign-in",
    "no-entitlement",
    "offline",
    "error",
  ]);
  const MEDIA_STATES = Object.freeze([
    "idle",
    "too-large",
    "unsupported",
    "ingesting",
    "ready",
    "error",
  ]);

  function truthfulUnavailable(name, reason) {
    return Object.freeze({
      status: "unavailable",
      name: String(name),
      reason: String(reason || "No approved adapter is installed."),
    });
  }

  function classifyMedia(file) {
    if (!file || typeof file.size !== "number") {
      return { state: "error", message: "No media file was provided." };
    }
    if (file.size > MAX_MEDIA_BYTES) {
      return {
        state: "too-large",
        message: `${file.name || "Media"} exceeds the 100MB local ingest limit.`,
      };
    }
    if (!/^(image|audio|video)\//.test(String(file.type || ""))) {
      return {
        state: "unsupported",
        message: `${file.type || "unknown"} is not an approved media type.`,
      };
    }
    return {
      state: "ingesting",
      message: `Waiting for a first-party ingest adapter for ${file.name || "media"}.`,
    };
  }

  function createPrivateDraftStore() {
    let drafts = [];
    return Object.freeze({
      add(draft) {
        drafts = [
          ...drafts,
          Object.freeze({
            ...draft,
            private: true,
          }),
        ];
      },
      snapshot() {
        return structuredClone(drafts);
      },
      reset() {
        drafts = [];
      },
    });
  }

  class LivingCompanyWeek {
    constructor(store = createPrivateDraftStore()) {
      this.store = store;
      this.reset();
    }
    reset() {
      this.store.reset?.();
      this.day = 0;
      this.state = {
        status: "idle",
        externalSideEffects: 0,
        sends: 0,
        publishes: 0,
        submissions: 0,
        ledger: [],
      };
      return this.snapshot();
    }
    step() {
      const days = ["monday", "tuesday", "wednesday", "thursday", "friday"];
      if (this.day >= days.length) return this.snapshot();
      const day = days[this.day++];
      this.state.status = this.day === days.length ? "completed" : "running";
      this.state.ledger.push({
        sequence: this.day,
        day,
        event: day === "thursday" ? "fixture-offline-recovery" : `fixture-${day}`,
        redacted: true,
      });
      if (day === "tuesday") {
        this.store.add({
          kind: "private CEO memo",
          status: "draft",
          body: "Repeated fixture work identified; no automation promoted.",
        });
      }
      if (day === "friday") {
        this.store.add({
          kind: "expense",
          status: "review-ready",
          submissionStatus: "not-submitted",
        });
        this.store.add({
          kind: "private meme",
          status: "draft",
          altText: "Original receipt folder showing zero external side effects.",
        });
      }
      return this.snapshot();
    }
    run() {
      while (this.day < 5) this.step();
      return this.snapshot();
    }
    snapshot() {
      return structuredClone({
        ...this.state,
        drafts: this.store.snapshot(),
      });
    }
  }

  async function hashText(value) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  async function reviewImmutablePayload(action, payload, baseHash) {
    const serialized = JSON.stringify(payload);
    const payloadHash = await hashText(JSON.stringify({
      action,
      baseHash,
      payload: serialized,
    }));
    return Object.freeze({
      action,
      baseHash,
      payload: serialized,
      payloadHash,
    });
  }

  function createSemanticController(surfaces, snapshot, open) {
    const approved = new Set(surfaces);
    return Object.freeze({
      snapshot: () => structuredClone(snapshot()),
      open: async (surface) => {
        if (!approved.has(surface)) {
          throw new Error(`Unknown Frontier feature: ${String(surface)}`);
        }
        await open(surface);
        return structuredClone(snapshot());
      },
    });
  }

  global.OpenRappterFrontierCore = Object.freeze({
    MAX_MEDIA_BYTES,
    AUTH_STATES,
    MEDIA_STATES,
    LivingCompanyWeek,
    classifyMedia,
    createPrivateDraftStore,
    createSemanticController,
    reviewImmutablePayload,
    truthfulUnavailable,
  });
})(globalThis);
