// SPDX-License-Identifier: Apache-2.0
/**
 * Route aggregator for `hello-world-service` -- the service's URL map.
 *
 * SINGLE RESPONSIBILITY. This module composes the service's four route modules
 * behind ONE mountable `express.Router()`, and does nothing else. It is the
 * single mount point `../app.js` consumes: the application factory requires
 * `./routes` and registers the result as a single `app.use(routes)` at
 * POSITION 6 of its eight-position middleware pipeline. Laying the URL space
 * out in one readable place is the whole of this file's job, which is why the
 * mount paths below are written explicitly rather than inferred.
 *
 * THE URL MAP. Each module declares its paths RELATIVE to the mount it is
 * given here, so these four strings are the only place the service's URL
 * prefixes appear:
 *
 *   mount        module              effective paths
 *   -----------  ------------------  ------------------------------------
 *   `/`          `./root.routes`     `GET  /`
 *   `/health`    `./health.routes`   `GET  /health`, `GET /health/ready`
 *   `/metrics`   `./metrics.routes`  `GET  /metrics`
 *   `/api/v1`    `./api.routes`      `POST /api/v1/echo`
 *
 * WHERE THIS SITS IN THE PIPELINE, and what that forbids. `../app.js`
 * registers, in order: (1) `requestContext` -- request identity, the access
 * record and the metric counters; (2) `helmet()`; (3) `compression()`;
 * (4) `express.json({ limit })`; (5) `express.urlencoded({ extended: false,
 * limit })`; (6) THIS ROUTER, followed by any `options.extraRouters`;
 * (7) `notFound`; and (8) the four-arity `errorHandler`. Two consequences bind
 * this file:
 *
 *   * It must stay PLAINLY MOUNTABLE and must never terminate the pipeline. A
 *     sub-router entered for a path it does not match simply calls `next()`,
 *     which is what lets positions 7 and 8 do their work.
 *   * It must NOT produce a 404. `../middleware/not-found.js` at position 7
 *     owns every unmatched path and turns it into the typed error that
 *     position 8 renders as `{ error: { status, message, requestId } }`.
 *     A catch-all declared here would take that away from it and would also
 *     shadow `options.extraRouters`, which is registered immediately after
 *     this router.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It declares no route handler of
 * its own -- no `router.get`, no `router.post` -- and defines no standalone
 * middleware of its own: the only things it registers are the four child
 * routers below, each mounted with `router.use()`, which express records as a
 * middleware layer on this Router. It reads no configuration and touches no
 * environment, writes no log line, formats no error and validates no input.
 * Every one of those belongs to a module that already owns it, and adding any
 * of them here would turn a composition layer into a second, competing place
 * to look for behaviour. Its only import beyond the four siblings is
 * `express`, needed for `express.Router()` alone.
 *
 * CONSISTENCY OBLIGATION. `server/README.md`'s endpoint-reference table is the
 * canonical, single-location documentation of this URL map. This file is the
 * implementation that table describes, so adding, moving or removing a mount
 * here without updating that table makes the runbook untrue.
 */
'use strict';

// Required for `express.Router()` alone. No other part of the express surface
// is used here: this module creates no application, binds no port and defines
// no middleware of its own -- the only layers it registers are the four child
// router mounts below.
const express = require('express');

// The four route modules, required as siblings with no file extension so
// Node's CommonJS resolver picks up each `.js` file in this directory.
//
// Each is bound to a clearly named const and each is mounted directly, without
// unwrapping, because all four export a bare `express.Router()` by direct
// assignment (`module.exports = router`) rather than a wrapper object, a
// `{ router }` shape or a factory. Verified against all four modules; a change
// to any of their export shapes breaks the corresponding mount below.
const rootRoutes = require('./root.routes');
const healthRoutes = require('./health.routes');
const metricsRoutes = require('./metrics.routes');
const apiRoutes = require('./api.routes');

