// The browser half of node:crypto, for the two functions RAPP/1 actually uses.
//
// rapp-protocol.mjs calls createHash("sha256").update(...).digest("hex") and
// randomUUID(). Web Crypto's digest is async and the protocol's hashing is
// synchronous all the way down, so this carries a small synchronous SHA-256
// rather than restructuring the shipped module to suit a browser.
//
// This is the ONLY thing the page reimplements. Everything above it — the frame
// spec, the drill, the fold — is the code that ships, loaded unmodified. A
// browser copy of the logic would drift from the product. This small exception
// is pinned to standard vectors and padding boundaries by the parity suite.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(bytes) {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const length = bytes.length;
  const withPad = new Uint8Array((((length + 8) >> 6) + 1) << 6);
  withPad.set(bytes);
  withPad[length] = 0x80;
  const view = new DataView(withPad.buffer);
  view.setUint32(withPad.length - 4, length << 3, false);
  view.setUint32(withPad.length - 8, Math.floor((length * 8) / 0x100000000), false);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < withPad.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  new DataView(out.buffer).setUint32(0, h[0], false);
  for (let i = 0; i < 8; i += 1) new DataView(out.buffer).setUint32(i * 4, h[i], false);
  return out;
}

const encoder = new TextEncoder();

export function createHash(algorithm) {
  if (algorithm !== "sha256") throw new Error(`only sha256 is shimmed here, got ${algorithm}`);
  const parts = [];
  return {
    update(data, encoding) {
      if (typeof data === "string") parts.push(encoder.encode(data));
      else parts.push(data instanceof Uint8Array ? data : new Uint8Array(data));
      void encoding;
      return this;
    },
    digest(form) {
      const total = parts.reduce((n, p) => n + p.length, 0);
      const all = new Uint8Array(total);
      let at = 0;
      for (const part of parts) { all.set(part, at); at += part.length; }
      const bytes = sha256(all);
      if (form !== "hex") return bytes;
      return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    },
  };
}

export function randomUUID() {
  return globalThis.crypto.randomUUID();
}

export default { createHash, randomUUID };
