# Diagnostics

`Diagnostics` provides bounded, redacted observations, explicit bounded health
checks, and a JSON support export. It has no canonical-store or domain mutation
port. Every record/export is marked `authoritative: false`; neither successful
logs nor health observations prove business completion.

Redaction is fail-closed: raw inputs, outputs, secrets, paths, error objects,
unknown text, and executable/getter values are excluded. Resource identifiers
are salted pseudonyms. Only a narrow set of status codes and numeric counters
survive. Exports are detached from live retention, which is bounded.
Sink/clock failures cannot change application outcomes. Health probes are never
called during construction and timed-out probes return `unconfirmed`.

```sh
npm run build --workspace @rapp-work/diagnostics
npm test --workspace @rapp-work/diagnostics
```