/**
 * The aggregated router this module exports.
 *
 * A bare `express.Router()` carrying the four mounts registered below, created
 * once at require time: a Router is stateless with respect to requests, so a
 * single shared instance per process is correct and a factory would buy
 * nothing. It is exported by direct assignment (`module.exports = router`)
 * because `../app.js` mounts it with `app.use(require('./routes'))`, which
 * needs a mountable Router value -- not a wrapper object, not `{ router }`,
 * and not a factory that has to be invoked first. Any other export shape
 * breaks the application factory.
 *
 * No options are passed: this router declares no parameterised path, so it
 * needs no `mergeParams`, and its `caseSensitive` and `strict` matching
 * options therefore take THIS Router's own defaults -- both disabled -- and
 * not the application's. A child Router does NOT inherit them: express reads
 * `case sensitive routing` and `strict routing` only when it lazily builds the
 * application's own router, while `express.Router()` copies `caseSensitive`
 * and `strict` straight out of the option object it is handed, which is absent
 * here.
 *
 * What actually keeps path matching consistent across the whole URL space is
 * that NOTHING in this service enables either option -- `../app.js` sets only
 * `trust proxy` and disables `x-powered-by`, and all five Routers (this one
 * and the four it mounts) are constructed with no options -- so every mount
 * matches case-insensitively and tolerates a trailing slash. Enabling either
 * setting on the application alone would therefore NOT change matching here;
 * it would have to be passed explicitly to this Router and to every child
 * Router that needs it.
 *
 * @type {import('express').Router}
 */
const router = express.Router();

// WHY THE API VERSION IS CARRIED IN THE MOUNT PATH -- read this before adding
// a version anywhere else.
//
// `/api/v1` is a MOUNT PATH here, and the version deliberately appears nowhere
// inside `./api.routes` or any handler it declares. That is the point: a
// future v2 is an ADDED MOUNT LINE IN THIS FILE --
// `router.use('/api/v2', apiV2Routes);` -- next to a new module, and it
// requires no edit to any existing route module, no branch on a version inside
// a handler, and no version-sniffing middleware. The two versions then coexist
// as two independent subtrees that can be evolved and retired separately.
//
// The failure mode this comment exists to prevent is concrete: inspecting a
// version inside a handler (from a path segment, a query parameter or a custom
// header) puts routing logic where the router cannot see it, spreads the
// version across every handler that checks it, and makes retiring v1 a hunt
// through the tree instead of the deletion of one line here. Keep the version
// in the mount path.

// `GET /` -- the service's root response, in `text/plain`.
//
// Mounting at `/` is safe and does NOT shadow the three mounts that follow: a
// sub-router entered for a path it does not match calls `next()`, and
// `./root.routes` declares only `GET /`, which matches the exact path `/`
// alone. `/` stays first so the order of this file matches the order of the
// HTTP contract and of the runbook's endpoint table.
router.use('/', rootRoutes);

// `GET /health` (liveness) and `GET /health/ready` (readiness, which answers
// 503 once a drain has begun).
router.use('/health', healthRoutes);

// `GET /metrics` -- the Prometheus exposition document, per worker.
router.use('/metrics', metricsRoutes);

// `POST /api/v1/echo` -- the versioned API surface; see the versioning note
// above before adding a mount here.
//
// Note for any mount added to this file: express 5.2.1 resolves paths with
// path-to-regexp v8, which REJECTS unnamed wildcards and optional parameters
// at route-definition time rather than at call time. Use `'/path/*splat'` and
// `'/path{/:id}'`, never `'/path/*'` or `'/path/:id?'`. A violation throws
// while this module is being required, so the process never finishes booting
// -- and under PM2 cluster mode every worker fails the same way. The four
// mounts above are literal path prefixes and are unaffected.
router.use('/api/v1', apiRoutes);

// The file's entire public API: the aggregated Router itself, by direct
// assignment. Nothing else is exported -- in particular no helper for
// appending a mount after the fact, because by the time `createApp()` returns,
// positions 7 and 8 are already registered and a late mount would be
// unreachable behind the 404. A route the service does not ship belongs in
// `createApp()`'s `options.extraRouters` seam instead.
module.exports = router;
