# Gateway authentication

The gateway is unauthenticated by default. This page says how to turn
authentication on, what it protects, and — as precisely as possible — what it
does not.

## The switch

There is exactly one:

```bash
export OPENRAPPTER_TOKEN="$(openssl rand -hex 32)"
```

`index.ts` reads it once when the daemon starts:

```ts
auth: token ? { mode: 'token', tokens: [token] } : { mode: 'none' },
```

Set, the gateway requires a credential. Unset or empty, `mode` is `none` and
`isAuthCredentialValid` returns `true` for every caller, including one that
presents nothing.

There is no config-file equivalent. `config.security` exists in the schema and
is read by nothing (#219), so setting `approvalPolicy` there does not turn
anything on — `openrappter config validate` will now tell you so.

## Presenting the credential

Three forms are accepted, in this order:

```http
Authorization: Bearer <token>
X-Gateway-Token: <token>
```

or in the request body:

```json
{ "auth": { "token": "<token>" } }
```

The CLI reads `OPENRAPPTER_TOKEN` from the environment and presents it for you,
as do rappters contacting each other over `/twin` and `/chat`. A rappter with no
token sends no authorization header at all rather than a malformed one, so an
unauthenticated neighbourhood keeps working.

## What it protects

`/chat`, `/twin` and `/agents/import` each check the credential **before**
parsing the body, so an unauthenticated caller learns nothing about envelope
validity — otherwise the 400s become an oracle for probing the wire format
without a credential.

That matters more than it sounds. `/chat` runs agents. On a gateway with `mode:
none`, any local caller can execute the shell tool as the user running the
daemon.

## What it does not protect

**The default bind is loopback.** The daemon starts with `bind: 'loopback'`, so
without a token the exposure is to local processes rather than the network. A
token is what raises that boundary from "anything on this machine" to "anything
holding the secret".

**Turning it on has consequences for the neighborhood.** Every peer must hold
the credential. Peers present `OPENRAPPTER_TOKEN` when they have one, so a
device-wide token works today; a peer configured with a different token, or
none, is refused. Where credentials should come from when peers are not meant to
share one is still open (#133).

**Only token mode is reachable from the environment.** The server also supports
a password mode, but nothing sets it from `OPENRAPPTER_TOKEN`, so `mode:
'password'` requires constructing the server directly.

## Checking it works

With the daemon running and a token exported:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST http://127.0.0.1:18790/chat \
  -H 'Content-Type: application/json' \
  -d '{"user_input":"hello"}'
# 401

curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST http://127.0.0.1:18790/chat \
  -H "Authorization: Bearer $OPENRAPPTER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"user_input":"hello"}'
# 200
```

A `401` from the first and a `200` from the second is the whole test. If the
first returns `200`, the daemon was started without the variable in its
environment — it is read at startup, not per request, so exporting it in your
shell after the daemon is already running changes nothing.
