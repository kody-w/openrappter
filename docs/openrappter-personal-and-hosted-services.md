# OpenRappter Personal and separately operated services

OpenRappter is the free/open, local-first personal organism. OpenRappter-authored
material is offered under the **Apache License, Version 2.0**, subject to the
root [`LICENSE`](../LICENSE) and [`NOTICE`](../NOTICE). Apache-2.0 permits use,
modification, creation of derivative works, distribution, and commercial use,
subject to its terms. This summary does not replace those files or determine
the license of material authored by someone else.

This is a mixed-license repository. As recorded in `NOTICE`, imported material
under `beta/` and `rapp_brainstem/` remains governed by the MIT license
reproduced at
[`licenses/aibast-agents-library-MIT.txt`](../licenses/aibast-agents-library-MIT.txt).
Individual third-party files and dependencies may carry additional notices.
The applicable license and file-level notice control; this document neither
relicenses them nor makes the legal conclusion that every repository file has
one uniform license.

Anyone may run OpenRappter, fork it, and self-host or mutate their fork while
complying with Apache-2.0. Those open-source rights do not automatically create
an account, subscription, support obligation, service level, or entitlement in
a separately operated hosted service.

## RapterOS is separate

RapterOS is a separately operated private commercial service and control plane
owned by RapterBox LLC. Access to OpenRappter does not by itself grant access to
RapterOS tenancy, its non-public implementation, private training or mutation
machinery, RapterBox datasets, or any customer, default, or personal organism
state. Conversely, RapterOS does not change the OpenRappter license.

The boundary is implementation, service, and data—not a restriction added to
Apache-2.0:

- this repository contains no RapterOS billing or tenant-control-plane code;
- OpenRappter stores no RapterOS customer tenancy or subscription state;
- a hosted service must authenticate and isolate its own customers;
- no separately operated service should treat a personal/default organism as a
  clean customer baseline;
- interoperability uses public, versioned, data-only contracts.

The public `contracts/xpedition-extension-v1.json` schema is one such seam. It
describes display metadata, an approved local route and optional fragment, and
a capability selected from a closed public vocabulary. It cannot name an
external endpoint or private control-plane scope. A descriptor does not grant
that capability, inherit authentication, read local state, or bundle
hosted-service access.

Product, pricing, privacy, and legal terms for any separately operated service
belong in that service and require its owner and qualified-counsel review. This
document is a technical product-boundary explanation, not legal advice and not
a claim of counsel approval.
