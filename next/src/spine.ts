import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { canonicalJson, isBodyStream, sha256, snapshotJson, type JsonObject } from './canonical.js';
import { capabilityReference, type CapabilityReference } from './contract.js';
import { Refusal, requireThat } from './errors.js';

export interface ModelRequest {
  readonly root: string;
  readonly scope: string;
  readonly thought: string;
  readonly context: JsonObject;
  readonly purpose: 'organization' | 'perspective' | 'synthesis';
  readonly signal: AbortSignal;
}
export interface ModelProvider { complete(request: ModelRequest): Promise<JsonObject> }
export interface BotInterpreter {
  readonly root: string;
  publicResponse(request: ModelRequest, provider: ModelProvider): Promise<JsonObject>;
  close(): Promise<void>;
}
export interface BrainstemBinding {
  readonly available: boolean;
  hotload(input: {
    readonly root: string;
    readonly capability: CapabilityReference;
    readonly bytes: Uint8Array;
  }): Promise<BotInterpreter>;
}

export class UnavailableBrainstem implements BrainstemBinding {
  readonly available = false;
  async hotload(): Promise<BotInterpreter> {
    throw new Refusal('brainstem-binding-unavailable',
      'The immutable external Brainstem has no adopted root-isolated binding. No substitute runtime was started.');
  }
}

export async function targetCapability(): Promise<{ reference: CapabilityReference; bytes: Uint8Array }> {
  const bytes = await readFile(new URL('../agent.py', import.meta.url));
  return { bytes, reference: { artifact: 'agent.py', sha256: sha256(bytes), contract: 'rapp-work.brainstem-agent/1' } };
}

export interface Observation { readonly id: string; readonly root: string }
interface Lease { root: string; expires: number; abort: AbortController; active: number }

export class SharedBrainstem {
  readonly #binding: BrainstemBinding;
  readonly #catalog: ReadonlyMap<string, Uint8Array>;
  readonly #leases = new Map<Observation, Lease>();
  readonly #slots = new Map<string, Promise<BotInterpreter>>();
  readonly #clock: () => number;

  constructor(binding: BrainstemBinding, acceptedCapabilities: readonly { reference: CapabilityReference; bytes: Uint8Array }[],
    clock: () => number = Date.now) {
    this.#binding = binding;
    this.#clock = clock;
    this.#catalog = new Map(acceptedCapabilities.map(c => {
      const reference = capabilityReference(c.reference);
      requireThat(sha256(c.bytes) === reference.sha256, 'capability-integrity', 'Accepted capability bytes do not match their immutable reference.');
      return [reference.sha256, Uint8Array.from(c.bytes)];
    }));
  }

  observe(root: string, durationMs = 30_000): Observation {
    requireThat(isBodyStream(root) && Number.isSafeInteger(durationMs) && durationMs > 0 && durationMs <= 120_000,
      'observation', 'Observation is a bounded, explicit lease on one canonical root.');
    const handle = Object.freeze({ id: randomUUID(), root });
    this.#leases.set(handle, { root, expires: this.#clock() + durationMs, abort: new AbortController(), active: 0 });
    return handle;
  }

  #lease(handle: Observation): Lease {
    const lease = this.#leases.get(handle);
    requireThat(lease && !lease.abort.signal.aborted && lease.expires > this.#clock(),
      'unobserved', 'Unobserved canonical particles are dormant; no AI compute is authorized.');
    return lease;
  }

  status(root: string): JsonObject {
    const leases = [...this.#leases.values()].filter(l => l.root === root && l.expires > this.#clock() && !l.abort.signal.aborted);
    return { root, mode: leases.length ? 'observed' : 'dormant', observations: leases.length,
      activeComputations: leases.reduce((sum, l) => sum + l.active, 0), externalBindingAvailable: this.#binding.available };
  }

  async compute(handle: Observation, reference: CapabilityReference, request: Omit<ModelRequest, 'signal'>,
    provider: ModelProvider): Promise<JsonObject> {
    const lease = this.#lease(handle);
    requireThat(request.root === lease.root && canonicalJson(request.context).length <= 96_000,
      'root-isolation', 'Only this root’s bounded permitted canonical context may enter its interpreter.');
    const ref = capabilityReference(reference);
    const bytes = this.#catalog.get(ref.sha256);
    requireThat(bytes && sha256(bytes) === ref.sha256, 'capability-unverified',
      'The root capability is not in the host-selected exact-byte catalog.');
    let slot = this.#slots.get(lease.root);
    if (!slot) {
      slot = this.#binding.hotload({ root: lease.root, capability: ref, bytes: Uint8Array.from(bytes) });
      this.#slots.set(lease.root, slot);
      slot.catch(() => { if (this.#slots.get(lease.root) === slot) this.#slots.delete(lease.root); });
    }
    lease.active++;
    const timer = setTimeout(() => lease.abort.abort(), Math.max(1, lease.expires - this.#clock()));
    try {
      const bot = await slot;
      requireThat(bot.root === lease.root, 'root-isolation', 'The shared spine returned another bot’s interpreter.');
      this.#lease(handle);
      const response = await bot.publicResponse({ ...request, signal: lease.abort.signal }, provider);
      this.#lease(handle);
      return snapshotJson(response) as JsonObject;
    } finally {
      clearTimeout(timer);
      lease.active--;
    }
  }

  async unobserve(handle: Observation): Promise<void> {
    const lease = this.#leases.get(handle);
    if (!lease) return;
    lease.abort.abort();
    this.#leases.delete(handle);
    if (![...this.#leases.values()].some(l => l.root === lease.root)) {
      const slot = this.#slots.get(lease.root);
      this.#slots.delete(lease.root);
      if (slot) await slot.then(bot => bot.close(), () => undefined);
    }
  }

  async releaseRoot(root: string): Promise<void> {
    await Promise.all([...this.#leases.keys()].filter(h => h.root === root).map(h => this.unobserve(h)));
  }
}
