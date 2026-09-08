<!-- SPDX-License-Identifier: Apache-2.0 -->
# hello-world-service

The operating manual for this service. It is written for someone with shell
access on the host and no prior context, and it is meant to be sufficient on
its own: installing, configuring, running, deploying, reading the logs and
diagnosing a failure should never require opening a source file.

This file is the single home for three reference tables — the
[configuration variables](#4-configuration), the
[HTTP endpoints](#6-endpoint-reference) and the
[PM2 commands](#7-operating-under-pm2) — together with the
[host prerequisites](#8-host-prerequisites--four-required-steps). They are
deliberately not duplicated in the repository root `README.md`, because a
table maintained in two places diverges.

**Contents**

1. [What this service is, and where it sits](#1-what-this-service-is-and-where-it-sits)
2. [Prerequisites](#2-prerequisites)
3. [Install](#3-install)
4. [Configuration](#4-configuration)
5. [Running locally](#5-running-locally)
6. [Endpoint reference](#6-endpoint-reference)
7. [Operating under PM2](#7-operating-under-pm2)
8. [Host prerequisites — four required steps](#8-host-prerequisites--four-required-steps)
9. [Reading the logs](#9-reading-the-logs)
10. [Metrics, and their honest limitation](#10-metrics-and-their-honest-limitation)
11. [Troubleshooting](#11-troubleshooting)

## 1. What this service is, and where it sits

`hello-world-service` version 1.0.0 is an Express 5 HTTP service written in
CommonJS. It owns a middleware pipeline, a mounted router tree, a single
validated configuration surface, structured NDJSON logging, an in-process
metrics endpoint, and a two-phase drain that lets PM2 reload it without
dropping requests that finish inside the drain budget.

Everything belonging to the service lives under `server/`: the manifest, the
lockfile, the runtime pin, the configuration template, the PM2 descriptor, the
fifteen modules under `server/src/`, and — at run time — `server/node_modules`
and `server/logs`.

**Working directory: `server/`, established once, here.** Every command in
this document is run from `server/`, and no later block repeats the change of
directory — so change into it now, from the repository root:

```bash
cd server        # the only command in this document run from the repository root
```

PM2 depends on this too, not just the reader: the descriptor resolves its
entry script and both log files relative to the directory PM2 is invoked from,
so `server/` is where every `pm2:*` script belongs. Where a command needs a
different directory, the block that carries it says so explicitly.

**Why it is under `server/` rather than at the repository root.** This is a
deliberate separation from the inherited documentation toolchain, not a
technical necessity. `antora-playbook.yaml` at the repository root resolves an
Asciidoctor extension from a root-relative `src/docgen/apiref-macro.js`
(line 53) and its UI assets from a root `./node_modules/@asciidoctor/tabs/dist/`
path (lines 67 and 71). Those paths *could* coexist with a root
`package.json`, so nothing forced this layout — but sharing one package
namespace and one `node_modules` tree between an application and a
documentation pipeline buys nothing. The service installs into
`server/node_modules` and leaves the root `node_modules` that the Antora
toolchain reads untouched, so the Java 17 / Maven / Antora stack behaves
exactly as it did before this service existed. Isolation is cheaper than
entanglement, and it is reversible.

The AsciiDoc documents at the repository root — `README.adoc`,
`BUILDING.adoc`, `SECURITY.adoc`, `FUZZING.adoc`, `RELEASE-NOTES.adoc` and
`CODE_OF_CONDUCT.adoc` — are inherited Apache Logging scaffolding retained for
reference; they describe a different project and have nothing to do with this
service.

## 2. Prerequisites

**Host.** A Linux host with an init system PM2 can register against (systemd
or equivalent). That is the declared target, and two consequences follow
directly:

- **Windows is not a supported host.** The `dev` script uses POSIX inline
  environment assignment (`NODE_ENV=development node src/server.js`), which
  `cmd.exe` and PowerShell do not interpret, and the boot-persistence step in
  [section 8](#8-host-prerequisites--four-required-steps) depends on
  `pm2 startup` finding a supported init system.
- **Development on macOS is expected to work.** Only the boot-persistence step
  is host-specific.

No particular CPU architecture is required. Node.js 24.20.0 and every package
this service depends on support both x86_64 and ARM64 Linux.

**Runtime.** Node.js **24.20.0** (Active LTS, "Krypton") with npm **11.19.0**.
How you install them is your choice — a distribution package, NodeSource, the
official tarball, or a version manager. What matters is that these two
commands report these two versions:

```bash
node --version   # v24.20.0
npm --version    # 11.19.0
```

`server/.nvmrc` pins the version as a bare token, `24.20.0`, so that a host
which already has [nvm](https://github.com/nvm-sh/nvm) can select it without
being told the number:

```bash
nvm use          # reads .nvmrc -> 24.20.0; only if nvm is installed
```

**`.nvmrc` records the version; it does not install nvm and it does not
install Node.** On a host without nvm, install Node 24.20.0 by whatever means
that host uses and check it with `node --version` — every other command in
this document works identically either way, and nvm appears nowhere else in
it.

`package.json` declares bounded ranges rather than open ones —
`"node": ">=24.20.0 <25"` and `"npm": ">=11.19.0 <12"`. The upper bounds are
the point: an open range would claim support for the Node 26 line, which this
service deliberately does not target, and for npm majors never tested against
the committed lockfile. Raising either ceiling is a conscious decision for
whoever re-verifies the stack, and npm warns when the running toolchain falls
outside the declared range.

**Process manager.** PM2 **7.0.4** and its **pm2-logrotate 3.0.0** module,
installed globally on the host. Installing them is the first of the four
[host prerequisites](#8-host-prerequisites--four-required-steps) and is
required before any `pm2:*` script will work.

Neither is a manifest dependency, for two independent reasons:

- **Operationally**, every `pm2:*` script invokes the PM2 CLI at run time. As
  a `devDependency` it would be removed by the production install
  (`npm ci --omit=dev`), leaving the operating commands broken; as a runtime
  dependency it would misdescribe a supervisor as application code, which the
  service never imports.
- **Legally**, `pm2@7.0.4` declares **AGPL-3.0** — the only non-permissive
  licence anywhere in this stack. This repository ships the Apache-2.0
  `LICENSE.txt` and an ASF `NOTICE.txt`, and a strong-copyleft entry in a
  declared dependency tree under those files invites a licence question that a
  global install simply does not raise. `pm2-logrotate` is MIT and raises no
  such question, but it is a PM2 module installed into PM2 itself, which no
  project manifest can express.

PM2 remains the process manager; only its installation location differs. The
descriptor and every script address it through the CLI, so nothing in the
service imports it.

**Operator tools.** The service itself needs none of these — they are what the
examples in this document use, and a generic Linux host does not guarantee
any of them. Each has an alternative, so none is a hard requirement:

| Tool | Used for | If the host does not have it |
|---|---|---|
| `curl` | every HTTP example, from `curl -i http://localhost:3000/` onward | any HTTP client: `wget -qO- <url>`, or `wget -S -O /dev/null <url>` where the examples show response headers |
| `jq` | filtering the NDJSON log stream and reading `pm2 jlist` output | `python3 -m json.tool` to pretty-print one record, or `grep` on the raw lines — every log line is a self-contained JSON object, so line-oriented tools work |
| `nvm` | `nvm use` only, to select the version in `.nvmrc` | install Node 24.20.0 by any other means, as described under **Runtime** above |
| `ss` or `lsof` | finding what already holds `PORT` when a bind fails | either one, or `fuser -n tcp <port>`; a minimal host may have none of the three, in which case install one (`iproute2` provides `ss`) or just test the port — `python3 -c "import socket;print(socket.socket().connect_ex(('127.0.0.1',3000))==0)"` prints `True` when something is listening |

Install what you are missing with the host's package manager before working
through this document — on Debian or Ubuntu, `apt-get install -y curl jq`
covers the first two.

## 3. Install

Two install paths, deliberately distinct. Both are correct; each belongs to
its own context.

```bash
npm ci              # development and validation -- installs pino-pretty
npm ci --omit=dev   # production -- omits pino-pretty
```

**Why omitting `pino-pretty` in production is safe.** `pino-pretty` is the
service's only `devDependency`, and `src/lib/logger.js` constructs the pretty
transport **only** on the non-production branch. In production the logger
never references the package, so its absence from the installed tree cannot be
reached. This is also why the omission is correct rather than merely
tolerable: `pino-pretty` is a development tool that re-adds exactly the
formatting overhead pino exists to avoid, and it has no place in a production
process.

**`npm ci` requires the committed lockfile.** `server/package-lock.json`
(`lockfileVersion` 3, resolving 113 packages) is tracked precisely so that
both installs are reproducible. `npm ci` fails outright without it, and fails
if the lockfile and the manifest disagree — which is the intended behaviour,
not a problem to work around with `npm install`.

## 4. Configuration

Every environment read in this service happens in one module,
`src/config/index.js`. It loads `.env`, applies a default for every variable,
validates everything it finds, and exports a frozen object. No other module
reads `process.env`.

Start from the committed template:

```bash
cp .env.example .env
# then edit .env
```

`.env.example` is the committed contract and carries every default with a
comment. The real `.env` is an operator artefact: it is git-ignored by the
repository root `.gitignore` and **must never be committed**.

### The eight variables

| Variable | Default | Validation | Notes |
|---|---|---|---|
| `PORT` | `3000` | integer, 1–65535 | TCP port the HTTP listener binds. |
| `HOST` | `0.0.0.0` | non-empty string | `0.0.0.0` accepts on every interface; `127.0.0.1` restricts to loopback. |
| `NODE_ENV` | `development` | one of `development`, `test`, `production` | Selects production behaviour: raw NDJSON logs and 5xx messages masked in responses. **PM2 owns this key in production** — see [precedence](#precedence-pm2-beats-env-beats-the-defaults). |
| `LOG_LEVEL` | `info` | one of `trace`, `debug`, `info` | Level of the pino root logger. Nothing higher is accepted — see below. |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | integer, 3000–10000 inclusive | Total drain budget in milliseconds, after which shutdown is forced. |
| `DRAIN_DELAY_MS` | `2000` | integer, 0 to `SHUTDOWN_TIMEOUT_MS − 1000` | The deregistration window inside that budget. |
| `BODY_LIMIT` | `100kb` | matches `^\d+(kb\|mb)?$` case-insensitively, resolving to at most 1 MB | Maximum request body size for both body parsers; a larger body is rejected with `413`. |
| `TRUST_PROXY` | `false` | `true` or `false` | Whether Express trusts `X-Forwarded-*` headers. Set `true` only under the conditions in [section 8](#8-host-prerequisites--four-required-steps). |

**Nothing is mandatory.** A default exists for every variable, so a service
started with no `.env` at all runs on port 3000 in `development` at log level
`info` with `trust proxy` disabled. But anything you *do* supply must be
valid, and **all failures are reported together** — an operator with three bad
values sees three, not just the first. Invalid configuration prevents the
listener from binding at all; the process exits non-zero before serving
anything. See [section 11](#11-troubleshooting) for what that output looks
like.

### The four values that carry a decision

- **`LOG_LEVEL` excludes `warn` and above.** The service guarantees exactly
  one access record per request, emitted at `info` for a successful one. A
  threshold of `warn` would filter those records and make the guarantee false,
  so the validator rejects it rather than letting the log stream quietly lose
  every successful request.
- **`SHUTDOWN_TIMEOUT_MS` is capped at 10000.** It must stay below PM2's
  `kill_timeout` of 12000, which is fixed in `ecosystem.config.js`. The
  resulting 2000 ms margin is the whole point: **the application, not the
  supervisor, decides how a drain ends.** The service's own force-exit timer
  fires first, logs the overrun and exits deliberately, instead of the worker
  being `SIGKILL`ed mid-drain with nothing recorded.
- **`DRAIN_DELAY_MS` is the deregistration window inside that budget.** During
  it, `GET /health/ready` answers `503` while the listener is still accepting,
  so a poller can observe the negative answer and stop sending new work. Its
  ceiling is derived from `SHUTDOWN_TIMEOUT_MS`, so the two cannot be
  configured into contradiction.
- **`TRUST_PROXY` defaults to `false`.** Trusting forwarded headers with no
  known network topology lets any direct client forge `X-Forwarded-For` and
  `X-Forwarded-Proto`, which would then be logged as its real address and
  scheme. Turning it on is a statement about the topology, and the conditions
  under which that statement is true are in
  [section 8](#8-host-prerequisites--four-required-steps).

### Precedence: PM2 beats `.env` beats the defaults

**The real process environment (where PM2 sets `NODE_ENV`) beats `.env`, which
beats the built-in defaults.**

The mechanism matters because the losing value disappears without a trace.
PM2 injects its descriptor's `env` block into each worker's **real**
environment before any application code runs, and `dotenv` is loaded without
`override`, so a key present in both places is won by PM2 and the `.env` value
is **silently ignored** — no warning, no error, nothing in the logs.

That is why `ecosystem.config.js` carries exactly one key,
`NODE_ENV: 'production'`. It is the one value the process topology genuinely
owns: starting under the production descriptor *is* what makes the environment
production. Everything else in the table above belongs to `server/.env`.

> **Warning.** Adding any other key to the descriptor's `env` block silently
> disables its `.env` counterpart. If `PORT` were added there, editing `PORT`
> in `.env` would stop having any effect and nothing would say so.

### `NODE_APP_INSTANCE`

One more variable is read by the configuration module but is **not**
operator-settable, which is why it is deliberately absent from `.env.example`:
`NODE_APP_INSTANCE`, injected by PM2 into each cluster worker. It is parsed as
a non-negative integer and **defaults to `0` when absent**, and it surfaces as
`instance` in the `GET /health` response and on every log line. A process
launched directly with no PM2 therefore reports `instance: 0` rather than
omitting the field, so both payloads have the same shape however the service
was started and no consumer has to handle a missing key.

`GET /metrics` carries it as well: every sample in the exposition is labelled
`service="hello-world-service",instance="<n>"`, so the worker that answered a
scrape is read straight off the labels — the same field name and the same
value as the `instance` in the `GET /health` payload and on every log line.

One note before a real Prometheus server is pointed at this endpoint:
`instance` is also a label Prometheus attaches itself, taken from the scrape
target. With the default `honor_labels: false` the server keeps its own and
renames the one above to `exported_instance`, so a query written against
Prometheus may have to use that name. That is a detail of querying rather than
a defect here — the label is deliberately called `instance` so that
`GET /health`, the metrics output and the logs describe the process
identically. See [section 10](#10-metrics-and-their-honest-limitation).

## 5. Running locally

```bash
npm start           # node src/server.js
npm run dev         # NODE_ENV=development node src/server.js
```

Both bind `HOST:PORT` — `0.0.0.0:3000` with no `.env`. `npm start` respects
whatever `NODE_ENV` the environment or `.env` supplies; `npm run dev` forces
`development` regardless.

Outside production the logger attaches a `pino-pretty` transport, so output is
human-readable text rather than NDJSON. The raw NDJSON contract described in
[section 9](#9-reading-the-logs) applies to production only.

Stop a foreground process with `Ctrl+C`. That is `SIGINT`, which is the same
handled two-phase drain PM2 uses, so expect a `Drain started` line, a pause of
`DRAIN_DELAY_MS`, then `Drain complete; exiting` — not an instant exit. This
is deliberate and is explained in [section 7](#7-operating-under-pm2).

## 6. Endpoint reference

| Method and path | Success | Failure |
|---|---|---|
| `GET /` | `200`, `text/plain; charset=utf-8`, body `Hello, World!\n` | — |
| `GET /health` | `200` JSON `{ status: "ok", service, uptime, pid, instance, timestamp }` | — |
| `GET /health/ready` | `200` JSON `{ status: "ready" }` | `503` JSON `{ status: "shutting_down" }` once a drain has begun |
| `GET /metrics` | `200`, `text/plain; version=0.0.4`, Prometheus exposition format | — |
| `POST /api/v1/echo` | `200` JSON `{ echo: <body>, requestId }` | `400` non-JSON media type, or an absent, empty, non-object or malformed body; `413` over `BODY_LIMIT`; `415` unsupported content encoding |
| any unmatched path | — | `404` JSON `{ error: { status, message, requestId } }` |

Every route is served on `HOST:PORT`. The examples below assume the default
`localhost:3000`.

**`GET /`** — the root response.

```bash
curl -i http://localhost:3000/
# HTTP/1.1 200 OK
# Content-Type: text/plain; charset=utf-8
# Hello, World!
```

**`GET /health`** — liveness. Answers `200` for as long as the process is
running, including while it drains.

```bash
curl -s http://localhost:3000/health
# {"status":"ok","service":"hello-world-service","uptime":12.34,
#  "pid":1234,"instance":0,"timestamp":"2026-01-01T00:00:00.000Z"}
```

`uptime` is fractional seconds since this worker started. `pid` and `instance`
identify the worker differently and are both present on purpose. `pid` is the
current operating-system process id: it names this worker for as long as the
process lives, and a replacement worker comes up with its own, so the number
changes when a worker is replaced. It is not a permanent worker identifier
either, because the operating system may reuse a number once the process that
held it has exited.
`instance` is this application's PM2 cluster ordinal, taken from
`NODE_APP_INSTANCE`: it survives a replacement, because PM2 hands the incoming
worker the ordinal the outgoing one held, and it reads `0` for a directly
launched process.

**A `pid` that changed between two probes does not on its own mean the worker
was replaced.** The two cluster workers share one listening socket, so
consecutive probes are answered by whichever worker that socket assigns — a
different `pid` and a different `instance`, with nothing having restarted.
Read the two fields as a pair: a replacement is the case where **the same
`instance` reports a `pid` it did not report before**, while a different
`instance` is ordinary load distribution and means nothing else. For an
unambiguous answer, use the restart counter in `npm run pm2:status` (the `↺`
column) or the lifecycle records in the log — `Drain started` and
`Drain complete; exiting` for a handled replacement, a `fatal` record for a
worker that died without draining (see
[section 9](#9-reading-the-logs)).

**`GET /health/ready`** — readiness. This is the probe a reverse proxy or
supervisor should poll rather than `/health`, because it is the one that turns
negative while the service drains; liveness stays `200` until the process is
gone.

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/health/ready
# 200        -> {"status":"ready"}
# 503        -> {"status":"shutting_down"}   once a drain has begun
```

**It is not a per-worker routing gate, and must not be configured as one.**
Every cluster worker shares one listening socket, so no external caller can
choose which worker answers it. A poll issued during a `pm2 reload` may come
back `503` from the worker that is draining, or `200` from one that is
healthy, and **no `503` observation is guaranteed at all**: the poll may
simply never land on the draining worker, and with `DRAIN_DELAY_MS=0` — a
valid setting — there is no window in which it could. Treat neither answer as
contractual during a reload. The only case in which the negative answer is
what *every* poll gets is the whole service stopping, whether that is a
single-process deployment or `pm2 stop` on the cluster. (Illustration, not a
promise: on the default two-worker topology a poller at 100 ms intervals
happened to see `503` on 13, 14 and 13 of 120 polls across three reloads.)
What makes a cluster reload a handover is PM2's `ready` overlap and its
retirement of the outgoing worker, not this probe — see
[the readiness handshake](#the-readiness-handshake).

**`GET /metrics`** — Prometheus text exposition format. See
[section 10](#10-metrics-and-their-honest-limitation).

```bash
curl -s http://localhost:3000/metrics | head -5
# # HELP http_requests_total Total HTTP requests accepted by this worker since start.
# # TYPE http_requests_total counter
# http_requests_total 3
```

**`POST /api/v1/echo`** — echoes a JSON object or array back with the request
id. The request must declare `Content-Type: application/json` and must
actually carry a payload.

```bash
curl -s -X POST http://localhost:3000/api/v1/echo \
  -H 'Content-Type: application/json' \
  -d '{"hello":"world"}'
# {"echo":{"hello":"world"},"requestId":"..."}

# 200 -- an empty JSON object is a valid body, echoed back as it arrived
curl -s -X POST http://localhost:3000/api/v1/echo \
  -H 'Content-Type: application/json' -d '{}'
# {"echo":{},"requestId":"..."}

# 200 -- so is an empty array
curl -s -X POST http://localhost:3000/api/v1/echo \
  -H 'Content-Type: application/json' -d '[]'
# {"echo":[],"requestId":"..."}
```

**"Empty" here means an empty payload** — a request that carries no bytes. An
empty JSON object `{}` and an empty array `[]` are deliberate bodies, not
missing ones: both return `200` with `echo` set to exactly what was sent.

Every rejection below is a `400` that names the fault it actually found, in
the same `{ error: { status, message, requestId } }` envelope. The endpoint
owns three messages, checked in this order:

- **A media type that is not `application/json`** — a form-encoded body
  included — is `Request Content-Type must be application/json`. The media
  type is checked first, so a bodyless request declaring any other type is
  answered here as well.
- **No payload** is `Request body is required`. This covers every framing: no
  `Content-Length` at all, `Content-Length: 0`, and a
  `Transfer-Encoding: chunked` message that streams zero bytes. A bodyless
  request that correctly declares `Content-Type: application/json` gets this
  body-specific reason rather than a media-type one.
- **A parsed body that is neither an object nor an array** is `Request body
  must be a JSON object or array`.

Two further rejections come from `express.json()` before the endpoint runs, so
their message is the JSON parser's own and the error handler maps the parser's
`entity.parse.failed` to `400`: **malformed JSON**, e.g.
`Unexpected end of JSON input` for a truncated object, and **a bare scalar
such as `42`**, `Unexpected token '4', "42" is not valid JSON`.

A body over `BODY_LIMIT` is `413` (`request entity too large`); an
unsupported `Content-Encoding` is `415`.

Emptiness is judged on the bytes the parser actually consumed, not on the
parsed value and not on the framing headers alone — `express.json()` turns a
zero-length payload into `{}`, and a chunked message declares no length — so
an empty payload and a literal `{}` are distinguished under every framing.

```bash
# 400 -- no payload at all, even with the JSON media type declared
curl -s -X POST http://localhost:3000/api/v1/echo \
  -H 'Content-Type: application/json'
# {"error":{"status":400,"message":"Request body is required","requestId":"..."}}

# 400 -- a zero-length payload, the same reason
curl -s -X POST http://localhost:3000/api/v1/echo \
  -H 'Content-Type: application/json' --data ''
# {"error":{"status":400,"message":"Request body is required","requestId":"..."}}

# 400 -- a chunked message that streams no bytes, the same reason: an empty
#        payload is rejected whether or not it declares a length
curl -s -X POST http://localhost:3000/api/v1/echo \
  -H 'Content-Type: application/json' -H 'Transfer-Encoding: chunked' --data ''
# {"error":{"status":400,"message":"Request body is required","requestId":"..."}}

# 400 -- media type is not application/json
curl -s -X POST http://localhost:3000/api/v1/echo \
  -H 'Content-Type: application/x-www-form-urlencoded' -d 'a=1'
# {"error":{"status":400,"message":"Request Content-Type must be application/json","requestId":"..."}}

# 400 -- the media type is checked first, so a bodyless request of another
#        type is a media-type fault rather than a missing-body one
curl -s -X POST http://localhost:3000/api/v1/echo -H 'Content-Type: text/plain'
# {"error":{"status":400,"message":"Request Content-Type must be application/json","requestId":"..."}}

# 400 -- malformed JSON, message from the parser
curl -s -X POST http://localhost:3000/api/v1/echo \
  -H 'Content-Type: application/json' -d '{"a":'
# {"error":{"status":400,"message":"Unexpected end of JSON input","requestId":"..."}}

# 413 -- body over BODY_LIMIT
head -c 200000 /dev/zero | tr '\0' 'x' \
  | curl -s -X POST http://localhost:3000/api/v1/echo \
      -H 'Content-Type: application/json' --data-binary @-
# {"error":{"status":413,"message":"request entity too large","requestId":"..."}}

# 415 -- an encoding the parser does not support
curl -s -X POST http://localhost:3000/api/v1/echo \
  -H 'Content-Type: application/json' -H 'Content-Encoding: foo' \
  -d '{"a":1}'
# {"error":{"status":415,"message":"unsupported content encoding \"foo\"","requestId":"..."}}
```

The media-type check is not redundant with the body-shape check: without it, a
form-encoded body would pass the urlencoded parser and arrive at the handler
as a perfectly good object.

**An unmatched path** — the terminal 404 producer.

```bash
curl -s http://localhost:3000/nope
# {"error":{"status":404,"message":"Cannot GET /nope","requestId":"..."}}
```

### Three response shapes, deliberately

- **Application failures** use the `{ error: { status, message, requestId } }`
  envelope — every 4xx and 5xx from the error handler, including the 404.
- **Probe responses** use a flat `{ status: … }` object in both the healthy
  and the draining case. A probe's consumer matches on the status code and a
  small stable body, so the `503` from `/health/ready` is deliberately *not*
  routed through the error handler.
- **`GET /metrics`** returns Prometheus text, not JSON, because that is the
  format a scraper parses.

### `POST /api/v1/echo` is a reference endpoint

It is not a product capability. It exists so that routing and the middleware
pipeline are verifiable end to end — it exercises the JSON parser, the size
limit, three of the five mapped parser statuses, request-id propagation and,
with a large enough response, compression. It is expected to be replaced by
real business routes, and nothing else in the service depends on it.

### Cross-cutting response characteristics

- **Every response carries `x-request-id`.** An inbound `x-request-id` is
  echoed **only** when it matches `^[A-Za-z0-9._-]{1,128}$`; anything else —
  over-length, or containing characters outside that set — is replaced by a
  freshly generated UUID. Accepting an arbitrary inbound value would let a
  caller inject unbounded or structured content into every log line correlated
  with that request.
- **Helmet's default security headers are present on every response**,
  including `Content-Security-Policy`, `Strict-Transport-Security`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN` and
  `Referrer-Policy: no-referrer`.
- **`X-Powered-By` is absent** — the setting is disabled explicitly.
- **Responses above the compression threshold are gzipped** when the client
  sends `Accept-Encoding: gzip`. `GET /` and `GET /health` are both well below
  the threshold and are therefore not compressed in practice; a large
  `POST /api/v1/echo` response is. Note that `Vary: Accept-Encoding` is set on
  every response compression considers, compressed or not — so its presence on
  an uncompressed `GET /` is correct, and `Content-Encoding` is the header
  that tells you whether compression actually happened.

```bash
curl -s -D - -o /dev/null -H 'Accept-Encoding: gzip' \
  -X POST http://localhost:3000/api/v1/echo \
  -H 'Content-Type: application/json' \
  -d "{\"pad\":\"$(head -c 4000 /dev/zero | tr '\0' 'x')\"}" \
  | grep -i -e content-encoding -e vary
# content-encoding: gzip
# vary: Accept-Encoding
```

### Every route is unauthenticated

There is no authentication, no authorization, no CORS policy and no rate
limiting anywhere in this service — all four are out of scope for this
change. That applies to `GET /metrics` as much as to anything else, which is
why restricting it at the proxy is part of
[section 8](#8-host-prerequisites--four-required-steps).

## 7. Operating under PM2

Run these from the `server/` directory. PM2 resolves every path in the
descriptor — the entry script and both log files — relative to the directory
it is invoked from.

| Command | Script | What it does |
|---|---|---|
| start | `npm run pm2:start` | `pm2 start ecosystem.config.js` — starts two cluster workers under the name `hello-world-service` |
| reload | `npm run pm2:reload` | `pm2 reload ecosystem.config.js --update-env` — the drain-aware deploy path; re-reads the descriptor |
| scale | `npm run pm2:scale -- <n>` | `pm2 scale hello-world-service <n>` — change the worker count |
| stop | `npm run pm2:stop` | `pm2 stop ecosystem.config.js` — handled shutdown of every worker, application left registered |
| delete | `npm run pm2:delete` | `pm2 delete ecosystem.config.js` — stop and remove the application from PM2 |
| logs | `npm run pm2:logs` | `pm2 logs hello-world-service` — tail this application's log files |
| status | `npm run pm2:status` | `pm2 status` — the process table: worker list, mode, restart counts |

`npm run pm2:status` is bare `pm2 status`, so it lists every application in
the PM2 registry, not only this one. Note the `--` in the scale command: it is
how npm forwards the worker count through to the underlying `pm2 scale`.

A healthy start looks like this — two workers, `cluster` mode, zero restarts:

```bash
npm run pm2:start && npm run pm2:status
# two rows named hello-world-service, both:
#   mode = cluster   status = online   restarts (↺) = 0
```

If a row shows `errored`, or a restart count that keeps climbing, the worker
is failing at start-up — go to [section 11](#11-troubleshooting).

### The reload guarantee, and its bound

During `pm2 reload`, PM2 starts a replacement worker, waits for that worker's
`ready` message, and only then retires the outgoing worker — which
deregisters, stops accepting new connections, and finishes what it already
holds.

**Requests that finish inside the drain budget finish. A handler still
executing when the budget expires is terminated by the force exit.**

That second sentence is the honest bound, and no setting available here
removes it. In particular, Node's `server.requestTimeout` does not: it limits
how long a *request* may take to **arrive**, not how long a handler may
**run**, so it cannot cap handler execution and this service does not pretend
otherwise. Bounding long-running work would require per-handler deadlines and
cancellation of whatever downstream call is slow, and this service implements
neither.

It ships without them because of what its handlers currently do, which is the
defensible property rather than a latency figure: **every handler does bounded
in-memory work and performs no outbound I/O** — no database, no cache, no HTTP
call to another service, nothing that can block on something outside this
process. The work each one does is bounded by its own input, and on one path
that input is not constant: `POST /api/v1/echo` inspects, serializes and
optionally gzips a body of up to `BODY_LIMIT`, so its cost scales with the
request. No fixed per-handler upper bound is claimed here, and none is
measured by this document — if you need latency numbers, take them from the
`responseTime` field that every access record carries
([section 9](#9-reading-the-logs)), which is the only latency this service
records: `GET /metrics` exposes counts and process figures, not timings.

What that property buys is the reason the missing deadlines have not mattered:
with no outbound call to hang on, a handler cannot be left waiting on a
dependency while the drain budget runs out. **Add a handler that calls
something over the network, or one that iterates over unbounded input, and the
bound above becomes the one that applies to it** — at which point per-handler
deadlines and cancellation stop being optional.

### The readiness handshake

The "waits for that worker's `ready` message" step above is not automatic.
The descriptor sets `wait_ready: true`, and the service answers it by sending
`ready` from inside its listen callback — so PM2 judges a replacement worker
up only once the application says it is listening, rather than treating a
successful fork as sufficient. That overlap, plus the outgoing worker's drain,
is what makes a reload a handover rather than a cut.

`listen_timeout: 8000` bounds that wait. If a worker never sends `ready`, PM2
waits out the full eight seconds and then retires the outgoing worker anyway,
so a **broken handshake presents as every reload stalling for about eight
seconds per worker while still reporting success**. If reloads are suddenly
slow but green, that is the first thing to check.

Do not confuse this with `GET /health/ready`. PM2's readiness is a
process-lifecycle gate — it decides *when PM2 retires the old worker*, and PM2
is not a proxy that withholds traffic from a worker that is already
listening. The HTTP probe is a different thing entirely: it reports drain
state over HTTP.

### The two shutdown phases

Both `pm2 reload` and `pm2 stop` signal the same handled shutdown, so this is
what you are watching in either case:

1. **Deregistration.** Drain state flips, so `GET /health/ready` begins
   answering `503` **while the listener is still accepting**, and the process
   waits `DRAIN_DELAY_MS` (default 2000). This is the window in which a poller
   observes the negative answer and stops sending new work. Without it,
   closing the listener immediately would mean the probe could never be
   answered — the connection would be refused instead.
2. **Drain and exit.** The listener stops accepting, idle keep-alive sockets
   are shed, and when the close completes the process logs
   `Drain complete; exiting`, flushes the logger, releases its PM2 IPC channel
   and exits `0`. A `SHUTDOWN_TIMEOUT_MS` timer forces exit `1` if the drain
   overruns, logging `Drain budget exhausted; forcing exit` first.

The whole sequence is bounded by `SHUTDOWN_TIMEOUT_MS`, which is itself held
below PM2's `kill_timeout` of 12000 so that the application ends its own drain
rather than being killed mid-flight.

### Reload versus scale

**Reload applies code and environment changes. Scale changes how many workers
run.** They are not interchangeable, and the failure mode is quiet.

`pm2:reload` targets the **descriptor file** rather than the registered
process name, and passes `--update-env`, so changed field and environment
values are re-read from `ecosystem.config.js` on every deploy instead of from
PM2's already-registered definition.

But reload does **not** reconcile the worker count. Verified with PM2 7.0.4:
raising `instances` from 2 to 3 and reloading reloads the two registered
workers and stores the new value, while still leaving **two** workers online.
Nothing reports the discrepancy. A change to `instances` therefore needs an
explicit second step, and a third if the host is configured to bring the
service back after a reboot:

```bash
npm run pm2:scale -- 3     # pm2 scale hello-world-service 3
pm2 save                   # persist the new worker count for resurrection
# or, equivalently:
npm run pm2:delete && npm run pm2:start && pm2 save
```

### What needs a `pm2 save`, and what does not

`pm2 save` writes PM2's **saved process list** to `$PM2_HOME/dump.pm2` (by
default `~/.pm2/dump.pm2`), and that file — not the descriptor — is what the
boot-time `pm2 resurrect` in
[section 8.3](#83-configure-boot-persistence) replays. It is a snapshot of the
processes PM2 had registered, *and of the metadata it held for them*, at the
moment you last ran the command. So the rule is broader than worker count:
**any change to PM2's process list or to the metadata it keeps for those
processes — the registration, the worker count, descriptor fields,
environment values — is durable only once you save it.** Skip the save and the
next resurrection replays the previous snapshot, with no warning that it is
stale.

| After this | Save? | Why |
|---|---|---|
| `npm run pm2:start` | **yes** | first registration; nothing is in the saved list until you put it there |
| `npm run pm2:scale -- <n>` | **yes** | the saved list holds one entry per worker, so the old count survives the reboot otherwise |
| `npm run pm2:delete`, then `pm2:start` | **yes** | delete and re-register rewrites the registration the snapshot describes |
| `npm run pm2:delete` alone, retiring the service | **yes** — `pm2 save --force` | with no processes left, plain `pm2 save` refuses: *"PM2 is not managing any process, skipping save"*. Without `--force` the deleted application is still in the snapshot and comes back at the next reboot |
| `npm run pm2:reload` **after changing the descriptor or the environment** | **yes** | reload applies the change to the running processes only. The saved snapshot keeps the values from the last save, so a resurrection would quietly put the old ones back |
| `npm run pm2:reload` for **code only**, with the descriptor and environment unchanged | no | new workers run the new code from the same registration and the same metadata, so the existing snapshot is still accurate |
| `npm run pm2:stop` | no | stop leaves the application registered; the snapshot already describes it, and `pm2 resurrect` starting it again after a reboot is the intended behaviour |

**Why a metadata-changing reload needs its own save**, since this is the row
most easily dismissed: `pm2 reload ecosystem.config.js --update-env` updates
each live process's environment and field values in the running daemon, while
`dump.pm2` is rewritten only by `pm2 save`. Measured with PM2 7.0.4 on a
single-worker application: starting with an environment key set to `v1` and
saving, then changing it to `v2` in the descriptor and reloading, left the
process running `v2` while the snapshot still read `v1` — and a
`pm2 kill && pm2 resurrect`, which is what a reboot does, brought the process
back on `v1`. Running `pm2 save` after the reload made `v2` survive the same
cycle. **A deploy that changes `NODE_ENV`, `instances`, a timeout, or any
other descriptor value therefore ends with `pm2 save`,** or the change lasts
only until the host restarts.

The topology cases were reproduced the same way. Saving with two workers
online and then scaling to three left the snapshot at **two** entries, so what
a resurrection restores is two. Deleting the application without a forced save
left its entries in the snapshot, and `pm2 resurrect` then brought those
workers **back** — a service that had been deliberately retired, running
again. Neither is reported as an error, which is why the save belongs in the
procedure rather than in a footnote. If you are unsure whether the snapshot
matches reality, read it — it holds one entry per saved worker, so counting
the entries for this application tells you the count a reboot would restore:

```bash
jq -r 'group_by(.name)[] | "\(.[0].name): \(length) saved worker(s)"' \
  "${PM2_HOME:-$HOME/.pm2}/dump.pm2"
# hello-world-service: 2 saved worker(s)
```

### Reload versus restart

`pm2 restart` is a coarser instrument rather than an unsafe one. It signals
the same handled shutdown and honours `kill_timeout`, so an accepted request
can still finish within the application's budget — but it retires workers
**without waiting for a ready replacement**, so it opens an availability gap
that reload does not.

Use **reload** for deployments. **Restart** is for recovering a wedged
process.

### Why `instances: 2` and not `'max'`

Two workers buy two things: **redundancy**, so a crashing worker does not take
the service down while `autorestart` replaces it, and **load distribution**
across cores. `'max'` is rejected because it resolves to the host's CPU count,
which on a single-vCPU host or a CPU-constrained container is **one** —
quietly removing both properties while still reading like a throughput
setting.

`instances` is the one field an operator routinely tunes. Raise it for
throughput, and remember it needs `pm2:scale` as well as `pm2:reload`.

The descriptor also sets `max_memory_restart: '256M'`, so a worker found above
that figure is restarted, and `autorestart` with
`exp_backoff_restart_delay: 100`, so a worker that fails at start-up retries
with widening backoff instead of looping tightly and flooding the logs.

**`max_memory_restart` is a polled threshold, not a hard ceiling**, and the
difference matters when you size a host. PM2 samples each worker's resident
memory on its internal worker interval — **roughly every 30 seconds**
(`PM2_WORKER_INTERVAL`, default 30000 ms) — and restarts the worker at the
first sample that exceeds the figure. So a slow leak is caught at 256 MB give
or take a sample, which is what the setting is for: a leaking worker is
replaced, and the restart counter in `npm run pm2:status` makes it visible
instead of silent. But a worker that allocates faster than that sampling
interval can climb well past 256 MB between checks, and on a memory-tight host
the kernel's OOM killer can reach it before PM2's next sample does — in which
case the worker dies without the drain lines and `autorestart` replaces it, as
described in
[a worker vanished with no drain lines](#a-worker-vanished-with-no-drain-lines).

If you need a limit that cannot be overshot, it has to come from below the
supervisor: a cgroup or `systemd` unit limit (`MemoryMax=`), or a container
memory limit. Set that as well as, not instead of, this field — the OS limit
caps the damage, while `max_memory_restart` is what turns a leak into a
recorded restart you can go and look at.


## 8. Host prerequisites — four required steps

All four are **required**, not optional. Each needs host privilege or a host
policy decision, which is why they belong to whoever runs the service rather
than to the application.

### 8.1 Install PM2 and its logrotate module

This is the **first** step of any deployment, before `npm ci --omit=dev`. A
host without it has no supervisor, and every `pm2:*` script fails.

```bash
npm install -g pm2@7.0.4
pm2 install pm2-logrotate@3.0.0
pm2 --version    # 7.0.4
```

### 8.2 Configure log retention

Not discretionary. The descriptor directs both streams to persistent files,
and files that are written and never rotated fill the disk — which takes a
service down more reliably than most application bugs. Apply these settings
once, after installing the module:

```bash
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
```

What those four settings actually do, because the arithmetic is not obvious:

- **`max_size 10M` is a rotation trigger, checked periodically.** The module
  looks at each log file's size on its own worker interval — 30 seconds by
  default — and rotates the file when it is found above 10 MB. A burst can
  therefore carry a file somewhat past 10 MB before the next check sees it.
- **`rotateInterval '0 0 * * *'` forces a rotation at midnight**, size or no
  size. This is in addition to the size trigger, not a schedule for it, so a
  quiet day still produces an archive.
- **`retain 7` keeps seven archives per file, alongside the live file.**
  Rotation copies the log's contents to `<name>__<timestamp>.log[.gz]` and
  then **truncates the original in place** — which is what keeps PM2's open
  file handle valid — so each stream is at most seven archives *plus* its
  current file. This applies to `out.log` and `error.log` independently, and
  to `$PM2_HOME/pm2.log` as well.
- **`compress true` gzips each archive.** The ratio depends entirely on the
  content; NDJSON with repeating keys compresses well, but no fixed figure
  follows from the setting.

**So the settings bound the growth without producing a byte number**, and this
document does not quote one: per stream, up to seven compressed archives of
roughly one rotation window each, plus one uncompressed live file of up to
about `max_size`, with an extra archive appearing on each daily forced
rotation until `retain` starts discarding the oldest. In this service
`error.log` is normally empty
([section 9](#9-reading-the-logs)), so `out.log` dominates in practice — but
that is an observation about this workload, not a guarantee. Measure the real
figure on the host and size the disk from that:

```bash
du -sh logs/                       # total the service's log directory
ls -l logs/                        # the live files and their archives
```

Lower `max_size` or `retain` if that total is more than the host can spare.

A host that already runs the system `logrotate` may instead apply an
equivalent policy to `server/logs/*.log`, in which case it **must** use
`copytruncate`, because PM2 holds the file handles open and a renamed file
would keep receiving writes at its old inode. Either approach is acceptable.
Leaving the question open is not.

### 8.3 Configure boot persistence

Without this the service does not come back after a host reboot. PM2 keeps
processes alive, but nothing keeps PM2 alive across a restart.

This is five steps, and **step 2 is the one that is easy to miss: `pm2 startup`
run without privilege installs nothing.** It prints a command and exits with
an error, and unless you run the command it printed, no startup unit exists —
the service will simply be gone after the next reboot, with nothing having
reported a failure.

**Step 1 — ask PM2 what to run.**

```bash
pm2 startup
```

Run as an unprivileged user, this detects the init system and prints the
command that does the actual work — verified output, with this host's paths
and user in place of yours:

```text
[PM2] Init System found: systemd
[PM2] To setup the Startup Script, copy/paste the following command:
sudo env PATH=$PATH:/usr/local/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u deploy --hp /home/deploy
```

**It then exits non-zero and installs nothing.** That is the expected outcome
of step 1, not a failure to work around — and it is why stopping here leaves
you with no boot persistence at all.

**Step 2 — run the exact command it printed.** Copy it verbatim from your own
terminal; do not retype the example above. Every part of that line is
host-specific: the first path is the directory holding your `node` binary, the
second is your PM2 CLI, and `-u <user>` / `--hp <home>` are what make the
generated unit start PM2 as the right user with the right `PM2_HOME`.

```bash
sudo env PATH=$PATH:/usr/local/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u deploy --hp /home/deploy
```

On success PM2 reports the unit it wrote and the commands it ran — for systemd
that is `/etc/systemd/system/pm2-<user>.service` followed by
`systemctl enable pm2-<user>` — and finishes by telling you to freeze the
process list, which is step 5 below.

If you are already root, `pm2 startup` performs steps 1 and 2 in one go and
prints the same unit path. **Pass the user and home explicitly in that case** —
`pm2 startup systemd -u root --hp /root` — because PM2 derives the unit name
from `$USER`, and a root shell with `$USER` unset yields a unit called
`pm2-undefined`.

**Step 3 — verify the unit exists and is enabled.** Do not take the previous
step's output as proof:

```bash
systemctl is-enabled pm2-deploy      # -> enabled
systemctl status pm2-deploy --no-pager | head -5
cat /etc/systemd/system/pm2-deploy.service
```

Substitute the `-u` value from step 2 for `deploy`. If `is-enabled` reports
`disabled` or the unit is not found, step 2 did not take effect — re-run it
and read its output.

**Step 4 — have the application running.** The saved list in step 5 is a
snapshot of what is running now, so start the service first if it is not
already up:

```bash
npm run pm2:start
npm run pm2:status                   # two workers, online
```

**Step 5 — freeze the process list.**

```bash
pm2 save                             # writes $PM2_HOME/dump.pm2
```

The unit from step 2 runs `pm2 resurrect` at boot, which replays exactly that
file. This is also why every later topology change needs its own save — see
[what needs a `pm2 save`](#what-needs-a-pm2-save-and-what-does-not).

**Verify the whole chain before you rely on it.** The only conclusive test is
a reboot: restart the host, then confirm the workers came back.

```bash
sudo systemctl reboot
# after the host is back:
npm run pm2:status                   # two workers, online, restarts 0
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/health
```

If a reboot is not available, `pm2 kill && pm2 resurrect` exercises the
snapshot half of the chain but **not** the unit half, so it does not
substitute for the test above.

A host that prefers to own the handoff with its own service manager may skip
`pm2 startup` and register its own unit invoking `pm2 resurrect` at boot, with
the same `PM2_HOME` the service runs under; `pm2 save` is still required,
because that unit replays the same file. Either way the handoff must be
explicit — that is why an init-capable Linux host is the declared target in
[section 2](#2-prerequisites).

### 8.4 Configure the reverse proxy and TLS

Required if the service is reachable from outside the host. The service speaks
plain HTTP on `PORT` and terminates no TLS; a proxy in front of it is where
certificates live. Three consequences are visible to the application, and all
three must be handled:

- **Set `TRUST_PROXY=true` only when the topology justifies it** — that is,
  when a proxy is actually in front of the service, is the **sole** path to
  it, and **overwrites rather than appends** client-supplied `X-Forwarded-*`
  headers. If any of those three is untrue, the spoofing that the `false`
  default prevents simply returns through the proxy, and forged addresses end
  up in the logs as real ones.
- **Point the proxy's health check at `GET /health/ready`, not
  `GET /health`.** Readiness is what turns negative during the deregistration
  window, letting the proxy stop sending work before the listener closes. A
  proxy polling `/health` will keep routing to a draining worker, because
  liveness stays `200` until the process is gone.
  **Configure it knowing the bound: this is not a per-worker routing gate.**
  All cluster workers share one listening socket, so the proxy cannot address
  the draining worker. During a `pm2 reload` a poll may return `503` from the
  draining worker or `200` from a healthy one, and **neither answer is
  guaranteed** — so do not build the proxy around either. Two consequences: a
  check that withdraws the upstream on one negative poll withdraws the healthy
  workers with it, so give it a failure threshold; and a check that never sees
  a `503` has learned nothing about whether a worker was draining. Under
  reload the handover comes from PM2's
  `ready` overlap and its retirement of the outgoing worker
  ([the readiness handshake](#the-readiness-handshake)); the `503` is what the
  proxy acts on when the service stops as a whole, and in a single-process
  deployment. Do not build a configuration that assumes the proxy can drain
  individual workers.
- **Restrict `GET /metrics` to internal callers.** It is unauthenticated like
  every other route, and it exposes request counts and process figures.

## 9. Reading the logs

**In production the process writes raw NDJSON**: one JSON object per line on
stdout, which PM2 captures into `logs/out.log`. Configuration-failure output
goes to stderr, captured into `logs/error.log`. Outside production
`pino-pretty` renders human-readable text instead, so **the NDJSON guarantee
is scoped to production**.

```bash
npm run pm2:logs                      # tail both streams via PM2
tail -f logs/out.log                  # the raw NDJSON stream
```

Use the **file** for anything machine-readable. `pm2 logs` prefixes each line
it displays with PM2's own process id (`pm_id`) and the application name,
which is helpful to read and fatal to parse — the prefix sits outside the JSON
object, exactly like the PM2 timestamp discussed below. `logs/out.log` itself
carries no prefix.

The prefix's width is not fixed, and one `npm run pm2:logs` session shows two
forms of it: the historical tail printed first pads the `pm_id|name` pair to
ten characters and **truncates** it (`2|hello-wo | {…}`), while the live lines
streamed afterwards pad the pair to its own length and show it in full
(`2|hello-world-service | {…}`). Neither is worth matching on. Parse the file.

**That `pm_id` is not the `instance` field inside the record.** `pm_id` is
**daemon-global**: the identifier PM2 assigns in its own process registry, the
`id` column of `npm run pm2:status`, counted across every application *and
module* one daemon holds — and it never appears in the JSON. `instance` is
**application-local**: this application's cluster ordinal from
`NODE_APP_INSTANCE`, and the only one of the two the service itself can see.

**Never infer one from the other**, in either direction. Where the two numbers
happen to agree it is incidental and carries no meaning: `pm2-logrotate` is
installed before the service
([section 8.1](#81-install-pm2-and-its-logrotate-module)) and already occupies
a `pm_id`, so this service's `instance` `0` is commonly `pm_id` `1`. Restarts,
scaling and a second application each redraw the relationship in their own
way, and nothing reports it. Correlate on the `instance` and `pid` carried by
the record itself, and treat the console prefix as a reading aid only.

Because every line in the file is a self-contained JSON object, `jq` works one
line at a time:

```bash
# everything correlated with one request id -- note the two paths
jq -c 'select(.req.id == "3f1c..." or .requestId == "3f1c...")' logs/out.log

# every server error (5xx and fatal), with the fields worth seeing
jq -c 'select(.level >= 50) | {time, level, msg, id: (.req.id // .requestId)}' logs/out.log

# which worker served what
jq -r '[.instance, .pid, .msg] | @tsv' logs/out.log | sort | uniq -c
```

**The request id lives at two different JSON paths, by record type.** The
access record carries it as `req.id`, because that is where pino-http puts it
when it serializes the request; the exception record carries it as a top-level
`requestId`. The *value* is identical — that is the whole point of the
correlation key — but a filter that checks only one path silently misses half
the records for the request it is chasing, which is why the example above
tests both.

Every record **pino** writes — which is every record produced once
configuration has succeeded and the logger exists — carries `pid`, `instance`
and `service` from the logger's base fields, plus pino's own `level` and
`time`. `pid` is the operating-system process id and `instance` is the PM2
cluster ordinal, or `0` for a directly launched process, so which worker
produced a given line is always recoverable from the line itself — which is
why both workers are allowed to write to one merged pair of files.

**The one record that carries none of that is the configuration-failure
record**, written by the minimal fallback writer in `src/server.js` *before*
any logger exists. It has `level` — the string `"fatal"`, not pino's numeric
`60` — plus `time`, `pid`, `msg`, `err`, and a `code` naming which kind of
start-up failure it was: `ERR_CONFIG_VALIDATION`, which also carries
`failures`, or `ERR_CONFIG_BOOTSTRAP`, which carries `stack` instead. It has
**no `instance` and no `service`**, so a filter requiring either will skip it,
and it goes to stderr rather than stdout. [Section
11](#11-troubleshooting) shows one in full.

**`logs/error.log` is expected to be empty in a clean run.** pino writes
records at *every* level to stdout, so `out.log` carries the whole stream,
`error`- and `fatal`-level records included, so `out.log` carries the whole
stream. Exactly two records bypass it and go to stderr: the pre-logger
configuration-failure record from [section 11](#11-troubleshooting), and an
`ERR_TERMINAL_FLUSH` record if the log destination reported a failure, or did
not drain inside its bound, while the process was exiting. Both are written
straight to file descriptor 2 — and in the shipped `cluster` topology a
worker's descriptor 2 belongs to the PM2 daemon, while `error_file` is filled
from the `process.stderr` stream, so both land in `pm2 logs`
(`$PM2_HOME/pm2.log`) rather than in `error.log`. An `ERR_TERMINAL_FLUSH`
record wherever it appears is a real log-durability failure — the closing
records of that run may be missing — and is worth investigating rather than
filtering out. Service records appearing in `error.log` mean the logger's
stream configuration has changed, not that the service is failing.

**`time: false` in the descriptor is deliberate.** PM2's `time: true` would
prefix every captured line with a human-readable timestamp, and that prefix
sits *outside* the JSON object — so each line stops being valid JSON and
line-by-line parsing of `out.log` breaks, while the logs still look right to a
human skimming them. Pino already stamps a `time` field inside the object,
where a parser can read it. Do not turn it on.

### The two record types

- **Access record** — exactly **one per request**, emitted when the response
  completes, carrying the request id, method, path, status and response time.
  Its level is derived from the status: 5xx at `error`, 4xx at `warn`,
  everything else at `info`. This one-record-per-request guarantee is what
  constrains `LOG_LEVEL` to `trace`, `debug` and `info`.

  Records store the level as pino's **number**, not its name, which is what
  `jq` filters on: `trace` 10, `debug` 20, `info` 30, `warn` 40, `error` 50,
  `fatal` 60.
- **Exception record** — emitted for **unexpected failures only**, the 500
  class, where the message is masked out of the response and would otherwise
  be lost entirely. Handled outcomes such as a 404 or a rejected body produce
  the **access record alone**: they are ordinary traffic, not incidents, and
  duplicating them at `error` would make the error stream useless.

Both records for the same request carry the **same request id**, which is the
correlation key.

### Redaction and masking

The `authorization` and `cookie` request headers are redacted before anything
is written, so neither ever appears in clear text in the logs. Separately, in
production a 5xx response message is replaced by `Internal Server Error` while
the real message stays in the log — so the log is where a 500 is diagnosed,
and the response body deliberately says nothing useful to a client.

## 10. Metrics, and their honest limitation

`GET /metrics` serves Prometheus text exposition format from in-process
counters. Six metric families, no additional dependency — the counters are
plain integers and the process figures are read from `process` at render time:

| Metric | Type | Meaning |
|---|---|---|
| `http_requests_total` | counter | Requests accepted by this worker since start |
| `http_requests_by_status_class_total` | counter | Responses that **completed**, by status class, labelled `status_class="1xx"` … `"5xx"`; a request the client abandoned mid-response completes nothing and so lands in no bucket |
| `http_requests_in_flight` | gauge | Requests currently being handled by this worker |
| `process_uptime_seconds` | gauge | Seconds since this worker started |
| `process_resident_memory_bytes` | gauge | Resident set size of this worker |
| `process_cpu_seconds_total` | counter | User plus system CPU time consumed by this worker |

Every sample carries the process identity — `service="hello-world-service"`
and `instance="<n>"`, the same pair as the `GET /health` payload and every log
line ([section 4](#4-configuration)) — and the status-class family adds
`status_class` on top of it. Six families, ten sample lines, and the identity
adds no series: one process has one identity.

`http_requests_total` is incremented when a request is **accepted** and the
status-class buckets when its response **completes**. Both moves are
synchronous and paired — the total and the gauge rise together, the gauge
falls and one bucket rises together — so no scrape can catch a half-applied
update, and the relationship is an **exact identity at every point a scrape
can observe** rather than an approximation or something that only holds while
the process is idle: `http_requests_total = sum(status-class buckets) +
http_requests_in_flight + A`.

`A` is the number of requests whose response never completed because the client
destroyed the connection first. Those are real accepted requests, so they are
in the total; they completed nothing, so they are in no status bucket. `A` is
deliberately not a seventh metric family — the six above are the whole
exposition surface — so read the identity like this: **on a worker that has
served no aborted connection the two sides are equal to the digit, and a
shortfall in `sum(buckets)` is the number of aborted responses.**

What the identity rules out is the other direction. A surplus — or a
shortfall on a worker known to have had no aborts — is not arithmetic. It
means a completion that was missed or counted twice, or a response whose
status fell outside `100`–`599`, and either is a defect to find rather than a
figure to explain.

**Counters are per-worker.** Each worker is its own process with its own
counters, and any one read of the endpoint — a `curl` today, a collector's
scrape later — reaches whichever worker the shared listening socket assigns it
to, so it sees **one worker's** numbers and the next read may see a different
worker's. This is inherent to counting in-process behind a shared port; it is
not a bug and there is no setting that changes it. The correct fix, if metrics
ever matter more here than they do today, is an aggregator in front of the
workers, which is out of scope for this change.

**Nothing collects this endpoint.** What this change ships is the Prometheus
exposition endpoint and nothing else around it: **no metrics collector, no
scrape configuration, no dashboard, no alerting system and no alert rule.**
Every one of those is operator or follow-on work. Today the numbers are read
by hand, with the `curl` in [section 6](#6-endpoint-reference), and the
endpoint's value before a collector exists is exactly that it is the interface
a collector is later pointed at, with no application change needed when one
is.

**There is no alerting**, and the reason the rule is absent is worth keeping
straight. An alert rule needs an alerting system to evaluate it and a named
recipient to receive it, and this project has neither — no alertmanager
rules, no thresholds, no on-call schedule. So: this service is observable by
log inspection, probe polling and reading the metrics endpoint, but **nothing
notifies anyone**, and a degradation that does not stop the process is noticed
only when someone looks. What would close the gap is a decision, not more
code: name the monitoring destination and the recipient, and the rule becomes
ordinary follow-on work with this endpoint already in place.

**There is also no automated regression coverage.** The service ships no test
file, no test runner and no `test` script, so the lifecycle, error-mapping and
configuration behaviour described in this document has no automated guard, and
a future change can break it silently.

## 11. Troubleshooting

### The service exits immediately and never binds

Configuration failed validation. The process exits non-zero **before** binding
the listener, naming every invalid variable at once rather than only the
first. The output is **one parseable JSON object on stderr**, written by a
minimal fallback writer used for configuration failures only:

```bash
PORT=abc npm start
# stdout — npm's own lifecycle banner, not a service record:
# > hello-world-service@1.0.0 start
# > node src/server.js
# stderr — one JSON object, wrapped here only for reading:
# {"level":"fatal","time":1767225600000,"pid":1234,
#  "code":"ERR_CONFIG_VALIDATION",
#  "msg":"Configuration validation failed; the listener was never bound",
#  "err":"Invalid environment configuration: PORT must be a whole number (received \"abc\") ...",
#  "failures":["PORT must be a whole number (received \"abc\")"]}
echo $?
# 1
```

**The service writes nothing to stdout on this path** — that one record, on
stderr, is the whole of its output. The stdout lines are npm's lifecycle
banner, which npm 11.19.0 prints for every `npm run` target unless it is
silenced; they belong to npm, not to the service. Where the two streams must
be cleanly separated, use `npm --silent start`, which leaves stdout empty, or
run `node src/server.js` directly.

`failures` holds one entry per invalid variable — three bad values produce
three entries. The redirection below sends stdout to `/dev/null`, so the
banner is discarded and `jq` reads only the record:

```bash
PORT=abc LOG_LEVEL=warn TRUST_PROXY=maybe npm start 2>&1 >/dev/null | jq -r '.failures[]'
# PORT must be a whole number (received "abc")
# LOG_LEVEL must be one of trace, debug, info (received "warn")
# TRUST_PROXY must be exactly "true" or "false" (received "maybe")
```

A validation failure is deliberately not a stack trace. It happens before any
logger exists, which is exactly when a legible message matters most, so this
one record is written synchronously to file descriptor 2 with no logger and no
transport. Read `failures` for the structured list, `err` for the one-line
summary, and check the value of each named variable against the table in
[section 4](#4-configuration).

**Read `code` before editing `server/.env`.** Only
`ERR_CONFIG_VALIDATION` says the environment is at fault. `ERR_CONFIG_BOOTSTRAP`
— or any other code — means the configuration module itself failed to load, so
no variable was ever read: that record carries `stack` in place of `failures`,
and the fault is in the code or the dependency tree rather than in anything an
operator set. Editing `.env` will not move it; read the `stack`.

Under PM2 the same failure presents as a worker that restarts with widening
backoff. In the shipped `cluster` topology the record does **not** reach
`logs/error.log`: it is written straight to file descriptor 2, which in a
cluster worker belongs to the PM2 daemon, while `error_file` is filled from
the `process.stderr` stream. Read it with `npm run pm2:logs`, or find it in
`$PM2_HOME/pm2.log`.

### `EADDRINUSE`, or a permission failure on bind

These surface on the server `error` event, **not** in the listen callback, so
they are logged through the configured logger — `Listener error; exiting` at
`error` level, carrying the error code — and the process exits non-zero.

```bash
jq -c 'select(.msg == "Listener error; exiting")' logs/out.log
# {"level":50,...,"err":{"code":"EADDRINUSE",...},"port":3000,
#  "msg":"Listener error; exiting"}
```

To find what already holds the port, use whichever tool your host provides —
neither is guaranteed to be installed:

```bash
ss -ltnp | grep :3000     # iproute2
lsof -i :3000             # if lsof is available
```

Check for an already-running instance (`npm run pm2:status`), confirm `PORT`
in `.env`, and remember that a port below 1024 needs privilege the service
does not have by default.

### Correlating a user report to a log line

Take the `x-request-id` value from the response headers, or the `requestId`
field from an error envelope, and filter the stream on it. Both the access
record and any exception record for that request carry the same id:

```bash
curl -s -D - -o /dev/null http://localhost:3000/ | grep -i x-request-id
jq -c 'select(.req.id == "<that value>" or .requestId == "<that value>")' logs/out.log
```

Both paths are required, and neither is optional: the access record carries the
id at `.req.id` and the exception record carries it at the top level as
`.requestId`, as [section 9](#9-reading-the-logs) sets out. A filter naming
only one of them silently returns half the story — and there is no top-level
`.reqId` field on any record.

If the caller supplied its own `x-request-id` and it does not appear in the
logs, the value failed the `^[A-Za-z0-9._-]{1,128}$` check and was replaced by
a generated UUID — see
[cross-cutting response characteristics](#cross-cutting-response-characteristics).

### A shutdown looks like it happened twice

It did not. Repeated shutdown signals are idempotent: sending `SIGTERM` twice
in quick succession produces **one** drain, not two. The second signal is
recorded at `debug` level as `Signal ignored; a drain is already under way`,
which is below the default `LOG_LEVEL` of `info` and therefore usually
invisible. Expect exactly one `Drain started` and one `Drain complete` line
per shutdown.

### A worker vanished with no drain lines

That is the fatal path, and it is correct behaviour rather than a bug. After
an `uncaughtException` or an `unhandledRejection` the process state is
undefined, so continuing to accept requests for `DRAIN_DELAY_MS` and then
performing asynchronous cleanup would mean serving traffic from a process that
has already failed. Instead the service logs
`Unrecoverable error; exiting immediately without draining` at `fatal` level,
flushes the logger, releases the PM2 IPC channel and exits `1` **immediately**
— no deregistration window, no listener close.

```bash
jq -c 'select(.level == 60)' logs/out.log
```

PM2's `autorestart` then replaces the worker, which is the right recovery for
a process in an unknown state. So the absence of drain lines here is the
signal, not the defect: find the `fatal` record and fix what threw.

### A slow request was cut off during a deploy

Expected within the stated bound. A handler still executing when
`SHUTDOWN_TIMEOUT_MS` expires is terminated by the force exit, which logs
`Drain budget exhausted; forcing exit` and exits `1`. See
[the reload guarantee](#the-reload-guarantee-and-its-bound). If handlers in
this service legitimately run for seconds, the budget is not the right tool —
per-handler deadlines and cancellation are.

### Reloading did not change the worker count

Reload does not reconcile `instances`; use `npm run pm2:scale -- <n>`. See
[reload versus scale](#reload-versus-scale).

### A reload takes seconds — is that the handshake failing?

Usually not. **A reload is deliberately slower than a start, and the two have
different expected durations** — comparing a reload against start-up time is
what makes a healthy reload look broken.

A **start** brings both workers up in parallel and waits only for their
`ready` messages, so `npm run pm2:start` returns in well under a second — a
few hundred milliseconds on an unloaded host.

A **reload** is sequential and pays the drain budget on each outgoing worker.
PM2 retires them one at a time: it starts a replacement, waits for its
`ready`, signals the outgoing worker, and only moves to the next worker once
that one has exited. Each outgoing worker deregisters, waits the full
`DRAIN_DELAY_MS` (default 2000) while still accepting, then closes and exits.
So the expected duration is roughly:

```text
instances x (DRAIN_DELAY_MS + close time) + replacement start-up
```

With the defaults — two workers, `DRAIN_DELAY_MS=2000` — that is **a little
over four seconds, and it is the correct behaviour**. A measured run on an
idle host: the command returned in 4.6 s, with the first worker's
`Drain started` at +0.3 s and `Drain complete` at +2.3 s, and the second
worker's at +2.5 s and +4.5 s. Requests continued to be served throughout.
Reducing `DRAIN_DELAY_MS` shortens it proportionally; raising `instances`
lengthens it.

**When it *is* the handshake.** A missing `ready` message costs an extra
`listen_timeout` — eight seconds — **per worker**, because PM2 waits out the
whole timeout before accepting the replacement and moving on, and it still
reports success at the end. Measured against a worker deliberately built not
to send `ready`, both with two workers: **`pm2 start` took 16 s** instead of
under one, and **`pm2 reload` took 20 s** instead of 4.6 — that is the eight
seconds and the two-second drain, twice. So the tell is roughly a fourfold
reload and a start that is slow at all, since a healthy start does not pay the
timeout.

Confirm it rather than infer it: a worker that sent `ready` logged
`Service listening` on start-up, so a replacement with no such line is the
broken case.

```bash
# per-worker timings for the last reload, oldest line first
jq -r 'select(.msg | test("Service listening|Drain started|Drain complete")) | "\(.time) \(.pid) \(.msg)"' logs/out.log | tail -8
```

Subtract the timestamps: gaps of about `DRAIN_DELAY_MS` between a worker's
`Drain started` and `Drain complete` are the drain working as designed, while
a gap of about eight seconds before a replacement appears is the handshake
failing. See [the readiness handshake](#the-readiness-handshake).

### Production start-up fails on `pino-pretty`

`MODULE_NOT_FOUND` for `pino-pretty` on a production tree means the logger is
referencing the transport unconditionally instead of only on the
non-production branch. The production install omits the package by design, as
described in [section 3](#3-install); the fix belongs in
`src/lib/logger.js`, not in the install command.

### Verifying a change

There is no CI in this repository and no automated test suite, so nothing runs
on your behalf. Verification is a manual sequence: install both trees, start
the service, exercise the endpoints in
[section 6](#6-endpoint-reference), and confirm the PM2 behaviour in
[section 7](#7-operating-under-pm2) — a reload under load with no failed
response, a topology change through `pm2:scale`, and a clean stop where each
worker logs both drain lines and exits before `kill_timeout`.
