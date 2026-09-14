import { randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalJson, isBodyStream, mintIdentity, sha256, type JsonObject, type RappFrame } from './canonical.js';
import { Bots, findRoot } from './bots.js';
import { label, object, text, workEvent } from './contract.js';
import { Refusal, requireThat } from './errors.js';
import { foldState, permittedScopes } from './state.js';
import type { RootSnapshot, StoreSnapshot } from './repository.js';
import { AI_LIMITS, grantData, type AiRight, type ClientActor, type ClientGrant } from './ai-contract.js';
import { memoryFrames } from './source-memory.js';

export interface ActiveGrant { data: ClientGrant; frame: RappFrame; active: boolean }
export function clientGrants(root: RootSnapshot): Map<string, ActiveGrant> {
  const grants = new Map<string, ActiveGrant>();
  for (const frame of memoryFrames(root)) {
    const e = workEvent(frame.payload);
    if (e.event === 'client.granted') {
      const data = grantData(e.data);
      requireThat(root.definition.signer === root.definition.root, 'client-authority', 'Client delegation requires the root’s selected canonical signature.');
      grants.set(data.client, { data, frame, active: true });
    } else if (e.event === 'client.revoked') {
      const data = object(e.data, ['client', 'grantWave', 'reason']);
      const previous = grants.get(String(data.client));
      requireThat(previous && previous.frame.frame_hash === data.grantWave, 'client-authority', 'Revocation must name the exact selected client grant.');
      previous.active = false;
    }
  }
  return grants;
}
export function actorFor(grant: ActiveGrant): ClientActor {
  return { id: grant.data.client, name: grant.data.name, provider: grant.data.provider, grantWave: grant.frame.frame_hash };
}

export class ClientAuthority {
  constructor(readonly bots: Bots) {}

  async grant(root: string, value: unknown, operationId: string): Promise<JsonObject> {
    const input = object(value, ['name', 'provider', 'scope', 'rights', 'ttlSeconds'], ['client']);
    text(input.name, 80); label(input.provider); label(input.scope);
    const ttl = Number(input.ttlSeconds);
    requireThat(Number.isInteger(input.ttlSeconds) && ttl >= 1 && ttl <= 86_400,
      'client-expiry', 'The operator must choose a 1–86400 second credential lifetime.');
    return this.bots.repository.transaction(async tx => {
      const snapshot = findRoot(tx, root);
      requireThat(snapshot.definition.signer === root && this.bots.signer(root), 'client-authority',
        'An explicitly bound root signer is required to grant AI-client authority.');
      const state = foldState(snapshot);
      permittedScopes(state.scopes, String(input.scope));
      const grants = clientGrants(snapshot);
      const existing = memoryFrames(snapshot).find(f => f.payload.operationId === operationId);
      if (existing) {
        requireThat(existing.payload.event === 'client.granted', 'idempotency-conflict', 'This request ID is already used.');
        const data = grantData(workEvent(existing.payload).data);
        requireThat(data.name === input.name && data.provider === input.provider && data.scope === input.scope
          && data.ttlSeconds === ttl && canonicalJson(data.rights) === canonicalJson(input.rights)
          && (input.client === undefined || input.client === data.client), 'idempotency-conflict', 'The client grant request changed.');
        return { client: data.client, grantWave: existing.frame_hash, capability: null,
          status: 'already-issued', next: 'Credential plaintext is never stored. Explicitly rotate this client if the one-time response was lost.' };
      }
      const client = input.client === undefined ? mintIdentity('local', 'ai-client') : String(input.client);
      requireThat(isBodyStream(client) && (input.client === undefined || grants.has(client)),
        'client-identity', 'Renew only an existing attributed client identity, never a guessed root/peer identity.');
      requireThat(input.client !== undefined || grants.size < AI_LIMITS.clientsPerRoot, 'client-limit', 'This root reached its bounded client catalog.');
      const capability = randomBytes(32).toString('base64url');
      const issuedUtc = this.bots.now();
      const data = grantData({ client, name: input.name, provider: input.provider, scope: input.scope, rights: input.rights,
        tokenHash: sha256(capability), issuedUtc, expiresUtc: new Date(Date.parse(issuedUtc) + ttl * 1_000).toISOString(), ttlSeconds: ttl });
      const frame = await this.bots.appendEvent(tx, snapshot, 'client.granted', data, operationId, data.scope);
      return { client, grantWave: frame.frame_hash, capability, expiresUtc: data.expiresUtc, scope: data.scope,
        rights: data.rights, root, status: 'issued-once' };
    });
  }

  async revoke(root: string, client: string, reason: string, operationId: string): Promise<JsonObject> {
    return this.bots.repository.transaction(async tx => {
      const snapshot = findRoot(tx, root);
      const selected = clientGrants(snapshot).get(client);
      requireThat(selected && this.bots.signer(root), 'client-authority', 'The root operator must revoke an existing client grant.');
      const frame = await this.bots.appendEvent(tx, snapshot, 'client.revoked',
        { client, grantWave: selected.frame.frame_hash, reason: text(reason, 300) }, operationId, selected.data.scope);
      return { client, source: frame.frame_hash, revoked: true };
    });
  }

  authenticate(snapshot: RootSnapshot, root: string, capability: string, rights: readonly AiRight[], atUtc = this.bots.now()): ActiveGrant {
    requireThat(snapshot.definition.root === root && snapshot.definition.signer === root
      && typeof capability === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(capability),
    'client-unauthorized', 'Exact root GUID and independently issued capability authentication are required.');
    const digest = Buffer.from(sha256(capability), 'hex');
    const selected = [...clientGrants(snapshot).values()].find(g =>
      timingSafeEqual(Buffer.from(g.data.tokenHash, 'hex'), digest));
    requireThat(selected?.active && Date.parse(selected.data.expiresUtc) > Date.parse(atUtc)
      && rights.every(right => selected.data.rights.includes(right)), 'client-unauthorized',
    'The root-scoped credential is absent, expired, revoked or lacks this exact capability.');
    const visibility = memoryFrames(snapshot).filter(f => f.payload.event === 'root.visibility').at(-1);
    requireThat(!visibility || workEvent(visibility.payload).data.hidden === false, 'bot-hidden', 'Hidden roots do not serve AI clients.');
    permittedScopes(foldState(snapshot).scopes, selected.data.scope);
    return selected;
  }

  async authorize(root: string, capability: string, rights: readonly AiRight[]): Promise<{ root: RootSnapshot; grant: ActiveGrant }> {
    const selected = await this.authorizeStore(root, capability, rights);
    return { root: selected.root, grant: selected.grant };
  }

  async authorizeStore(root: string, capability: string, rights: readonly AiRight[]):
    Promise<{ snapshot: StoreSnapshot; root: RootSnapshot; grant: ActiveGrant }> {
    const snapshot = await this.bots.repository.snapshot();
    const selected = snapshot.roots.find(candidate => candidate.definition.root === root);
    if (!selected) throw new Refusal('client-unauthorized',
      'Exact root GUID and independently issued capability authentication are required.');
    return { snapshot, root: selected, grant: this.authenticate(selected, root, capability, rights) };
  }
}
