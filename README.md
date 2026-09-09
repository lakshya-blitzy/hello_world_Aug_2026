<!-- SPDX-License-Identifier: Apache-2.0 -->
# hello_world_Aug_2026

This repository hosts `hello-world-service` version 1.0.0, an Express 5 HTTP
service written in CommonJS. Everything belonging to it — the manifest, the
lockfile, the runtime pin, the PM2 descriptor and the source modules — lives
under `server/`, so the service installs into its own `node_modules` rather
than the root tree the inherited documentation toolchain reads.

The AsciiDoc documents at this level (`README.adoc`, `BUILDING.adoc`,
`SECURITY.adoc`, `FUZZING.adoc`, `RELEASE-NOTES.adoc` and
`CODE_OF_CONDUCT.adoc`), together with the Java/Maven and Antora
configuration, are inherited Apache Logging scaffolding retained for
reference; they describe a different project.

## Quick start

```bash
cd server && npm ci && npm start
```

Run that form only on a trusted, isolated host. It starts the service on
`HOST`, whose default is `0.0.0.0`, so the listener accepts on every
interface, and no route authenticates its caller — including `GET /metrics`,
which reports request counts and process figures. Anywhere a stranger can
reach the host, bind to loopback instead:

```bash
cd server && npm ci && HOST=127.0.0.1 npm start
```

`HOST=127.0.0.1` in `server/.env` has the same effect for every later start.
Before the service is reachable from another host, read the host
prerequisites in section 8 of the runbook,
[`server/README.md`](server/README.md): TLS is terminated by a reverse proxy
in front of this plain-HTTP listener, `TRUST_PROXY` is set only when that
topology justifies it, and `GET /metrics` is restricted to internal callers.

## Documentation

[`server/README.md`](server/README.md) is the canonical runbook: prerequisites,
installation, configuration, the endpoint reference, operating the service
under PM2, and troubleshooting.
