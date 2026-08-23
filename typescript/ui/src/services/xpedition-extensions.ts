export const AUTHORITATIVE_XPEDITION_EXTENSION_SCHEMA_ID =
  'https://openrappter.dev/contracts/xpedition-extension-v1.json' as const;

export const APPROVED_XPEDITION_ROUTE_IDS = [
  'observe',
  'chat',
  'show-and-tell',
  'agents',
  'showcase',
  'flight',
  'skills',
  'channels',
  'sessions',
  'cron',
  'devices',
  'presence',
  'debug',
  'zen',
  'accounts',
  'memory',
  'settings',
  'terminal',
  'help',
] as const;

export type ApprovedXpeditionRouteId =
  (typeof APPROVED_XPEDITION_ROUTE_IDS)[number];

export type ApprovedXpeditionCapability =
  | 'ui:view'
  | 'agent:read'
  | 'channel:read'
  | 'session:read'
  | 'skill:read'
  | 'system:read'
  | 'memory:read';

export interface XpeditionExtensionDescriptorV1 {
  appId: ApprovedXpeditionRouteId;
  capabilityIds?: readonly ApprovedXpeditionCapability[];
  order?: number;
  surfaceVersion: 1;
}

export interface XpeditionExtensionReadResult {
  ok: boolean;
  value?: XpeditionExtensionDescriptorV1;
  error?: string;
}

export interface AuthoritativeXpeditionExtensionReaderV1 {
  schemaId: typeof AUTHORITATIVE_XPEDITION_EXTENSION_SCHEMA_ID;
  read(candidate: unknown): XpeditionExtensionReadResult;
}

export type XpeditionExtensionAppId = `extension:${string}`;

interface RegisteredDescriptor {
  appId: XpeditionExtensionAppId;
  descriptor: XpeditionExtensionDescriptorV1;
}

type ExtensionListener = (
  descriptors: readonly RegisteredDescriptor[],
) => void;

const descriptors = new Map<XpeditionExtensionAppId, RegisteredDescriptor>();
const listeners = new Set<ExtensionListener>();
let authoritativeReader: AuthoritativeXpeditionExtensionReaderV1 | null = null;

function snapshot(): readonly RegisteredDescriptor[] {
  return Object.freeze(
    [...descriptors.values()].map((registration) => Object.freeze({
      appId: registration.appId,
      descriptor: Object.freeze({ ...registration.descriptor }),
    })),
  );
}

function notify(): void {
  const current = snapshot();
  for (const listener of listeners) listener(current);
}

export function installAuthoritativeXpeditionExtensionReader(
  reader: AuthoritativeXpeditionExtensionReaderV1,
): () => void {
  if (reader.schemaId !== AUTHORITATIVE_XPEDITION_EXTENSION_SCHEMA_ID) {
    throw new Error('XPedition reader does not match the authoritative #445 schema id.');
  }
  if (authoritativeReader) {
    throw new Error('The authoritative XPedition descriptor reader is already installed.');
  }
  authoritativeReader = reader;
  return () => {
    authoritativeReader = null;
    descriptors.clear();
    notify();
  };
}

export function registerXpeditionDescriptor(
  candidate: unknown,
): () => void {
  if (!authoritativeReader) {
    throw new Error(
      'XPedition v1 registration is disabled until #445 lands and its authoritative contract reader is installed.',
    );
  }
  const result = authoritativeReader.read(candidate);
  if (!result.ok || !result.value) {
    throw new Error(result.error || 'Descriptor rejected by the authoritative #445 reader.');
  }
  const descriptor = Object.freeze({ ...result.value });
  if (
    descriptor.surfaceVersion !== 1 ||
    !APPROVED_XPEDITION_ROUTE_IDS.includes(descriptor.appId)
  ) {
    throw new Error('Descriptor does not map to an approved local XPedition v1 route.');
  }
  const canonical = Object.freeze({
    appId: descriptor.appId,
    ...(descriptor.capabilityIds
      ? { capabilityIds: Object.freeze([...descriptor.capabilityIds]) }
      : {}),
    ...(descriptor.order === undefined ? {} : { order: descriptor.order }),
    surfaceVersion: 1 as const,
  });
  const appId = `extension:${canonical.appId}` as XpeditionExtensionAppId;
  if (descriptors.has(appId)) {
    throw new Error(`XPedition descriptor is already registered: ${canonical.appId}`);
  }
  descriptors.set(appId, Object.freeze({ appId, descriptor: canonical }));
  notify();
  return () => {
    if (descriptors.delete(appId)) notify();
  };
}

export function listXpeditionDescriptors(): readonly RegisteredDescriptor[] {
  return snapshot();
}

export function xpeditionDescriptor(
  appId: unknown,
): RegisteredDescriptor | null {
  return typeof appId === 'string'
    ? descriptors.get(appId as XpeditionExtensionAppId) ?? null
    : null;
}

export function isRegisteredXpeditionDescriptorId(
  appId: unknown,
): appId is XpeditionExtensionAppId {
  return typeof appId === 'string' &&
    descriptors.has(appId as XpeditionExtensionAppId);
}

export function subscribeXpeditionDescriptors(
  listener: ExtensionListener,
): () => void {
  listeners.add(listener);
  listener(snapshot());
  return () => listeners.delete(listener);
}

export interface XpeditionDescriptorApiV1 {
  schemaId: typeof AUTHORITATIVE_XPEDITION_EXTENSION_SCHEMA_ID;
  register(candidate: unknown): () => void;
  list(): readonly RegisteredDescriptor[];
}

export function installXpeditionDescriptorApi(): XpeditionDescriptorApiV1 {
  const api: XpeditionDescriptorApiV1 = Object.freeze({
    schemaId: AUTHORITATIVE_XPEDITION_EXTENSION_SCHEMA_ID,
    register: registerXpeditionDescriptor,
    list: listXpeditionDescriptors,
  });
  if (globalThis.window) {
    globalThis.window.openrappterXpeditionDescriptors = api;
  }
  return api;
}

declare global {
  interface Window {
    openrappterXpeditionDescriptors?: XpeditionDescriptorApiV1;
  }
}
