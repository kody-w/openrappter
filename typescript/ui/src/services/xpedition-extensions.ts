export const XPEDITION_EXTENSION_SCHEMA =
  'openrappter-xpedition-extension/1.0' as const;

export type XpeditionExtensionId = `extension:${string}`;

export interface XpeditionAppExtensionV1 {
  schema: typeof XPEDITION_EXTENSION_SCHEMA;
  id: XpeditionExtensionId;
  title: string;
  shortTitle: string;
  description: string;
  glyph: string;
  elementTag: `${string}-${string}`;
  desktop?: boolean;
  dataSeams: readonly string[];
}

type ExtensionListener = (
  extensions: readonly XpeditionAppExtensionV1[],
) => void;

const extensions = new Map<XpeditionExtensionId, XpeditionAppExtensionV1>();
const listeners = new Set<ExtensionListener>();

function bounded(value: unknown, name: string, max: number): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    Array.from(value).length > max
  ) {
    throw new Error(`${name} must be a non-empty string of at most ${max} characters.`);
  }
  return value.trim();
}

function validate(
  candidate: XpeditionAppExtensionV1,
): XpeditionAppExtensionV1 {
  if (candidate.schema !== XPEDITION_EXTENSION_SCHEMA) {
    throw new Error(`Unsupported XPedition extension schema: ${String(candidate.schema)}`);
  }
  if (!/^extension:[a-z0-9][a-z0-9-]{1,62}$/.test(candidate.id)) {
    throw new Error(
      'XPedition extension id must use extension:<lowercase-kebab-name>.',
    );
  }
  if (!/^[a-z][a-z0-9]*-[a-z0-9-]+$/.test(candidate.elementTag)) {
    throw new Error('XPedition extension elementTag must be a valid custom-element name.');
  }
  if (
    !Array.isArray(candidate.dataSeams) ||
    candidate.dataSeams.length === 0 ||
    candidate.dataSeams.length > 20 ||
    candidate.dataSeams.some((seam) =>
      typeof seam !== 'string' ||
      seam.trim() === '' ||
      Array.from(seam).length > 100)
  ) {
    throw new Error('XPedition extension dataSeams must name 1–20 bounded interfaces.');
  }
  return Object.freeze({
    schema: XPEDITION_EXTENSION_SCHEMA,
    id: candidate.id,
    title: bounded(candidate.title, 'title', 80),
    shortTitle: bounded(candidate.shortTitle, 'shortTitle', 40),
    description: bounded(candidate.description, 'description', 240),
    glyph: bounded(candidate.glyph, 'glyph', 8),
    elementTag: candidate.elementTag,
    desktop: candidate.desktop === true,
    dataSeams: Object.freeze(
      candidate.dataSeams.map((seam) => seam.trim()),
    ),
  });
}

function notify(): void {
  const snapshot = listXpeditionExtensions();
  for (const listener of listeners) listener(snapshot);
}

export function registerXpeditionExtension(
  candidate: XpeditionAppExtensionV1,
): () => void {
  const extension = validate(candidate);
  if (extensions.has(extension.id)) {
    throw new Error(`XPedition extension is already registered: ${extension.id}`);
  }
  extensions.set(extension.id, extension);
  notify();
  return () => {
    if (extensions.delete(extension.id)) notify();
  };
}

export function listXpeditionExtensions(): readonly XpeditionAppExtensionV1[] {
  return Object.freeze(
    [...extensions.values()].map((extension) => Object.freeze({
      ...extension,
      dataSeams: Object.freeze([...extension.dataSeams]),
    })),
  );
}

export function xpeditionExtension(
  id: unknown,
): XpeditionAppExtensionV1 | null {
  return typeof id === 'string'
    ? extensions.get(id as XpeditionExtensionId) ?? null
    : null;
}

export function isRegisteredXpeditionExtensionId(
  id: unknown,
): id is XpeditionExtensionId {
  return typeof id === 'string' &&
    extensions.has(id as XpeditionExtensionId);
}

export function subscribeXpeditionExtensions(
  listener: ExtensionListener,
): () => void {
  listeners.add(listener);
  listener(listXpeditionExtensions());
  return () => listeners.delete(listener);
}

export interface XpeditionExtensionApiV1 {
  schema: typeof XPEDITION_EXTENSION_SCHEMA;
  register(extension: XpeditionAppExtensionV1): () => void;
  list(): readonly XpeditionAppExtensionV1[];
}

export function installXpeditionExtensionApi(): XpeditionExtensionApiV1 {
  const api: XpeditionExtensionApiV1 = Object.freeze({
    schema: XPEDITION_EXTENSION_SCHEMA,
    register: registerXpeditionExtension,
    list: listXpeditionExtensions,
  });
  if (globalThis.window) {
    globalThis.window.openrappterXpeditionExtensions = api;
  }
  return api;
}

declare global {
  interface Window {
    openrappterXpeditionExtensions?: XpeditionExtensionApiV1;
  }
}
