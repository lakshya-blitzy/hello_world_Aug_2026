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
cd server
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
installed globally on the host, outside this repository's dependency tree.
Installing them — with PM2's one affected transitive package replaced and the
module taken from a reviewed artefact — is the first of the four
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
values sees three, not just the first. **A blank assignment counts as
supplied**: `KEY=`, or a value that is only whitespace, is rejected rather
than defaulted — `<NAME> was supplied but is empty; blanking a value is not
the same as omitting it` — so to take a default, delete the line or leave the
key out. Invalid configuration prevents the listener from binding at all; the
process exits non-zero before serving anything. See
[section 11](#11-troubleshooting) for what that output looks like.

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
>
> **And deleting the key again does not undo it.** Verified with PM2 7.0.4:
> `pm2 reload … --update-env` adds and changes keys in that block, but a key
> *removed* from it survives in the flattened process environment PM2 keeps
> for the application and is still injected into brand-new workers — so the
> `.env` value stays shadowed after the very deploy that was meant to restore
> it, again with nothing saying so. Retiring a key takes a re-registration,
> `npm run pm2:delete && npm run pm2:start` followed by `pm2 save`, and
> [reload versus scale](#reload-versus-scale) has the sequence and the
> `pm2 env <id>` check that confirms what a worker actually carries.

### `NODE_APP_INSTANCE`

One more variable is read by the configuration module but is **not**
operator-settable, which is why it is deliberately absent from `.env.example`:
`NODE_APP_INSTANCE`, injected by PM2 into each cluster worker. It is parsed as
a non-negative integer and **defaults to `0` when absent**, and it surfaces as
`instance` in the `GET /health` response and on every log line. A process
launched directly with no PM2 therefore reports `instance: 0` rather than
omitting the field, so both payloads have the same shape however the service
was started and no consumer has to handle a missing key.

`GET /metrics` does **not** carry it: the exposition carries no identity
labels at all, deliberately, because the counter store reads no configuration
and the scrape surface is kept to counts and process figures. The instance is
read from the `GET /health` payload or from a log line instead, and a scrape
therefore cannot be attributed to a particular worker. See
[section 10](#10-metrics-and-their-honest-limitation).

## 5. Running locally

```bash
npm start           # node src/server.js
npm run dev         # NODE_ENV=development node src/server.js
```

Both bind `HOST:PORT` — `0.0.0.0:3000` with no `.env`. `npm start` respects
whatever `NODE_ENV` the environment or `.env` supplies; `npm run dev` forces
`development` regardless.

**That default accepts on every interface, and no route authenticates its
caller.** With no `.env`, `HOST` is `0.0.0.0`, so a local run is reachable
from any address that reaches the machine — `GET /metrics`, with its request
counts and process figures, included
([every route is unauthenticated](#every-route-is-unauthenticated)). Run it
that way only on a host you trust to be isolated. Anywhere else, bind to
loopback:

```bash
HOST=127.0.0.1 npm start
```

`HOST=127.0.0.1` in `.env` has the same effect for every later start. A
service that is meant to be reachable from another host belongs behind the
reverse proxy and TLS termination of
[section 8.4](#84-configure-the-reverse-proxy-and-tls), which is also where
`GET /metrics` is restricted to internal callers — not on an open `0.0.0.0`
binding.

Outside production the logger attaches a `pino-pretty` transport, so output is
human-readable text rather than NDJSON. The raw NDJSON contract described in
[section 9](#9-reading-the-logs) applies to production only.

### Stopping it

Stop a foreground run with `Ctrl+C`. That is `SIGINT`, and it works because
the terminal delivers it to the **whole foreground process group** — so it
reaches the `node` process itself, not only the `npm` wrapper in front of it.
What follows is the same handled two-phase drain PM2 uses: a `Drain started`
line, a pause of `DRAIN_DELAY_MS` (default 2000), then
`Drain complete; exiting` and exit `0` — not an instant exit. This is
deliberate, and the two phases are explained in
[section 7](#7-operating-under-pm2).

**A script or a supervisor must not signal the PID of `npm start` or
`npm run dev`.** `npm run-script` relays no signal to the shell subtree it
spawns, and that shell *forks* rather than *execs* `node`, so two processes
stand between the PID a caller captured and the service that handles signals:

```text
npm start                       <- the PID `$!` hands back
└─ sh -c node src/server.js
   └─ node src/server.js        <- the only process with the drain handlers
```

Signalling that wrapper PID has two measured outcomes, both wrong:

- `SIGTERM` kills the wrapper at once — exit `143` in 0.01 s — and
  **orphans the service**, which is reparented to `PPid: 1`, keeps serving
  and keeps the TCP port bound; `GET /health` still answers `200`.
- `SIGINT` is ignored outright: the wrapper was still alive at t+8 s with the
  service still serving, and a scripted `wait` on that PID does not return —
  it blocked past 45 s in one measured run and for about 290 s in another,
  each time until it was abandoned. A naive stop script hangs rather than
  fails, which is the worse failure of the two.

Three forms do work. Prefer the first for anything non-interactive — it is
what `ecosystem.config.js` runs in production — because it removes the
wrapper altogether, so the PID you hold *is* the service:

```bash
# Form 1 -- run the service directly: no npm, no intervening shell.
node src/server.js &          # start it; $! is the node process itself
service=$!                    # keep that PID -- it carries the handlers

# ... the service serves for as long as you need it, then:

kill -TERM "$service"         # opens the two-phase drain
wait "$service"               # returns 0 after 2.01 s, one DRAIN_DELAY_MS

# The log carries one `Drain started` and one `Drain complete; exiting`, and
# the port is free once `wait` returns. `NODE_ENV=development node
# src/server.js` is the `npm run dev` equivalent and behaves identically.
```

If the npm script has to stay, signal the group rather than one PID — the
same thing the terminal does on `Ctrl+C`:

```bash
# Form 2 -- keep npm, signal the whole process group.
# `setsid` makes the run its own group leader, so $! is also the group id.
mkdir -p logs                 # logs/ is where this service's files go, and is
                              # git-ignored -- so a redirect cannot be committed
setsid npm start > logs/run.log 2>&1 < /dev/null &
pgid=$!

# ... the service serves for as long as you need it, then:

kill -TERM -"$pgid"           # the leading minus targets the GROUP, not a PID

# logs/run.log then carries both `Drain started` and `Drain complete; exiting`,
# the port is released after about 2 s, and no member of the group survives.
```

Two caveats come with Form 2, and neither is optional reading:

- **Do not trust its exit status.** `wait "$pgid"` returns `143`
  immediately, because npm dies at once while the service is still draining.
  A script that reads that as "stopped" and checks the port straight away
  finds it briefly still bound. Poll for the port's release instead.
- **`$!` is the group leader only in a non-interactive script**, which is
  where this form belongs; `ps -o pgid= -p $!` equal to `$!` is the check.
  An interactive shell has already put the job in its own group, which makes
  `setsid` fork — and then `$!` is no longer the leader.

The third form keeps npm and reaches past it to the service by walking the
two-process chain above:

```bash
# Form 3 -- keep npm, signal the service PID.
mkdir -p logs                 # as in Form 2: a git-ignored destination
npm start > logs/run.log 2>&1 &
wrapper=$!

# ... the service serves for as long as you need it, then:

# The wrapper's child is `sh -c ...`; that shell's child is the node process.
service=$(pgrep -P "$(pgrep -P "$wrapper" | head -1)" | head -1)
kill -TERM "$service"         # drains exactly as in Form 1
wait "$wrapper"               # wrapper exits 0 after 2.01 s, port then free
```

If a run has already been orphaned, the survivor is still recoverable. Find
it with `pgrep -f 'node src/server.js'`, confirm the working directory of the
PID you get — `ls -l /proc/<pid>/cwd`, because that pattern matches any copy
of this service on the host — and send it `SIGTERM` directly. It drains
normally: `Drain started`, the `DRAIN_DELAY_MS` pause,
`Drain complete; exiting`, and the port is released.

## 6. Endpoint reference

| Method and path | Success | Failure |
|---|---|---|
| `GET /` | `200`, `text/plain; charset=utf-8`, body `Hello, World!\n` | — |
| `GET /health` | `200` JSON `{ status: "ok", service, uptime, pid, instance, timestamp }` | — |
| `GET /health/ready` | `200` JSON `{ status: "ready" }` | `503` JSON `{ status: "shutting_down" }` once a drain has begun |
| `GET /metrics` | `200`, `text/plain; version=0.0.4`, Prometheus exposition format | — |
| `HEAD` on any of the four `GET` paths above | that `GET`'s status and headers, with no body | that `GET`'s failure, with no body |
| `POST /api/v1/echo` | `200` JSON `{ echo: <body>, requestId }` | `400` non-JSON media type, or an absent, empty, non-object, malformed or more-than-64-levels-deep body; `413` over `BODY_LIMIT`; `415` unsupported content encoding |
| any unmatched path | — | `404` JSON `{ error: { status, message, requestId } }` |
| any method other than `GET`, `HEAD` or `POST` | — | `404` JSON `{ error: { status, message, requestId } }`, `OPTIONS` included |

**Each path above is matched exactly as written.** Routing is case-sensitive,
and neither a trailing slash nor an empty path segment is accepted, so
`/METRICS`, `/Metrics`, `/mEtRiCs`, `/metrics/`, `/metrics//`, `/HEALTH`,
`/Health/Ready`, `/health/READY`, `/health/`, `/health/ready/`,
`POST /API/V1/ECHO`, `POST /api/V1/echo`, `POST /api/v1/ECHO` and
`POST /api/v1/echo/` all answer the same `404` envelope as `/nope`. Two
clarifications, because both look like exceptions and neither is:

- **A query string is not part of the path.** `GET /metrics?x=1` is
  `GET /metrics` and is served normally; no route reads a query parameter.
- **A client may rewrite your path before it is sent.** `curl` resolves dot
  segments itself, so `curl http://localhost:3000/./metrics` requests
  `/metrics` and succeeds. Sent literally, `/./metrics` is a `404` like any
  other unmatched path.

This exactness is the reason
[section 8.4](#84-configure-the-reverse-proxy-and-tls)'s one-line proxy rule
for `/metrics` is sufficient rather than approximate: the served set equals the
table above, so a rule matching the documented spelling matches everything the
service will answer.

**`GET`, `HEAD` and `POST` reach the routes above; nothing else does.** A
method gate ahead of the mounts admits those three, so every other method —
`OPTIONS` included — falls through to the same terminal `404` envelope, whose
message names the method it rejected (`Cannot OPTIONS /health`). The gate
writes no status, body or header of its own, so **no `405` and no `Allow`
header is produced on any path** — `OPTIONS` is a plain `404` rather than the
`200` with `Allow` Express would otherwise send, and suppressing that is the
gate's only purpose.

**`HEAD` is served on all four read paths** — `/`, `/health`, `/health/ready`
and `/metrics` — and answers with **the same status and the same headers as
the matching `GET`, and no body**, which is what RFC 9110 requires. No route
declares a `HEAD` handler and none needs to: Express answers `HEAD` from the
path's own `GET` route, and Node suppresses the body. Two consequences are
worth knowing before you configure anything against it:

- **A `HEAD` probe is a valid health check.** `HEAD /health/ready` returns the
  same `200` and the same draining `503` as the `GET`, so a proxy, load
  balancer or uptime monitor that probes with `HEAD` — HAProxy's
  `option httpchk HEAD /` and many CDN and LB defaults do — reads the
  readiness state correctly from the status line.
  [Section 8.4](#84-configure-the-reverse-proxy-and-tls) still specifies
  `GET /health/ready` for the proxy, because a `GET` also returns the body,
  which is the more useful thing to have in a proxy's own log; a `HEAD` check
  is supported rather than preferred.
- **`curl -I` works, including on `/metrics`.** It is the cheapest way to read
  that endpoint's `text/plain; version=0.0.4` content type without
  downloading the exposition document. On `/` and the two probes the `HEAD`
  answer keeps the `Content-Length` of the body a `GET` would return, so the
  header describes the representation rather than the empty wire; `/metrics`
  sets no `Content-Length` on either method, so its `HEAD` answer carries none.

`HEAD` on a path with no `GET` is a `404` like any other unmatched request:
`HEAD /api/v1/echo` is `404`, because `/api/v1/echo` declares `POST` only and
there is no `GET` for a `HEAD` to mirror.

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
single-process deployment or `pm2 stop` on the cluster. What makes a cluster
reload a handover is PM2's `ready` overlap and its retirement of the outgoing
worker, not this probe — see
[the readiness handshake](#the-readiness-handshake).

**`GET /metrics`** — Prometheus text exposition format. No sample carries
any label except `status_class` on the status-class family. See
[section 10](#10-metrics-and-their-honest-limitation).

```bash
curl -s http://localhost:3000/metrics | head -6
# # HELP http_requests_total Total HTTP requests accepted by this worker since start.
# # TYPE http_requests_total counter
# http_requests_total 3
# # HELP http_requests_by_status_class_total Completed HTTP requests by response status class.
# # TYPE http_requests_by_status_class_total counter
# http_requests_by_status_class_total{status_class="1xx"} 0
```

**`POST /api/v1/echo`** — echoes a JSON object or array back with the request
id. The request must declare `Content-Type: application/json`, it must actually
carry a payload, the parsed body must be a JSON object — an empty one
included — or an array, and it must not nest more than **64 levels** deep.

```bash
curl -s -X POST http://localhost:3000/api/v1/echo \
  -H 'Content-Type: application/json' \
  -d '{"hello":"world"}'
# {"echo":{"hello":"world"},"requestId":"..."}

# 200 -- an empty array is a valid body, echoed back as it arrived
curl -s -X POST http://localhost:3000/api/v1/echo \
  -H 'Content-Type: application/json' -d '[]'
# {"echo":[],"requestId":"..."}
```

**An empty JSON object `{}` is echoed at `200` like any other object; what is
rejected is an empty PAYLOAD.** The two look alike from inside the endpoint and
are told apart deliberately, because the parser conflates them:
`express.json()` special-cases a payload of no bytes and yields `{}` for it
rather than raising a parse error, so a request that carried no bytes and a
request that carried the two bytes `{}` reach the endpoint as the same parsed
value. The endpoint therefore judges emptiness on the raw payload's BYTE COUNT,
recorded as the payload goes past body-parser position 4 in the pipeline, and
never on the parsed value: two bytes is a body, zero bytes is not. `{}` and
`[]` are symmetric under that rule — both are bodies a client sent
deliberately, and both are echoed back unchanged.

Every rejection below is a `400` that names the fault it actually found, in
the same `{ error: { status, message, requestId } }` envelope. The endpoint
owns four messages, checked in this order:

- **A media type that is not `application/json`** — a form-encoded body
  included — is `Request Content-Type must be application/json`. The media type
  is checked first, so a bodyless request declaring any other type is answered
  here as well, and so is a request that sends no payload framing at all: with
  neither a `Content-Length` nor a `Transfer-Encoding` header there is no
  payload for the declared media type to describe, which is what a
  `curl -X POST` with no `--data` sends.
- **An empty payload** is `Request body is required`. That covers a
  zero-length payload (`Content-Length: 0`) and a `Transfer-Encoding: chunked`
  message that streams no bytes — the two ways to declare a body and then send
  no bytes of one. A literal `{}` is **not** covered: it carried two bytes, so
  it is a body and is echoed.
- **A parsed body that is neither an object nor an array** is `Request body
  must be a JSON object or array`.
- **A body nested deeper than 64 levels** is `Request body must not nest
  deeper than 64 levels`. Depth is counted in containers — the body itself is
  level 1, a container inside it is level 2 — and the bound is inclusive, so a
  body at exactly 64 levels is echoed and one at 65 is rejected. The reason is
  the echo itself: writing the response serialises the body with
  `JSON.stringify`, which recurses once per level, so an unbounded structure
  would exhaust the stack **inside the response writer** and be reported as a
  server fault — a `500`, an `error`-level exception record, and an increment
  of the `5xx` bucket of [`/metrics`](#10-metrics-and-their-honest-limitation),
  which is the signal for the service failing rather than for a caller sending
  a body it will not echo. A 10 KB request can nest 5000 levels, so the size
  limit is no protection at this depth and the bound is a separate check. 64 is
  far below the depth at which serialisation actually breaks (measured between
  4300 and 4400 on this build) because that figure is a property of the
  available stack rather than a contract: it moves with the Node build and the
  call depth the request arrives on, and a limit set near it would answer one
  identical request differently from one day to the next. It is a fixed part of
  the endpoint's contract, not an operator setting — the eight variables in
  section 4 remain the whole of what a deployment configures.

Two further rejections come from `express.json()` before the endpoint runs, so
their message is the JSON parser's own and the error handler maps the parser's
`entity.parse.failed` to `400`: **malformed JSON**, e.g.
`Unexpected end of JSON input` for a truncated object, and **a bare scalar
such as `42`**, `Unexpected token '4', "42" is not valid JSON`.

A body over `BODY_LIMIT` is `413` (`request entity too large`). An unsupported
`Content-Encoding` is `415`, and so is an unsupported **charset** on the
`Content-Type` — `application/json; charset=…` — a different header and a
different rejection that happens to share the status. A body that declares an
encoding the parser *does* support — `gzip`, `deflate` or `br` — and then
cannot be decompressed is a `400` carrying the decompressor's own message
(`incorrect header check` for gzip and deflate, `Decompression failed` for
brotli). All three are the client's fault and are answered as such, which also
keeps them out of the `5xx` bucket of
[`/metrics`](#10-metrics-and-their-honest-limitation) — that bucket is the
signal for the service failing, not for a caller sending a corrupt upload.

Four in-memory checks run, in this order: the media type, then the raw
payload's byte count for an empty payload, then the parsed shape, then the
nesting depth. Emptiness is judged on that byte count — captured while the
payload is still a buffer, which is the only moment it exists — rather than on
the parsed value, which cannot tell an absent payload from a literal `{}`.
Depth is checked last because it is the only one of the four that walks the
parsed body; it walks it level by level rather than recursively, and stops at
the first container past the bound, so rejecting a 5000-level payload costs
about 65 steps. Nothing re-reads the request stream, and no framing header is
inspected on its own.

```bash
# 400 -- no payload framing at all, so the media type has nothing to describe
curl -s -X POST http://localhost:3000/api/v1/echo \
  -H 'Content-Type: application/json'
# {"error":{"status":400,"message":"Request Content-Type must be application/json","requestId":"..."}}

# 200 -- a literal empty object is a body: two bytes were sent, so it is
#        echoed back unchanged
curl -s -X POST http://localhost:3000/api/v1/echo \
  -H 'Content-Type: application/json' -d '{}'
# {"echo":{},"requestId":"..."}

# 400 -- a zero-length payload: a body was declared and no bytes were sent
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

# 400 -- nested deeper than 64 levels. 5000 levels of array is 10 KB, well
#        inside BODY_LIMIT, which is why depth is bounded on its own
python3 -c "print('['*5000 + ']'*5000, end='')" \
  | curl -s -X POST http://localhost:3000/api/v1/echo \
      -H 'Content-Type: application/json' --data-binary @-
# {"error":{"status":400,"message":"Request body must not nest deeper than 64 levels","requestId":"..."}}

# 200 -- exactly 64 levels is accepted: the bound is inclusive
python3 -c "print('['*64 + ']'*64, end='')" \
  | curl -s -X POST http://localhost:3000/api/v1/echo \
      -H 'Content-Type: application/json' --data-binary @-
# {"echo":[[[...]]],"requestId":"..."}

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

# 415 -- a charset the parser cannot decode, on an otherwise valid media type
curl -s -X POST http://localhost:3000/api/v1/echo \
  -H 'Content-Type: application/json; charset=nonesuch' \
  -d '{"a":1}'
# {"error":{"status":415,"message":"unsupported charset \"NONESUCH\"","requestId":"..."}}

# 400 -- a supported encoding whose payload will not decompress
printf 'not really gzip' | curl -s -X POST http://localhost:3000/api/v1/echo \
  -H 'Content-Type: application/json' -H 'Content-Encoding: gzip' \
  --data-binary @-
# {"error":{"status":400,"message":"incorrect header check","requestId":"..."}}
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
limit, four of the six mapped parser statuses, request-id propagation and,
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
- **No response carries an `ETag`.** Validator generation is disabled for the
  whole application, so no response — including any route added later — can be
  revalidated against this service with a conditional request.
- **Both probe responses carry `Cache-Control: no-store`.** `GET /health` and
  `GET /health/ready` forbid storage outright, because a stored
  `{"status":"ready"}` replayed by an intermediary during a drain would report
  a worker as available exactly when it is being withdrawn. No other response
  sets a cache directive of its own.
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

Because the proxy rule is the only control there is, what the service serves
has to match what that rule can express, and it does: routing is
case-sensitive and slash-exact, so `/metrics` is the single spelling that
reaches the handler. An exact, case-sensitive path rule — which is what every
common proxy writes by default — therefore covers the endpoint completely,
with no case-insensitive or trailing-slash variant left open behind it.

## 7. Operating under PM2

Run these from the `server/` directory. PM2 resolves every path in the
descriptor — the entry script and both log files — relative to the directory
it is invoked from.

| Command | Script | What it does |
|---|---|---|
| start | `npm run pm2:start` | `pm2 start ecosystem.config.js` — starts two cluster workers under the name `hello-world-service` |
| reload | `npm run pm2:reload` | `pm2 reload ecosystem.config.js --update-env` — the drain-aware deploy path; re-reads the descriptor |
| scale | `npm run pm2:scale -- <n>` | `pm2 scale hello-world-service <n>` — change the worker count. **`<n>` must be at least 1:** `-- 0` deletes the application rather than stopping it, and [`pm2:scale` cannot undo that](#reload-versus-scale) |
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

**What PM2's own daemon log looks like while that happens, because it reads
worse than it is.** For every retiring worker, `$PM2_HOME/pm2.log` —
`pm2 logs PM2`, not `npm run pm2:logs` — fills with
`pid=<n> msg=failed to kill - retrying in 100ms`, one line every 100 ms for as
long as the drain lasts, so a healthy in-budget reload writes 15 to 37 of them
per worker. **That is PM2 polling whether the pid has gone, not a repeated
signal and not a failed kill**, and the line to read is the one immediately
after them: `exited with code [0] via signal [SIGINT]`, which is the clean
case. A signal genuinely delivered twice would leave its trace in the
*service's* log instead, as the `debug`-level record
`Signal ignored; a drain is already under way` — and that record does not
appear during a reload, because the application receives exactly one signal.
The reproduction and the counting command are in
[section 11](#11-troubleshooting).

### Reload versus scale

**Reload applies code and environment changes. Scale changes how many workers
run.** They are not interchangeable, and the failure mode is quiet.

`pm2:reload` targets the **descriptor file** rather than the registered
process name, and passes `--update-env`, so changed field and environment
values are re-read from `ecosystem.config.js` on every deploy instead of from
PM2's already-registered definition.

**One thing `--update-env` does not do: remove an environment key you deleted
from the descriptor.** Verified with PM2 7.0.4. Adding a key to the `env`
block reaches the new workers, and changing a key's value propagates — but
deleting the key does not take it away. PM2 re-reads the block, so its record
of the block itself loses the key, while the flattened copy the daemon keeps
for the application survives and is still injected into **brand-new** workers.
A worker started by that reload therefore still carries the old value, and any
`.env` entry the key was shadowing
([section 4](#precedence-pm2-beats-env-beats-the-defaults)) is still being
ignored. The recovery is a re-registration rather than another reload:

```bash
npm run pm2:delete && npm run pm2:start   # the key is gone from the workers
pm2 save                                  # a new registration; persist it
pm2 env <id>                              # confirm what a worker carries
```

`pm2 env <id>`, with the id from `npm run pm2:status`, is the check that
settles it: it prints what PM2 injects, rather than what the descriptor now
says it should inject — and for a key that came from the `env` block, what PM2
injects is exactly what the worker carries. It is not the worker's whole
environment: values that reach the process from `server/.env` are loaded by
`dotenv` inside the process and never appear here, so `PORT` being absent from
this output while the service is plainly bound to it is correct rather than a
discrepancy. The `pm2 save` is required for the reason in
[what needs a `pm2 save`](#what-needs-a-pm2-save-and-what-does-not) — delete
and re-register rewrites the registration the saved snapshot describes.

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

> **`<n>` must be at least 1, and `-- 0` is not a stop.** Verified with PM2
> 7.0.4: `npm run pm2:scale -- 0` exits **`0`** while **deleting the
> application from PM2 entirely** — both workers removed, no row left in
> `pm2 status`, the port free and every request refused. And the obvious
> recovery does not work, because there is no longer an application of that
> name to scale: `npm run pm2:scale -- 2` fails with
> `[PM2][ERROR] Application hello-world-service not found`. Two commands do
> recover it, and both were verified:
>
> ```bash
> npm run pm2:start    # re-register and start from the descriptor
> npm run pm2:reload   # also works: warns "Applications hello-world-service
>                      # not running, starting…", honours wait_ready, and
>                      # brings both instances up from the descriptor
> pm2 save             # either way the registration is new — persist it
> ```
>
> Follow either with `pm2 save`, for the reason in
> [what needs a `pm2 save`](#what-needs-a-pm2-save-and-what-does-not): the
> registration is new, and an unsaved one is not what a reboot restores. **To
> stop serving without deregistering, use `npm run pm2:stop`** — it leaves the
> application in the registry, which is what keeps the saved snapshot accurate
> and lets `npm run pm2:start` bring it back.

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
`dump.pm2` is rewritten only by `pm2 save`. The two therefore diverge the
moment a reload changes a value: the live processes carry the new one, the
snapshot still carries the one written at the last save, and a resurrection
replays the saved one. **A deploy that changes `NODE_ENV`, `instances`, a
timeout, or any other descriptor value therefore ends with `pm2 save`,** or
the change lasts only until the host restarts.

The topology cases follow from the same split. The saved list holds one entry
per saved worker, so a scale that is not saved is not restored: what a
resurrection brings up is the worker count the snapshot held when it was last
written. And a delete without `pm2 save --force` leaves the retired
application's entries in the snapshot, so a resurrection starts those workers
**again** — a service that had been deliberately retired, running. Neither
condition is reported as an error, which is why the save belongs in the
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

**The heap half of the same budget: `node_args: ['--max-old-space-size=192']`.**
A restart threshold on its own has nothing on the other side of it. Node sizes
V8's heap from **host** memory unless it is told otherwise, and on the host
these figures were measured on that is a `heap_size_limit` of **4288 MiB —
16.7 times the 256 MB threshold** — so V8 has no reason to collect anywhere
near the threshold, and whatever headroom the service keeps under load is a
property of how much memory the host has rather than of anything the
descriptor says. The descriptor therefore declares the heap figure as well:
192 MB of old space, which Node 24.20.0 reports as a `heap_size_limit` of
384 MiB once the other heap spaces are counted.

What that changed under sustained large-body `POST /api/v1/echo` load is
below, and **the two resident-memory sources disagree materially, so both are
quoted** — PM2 samples its own figure and compares *that* against
`max_memory_restart`, while `VmRSS` is what `ps` and `/proc` report to an
operator:

| Heap sizing | PM2's sampled figure | `VmRSS` (`ps`, `/proc`) |
|---|---|---|
| Host-derived, no `node_args` | 168.1 MiB — 65.7% of the threshold | 239.8 MiB — **93.7%**, i.e. 6.3% of headroom left |
| Declared, `--max-old-space-size=192` | 134.3 MiB — 52.5% | 155.3 MiB — 60.7% |

The shape changed as well as the figure: with the heap declared, resident
memory reached a **flat plateau** and stayed there across twelve equal request
batches and across idle, instead of still stepping upward while the load
continued. Both runs served every request correctly.

**This is not a cap on the process, and the paragraphs above still apply.**
Resident memory is the heap *plus* external buffers *plus* native allocation,
so the flag bounds the dominant term and not the total: `max_memory_restart`
remains the safety net, and an OS-level limit remains the only figure that
cannot be overshot. Nor is the plateau a guarantee — it is what this workload
measured on one host, and a different body size, concurrency or host will move
it. The flag also binds **only the workers PM2 launches**: `npm start` and
`npm run dev` read no descriptor at all and get the host-derived heap.

**So the two fields move together.** They are one budget in two halves, like
`SHUTDOWN_TIMEOUT_MS` and `kill_timeout`: change either and re-check the
other, and keep **the figure in the flag** — the `192`, not the 384 MiB
`heap_size_limit` V8 derives from it — below the restart threshold. Raise it
past the threshold and the threshold stops being a safety net and becomes an
operational trigger: ordinary steady-state growth ends up on the wrong side of
it, and PM2 restarts workers that are doing nothing wrong. Neither number is
the one PM2 compares, which is worth keeping straight — PM2 measures
**resident** memory, and the flag's contribution is to bound the largest part
of it.


## 8. Host prerequisites — four required steps

All four are **required**, not optional. Each needs host privilege or a host
policy decision, which is why they belong to whoever runs the service rather
than to the application.

### 8.1 Install PM2 and its logrotate module

This is the **first** step of any deployment, before `npm ci --omit=dev`. A
host without it has no supervisor, and every `pm2:*` script fails.

The two versions are fixed — PM2 **7.0.4** and `pm2-logrotate` **3.0.0** — and
both are installed globally on the host rather than declared in
`server/package.json`, for the reasons in [section 2](#2-prerequisites).
**Pinning those two versions does not pin what they install**, and that is the
whole of this step's difficulty:

- **PM2 7.0.4 depends on `js-yaml` 4.3.1 exactly**, and that release is
  affected by GHSA-2883-xcg3-v3hh (CVE-2026-84375): repeated empty YAML merge
  sources force quadratic CPU work. It is fixed in 4.3.2, the highest 4.x. The
  dependency is an exact version rather than a range, so every install
  resolves the affected release, and `npm audit fix --force` offers only to
  downgrade PM2 to 5.3.1, which is not this supervisor.
- **`pm2-logrotate` 3.0.0 declares `pm2: "latest"` and `pmx: "latest"`**, plus
  caret ranges for `graceful-fs`, `node-schedule` and `moment-timezone`. And
  `pm2 install <name>` runs `npm install` under `$PM2_HOME/modules/<name>`
  behind a wrapper manifest of its own making —
  `{"dependencies":{"pm2-logrotate":"^3.0.0"}}`, a caret, so even the module
  root floats on the next reinstall. A bare `pm2 install pm2-logrotate@3.0.0`
  therefore resolves a different tree on a different host or a different day
  — and **starts it**, so the unreviewed tree is already running by the time
  anything could check it. Checking afterwards does not undo that.

So the order below matters as much as the versions. PM2 is installed globally
and then has its one affected package replaced, before PM2 is used for
anything; the module arrives as an artefact whose entire closure was resolved
and reviewed on a host you trust, so nothing unreviewed ever resolves or runs
on the deployment host. Every artefact is a genuine registry package, which
is what lets you check it against the registry's own integrity hash.

**Step 1 — install PM2 globally.** The first command of any deployment.

```bash
npm install -g pm2@7.0.4
pm2 --version    # 7.0.4
```

PM2 7.0.4 declares no `preinstall`, `install` or `postinstall` script, so this
unpacks the package without executing any of it. The affected parser is on
disk and unused; step 2 removes it before PM2 does any work.

**Step 2 — replace `js-yaml` with the fixed release.** `npm pack` fetches the
genuine registry tarball, so you can compare its hash with the registry's own
before anything is unpacked; the loop then replaces every copy under the
global PM2 tree.

```bash
PM2_ROOT="$(npm root -g)/pm2"
npm pack js-yaml@4.3.2                        # the registry artefact
sha256sum js-yaml-4.3.2.tgz                   # record it
npm view js-yaml@4.3.2 dist.integrity         # the registry's own sha512
find "$PM2_ROOT" -type d -name js-yaml | while read -r d; do
  sudo rm -rf "$d" && sudo mkdir -p "$d"
  sudo tar xzf js-yaml-4.3.2.tgz -C "$d" --strip-components 1
done
```

Then confirm nothing below 4.3.2 survives and PM2 still runs:

```bash
find "$PM2_ROOT" -type d -name js-yaml \
  -exec node -p "require('{}/package.json').version" \;   # every line 4.3.2+
pm2 --version                                             # 7.0.4
```

**Do not substitute `npm install js-yaml@4.3.2 --prefix "$PM2_ROOT"`.** That
treats the global package as a project and re-resolves PM2's whole dependency
set from the registry — trading a known tree for an unreviewed one — and
leaves `npm ls` calling the result `invalid`, because PM2's own manifest still
names 4.3.1. Replacing the one directory changes one package and nothing else.

**Step 3 — build the logrotate artefact once, on a host you trust.** This is
the only place the module's dependency tree is resolved, and `--ignore-scripts`
means nothing in it runs even here.

```bash
npm pack pm2-logrotate@3.0.0                  # the registry artefact
mkdir -p build/module
tar xzf pm2-logrotate-3.0.0.tgz -C build/module --strip-components 1
node -e '
const fs = require("fs"), p = "build/module/package.json";
const m = JSON.parse(fs.readFileSync(p, "utf8"));
m.dependencies.pm2 = "7.0.4";              // was "latest"
m.overrides = { "js-yaml": "^4.3.2" };     // transitive here, so legal
fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
'
npm install --prefix build/module --ignore-scripts
npm ls --prefix build/module js-yaml --all    # js-yaml@4.3.2 under pm2@7.0.4
npm audit --prefix build/module               # found 0 vulnerabilities
tar czf pm2-logrotate-3.0.0-vetted.tar.gz -C build module
sha256sum pm2-logrotate-3.0.0-vetted.tar.gz   # record it for step 4
```

Two details in that manifest edit are not interchangeable. `pm2` is a **direct**
dependency of the module, and npm rejects an `overrides` entry that contradicts
one (`EOVERRIDE`), so its specification is rewritten instead; `js-yaml` arrives
through PM2, so an override is the right instrument for it. `pmx` keeps its
`latest` specification and is resolved once, here — what pins it on every host
is the artefact, not the specification.

**Step 4 — install the module from that artefact on each deployment host.** No
`sudo`: `$PM2_HOME` belongs to the user PM2 runs as.

```bash
sha256sum pm2-logrotate-3.0.0-vetted.tar.gz   # must equal step 3's value
pm2 install ./pm2-logrotate-3.0.0-vetted.tar.gz
```

PM2 recognises a tarball and takes its **TAR module** path: it unpacks the
archive into `$PM2_HOME/modules/pm2-logrotate` and starts the app the package
declares, **running no package manager at all**. What runs is the closure you
reviewed, the registry is never consulted here, and the floating
specifications above are never resolved on this host. PM2 records the module
under `tar-modules` in `$PM2_HOME/module_conf.json` and relaunches it whenever
the daemon starts, so this survives a restart and a reboot without repeating.

**Step 5 — verify the closure on the host before going further.**

```bash
MOD="${PM2_HOME:-$HOME/.pm2}/modules/pm2-logrotate"
pm2 --version                                 # 7.0.4
npm ls --prefix "$MOD" js-yaml --all          # pm2@7.0.4 overridden -> 4.3.2
npm audit --prefix "$MOD"                     # found 0 vulnerabilities
pm2 ls                                        # pm2-logrotate 3.0.0, online
find "$(npm root -g)/pm2" -type d -name js-yaml \
  -exec node -p "require('{}/package.json').version" \;   # every line 4.3.2+
```

**A `js-yaml` below 4.3.2 in either tree, or a non-zero `npm audit`, means the
host is not running what was reviewed.** Redo step 2, or reinstall the module
from its artefact — an artefact you can hash is the only thing here that a
later check can be held against.

**Standing restriction: PM2 parses only the committed JavaScript descriptor.**
Point it at `ecosystem.config.js` and nothing else. Do not give PM2 a YAML
ecosystem file, do not hand it a descriptor from an untrusted source, and do
not let it read configuration a caller can influence. The CLI's YAML path
stays reachable whatever version of `js-yaml` sits underneath it, so this
restriction is what protects a host where step 2 has not been done, and
remains the correct practice on one where it has.

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

**These four commands establish the policy; they do not confirm it.** A
freshly installed module starts at `retain 30` and `compress false`, so a host
that skips this step keeps far more, uncompressed, than this policy asks for.
Read the settings back from `$PM2_HOME/module_conf.json` if you need to know
what a host is actually running.

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

**If that total is more than the host can spare, do not begin by shortening
the window.** In order of preference: give the log directory more disk, or
ship the records off the host — a copy in a log store or an object bucket is
history this policy can no longer lose. Reducing `max_size` or `retain`
locally is the last resort, and it takes three things: an explicit retention
minimum from whoever owns the incident-response and audit requirement, rather
than a figure chosen to fit the disk; confirmation that the history being
given up is already shipped or archived elsewhere; and an equivalent bounded
policy left in place afterwards, with both settings still set and neither at
zero.

**A reduction is not recoverable.** A shorter window means an investigation,
or an audit request, reaches exactly that far back and no further, and a file
that has rotated out of `retain` is gone from this host.

A host that already runs the system `logrotate` may instead apply an
equivalent policy to `server/logs/*.log`, in which case it **must** use
`copytruncate`, because PM2 holds the file handles open and a renamed file
would keep receiving writes at its old inode. Either approach is acceptable.
Leaving the question open is not.

### 8.3 Configure boot persistence

Without this the service does not come back after a host reboot. PM2 keeps
processes alive, but nothing keeps PM2 alive across a restart.

This is five steps, and **step 2 is the one that is easy to miss:
`pm2 startup` run without privilege installs nothing.** It prints a command
and exits with an error, and until step 2 has been done no startup unit
exists — the service will simply be gone after the next reboot, with nothing
having reported a failure.

**Step 1 — ask PM2 what to run.**

```bash
pm2 startup
```

Run as an unprivileged user, this detects the init system and prints the
command that would do the actual work. **Treat that line as input to inspect,
not as a command to paste** — step 2 says why. Its shape, with the installing
host's paths and user in place of yours:

```text
[PM2] Init System found: systemd
[PM2] To setup the Startup Script, copy/paste the following command:
sudo env PATH=$PATH:/usr/local/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u deploy --hp /home/deploy
```

**It then exits non-zero and installs nothing.** That is the expected outcome
of step 1, not a failure to work around — and it is why stopping here leaves
you with no boot persistence at all.

**Step 2 — build the privileged command from the printed one, with a `PATH`
you chose.** Two things in that line are host-specific and worth taking from
it: the absolute path of your PM2 script, and the `-u <user>` / `--hp <home>`
values that make the generated unit start PM2 as the right user with the right
`PM2_HOME`. **Do not take its `PATH=$PATH`.** The PM2 CLI begins
`#!/usr/bin/env node`, so the privileged process resolves `node` through
whatever `PATH` it is handed: one user-writable directory anywhere on that
list is enough for a `node` planted there to run as root (CWE-426, CWE-427).
And the exposure does not end with this one command — PM2 writes the `PATH` it
was given into the unit it generates (`Environment=PATH=…`) and starts PM2
from it (`ExecStart=… resurrect`), so root re-resolves `node` through that
same list at **every boot**.

So decide the `PATH` first, then verify every directory on it before handing
any of them to root. **The rule is root-owned and writable by no one else** —
group-writable is as good as world-writable to a member of that group, and a
writable *parent* lets the directory itself be replaced, so both are tested
here, and every ancestor with them. Any output disqualifies the path it names:

```bash
SAFE_PATH=/usr/local/bin:/usr/bin:/bin        # the list, decided once
PM2_BIN="$(npm root -g)/pm2/bin/pm2"          # the absolute vetted script

# Each directory on that PATH, and every ancestor of it.
for d in $(printf '%s' "$SAFE_PATH" | tr ':' ' '); do
  p="$d"
  while :; do
    find -L "$p" -maxdepth 0 \( -perm -0002 -o -perm -0020 -o ! -user root \) \
      -printf 'UNSAFE %p\n'
    [ "$p" = / ] && break
    p="$(dirname "$p")"
  done
done

# The interpreter that PATH actually selects — resolved under that PATH, not
# under yours — and the CLI script, since a root-owned directory can still
# hold a link to a binary someone else owns.
NODE_BIN="$(PATH="$SAFE_PATH" command -v node)"
stat -Lc '%A %U:%G %n' "$NODE_BIN" "$PM2_BIN"
find -L "$NODE_BIN" "$PM2_BIN" \
  \( -perm -0002 -o -perm -0020 -o ! -user root \) -printf 'UNSAFE %p\n'
```

Nothing may be reported. If the interpreter itself comes back owned by a
non-root user — which happens on hosts where Node was unpacked as an ordinary
user — fix that before going further: chown it to `root:root`, or install a
root-owned Node and put its directory on `SAFE_PATH` instead. Then run the
registration with that `PATH` and that absolute script, and nothing else:

```bash
sudo env PATH="$SAFE_PATH" "$PM2_BIN" \
  startup systemd -u deploy --hp /home/deploy
```

Substitute your own user and home; keep the `PATH` to exactly what you
checked. It exists only so root can find `node` and this script — nothing on
it needs to be a place users can write.

On success PM2 reports the unit it wrote and the commands it ran — for systemd
that is `/etc/systemd/system/pm2-<user>.service` followed by
`systemctl enable pm2-<user>` — and finishes by telling you to freeze the
process list, which is step 5 below.

If you are already root, `pm2 startup` performs steps 1 and 2 in one go — and
that convenience is where the `PATH` rule is most easily lost, because a root
shell's own `PATH` is then the one that reaches the unit. **Run it with the
same checked `PATH` and the same absolute script, and pass the user and home
explicitly**, since PM2 derives the unit name from `$USER` and a root shell
with `$USER` unset yields a unit called `pm2-undefined`:

```bash
env PATH="$SAFE_PATH" "$PM2_BIN" startup systemd -u root --hp /root
```

**Step 3 — verify the unit exists, is enabled, and runs in the environment you
intended.** Do not take the previous step's output as proof:

```bash
systemctl is-enabled pm2-deploy      # -> enabled
systemctl status pm2-deploy --no-pager | head -5
cat /etc/systemd/system/pm2-deploy.service
grep -E '^Environment=PATH=|^ExecStart=' \
  /etc/systemd/system/pm2-deploy.service
```

Substitute the `-u` value from step 2 for `deploy`. If `is-enabled` reports
`disabled` or the unit is not found, step 2 did not take effect — re-run it
and read its output.

**Then read the two lines the `grep` prints and hold them to step 2's rule.**
`Environment=PATH=` is assembled from the `PATH` PM2 was handed plus a fixed
system list, so anything that reached the command reached the unit: it must
contain only directories verified as root-owned and not world-writable, and a
duplicate entry is harmless where a user-writable one is not.
`ExecStart=` names the script root runs at boot, and if it names the script
alone, the unit's `PATH` is what decides which `node` executes it.

Correcting either is an edit to the unit file followed by a reload:

```bash
sudo systemctl daemon-reload
```

**A reload is all it needs — do not `systemctl restart pm2-<user>`.** The unit
executes only at boot, and PM2 generates it with `ExecStop=… kill` and
`ExecStart=… resurrect`, so restarting the unit is the daemon-wide stop and
snapshot replay this section prohibits below, reached by another route.

**Pinning `ExecStart` to the absolute interpreter as well as the absolute
script removes boot-time resolution altogether.** The pinned form is
`<NODE_BIN> <PM2_BIN> resurrect` — both absolute, both the paths step 2
verified, so on a typical host
`/usr/local/bin/node /usr/lib/node_modules/pm2/bin/pm2 resurrect`. After that
nothing on the unit's `PATH` chooses the `node` that runs as root. Re-run the
`grep` after the reload to confirm what the unit holds.

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

**Verify the chain — the non-destructive checks first, and always.** Both
halves of it can be read without disturbing anything, and between them they
catch the failures that actually happen:

```bash
systemctl is-enabled pm2-deploy      # -> enabled
cat /etc/systemd/system/pm2-deploy.service
jq -r 'group_by(.name)[] | "\(.[0].name): \(length) saved worker(s)"' \
  "${PM2_HOME:-$HOME/.pm2}/dump.pm2"
```

That establishes the unit half — a unit exists, it is enabled, and its
`User=`, `Environment=PM2_HOME=`, `Environment=PATH=` and `ExecStart=` are the
ones you intended — and the snapshot half:
`dump.pm2` describes the application and worker count you expect back.
**What it cannot establish is that the boot works.** Whether the init system
starts the unit at the right point, whether the environment baked into it is
still enough for root to find `node`, and whether something later in boot
interferes are all outside what any file can tell you. Only a real restart
settles those, which is why the reboot below remains the conclusive test —
and why it is not the first thing to try.

**A reboot is conclusive and disruptive in equal measure.** Run it on a
staging or disposable host that mirrors the production configuration — same
unit, same user, same `PM2_HOME`, same descriptor — and the question is
answered with nothing at stake. That is the default, and for most hosts it
is the whole of this test.

**Rebooting a production host takes down every service on it, not just this
one.** All of the following belong in place first:

- authorisation for the work from whoever owns the host;
- a scheduled maintenance window to do it inside;
- verified redundancy — another host serving the same traffic, or downtime
  explicitly accepted for this window;
- a review of every other workload on the host, since PM2 is rarely the only
  thing running and the machine's other tenants did not ask for this restart;
- a rollback expectation: if the workers do not come back, `npm run pm2:start`
  restores service by hand, and steps 1 to 3 are where the fault will be.

```bash
sudo systemctl reboot
# after the host is back:
npm run pm2:status                   # two workers, online, restarts 0
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/health
```

**`pm2 kill && pm2 resurrect` is not the fallback for a host you cannot
reboot.** `pm2 kill` stops the PM2 daemon and with it **every application and
module that daemon manages** — other services, `pm2-logrotate`, all of it —
not only this one. `pm2 resurrect` then replays whatever `dump.pm2` last
recorded, so it can also put back configuration that was deliberately changed
or restart an application that was deliberately retired
([what needs a `pm2 save`](#what-needs-a-pm2-save-and-what-does-not)). On a
shared or production daemon that is a multi-application outage with a
configuration rollback attached: **do not run it there.** Where it is used at
all it belongs on a disposable or staging host, or under a `PM2_HOME` that
holds nothing but this service; read `dump.pm2` with the `jq` above first, so
you know what the resurrection will replay; and treat it as the same
authorised, windowed work as a reboot. Even then it exercises the snapshot
half of the chain and **not** the unit half, so it does not substitute for the
test above.

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
  every other route, and it exposes request counts and process figures. **One
  exact-path rule is enough, and that is a property of the service rather than
  an assumption about your proxy**: routing is case-sensitive and slash-exact,
  so `/metrics` is the only spelling that reaches the handler — `/METRICS`,
  `/Metrics` and `/metrics/` are `404`s from the application itself
  ([section 6](#6-endpoint-reference)). Write the rule the way your proxy
  writes exact paths:

  ```nginx
  # nginx — `=` is an exact, case-sensitive match
  location = /metrics { allow 10.0.0.0/8; deny all; }
  ```

  ```haproxy
  # HAProxy — `path` is an exact, case-sensitive match
  http-request deny if { path /metrics } !{ src 10.0.0.0/8 }
  ```

  Do **not** relax it into a prefix or case-insensitive form
  (`location /metrics`, `path_beg /metrics`, `~*`): a prefix rule also covers
  paths the service does not serve, which hides a later route added under
  `/metrics/…` behind a rule nobody re-reads. If the restriction is enforced
  somewhere that only offers prefix matching, prefer denying `/metrics` and
  everything beneath it over widening the match to spellings the application
  already refuses.

## 9. Reading the logs

**In production the process writes raw NDJSON**: one JSON object per line on
stdout, which PM2 captures into `logs/out.log`. Configuration-failure output
goes to the process's standard error, which PM2 captures into
`logs/error.log`. Outside production
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

# every error- and fatal-level record: 5xx access and exception records, plus
# lifecycle failures such as a listener error or an exhausted drain budget
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
and it goes to the process's standard error rather than stdout — which under
PM2 means `logs/error.log`. [Section 11](#11-troubleshooting) shows one in
full.

**`logs/error.log` is expected to be empty in a clean run, and it has exactly
one job when it is not.** pino writes records at *every* level to stdout, so
`out.log` carries the whole stream, `error`- and `fatal`-level records
included. Precisely one record bypasses it: the pre-logger
configuration-failure record from [section 11](#11-troubleshooting), which is
written before any logger exists and therefore cannot use the stdout stream.
It goes to the process's standard error, which is the stream PM2 collects into
`error_file`, so **under PM2 it lands in `logs/error.log`** — the file this
descriptor declares and this runbook tells you to read. Run directly, with
nothing owning standard error, the same record goes straight to file
descriptor 2 and appears on your terminal.

Nothing else uses that route. A terminal-flush failure — the log destination
reporting an error, or failing to report inside the remaining drain budget,
while the process was exiting — is *attempted* through the ordinary stdout
logger as an `error`-level record carrying `code: "ERR_TERMINAL_FLUSH"`, aimed
at `out.log` like everything else, **and the process exits non-zero even when
the drain itself had succeeded.**

Read that order of precedence carefully, because the record is the half that
can go missing: the destination it is written to is the destination that just
failed, and the process exits without establishing a second barrier for it, so
it may be absent from `out.log` exactly when it would have been most useful.
**The escalated non-zero exit status is the authoritative external signal.**
From outside, a broken log destination therefore looks like a worker that
exited non-zero on an ordinary `pm2 stop` with its closing lines absent from
`out.log` — a `Drain started` with no `Drain complete; exiting` to match it,
even though the drain itself finished.

The same absence has one innocent cause worth knowing before you go looking:
when a drain runs all the way to `SHUTDOWN_TIMEOUT_MS` and is forced, the
budget is spent, so the closing record is handed to the destination without
waiting for its report and may not reach the file. That case announces itself
— `Drain budget exhausted; forcing exit` is written before the force, and the
exit is non-zero because the drain overran, not because logging broke. Any
other non-zero exit with missing closing records is a real log-durability
failure, and is worth investigating rather than filtering out.
Service records other than the configuration-failure one appearing in
`error.log` mean the logger's stream configuration has changed, not that the
service is failing.

**That holds even for the one failure the service cannot answer, and it takes a
deliberate choice to keep it true.** If a request fails *after* its response
has already begun — a handler that has written its status and some body and
then fails inside the request cycle — the response cannot be replaced by the
error envelope, because the status and the bytes are already on the wire. What
the service does instead is write the ordinary exception record to stdout and
then **destroy the connection**, so a half-written response is cut short rather
than left looking like a complete one. Express's own default
handler would have ended the connection the same way, but only after printing
the raw multi-line stack to standard error — which would put an unparseable,
unbounded and *unscrubbed* block into `error.log`, bypassing the redaction that
keeps credentials out of the log. The service therefore closes the connection
itself, and `error.log` stays empty. Diagnose this case from the `level: 50`
record on stdout, which carries the request id, the real message and the
bounded, scrubbed stack.

The visible symptoms are worth recognising, because the request looks
successful from the status alone. What the caller sees depends on how far the
response had got: a handler that had written only part of its body leaves the
exchange cut short — `curl` reports an empty reply or a truncated transfer
depending on how much had already reached the client — while a handler that had
*completed* its response and then failed afterwards leaves that response
delivered intact, with only the connection closed behind it. In the logs both
look the same: the access record for that request id shows the status the
handler had already sent, commonly `200` at level `30`, paired with an
exception record at level `50` saying the request failed. **Two records
disagreeing about one request id is the signature of this case**, and it always
means a bug in a handler rather than a bad request.

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

  Under `req` it carries the id, the method, the **pathname only** (the query
  string is dropped, never redacted), the trust-aware `ip` and `protocol` —
  which is where `TRUST_PROXY` shows up in the logs — and an **allowlist of
  request headers**: `host`, `user-agent`, `content-type`, `content-length`
  and `accept-encoding` with their values, plus `authorization` and `cookie`
  as `[Redacted]` markers recording only that the request carried a
  credential. No other inbound header reaches a record, no `X-Forwarded-*`
  value is written, and no response header is.

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

**Every string in a record whose length a caller chooses is bounded**, and a
value that was cut says so with an explicit `... (truncated)` suffix. The
limits are the header values and the `ip` and `protocol` fields at **512**
characters each, the pathname at **512** (the same bound the 404 message
reflects back to the caller), and an error message at **1024** with its
stack at 4096. So a truncated value in the log is this service's own policy
at work — not a corrupted line, and not a client sending something malformed
— and it is also why no single request can decide how large a log line the
service writes: a 15 KB `User-Agent` costs 512 characters plus the marker in
`out.log` rather than 15 KB. Credential material found *inside* one of those
strings is replaced by `[REDACTED]`, spelled in capitals to distinguish it
from pino's `[Redacted]` on a redacted header.

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
| `process_resident_memory_bytes` | gauge | Resident set size of this worker — libuv's coarse figure, which reads materially **lower** than `ps`/`VmRSS` and can sit frozen while real memory grows; before you alert on it read [what the resident-memory gauge does and does not measure](#what-the-resident-memory-gauge-does-and-does-not-measure) |
| `process_cpu_seconds_total` | counter | User plus system CPU time consumed by this worker |

No sample carries an identity label. The only label anywhere in the
exposition is `status_class` on the status-class family, which leaves the
whole surface at six families and ten sample lines per scrape. That is
deliberate on two counts: the counter store is a dependency-free leaf that
reads no configuration and no environment, and the exposition is minimised
to counts and process figures so an unauthenticated scrape discloses
neither the service identity nor the worker topology. The service name and
the instance ordinal are carried by the `GET /health` payload and by every
log line instead ([section 4](#4-configuration)).

So a scrape cannot be attributed to a particular worker — nothing in the
document names the process that answered it. That is the shared-socket
limitation **Counters are per-worker** below describes, and the absent
label makes it matter more rather than less.

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

### What the resident-memory gauge does and does not measure

`process_resident_memory_bytes` is `process.memoryUsage().rss`, which is
libuv's `uv_resident_set_memory()` — **field 24 of `/proc/<pid>/stat`
multiplied by the page size**. That is not the number `ps` prints. The kernel
serves that field from batched per-CPU counters, so it lags, and it moves only
in whole page-count quanta — **1.5 MiB steps** on this kernel — while
`/proc/<pid>/status` `VmRSS`, the figure behind `ps -o rss=` and
`smaps_rollup`, tracks each allocation as it happens.

Measured on a production worker: the gauge read **66,658,304 B on five
consecutive scrapes, byte for byte**, and was still exactly that after ~500
seconds of process life and 60 × 2 KB `POST /api/v1/echo` round trips — while
across the same window `VmRSS` rose 75,689,984 → 75,927,552 B and `ps -o rss=`
rose 73,716 → 73,912 KiB. The gauge sat **11.9 % below** the OS figure and did
not move at all while the OS figure did.

That leaves the gauge good for two things and unfit for a third:

- **A rough per-worker trend** over minutes to hours. Over that span the
  quantisation washes out and the direction is real.
- **Reasoning about `max_memory_restart`**, because PM2 reads the same
  `/proc/<pid>/stat` field this gauge does — see the sizing note below.
- **Not** an input to a container-limit or memory-growth alert. A leak can
  advance by megabytes with this number frozen, and a cgroup or container
  limit is enforced against `VmRSS`-class accounting rather than against this
  field. Alert on `VmRSS`, on `ps -o rss=`, or on the cgroup's own
  `memory.current`.

**Cross-check a live worker** — substitute its pid, which
`npm run pm2:status` prints and every log line carries as `pid`:

```bash
PID=1234
curl -s http://localhost:3000/metrics \
  | awk '/^process_resident_memory_bytes /{print "metric   " $2 " B"}'
awk '/^VmRSS:/{print "VmRSS    " $2*1024 " B"}' /proc/$PID/status
echo "ps       $(( $(ps -o rss= -p $PID) * 1024 )) B"
awk -v p="$(getconf PAGESIZE)" '{print "stat[24] " $24*p " B"}' /proc/$PID/stat
```

`metric` and `stat[24]` will agree **exactly**; `VmRSS` and `ps` will agree
with each other and read **higher**. That is the expected outcome, not a
fault. The reading that would mean something is wrong is `metric` above
`VmRSS`.

The source is **deliberately unchanged**. `process.memoryUsage()` is what this
service is specified to report, and `process.memoryUsage.rss()` is not an
accuracy improvement: it returns the identical libuv figure — identical on 12
of 12 samples taken in both call orders on this host — so it is a cheaper call
on the same number, not a truer one.

**Sizing note, and it matters the moment you read `ps` next to
`max_memory_restart`.** Under sustained large-body load the two sources
diverge much further than the 11.9 % above. One worker plateaued at **168.1
MiB on the `/proc/<pid>/stat` source — 65.7 % of the descriptor's 256 MiB
`max_memory_restart` ceiling — while the `VmRSS`/`ps` source read 239.8 MiB,
or 93.7 % of that same ceiling**: a ~70 MiB disagreement about one worker at
one instant. **PM2 compares against the lower of the two.** Its `pidusage`
dependency computes resident memory as `infos[21] * pageSize` in
`pm2/node_modules/pidusage/lib/procfile.js`, and that index is
`/proc/<pid>/stat` field 24 again — the same field as the gauge. So an
operator watching `ps` sees a worker that looks far closer to being recycled
than the figure PM2 actually acts on: size the host against the `ps` number,
and expect the restart decision to be taken on the lower one. The threshold is
also polled rather than hard, which compounds the same gap —
[Why `instances: 2` and not `'max'`](#why-instances-2-and-not-max) has that
part.

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
#  "err":"Invalid environment configuration: PORT must be a whole number
#   matching ^-?\\d+$ -- digits, optionally preceded by a minus sign, and
#   nothing else (3 characters supplied). Every variable is optional ...",
#  "failures":["PORT must be a whole number matching ^-?\\d+$ -- digits,
#   optionally preceded by a minus sign, and nothing else (3 characters
#   supplied)"]}
echo $?
# 1
```

Each entry names the variable and states the rule it broke, but **never echoes
the value** — where the length is informative it reports a character count
instead, and a blank simply reports that the variable is empty. That is
deliberate: a variable can hold a credential, and this record goes to stderr
where PM2 files it, so echoing the value would put it in a log file. Compare
the named variable against your own `server/.env`.

**The service writes nothing to stdout on this path** — that one record, on
stderr, is the whole of its output. The stdout lines are npm's lifecycle
banner, which npm 11.19.0 prints for every `npm run` target unless it is
silenced; they belong to npm, not to the service. Where the two streams must
be cleanly separated, use `npm --silent start`, which leaves stdout empty, or
run `node src/server.js` directly.

`failures` holds one entry per invalid variable — four bad values produce four
entries, and a variable supplied blank is one of them. The redirection below
sends stdout to `/dev/null`, so the banner is discarded and `jq` reads only
the record:

```bash
PORT=abc HOST= LOG_LEVEL=warn TRUST_PROXY=maybe npm start 2>&1 >/dev/null | jq -r '.failures[]'
# PORT must be a whole number matching ^-?\d+$ -- digits, optionally preceded by a minus sign, and nothing else (3 characters supplied)
# HOST was supplied but is empty; blanking a value is not the same as omitting it
# LOG_LEVEL must be exactly one of trace, debug, info, matched case-sensitively (4 characters supplied)
# TRUST_PROXY must be exactly "true" or "false", lower-case (5 characters supplied)
```

A validation failure is deliberately not a stack trace. It happens before any
logger exists, which is exactly when a legible message matters most, so this
one record is written to the process's standard error with no logger and no
transport — synchronously to file descriptor 2 when nothing owns that stream,
and through the stream itself when a supervisor does, so that PM2 files it
where the descriptor says it goes. Read `failures` for the structured list,
`err` for the one-line summary, and check the value of each named variable
against the table in [section 4](#4-configuration).

**Read `code` before editing `server/.env`.** Only
`ERR_CONFIG_VALIDATION` says the environment is at fault. `ERR_CONFIG_BOOTSTRAP`
— or any other code — means the configuration module itself failed to load, so
no variable was ever read: that record carries `stack` in place of `failures`,
and the fault is in the code or the dependency tree rather than in anything an
operator set. Editing `.env` will not move it; read the `stack`.

Under PM2 the same failure presents as a worker that restarts with widening
backoff, and **the record is in `logs/error.log`** — one copy per restart
attempt, each exiting non-zero:

```bash
head -1 logs/error.log | jq -r '.code, .failures[]'
npm run pm2:logs                      # or watch both streams live
```

`logs/out.log` stays empty on that run, because the process never reached the
logger. If `error.log` is empty too, the failure is not a configuration
failure — look for a worker that started and then died, in
[section 9](#9-reading-the-logs).

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

### The application is gone from `pm2 status` and scale says it is not found

Something scaled it to zero. `npm run pm2:scale -- 0` is not a stop: it exits
`0` and **deletes the application from PM2**, so no row remains in
`pm2 status`, the port is free, and requests are refused rather than answered.
Scaling back up cannot help, because there is no registration left to scale —
`npm run pm2:scale -- 2` reports
`[PM2][ERROR] Application hello-world-service not found`. Re-register it
instead:

```bash
npm run pm2:start          # re-register and start from the descriptor
# or:
npm run pm2:reload         # starts an unregistered application, warning first
pm2 save                   # the registration is new; without this, a reboot
                           # restores the previous snapshot
```

The distinction worth remembering afterwards: `npm run pm2:stop` stops serving
and **leaves the application registered**, which is what an operator almost
always wants; `pm2:delete` and `pm2:scale -- 0` deregister it. See
[reload versus scale](#reload-versus-scale) and
[what needs a `pm2 save`](#what-needs-a-pm2-save-and-what-does-not).

### PM2's daemon log says `failed to kill - retrying in 100ms`

It describes a **successful** drain, not a failed one, and every clean deploy
produces it:

```bash
grep -c "failed to kill" "${PM2_HOME:-$HOME/.pm2}/pm2.log"
```

Expect 15 to 37 of these lines **per retiring worker** — PM2 emits one every
100 ms for as long as that worker's drain lasts, so a drain that finishes an
in-flight request produces more of them than an idle one, and a reload of two
workers produces two such runs. They are PM2 polling whether the pid has gone.
They are **not** repeated signals: the application receives exactly one, and
nothing in the service reacts to them.

Read the lines around them instead. `exited with code [0] via signal [SIGINT]`
immediately afterwards is the clean case. `code [1]`, together with
`Drain budget exhausted; forcing exit` in the service's own log, is the forced
case — see
[a slow request was cut off during a deploy](#a-slow-request-was-cut-off-during-a-deploy).
And if you need to rule out a repeated signal, the evidence is in the
service's log rather than the daemon's: a second signal is recorded at `debug`
level as `Signal ignored; a drain is already under way`
([a shutdown looks like it happened twice](#a-shutdown-looks-like-it-happened-twice)),
and it does not appear during a PM2 reload.

All of this is in PM2's own daemon log, `$PM2_HOME/pm2.log`, which is a third
file beside the application's own two: `npm run pm2:logs` filters to
`logs/out.log` and `logs/error.log` ([section 9](#9-reading-the-logs)), so the
daemon's records need `pm2 logs PM2` instead.
[Section 8.2](#82-configure-log-retention) covers rotating this file as well
as the other two.

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

With the defaults — two workers, `DRAIN_DELAY_MS=2000` — the formula puts it
a little over four seconds, and **that is the correct behaviour rather than a
symptom**: requests continue to be served throughout. Reducing
`DRAIN_DELAY_MS` shortens it proportionally; raising `instances` lengthens
it.

**When it *is* the handshake.** A missing `ready` message costs an extra
`listen_timeout` — 8000 ms in the descriptor — **per worker**, because PM2
waits out the whole timeout before accepting the replacement and moving on,
and it still reports success at the end. So the tell is arithmetic rather
than a stopwatch reading: a reload that runs about
`instances x listen_timeout` longer than the formula predicts, and a start
that is slow at all, since a healthy start waits only for `ready` and never
pays the timeout.

Confirm it rather than infer it: a worker that sent `ready` logged
`Service listening` on start-up, so a replacement with no such line is the
broken case.

```bash
# per-worker timings for the last reload, oldest line first
jq -r 'select(.msg | test("Service listening|Drain started|Drain complete")) | "\(.time) \(.pid) \(.msg)"' logs/out.log | tail -8
```

Subtract the timestamps: a gap of about `DRAIN_DELAY_MS` between a worker's
`Drain started` and `Drain complete` is the drain working as designed, while a
gap approaching `listen_timeout` before a replacement's `Service listening`
appears is the handshake failing. See
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
