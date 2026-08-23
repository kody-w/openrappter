# OpenRappter Personal and separately operated services

OpenRappter is the free/open, local-first personal organism. This repository is
licensed under the **Apache License, Version 2.0** (`LICENSE`). It is not MIT
licensed. The license permits use, modification, creation of derivative works,
and distribution, including commercial use, subject to its actual terms.
Nothing here changes or retroactively relicenses existing OpenRappter code.

Anyone may run OpenRappter, fork it, and self-host or mutate their fork while
complying with Apache-2.0. Those open-source rights do not create an account,
subscription, support obligation, service level, or entitlement in a
separately operated hosted service.

## RapterOS is separate

RapterOS is a separately operated private commercial service and control plane
owned by RapterBox LLC. Access to OpenRappter does not by itself grant access
to RapterOS tenancy, its non-public implementation, private training or
mutation machinery, RapterBox datasets, or any customer/default/personal
organism state. Conversely, RapterOS does not change the OpenRappter license.

The boundary is implementation, service, and data—not a restriction added to
Apache-2.0:

- this repository contains no RapterOS billing or tenant-control-plane code;
- OpenRappter stores no RapterOS customer tenancy or subscription state;
- a hosted service must authenticate and isolate its own customers;
- no separately operated service may treat a personal/default organism as a
  clean customer baseline;
- interoperability uses public, versioned, data-only contracts.

The XPedition `XpeditionExtensionV1` descriptor is one such seam. A descriptor
does not grant host capabilities, secrets, state access, or service
entitlement. See [Windows XPedition](./windows-xpedition.md#external-product-extension-seam).

Product, pricing, privacy, and legal terms for any separately operated service
belong in that service and require its owner/counsel review. This document is a
technical product-boundary explanation, not legal advice.
