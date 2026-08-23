# XPedition Application Extension API

OpenRappter Personal exposes one stable, tenant-free application/window seam:

```text
openrappter-xpedition-extension/1.0
```

It lets an independently loaded web component become a first-class Start-menu
entry, desktop shortcut, window, taskbar item, and bounded semantic `open_app`
target. OpenRappter does not import or depend on the extension implementation.

## Product and license boundary

OpenRappter is the free/open personal organism. This repository's actual
license is the **Apache License 2.0**; consult [`LICENSE`](../LICENSE) and
[`NOTICE`](../NOTICE) for the governing terms and notices. This documentation
does not describe OpenRappter as MIT.

RapterOS is a separate private SaaS for licensed, isolated business organisms,
including hosted tenancy and training. Its provisioning, billing,
entitlements, tenant records, control plane, and proprietary implementation do
not live in OpenRappter. The two products coordinate only through versioned
interfaces such as this one.

## Runtime API

After the UI entry point loads:

```ts
window.openrappterXpeditionExtensions
```

has exactly:

```ts
interface XpeditionExtensionApiV1 {
  schema: 'openrappter-xpedition-extension/1.0';
  register(extension: XpeditionAppExtensionV1): () => void;
  list(): readonly XpeditionAppExtensionV1[];
}
```

Registration:

```ts
const unregister = window.openrappterXpeditionExtensions!.register({
  schema: 'openrappter-xpedition-extension/1.0',
  id: 'extension:business-operations',
  title: 'Business Operations',
  shortTitle: 'Operations',
  description: 'An independently provided business-organism surface.',
  glyph: 'OPS',
  elementTag: 'rapteros-business-operations',
  desktop: true,
  dataSeams: ['rapteros-business-status/1.0'],
});
```

The consumer must define `elementTag` with `customElements.define()` before the
window opens. If it does not, XPedition displays a truthful unavailable state
with the declared interfaces. It does not invent a placeholder dashboard.

Calling `unregister()` removes the app from future catalog and Start-menu
rendering. Existing core registrations cannot be replaced because extension
IDs must use `extension:<lowercase-kebab-name>`.

## Extension context

The mounted element receives one property:

```ts
interface XpeditionExtensionContextV1 {
  schema: 'openrappter-xpedition-extension-context/1.0';
  product: 'OpenRappter Personal';
  openApp(appId: string): void;
}
```

No gateway token, credential, filesystem capability, tenant identifier,
billing state, entitlement, training data, or control-plane client crosses
this interface. The extension must use its own authenticated, licensed
interfaces and approval boundaries.

`dataSeams` is descriptive evidence shown when an extension is unavailable. It
does not grant capabilities.

## Validation and compatibility

- IDs, labels, tags, glyphs, and seam names are bounded and validated.
- Duplicate IDs, unknown schemas, invalid custom-element names, and empty seam
  declarations are rejected.
- `open_app` accepts an extension ID only while that ID is registered.
- API `1.0` additions must remain backward compatible. A breaking shape
  requires a new schema version rather than silent reinterpretation.
- OpenRappter's default catalog and persisted preferences contain no tenant,
  billing, entitlement, or private control-plane fields.
