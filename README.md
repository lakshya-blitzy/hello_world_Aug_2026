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

## Documentation

[`server/README.md`](server/README.md) is the canonical runbook: prerequisites,
installation, configuration, the endpoint reference, operating the service
under PM2, and troubleshooting.
