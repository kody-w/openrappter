import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXCLUDED_PATH_PATTERNS,
  DEFAULT_REDACTED_KEYS,
  isExcludedFlightPath,
  sanitizeFlightMetadata,
  sanitizeFlightPayload,
  sanitizeFlightValue,
  summarizeFlightError,
} from "./redaction.js";

const githubToken = (): string =>
  ["ghp", "0123456789abcdefghijklmnopqrstuv"].join("_");
const awsKey = (): string => ["AKIA", "0123456789ABCDEF"].join("");
const bearer = (): string => ["Bearer", "header.payload.signature"].join(" ");

describe("flight recorder redaction", () => {
  it("exports non-empty immutable-typed defaults with positive and negative controls", () => {
    expect(DEFAULT_REDACTED_KEYS.has("token")).toBe(true);
    expect(DEFAULT_REDACTED_KEYS.has("apiKey")).toBe(true);
    expect(DEFAULT_REDACTED_KEYS.has("identityKey")).toBe(true);
    expect(DEFAULT_REDACTED_KEYS.has("displayName")).toBe(false);
    expect(DEFAULT_EXCLUDED_PATH_PATTERNS.length).toBeGreaterThan(0);
    expect(isExcludedFlightPath("/work/.env.local")).toBe(true);
    expect(isExcludedFlightPath("/work/flight.db.identity-key")).toBe(true);
    expect(isExcludedFlightPath("/work/src/index.ts")).toBe(false);
  });

  it("drops payload IO unless recordIO is explicitly true", () => {
    const payload = { ordinary: "survives only when opted in" };
    expect(sanitizeFlightPayload(payload)).toBeUndefined();
    expect(sanitizeFlightPayload(payload, { recordIO: false })).toBeUndefined();
    expect(sanitizeFlightPayload(payload, { recordIO: true })).toEqual(payload);
  });

  it("always sanitizes metadata independently of recordIO", () => {
    const secret = githubToken();
    const metadata = { apiKey: secret, operation: "recent-edits" };
    expect(JSON.stringify(metadata)).toContain(secret);

    const result = sanitizeFlightMetadata(metadata, { recordIO: false });

    expect(result).toEqual({ apiKey: "[redacted]", operation: "recent-edits" });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(sanitizeFlightMetadata(undefined)).toEqual({});
  });

  it("recursively redacts separator-insensitive and case-insensitive secret keys", () => {
    const value = "not-secret-shaped-by-value";
    const input = {
      TOKEN: value,
      auth: {
        Api_Key: value,
        "private-key": value,
        refreshToken: value,
        SESSION_TOKEN: value,
      },
      list: [{ Credential: value }, { authorization: value }],
      cookieJar: value,
      passwordHash: value,
    };

    const result = sanitizeFlightValue(input) as Record<string, unknown>;
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(value);
    expect(result.TOKEN).toBe("[redacted]");
    expect(result.list).toEqual([
      { Credential: "[redacted]" },
      { authorization: "[redacted]" },
    ]);
  });

  it("structurally sanitizes JSON object and array strings", () => {
    expect(
      sanitizeFlightValue(
        '{"password":"ordinary-secret","nested":[{"token":"other-secret"}]}',
      ),
    ).toEqual({
      password: "[redacted]",
      nested: [{ token: "[redacted]" }],
    });
    const escaped =
      'HTTP 400 body="{\\"password\\":\\"escaped-secret\\"}"';
    const sanitized = sanitizeFlightValue(escaped);
    expect(sanitized).not.toContain("escaped-secret");
    expect(sanitized).toContain("[redacted]");
    const unicodeEscaped = String.raw`"\u007b\"password\":\"unicode-secret\"\u007d"`;
    const unicodeSanitized = sanitizeFlightValue(unicodeEscaped);
    expect(unicodeSanitized).not.toContain("unicode-secret");
    expect(unicodeSanitized).toContain("[redacted]");
    const doubleEncoded = JSON.stringify(unicodeEscaped);
    const doubleSanitized = sanitizeFlightValue(doubleEncoded);
    expect(doubleSanitized).not.toContain("unicode-secret");
    expect(doubleSanitized).toContain("[redacted]");
    const primitiveSecret = String.raw`"\u0067\u0068\u0070_aaaaaaaaaaaaaaaaaaaa"`;
    const primitiveSanitized = sanitizeFlightValue(primitiveSecret);
    expect(primitiveSanitized).not.toContain("aaaaaaaaaaaaaaaaaaaa");
    expect(primitiveSanitized).toContain("[redacted]");
    expect(
      sanitizeFlightValue(
        '{"password":"ordinary-private-value", trailing}',
      ),
    ).toBe("[redacted]");
    expect(
      sanitizeFlightValue('{"value":9007199254740993}'),
    ).toEqual({ value: "9007199254740993n" });
  });

  it("bounds structural string work before payload limits apply", () => {
    const unmatched = "{".repeat(8_000);
    expect(sanitizeFlightValue(unmatched)).toBe(unmatched);
    expect(sanitizeFlightValue("{".repeat(70_000))).toBe(
      "[truncated:70000]",
    );
  });

  it("defers disabled payloads and bounds aggregate traversal", () => {
    let invoked = false;
    expect(
      sanitizeFlightPayload(
        () => {
          invoked = true;
          throw new Error("disabled payload should remain lazy");
        },
        { recordIO: false },
      ),
    ).toBeUndefined();
    expect(invoked).toBe(false);

    let elementReads = 0;
    const huge = new Proxy(new Array(200_000).fill("x"), {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          elementReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(
      sanitizeFlightPayload(huge, {
        recordIO: true,
        maxPayloadBytes: 100,
      }),
    ).toBe("[truncated:budget]");
    expect(elementReads).toBe(0);

    let getterReads = 0;
    const dynamic = Object.create(null);
    Object.defineProperty(dynamic, "items", {
      enumerable: true,
      get() {
        getterReads += 1;
        return getterReads === 1
          ? ["safe"]
          : new Array(20_000).fill("expanded");
      },
    });
    expect(sanitizeFlightValue(dynamic)).toEqual({ items: ["safe"] });
    expect(getterReads).toBe(1);
  });

  it("charges repeated aliases for every emitted occurrence", () => {
    const shared = new Array(1_000).fill("x");
    const aliases = new Array(1_000).fill(shared);

    expect(sanitizeFlightValue(aliases)).toBe("[truncated:budget]");
  });

  it("sorts unordered collections with locale-independent UTF-16 order", () => {
    expect(sanitizeFlightValue(new Set(["ä", "z"]))).toEqual([
      "z",
      "ä",
    ]);
    expect(
      sanitizeFlightValue(
        new Map<unknown, unknown>([
          ["ä", 1],
          ["z", 2],
        ]),
      ),
    ).toEqual([
      ["z", 2],
      ["ä", 1],
    ]);
    expect(sanitizeFlightValue(new Set([1e-5, 1e-6]))).toEqual([
      1e-6,
      1e-5,
    ]);
  });

  it("redacts credentials embedded in property names without collisions", () => {
    const secretKey = "password=ordinary-secret-value";
    const result = sanitizeFlightValue({
      "[redacted]": "control",
      [secretKey]: "sensitive",
    }) as Record<string, unknown>;

    expect(JSON.stringify(result)).not.toContain(secretKey);
    expect(result).toEqual({
      "[redacted]": "control",
      "[redacted]#2": "[redacted]",
    });
    expect(
      sanitizeFlightValue(
        { "exact-property-secret": "value" },
        { redactedValues: ["exact-property-secret"] },
      ),
    ).toEqual({ "[redacted]": "[redacted]" });
    expect(
      sanitizeFlightValue({
        "pass%77ord": "ordinary-private-value",
      }),
    ).toEqual({ password: "[redacted]" });
    expect(
      sanitizeFlightValue(
        { prefixALPHABETAsuffix: "value" },
        { redactedValues: ["ALPHABETA"] },
      ),
    ).toEqual({ "[redacted]": "value" });
    expect(
      sanitizeFlightValue({
        "%5Bexcluded-path%5D": "encoded",
        "[excluded-path]": "literal",
      }),
    ).toEqual({
      "[excluded-path]": "encoded",
      "[excluded-path]#2": "literal",
    });
    expect(
      sanitizeFlightValue({
        "%FF": 1,
        "ÿ": 2,
      }),
    ).toEqual({
      "�": 1,
      "ÿ": 2,
    });
    const identityKey = "ab".repeat(32);
    const encodedIdentity = [...identityKey]
      .map((character) =>
        `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
      )
      .join("");
    expect(
      sanitizeFlightValue(encodedIdentity, {
        redactedValues: [identityKey],
      }),
    ).toBe("[redacted]");
  });

  it("supports operator-supplied redacted keys without redacting near misses", () => {
    const result = sanitizeFlightValue(
      { signingPin: "1234", pin: "ordinary", displayName: "Ada" },
      { redactedKeys: ["signing_pin"] },
    );

    expect(result).toEqual({
      displayName: "Ada",
      pin: "ordinary",
      signingPin: "[redacted]",
    });
  });

  it("redacts secret-shaped string values while preserving explicit negative controls", () => {
    const values = {
      github: githubToken(),
      aws: awsKey(),
      bearer: bearer(),
      uri: ["postgresql://user", "pw@example.test/app"].join(":"),
      connection: ["Server=db;", "Password=hunter2;", "Database=app"].join(""),
      pem: [
        ["-----BEGIN", " PRIVATE KEY-----"].join(""),
        "ZmFrZS1ub3QtYS1yZWFsLWtleQ==",
        ["-----END", " PRIVATE KEY-----"].join(""),
      ].join("\n"),
      dsa: [
        ["-----BEGIN DSA", " PRIVATE KEY-----"].join(""),
        "ZmFrZS1kc2Eta2V5",
        ["-----END DSA", " PRIVATE KEY-----"].join(""),
      ].join("\n"),
      passwordOnlyUrl: "redis://:supersecret@host/0",
    };
    const input = {
      values: Object.values(values),
      ordinary: "AKIA-short-is-safe",
    };
    expect(input.values).toEqual(Object.values(values));
    expect(input.values.every((secret) => secret.length > 10)).toBe(true);

    const result = sanitizeFlightValue(input) as {
      values: unknown[];
      ordinary: string;
    };

    expect(result.values).toEqual(
      Object.values(values).map(() => "[redacted]"),
    );
    expect(result.ordinary).toBe("AKIA-short-is-safe");
    expect(
      sanitizeFlightValue(
        "https://example.test/path?token=ordinary-secret-value",
      ),
    ).toBe("[redacted]");
    expect(
      sanitizeFlightValue(
        "https://example.test/path?session_token=ordinary-secret-value",
      ),
    ).toBe("[redacted]");
    expect(
      sanitizeFlightValue(
        "https://example.test/path?%74oken=ordinary-secret-value",
      ),
    ).toBe("[redacted]");
    expect(
      sanitizeFlightValue(
        "/callback?session_token=ordinary-secret-value",
      ),
    ).toBe("[redacted]");
    expect(
      sanitizeFlightValue(
        "//host/path?%74oken=ordinary-secret-value",
      ),
    ).toBe("[redacted]");
    expect(
      sanitizeFlightValue(
        "https://example.test/cb#token=ordinary-secret-value",
      ),
    ).toBe("[redacted]");
    let deeplyEncoded = "%74oken";
    for (let index = 0; index < 65; index += 1) {
      deeplyEncoded = deeplyEncoded.replaceAll("%", "%25");
    }
    expect(
      sanitizeFlightValue(
        `https://example.test/?${deeplyEncoded}=ordinary-secret-value`,
      ),
    ).toBe("[redacted]");
    expect(
      sanitizeFlightValue('prefix {"a":1.0,"b":1e-7}'),
    ).toBe('prefix {"a":1,"b":1e-7}');
  });

  it("redacts embedded bearer tokens and credentials with near-miss controls", () => {
    const embeddedBearer = `HTTP 401: Authorization: ${bearer()} response body denied`;
    const embeddedCredential =
      "provider failed: client_secret=abcdefgh12345678 while connecting";
    const controls = [
      "HTTP 401: Authorization header missing; bearer token absent",
      "provider failed: client_secret field was not configured",
      "postgresql://example.test/app has no embedded password",
    ];

    expect(embeddedBearer).toContain(bearer());
    expect(embeddedCredential).toContain("abcdefgh12345678");
    expect(sanitizeFlightValue(embeddedBearer)).toBe("[redacted]");
    expect(sanitizeFlightValue(embeddedCredential)).toBe("[redacted]");
    expect(controls.map((value) => sanitizeFlightValue(value))).toEqual(
      controls,
    );
  });

  it("redacts secrets adjacent to non-ASCII letters", () => {
    const token = githubToken();
    const auth = bearer();
    for (const value of [
      `é${token}`,
      `${token}é`,
      `é${auth}`,
    ]) {
      expect(sanitizeFlightValue(value)).toBe("[redacted]");
    }
  });

  it("reproduces the Copilot MITM recent-edit privacy failure without a secret-named key", () => {
    const leakedToken = githubToken();
    const recentEdit = {
      kind: "recent-edit",
      file: "src/provider.ts",
      patch: `const copiedValue = "${leakedToken}";`,
      linesChanged: 1,
    };
    expect(recentEdit.patch).toContain(leakedToken);

    const sanitized = sanitizeFlightMetadata({ recentEdit });
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain(leakedToken);
    expect(serialized).toContain("[redacted]");
    expect(serialized).toContain("linesChanged");
  });

  it("excludes default sensitive paths but keeps surrounding object shape", () => {
    const input = {
      files: [
        "/repo/.env",
        "/repo/.env.local",
        "/home/me/.aws/credentials",
        "/home/me/.ssh/id_ed25519",
        "/keys/client.pem",
        "/keys/client.key",
        "/keys/client.p12",
        "/home/me/.copilot_token",
        "/repo/service-account.json",
        "/home/me/.git-credentials",
        "/repo/src/index.ts",
      ],
      count: 11,
    };

    const result = sanitizeFlightValue(input) as typeof input;

    expect(result.files.slice(0, 10)).toEqual(
      Array.from({ length: 10 }, () => "[excluded-path]"),
    );
    expect(result.files[10]).toBe("/repo/src/index.ts");
    expect(result.count).toBe(11);
  });

  it("redacts sibling content when an object identifies an excluded file", () => {
    const result = sanitizeFlightValue({
      path: "/repo/.env",
      content: "PRIVATE_VALUE=not-pattern-sensitive",
      bytes: [1, 2, 3],
      language: "dotenv",
    });

    expect(result).toEqual({
      bytes: "[excluded-path]",
      content: "[excluded-path]",
      language: "dotenv",
      path: "[excluded-path]",
    });
    expect(
      sanitizeFlightValue({
        name: ".env",
        content: "PRIVATE_VALUE=ordinary",
        contents: "PRIVATE_VALUE=second",
        value: "PRIVATE_VALUE=third",
      }),
    ).toEqual({
      content: "[excluded-path]",
      contents: "[excluded-path]",
      name: "[excluded-path]",
      value: "[excluded-path]",
    });
    for (const uri of [
      "file:///repo/.env?version=1",
      "file:///repo/%2Eenv#fragment",
    ]) {
      expect(
        sanitizeFlightValue({
          uri,
          content: "PRIVATE_VALUE=ordinary",
        }),
      ).toEqual({
        content: "[excluded-path]",
        uri: "[excluded-path]",
      });
      expect(
        sanitizeFlightValue(
          new Map([
            ["uri", uri],
            ["content", "PRIVATE_VALUE=ordinary"],
          ]),
        ),
      ).toEqual([
        ["content", "[excluded-path]"],
        ["uri", "[excluded-path]"],
      ]);
    }
    expect(
      sanitizeFlightValue({
        path: new URL("file:///repo/.env"),
        content: "PRIVATE_VALUE=ordinary",
      }),
    ).toEqual({
      content: "[excluded-path]",
      path: "[excluded-path]",
    });
    expect(
      sanitizeFlightValue({
        sourcePath: "/repo/.env",
        content: "PRIVATE_VALUE=ordinary",
      }),
    ).toEqual({
      content: "[excluded-path]",
      sourcePath: "[excluded-path]",
    });
    for (const locator of [
      "sourceUri",
      "documentPath",
    ]) {
      expect(
        sanitizeFlightValue({
          [locator]: "/repo/.env",
          content: "PRIVATE_VALUE=ordinary",
        }),
      ).toEqual({
        content: "[excluded-path]",
        [locator]: "[excluded-path]",
      });
    }
    expect(
      sanitizeFlightValue({
        textDocument: { uri: "file:///repo/.env" },
        contentChanges: [{ text: "PRIVATE_VALUE=ordinary" }],
      }),
    ).toEqual({
      textDocument: { uri: "[excluded-path]" },
      contentChanges: "[excluded-path]",
    });
    expect(
      sanitizeFlightValue({
        "%2Eenv": "PRIVATE_VALUE=ordinary",
      }),
    ).toEqual({
      "[excluded-path]": "[excluded-path]",
    });
    expect(
      sanitizeFlightValue({
        "%252Eenv": "PRIVATE_VALUE=ordinary",
      }),
    ).toEqual({
      "[excluded-path]": "[excluded-path]",
    });
    let descriptor: Record<string, unknown> = {
      uri: "file:///repo/.env",
    };
    for (let depth = 0; depth < 18; depth += 1) {
      descriptor = { nested: descriptor };
    }
    expect(
      sanitizeFlightValue({
        descriptor,
        content: "PRIVATE_VALUE=ordinary",
      }),
    ).toMatchObject({
      content: "[excluded-path]",
    });
    expect(
      sanitizeFlightValue({
        path: "/repo/.env",
        language: { raw: "PRIVATE_VALUE=ordinary" },
        size: { raw: 42 },
        content: "PRIVATE_VALUE=ordinary",
      }),
    ).toEqual({
      content: "[excluded-path]",
      language: "[excluded-path]",
      path: "[excluded-path]",
      size: "[excluded-path]",
    });
    expect(
      sanitizeFlightValue({
        sourcePath: "vscode-remote://host/%ZZ/private/%2Eenv",
        content: "PRIVATE_VALUE=ordinary",
      }),
    ).toEqual({
      content: "[excluded-path]",
      sourcePath: "[excluded-path]",
    });
    expect(
      sanitizeFlightValue({
        sourcePath: "/repo/%252Eenv",
        content: "PRIVATE_VALUE=ordinary",
      }),
    ).toEqual({
      content: "[excluded-path]",
      sourcePath: "[excluded-path]",
    });
    expect(
      sanitizeFlightValue({
        sourcePath:
          "vscode-remote://ssh-remote+host/home/alice/%2Eenv",
        content: "PRIVATE_VALUE=ordinary",
      }),
    ).toEqual({
      content: "[excluded-path]",
      sourcePath: "[excluded-path]",
    });
  });

  it("honors operator path patterns including stateful global regexes", () => {
    const privacy = { excludedPathPatterns: [/private-workspace/gi] };

    expect(isExcludedFlightPath("/private-workspace/a.txt", privacy)).toBe(
      true,
    );
    expect(isExcludedFlightPath("/private-workspace/b.txt", privacy)).toBe(
      true,
    );
    expect(isExcludedFlightPath("/public/a.txt", privacy)).toBe(false);
    expect(
      sanitizeFlightValue(
        { first: "/private-workspace/a.txt", second: "/public/a.txt" },
        privacy,
      ),
    ).toEqual({ first: "[excluded-path]", second: "/public/a.txt" });
  });

  it("replaces circular recurrences and preserves repeated non-circular references", () => {
    const shared = { label: "shared" };
    const input: Record<string, unknown> = { first: shared, second: shared };
    input.self = input;

    const result = sanitizeFlightValue(input);

    expect(result).toEqual({
      first: { label: "shared" },
      second: { label: "shared" },
      self: "[circular]",
    });
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("densifies sparse arrays so the hashed value matches stored JSON", () => {
    const sparse = Array(2) as unknown[];
    sparse[1] = "present";

    const result = sanitizeFlightValue({ sparse }) as {
      sparse: unknown[];
    };

    expect(result.sparse).toEqual([null, "present"]);
    expect(Object.hasOwn(result.sparse, 0)).toBe(true);
  });

  it("converts dates, buffers, typed arrays, arrays, maps, sets and errors", () => {
    const error = new Error("ordinary failure");
    Object.assign(error, { code: "E_TEST" });
    const result = sanitizeFlightValue({
      array: [1, undefined, 3],
      buffer: Buffer.from([1, 2, 3]),
      date: new Date("2025-01-02T03:04:05.000Z"),
      error,
      map: new Map<unknown, unknown>([
        ["z", 2],
        ["apiKey", githubToken()],
        ["a", 1],
      ]),
      set: new Set(["z", "a"]),
      typed: new Uint16Array([4, 5]),
    }) as Record<string, unknown>;

    expect(result.array).toEqual([1, null, 3]);
    expect(result.buffer).toEqual([1, 2, 3]);
    expect(result.date).toBe("2025-01-02T03:04:05.000Z");
    expect(result.typed).toEqual([4, 5]);
    expect(result.set).toEqual(["a", "z"]);
    expect(result.map).toEqual([
      ["a", 1],
      ["apiKey", "[redacted]"],
      ["z", 2],
    ]);
    expect(result.error).toMatchObject({
      name: "Error",
      message: "ordinary failure",
      code: "E_TEST",
    });

    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("turns hostile error getters into an unserializable marker", () => {
    const hostile = Object.create(Error.prototype);
    for (const key of ["name", "message", "stack"]) {
      Object.defineProperty(hostile, key, {
        get() {
          throw new Error(`blocked ${key}`);
        },
      });
    }

    const sanitized = {
      name: "[unserializable]",
      message: "[unserializable]",
      stack: "[unserializable]",
    };
    expect(sanitizeFlightValue(hostile)).toEqual(sanitized);
    expect(
      sanitizeFlightPayload({ error: hostile }, { recordIO: true }),
    ).toEqual({ error: sanitized });
  });

  it("structurally sanitizes prefixed JSON in error messages and stacks", () => {
    const secret = "ordinary-error-secret";
    const error = new Error(
      `HTTP 400: ${JSON.stringify({ password: secret })}`,
    );
    const result = sanitizeFlightValue(error);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[redacted]");
    expect(sanitizeFlightValue(result)).toEqual(result);

    const nested = sanitizeFlightValue(
      new Error(
        'Error: {not-json: {"password":"nested-error-secret"}}',
      ),
    );
    expect(JSON.stringify(nested)).not.toContain("nested-error-secret");
    expect(JSON.stringify(nested)).toContain("[redacted]");
  });

  it("stringifies unsafe integers so cross-runtime hashes cannot hide precision loss", () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    expect(Number.isSafeInteger(unsafe)).toBe(false);
    expect(
      sanitizeFlightValue({ unsafe, safe: Number.MAX_SAFE_INTEGER }),
    ).toEqual({
      safe: Number.MAX_SAFE_INTEGER,
      unsafe: `${unsafe}n`,
    });
  });

  it("produces deterministic JSON-compatible output for unordered collections", () => {
    const first = sanitizeFlightValue({
      map: new Map([
        ["b", 2],
        ["a", 1],
      ]),
      set: new Set(["b", "a"]),
    });
    const second = sanitizeFlightValue({
      set: new Set(["a", "b"]),
      map: new Map([
        ["a", 1],
        ["b", 2],
      ]),
    });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("redacts prototype-pollution keys without polluting the returned object", () => {
    const input = JSON.parse(
      '{"safe":"yes","__proto__":{"polluted":true},"constructor":"bad","prototype":"bad"}',
    ) as Record<string, unknown>;

    const result = sanitizeFlightValue(input) as Record<string, unknown>;

    expect(result.safe).toBe("yes");
    expect(result["[redacted]"]).toBe("[redacted]");
    expect(result["[redacted]#2"]).toBe("[redacted]");
    expect(result["[redacted]#3"]).toBe("[redacted]");
    expect(Object.hasOwn(result, "__proto__")).toBe(false);
    expect(Object.hasOwn(result, "constructor")).toBe(false);
    expect(Object.hasOwn(result, "prototype")).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("redacts secret and path-shaped property names without collisions", () => {
    const secretKey = githubToken();
    const pathKey = "/Users/alice/.ssh/id_ed25519";
    const input = Object.fromEntries([
      ["[redacted]", "reserved"],
      ["[redacted]#2", "reserved-two"],
      ["[excluded-path]", "reserved-path"],
      [secretKey, "secret-key-value"],
      [pathKey, "path-key-value"],
      ["constructor", "prototype-value"],
      ["apiKey", "field-value"],
      ["safe", "ordinary"],
    ]);
    const reversed = Object.fromEntries(Object.entries(input).reverse());

    const result = sanitizeFlightValue(input) as Record<string, unknown>;
    const reversedResult = sanitizeFlightValue(reversed);
    const serialized = JSON.stringify(result);

    expect(reversedResult).toEqual(result);
    expect(Object.keys(result)).toHaveLength(Object.keys(input).length);
    expect(serialized).not.toContain(secretKey);
    expect(serialized).not.toContain(pathKey);
    expect(result["[redacted]"]).toBe("reserved");
    expect(result["[redacted]#2"]).toBe("reserved-two");
    expect(result["[redacted]#3"]).toBe("[redacted]");
    expect(result["[redacted]#4"]).toBe("secret-key-value");
    expect(result["[excluded-path]"]).toBe("reserved-path");
    expect(result["[excluded-path]#2"]).toBe("[excluded-path]");
    expect(result.apiKey).toBe("[redacted]");
    expect(result.safe).toBe("ordinary");
    expect(Object.hasOwn(result, "constructor")).toBe(false);
  });

  it("excludes contents stored under bare sensitive filenames", () => {
    const result = sanitizeFlightValue({
      "server.p12": { bytes: [1, 2, 3] },
      "service-account.json": { client_email: "service@example.test" },
      "/Users/alice/client-secret.pem": { private: "secret" },
    }) as Record<string, unknown>;

    expect(result).toEqual({
      "[excluded-path]": "[excluded-path]",
      "[excluded-path]#2": "[excluded-path]",
      "[excluded-path]#3": "[excluded-path]",
    });
    expect(JSON.stringify(result)).not.toContain("service@example.test");
    expect(JSON.stringify(result)).not.toContain("client-secret.pem");
  });

  it("does not mutate original objects, arrays, maps or sets", () => {
    const nested = { apiKey: githubToken(), path: "/repo/.env" };
    const input = {
      nested,
      array: [nested],
      map: new Map([["secret", nested]]),
      set: new Set([nested]),
    };
    const originalToken = nested.apiKey;

    const result = sanitizeFlightValue(input);

    expect(result).not.toBe(input);
    expect(nested).toEqual({ apiKey: originalToken, path: "/repo/.env" });
    expect(input.array[0]).toBe(nested);
    expect(input.map.get("secret")).toBe(nested);
    expect(input.set.has(nested)).toBe(true);
  });

  it("enforces payload bytes after redaction and returns a valid truncation marker", () => {
    const input = {
      password: "x".repeat(2_000),
      ordinary: "y".repeat(200),
    };
    const result = sanitizeFlightPayload(input, {
      recordIO: true,
      maxPayloadBytes: 80,
    });
    const serialized = JSON.stringify(result);

    expect(result).toMatch(/^\[truncated:\d+\]$/);
    expect(serialized).toBe(JSON.stringify(result));
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(80);
    expect(serialized).not.toContain("x".repeat(100));
  });

  it("uses the 16 KiB default payload cap with a below-limit negative control", () => {
    const below = { text: "a".repeat(1_000) };
    const above = { text: "b".repeat(17_000) };

    expect(sanitizeFlightPayload(below, { recordIO: true })).toEqual(below);
    expect(sanitizeFlightPayload(above, { recordIO: true })).toMatch(
      /^\[truncated:\d+\]$/,
    );
  });

  it("returns an unserializable marker rather than throwing on hostile values", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("no enumeration");
        },
      },
    );

    expect(() =>
      sanitizeFlightPayload(hostile, { recordIO: true }),
    ).not.toThrow();
    expect(sanitizeFlightPayload(hostile, { recordIO: true })).toBe(
      "[unserializable]",
    );
  });

  it("summarizes provider errors without retaining message tokens or response bodies", () => {
    const token = githubToken();
    const bearerToken = bearer();
    const body = '{"customer":"private response body"}';
    const message = `HTTP 401 Authorization: ${bearerToken}; token=${token}; body=${body}`;
    const error = Object.assign(new Error(message), {
      code: "ERR_PROVIDER_AUTH",
      status: 401,
    });
    expect(error.message).toContain(token);
    expect(error.message).toContain(bearerToken);
    expect(error.message).toContain(body);

    const first = summarizeFlightError(error);
    const second = summarizeFlightError(error);
    const serialized = JSON.stringify(first);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      errorName: "Error",
      errorCode: "ERR_PROVIDER_AUTH",
      httpStatus: 401,
      messageChars: message.length,
    });
    expect(first.messageHash).toMatch(/^[a-f0-9]{64}$/);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(bearerToken);
    expect(serialized).not.toContain(body);
    expect(serialized).not.toContain("HTTP 401");
  });

  it("summarizes Error-like objects while omitting raw and nested values", () => {
    const errorLike = {
      name: "ProviderError",
      code: "E_UPSTREAM",
      statusCode: 503,
      message: "upstream response was unavailable",
      stack: "raw stack must never persist",
      body: { raw: "raw body must never persist" },
      nested: { authorization: bearer() },
    };

    const result = summarizeFlightError(errorLike);

    expect(result).toMatchObject({
      errorName: "ProviderError",
      errorCode: "E_UPSTREAM",
      httpStatus: 503,
      messageChars: errorLike.message.length,
    });
    expect(Object.keys(result).sort()).toEqual([
      "errorCode",
      "errorName",
      "httpStatus",
      "messageChars",
      "messageHash",
    ]);
    expect(JSON.stringify(result)).not.toContain("upstream response");
    expect(JSON.stringify(result)).not.toContain("raw stack");
    expect(JSON.stringify(result)).not.toContain("raw body");
  });

  it("summarizes string errors with a stable hash and no raw string", () => {
    const raw = `request failed with ${githubToken()}`;

    const first = summarizeFlightError(raw);
    const second = summarizeFlightError(raw);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      errorName: "Error",
      messageChars: raw.length,
    });
    expect(first.messageHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(first)).not.toContain(raw);
    expect(JSON.stringify(first)).not.toContain(githubToken());
  });

  it("omits unsafe error codes and invalid HTTP statuses", () => {
    const secretCode = githubToken();
    const result = summarizeFlightError({
      name: "Unsafe Name With Spaces",
      code: secretCode,
      status: 99,
      statusCode: 700,
      message: "ordinary",
    });

    expect(result.errorName).toBe("Error");
    expect(result.errorCode).toBeUndefined();
    expect(result.httpStatus).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(secretCode);
  });

  it("never throws while summarizing a hostile Proxy", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("blocked");
        },
      },
    );

    expect(() => summarizeFlightError(hostile)).not.toThrow();
    expect(summarizeFlightError(hostile)).toEqual({
      errorName: "Error",
      messageHash:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      messageChars: 0,
    });
  });

  it("preserves ordinary nested diagnostic data unchanged", () => {
    const input = {
      provider: {
        model: "gpt-4.1",
        durationMs: 42,
        usage: { inputTokens: 120, outputTokens: 30 },
      },
      files: ["src/index.ts", "README.md"],
      success: true,
    };

    expect(sanitizeFlightValue(input)).toEqual(input);
    expect(sanitizeFlightMetadata(input)).toEqual(input);
  });
});
