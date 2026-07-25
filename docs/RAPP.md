# OpenRappter on RAPP

OpenRappter is an **organism**. RAPP is the **substrate** it stands on — open,
MIT-licensed, and developed in the open at
[kody-w/rapp-1](https://github.com/kody-w/rapp-1).

That relationship is a claim, and a claim without a gate decays into a sentence
in a README that stopped being true six months ago. So it is checked:

```bash
python3 conformance.py        # 9 checks, proved against the code
```

## What conformance means here

| # | Check |
|---|---|
| R1 | Every agent is a single file matching `*_agent.py` |
| R2 | Every agent declares a `rapp-agent/1.0` `__manifest__` |
| R3 | Every manifest carries the fields the registry needs, with an `@scope/slug` name |
| R4 | Declared capabilities cover everything the code can reach |
| R5 | No agent over-declares a capability it cannot reach |
| R6 | The brainstem keeps wire parity with the RAPP kernel |
| R7 | An agent needs no import from the kernel to be loadable |
| R8 | The RAPP substrate is attributed |
| R9 | The repository contains no credential of its own |

## The capability declaration is derived, not asserted

Every agent's `capabilities` list was produced by reading that agent's own
syntax tree — not by a human deciding what sounded right. That matters because
the same analysis is what an enterprise strain
([kody-w/rapp-light](https://github.com/kody-w/rapp-light)) runs at approval
time and again at load time. An agent that under-declares is refused there.

So R4 is not a style rule. It is the difference between an agent that a governed
enterprise deployment can adopt and one it will withhold.

```python
__manifest__ = {
    "schema": "rapp-agent/1.0",
    "name": "@openrappter/shell",
    "version": "1.0.0",
    "capabilities": ["filesystem-write", "process-exec"],
    ...
}
```

R5 exists for the opposite failure. Over-declaring is not a security hole, but
it is a slow poison: an agent claiming `process-exec` it never uses gets
withheld by an organisation that forbids `process-exec`, for no reason, and the
owner learns to distrust every declaration.

## Portability is the single-file contract

R7 checks that no agent has an unguarded, module-level import of anything in the
kernel beyond `basic_agent`. An import inside a function, or one wrapped in
`try/except ModuleNotFoundError`, is fine — the file still loads alone, which is
the property that matters:

```python
try:
    from openrappter.security.exec_safety import ExecSafety
except ModuleNotFoundError:
    # The brainstem loads single-file agents in isolation. Keep non-shell
    # actions discoverable there, but fail closed if the safety module is absent.
    ExecSafety = None
```

## Kernel parity

`python/openrappter/brainstem.py` is a wire-compatible mirror of the RAPP kernel:
same routes, same JSON envelopes, same single-file agent contract. R6 checks the
routes are all still present and that `/chat` replies in the field `response`,
because those are the surface anything trained against a RAPP brainstem depends
on.

## Credentials

Agents that need real credentials should not read them. See
[RAPP Keyring](https://github.com/kody-w/rapp-keyring) for the broker, and
[rapp-light's credential model](https://github.com/kody-w/rapp-light/blob/main/docs/CREDENTIALS.md)
for how an enterprise governs which agent may use which secret.
