import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { PrivateRoot } from "../src/index.js";

it("never mistakes a live lock's atomic publication or unlink for a stale owner", async () => {
  const directory = join(process.cwd(), ".test-scratch", randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const root = await PrivateRoot.open(directory);
    await root.writeAtomic("counter", "0");
    let active = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      const contender = await PrivateRoot.open(directory);
      for (let index = 0; index < 12; index++) await contender.lock(async () => {
        expect(++active).toBe(1);
        const previous = Number((await contender.read("counter")).toString());
        await delay(1);
        await contender.writeAtomic("counter", String(previous + 1), true);
        active--;
      }, 10000);
    }));
    expect((await root.read("counter")).toString()).toBe("96");
    expect(active).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15000);
