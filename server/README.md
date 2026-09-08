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
[host prerequisites](#8-host-prerequisites-four-required-steps). They are
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
8. [Host prerequisites — four required steps](#8-host-prerequisites-four-required-steps)
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
and `server/logs`. Every command in this document is run from the `server/`
directory unless it says otherwise.

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
  [section 8](#8-host-prerequisites-four-required-steps) depends on
  `pm2 startup` finding a supported init system.
- **Development on macOS is expected to work.** Only the boot-persistence step
  is host-specific.

No particular CPU architecture is required. Node.js 24.20.0 and every package
this service depends on support both x86_64 and ARM64 Linux.

**Runtime.** Node.js **24.20.0** (Active LTS, "Krypton") with npm **11.19.0**.
The version is pinned in `server/.nvmrc`, so from the `server/` directory:

```bash
nvm use          # reads .nvmrc -> 24.20.0
node --version   # v24.20.0
npm --version    # 11.19.0
```

`package.json` declares bounded ranges rather than open ones —
`"node": ">=24.20.0 <25"` and `"npm": ">=11.19.0 <12"`. The upper bounds are
the point: an open range would claim support for the Node 26 line, which this
service deliberately does not target, and for npm majors never tested against
the committed lockfile. Raising either ceiling is a conscious decision for
whoever re-verifies the stack, and npm warns when the running toolchain falls
outside the declared range.

**Process manager.** PM2 **7.0.4** and its **pm2-logrotate 3.0.0** module,
installed globally on the host. Installing them is the first of the four
[host prerequisites](#8-host-prerequisites-four-required-steps) and is
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

## 3. Install

Two install paths, deliberately distinct. Both are correct; each belongs to
its own context.

```bash
cd server
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
cd server
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
| `TRUST_PROXY` | `false` | `true` or `false` | Whether Express trusts `X-Forwarded-*` headers. Set `true` only under the conditions in [section 8](#8-host-prerequisites-four-required-steps). |

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
  [section 8](#8-host-prerequisites-four-required-steps).

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

`GET /metrics` does not carry it: the exposition output has no `instance`
label, so the way to tell which worker answered a scrape is the
`process_uptime_seconds` and counter values themselves, or the `pid` and
`instance` on the corresponding access record in the log. See
[section 10](#10-metrics-and-their-honest-limitation).

## 5. Running locally

```bash
cd server
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
identify the worker differently and are both present on purpose: the instance
ordinal is stable across a restart while the pid is not, so a pid that changed
between two probes is how a caller sees that PM2 replaced the worker
underneath it.

**`GET /health/ready`** — readiness. This is the probe a reverse proxy or
supervisor should poll, because it is the one that turns negative while the
service drains.

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/health/ready
# 200        -> {"status":"ready"}
# 503        -> {"status":"shutting_down"}   once a drain has begun
```

**`GET /metrics`** — Prometheus text exposition format. See
[section 10](#10-metrics-and-their-honest-limitation).

```bash
curl -s http://localhost:3000/metrics | head -5
# # HELP http_requests_total Total HTTP requests accepted by this worker since start.
# # TYPE http_requests_total counter
# http_requests_total 3
```

**`POST /api/v1/echo`** — echoes a JSON object or array back with the request
id. The `Content-Type: application/json` header is required.

```bash
curl -s -X POST http://localhost:3000/api/v1/echo \
  -H 'Content-Type: application/json' \
  -d '{"hello":"world"}'
# {"echo":{"hello":"world"},"requestId":"..."}
```

Each of these is a `400`, and each names its own reason in the response
envelope: a body that is not JSON by media type (a form-encoded body
included), an absent body, an empty body, a bare scalar such as `42`, and
malformed JSON. A body over `BODY_LIMIT` is `413`; an unsupported
`Content-Encoding` is `415`.

```bash
# 400 -- media type is not application/json
curl -s -X POST http://localhost:3000/api/v1/echo \
  -H 'Content-Type: application/x-www-form-urlencoded' -d 'a=1'

# 400 -- malformed JSON
curl -s -X POST http://localhost:3000/api/v1/echo \
  -H 'Content-Type: application/json' -d '{"a":'

# 413 -- body over BODY_LIMIT
head -c 200000 /dev/zero | tr '\0' 'x' \
  | curl -s -X POST http://localhost:3000/api/v1/echo \
      -H 'Content-Type: application/json' --data-binary @-
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
[section 8](#8-host-prerequisites-four-required-steps).

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
cancellation of whatever downstream call is slow. This service does not
implement that, because all of its handlers are sub-millisecond — but if you
add a handler that is not, the bound above is the one that applies to it.

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
explicit second step:

```bash
npm run pm2:scale -- 3     # pm2 scale hello-world-service 3
# or, equivalently:
npm run pm2:delete && npm run pm2:start
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

The descriptor also sets `max_memory_restart: '256M'`, so a worker whose
resident memory exceeds that is restarted — an unbounded leak becomes a
bounded, visible restart — and `autorestart` with
`exp_backoff_restart_delay: 100`, so a worker that fails at start-up retries
with widening backoff instead of looping tightly and flooding the logs.


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

That is a 10 MB cap per file, seven rotated files retained, compressed, with a
daily rotation check — bounding `server/logs/` at roughly 70 MB compressed.

A host that already runs the system `logrotate` may instead apply an
equivalent policy to `server/logs/*.log`, in which case it **must** use
`copytruncate`, because PM2 holds the file handles open and a renamed file
would keep receiving writes at its old inode. Either approach is acceptable.
Leaving the question open is not.

### 8.3 Configure boot persistence

Without this the service does not come back after a host reboot. PM2 keeps
processes alive, but nothing keeps PM2 alive across a restart.

```bash
pm2 startup          # requires privilege; prints a command to run as root
npm run pm2:start    # if the application is not already running
pm2 save             # freeze the current process list for resurrection
```

A host that prefers to own the handoff with its own service manager may
instead register a unit that invokes `pm2 resurrect` at boot. Either way the
handoff must be explicit — that is why an init-capable Linux host is the
declared target in [section 2](#2-prerequisites).

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
it displays with the instance id and application name (`2|hello-wo | {…}`),
which is helpful to read and fatal to parse — the prefix sits outside the JSON
object, exactly like the PM2 timestamp discussed below. `logs/out.log` itself
carries no prefix.

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

Every record carries `pid`, `instance` and `service` from the logger's base
fields, plus pino's own `level` and `time`. `instance` is the PM2 cluster
ordinal, or `0` for a directly launched process, so which worker produced a
given line is always recoverable from the line itself — which is why both
workers are allowed to write to one merged pair of files.

**`logs/error.log` is expected to be empty in a clean run.** pino writes
records at *every* level to stdout, so `out.log` carries the whole stream,
`error`- and `fatal`-level records included. `error.log` receives only what
reaches the process's stderr — in practice just the pre-logger
configuration-failure record from [section 11](#11-troubleshooting). Service
records appearing there mean the logger's stream configuration has changed,
not that the service is failing.

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
| `http_requests_by_status_class_total` | counter | Completed requests by response status class, labelled `status_class="1xx"` … `"5xx"` |
| `http_requests_in_flight` | gauge | Requests currently being handled by this worker |
| `process_uptime_seconds` | gauge | Seconds since this worker started |
| `process_resident_memory_bytes` | gauge | Resident set size of this worker |
| `process_cpu_seconds_total` | counter | User plus system CPU time consumed by this worker |

`http_requests_total` is incremented on arrival and the status-class buckets on
completion, so `http_requests_total ≈ sum(status classes) +
http_requests_in_flight`, with equality holding only on an idle process. That
is arithmetic, not drift.

**Counters are per-worker.** Each worker is its own process with its own
counters, and a scrape reaches whichever worker the shared listening socket
assigns it to — so a single scrape sees **one worker's** numbers, and
consecutive scrapes may see different ones. This is inherent to counting
in-process behind a shared port; it is not a bug and there is no setting that
changes it. The correct fix, if metrics ever matter more here than they do
today, is an aggregator in front of the workers, which is out of scope for
this change.

**There is no alerting.** An alert rule needs an alerting system to evaluate
it and a named recipient to receive it, and this project has neither — no
alertmanager rules, no thresholds, no on-call schedule. So: this service is
observable by log inspection, probe polling and metric scraping, but
**nothing notifies anyone**, and a degradation that does not stop the process
is noticed only when someone looks. What would close the gap is a decision,
not more code: name the monitoring destination and the recipient, and the rule
becomes ordinary follow-on work with this endpoint already in place.

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
# {"level":"fatal","time":1767225600000,"pid":1234,
#  "msg":"Configuration validation failed; the listener was never bound",
#  "err":"Invalid environment configuration: PORT must be a whole number (received \"abc\") ...",
#  "failures":["PORT must be a whole number (received \"abc\")"]}
echo $?
# 1
```

Nothing is written to stdout, and `failures` holds one entry per invalid
variable — three bad values produce three entries:

```bash
PORT=abc LOG_LEVEL=warn TRUST_PROXY=maybe npm start 2>&1 >/dev/null | jq -r '.failures[]'
# PORT must be a whole number (received "abc")
# LOG_LEVEL must be one of trace, debug, info (received "warn")
# TRUST_PROXY must be exactly "true" or "false" (received "maybe")
```

It is deliberately not a stack trace. A configuration failure happens before
any logger exists, which is exactly when a legible message matters most, so
this one record is written synchronously to file descriptor 2 with no logger
and no transport. Read `failures` for the structured list, `err` for the
one-line summary, and check the value of each named variable against the table
in [section 4](#4-configuration).

Under PM2 the same failure presents as a worker that restarts with widening
backoff. Look in `logs/error.log`, which is where that record lands.

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
jq -c 'select(.reqId == "<that value>")' logs/out.log
```

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

### Reloads take about eight seconds per worker but report success

The `ready` handshake is not reaching PM2, so it waits out `listen_timeout`
before retiring each outgoing worker. A healthy start or reload of both
workers completes in well under a second. See
[the readiness handshake](#the-readiness-handshake).

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
