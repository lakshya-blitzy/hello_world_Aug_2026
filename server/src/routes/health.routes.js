// SPDX-License-Identifier: Apache-2.0
/**
 * Liveness and readiness probes for the service.
 *
 * SINGLE RESPONSIBILITY. This module answers the two questions an operator,
 * a supervisor or a reverse proxy asks about a running process -- "is it
 * alive?" and "should it be sent work?" -- and nothing else. It registers
 * exactly two routes on one `express.Router()` and holds no state, no
 * measurement and no policy of its own.
 *
 * MOUNTING. `./index.js` -- the route aggregator -- mounts this router at
 * `/health`, so the routes below are declared RELATIVE to that mount as `'/'`
 * and `'/ready'`, giving the effective paths `GET /health` and
 * `GET /health/ready`. Declaring `'/health'` here would produce
 * `/health/health`.
 *
 * DRAIN STATE IS READ HERE, NEVER SET. Only `isShuttingDown` is imported
 * below; `beginShutdown()` belongs to `../server.js`'s signal handler alone.
 * Calling the setter from here would let any HTTP client start a drain by
 * polling a probe.
 */
'use strict';

const express = require('express');

// Only `isShuttingDown` is destructured, and the omission is deliberate:
// `../lib/lifecycle.js` also exports `beginShutdown`, which is the write side
// of the drain latch and belongs exclusively to `../server.js`. Importing it
// here would be dead code and a standing invitation to misuse.
//
// `../lib/lifecycle.js` is a dependency-free leaf module for the sake of this
// very import. Reading the flag from `../server.js` instead would close the
// CommonJS cycle `server.js -> app.js -> routes/index.js -> health.routes.js
// -> server.js`, which does not throw -- it resolves to a partially
// initialised module object, so `isShuttingDown` would be `undefined` at the
// moment a request called it. Do not "simplify" this to an import from the
// process entry point.
const { isShuttingDown } = require('../lib/lifecycle');

// WHY THIS MODULE REQUIRES `../config` INSTEAD OF READING THE ENVIRONMENT.
// The liveness response carries the service name and the cluster instance,
// and both are derived from environment variables. `../config/index.js` is
// the codebase's SOLE environment boundary: it is the only module that reads
// the raw environment, validates it and freezes the result.
//
// Reading those two values anywhere else would break that boundary and, worse,
// let this response drift from what the logger reports: `../lib/logger.js`
// puts these same two values on every log line through this same object, so a
// health response and a log line disagreeing about which instance answered
// would be indistinguishable from a routing bug.
//
// There is deliberately no try/catch around this require: the config module
// validates and throws once during its own module evaluation, `../server.js`
// guards the first require of it and renders the failure, and by the time
// this route module loads configuration is already resolved and cached.
const config = require('../config');

/**
 * The router this module exports.
 *
 * A bare `express.Router()` carrying the two routes registered below. One
 * instance per process, created at require time: a Router is stateless with
 * respect to requests, so a single shared instance is correct and a factory
 * would buy nothing. It is exported by direct assignment
 * (`module.exports = router`) because `./index.js` mounts it with
 * `router.use('/health', require('./health.routes'))`, which needs a mountable
 * Router value -- not a wrapper object, not `{ router }`, and not a factory
 * that has to be invoked first. Any other export shape breaks that mount.
 *
 * @type {import('express').Router}
 */
const router = express.Router();

/**
 * Writes one probe response: the status, the JSON body, the two headers that
 * body determines, and the directive that keeps it out of caches.
 *
 * WHY THE PROBES DO NOT USE `res.json()`. `res.json()` delegates to
 * `res.send()`, which evaluates conditional-request freshness before writing:
 * on a GET it rewrites a 2xx to `304 Not Modified` and strips the body, and
 * `If-None-Match: *` counts as fresh whether or not the response carries an
 * ETag -- so disabling ETag generation in `../app.js` does not close that path
 * on its own. A probe that answers `304` with no body to a client that sent
 * one header is a probe whose contract does not hold: a poller cannot read a
 * status it was never sent. `res.end()` performs no freshness test, so both
 * answers below are exactly the status and body written here.
 *
 * WHY EVERY PROBE ANSWER IS `Cache-Control: no-store`. Not generating a
 * validator stops a cache from REVALIDATING a stored copy; it does not stop it
 * from storing one in the first place, and the two are different properties. A
 * probe body is point-in-time process state whose whole value is that it
 * describes this instant: a stored `{"status":"ready"}` replayed by an
 * intermediary during a drain would report a worker as available precisely
 * when it is being withdrawn, which is the failure the readiness probe exists
 * to prevent. `no-store` forbids the storage rather than merely marking it
 * stale, so it applies to the draining `503` exactly as to the healthy `200`
 * -- a cached negative answer would be as wrong once the process is gone.
 *
 * Both probe responses go through this one function so that the two contracts
 * cannot drift apart, and so the reasoning above is recorded once.
 *
 * @param {import('express').Response} res The response to write.
 * @param {number} status The HTTP status to send: `200` or `503`.
 * @param {object} payload The flat probe object to serialize. Key insertion
 *   order is preserved by `JSON.stringify`, and it is the documented order.
 * @returns {void} Nothing; the response is complete when this returns.
 */
function sendProbe(res, status, payload) {
  const body = JSON.stringify(payload);

  res.status(status);

  // Both headers written verbatim through the raw setter, carrying the same
  // values `res.json()` would derive, so a consumer sees no difference.
  // Content-Length is safe against `compression()` at pipeline position 3:
  // that middleware removes it whenever it compresses, and a probe body is far
  // below its size threshold, so it is never compressed.
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));

  // Set here rather than in `../app.js` because it is this contract's own
  // property, not a cross-cutting one: the root response is a fixed constant
  // that a cache may keep harmlessly, while these two bodies are only ever
  // true of the instant they were written. Helmet emits no cache directive of
  // its own, so nothing downstream overrides this.
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

/**
 * `GET /health` -- the liveness probe.
 *
 * Reports that this process is up and able to serve, together with just enough
 * identity to tell one worker from another. Responds `200` with a JSON body
 * carrying six fields, in the order written below:
 *
 *   * `status`    -- the literal `"ok"`
 *   * `service`   -- the canonical service name, from configuration
 *   * `uptime`    -- this process's uptime in seconds, as a number
 *   * `pid`       -- this process's operating-system process id
 *   * `instance`  -- the PM2 cluster instance ordinal, `0` when unclustered
 *   * `timestamp` -- ISO-8601 instant at which the response was produced
 *
 * Liveness answers a narrower question than readiness: it says the process is
 * running and its event loop is turning, not that it should be sent work. A
 * draining process is still alive, and this route keeps answering `200`
 * throughout a drain -- which is exactly why the two routes are separate and
 * why the runbook points a proxy's health check at `/health/ready` instead.
 *
 * The handler is synchronous and has no failure response, so it takes no
 * `next` parameter, performs no validation and wraps nothing in try/catch:
 * every value it reads is a `process` figure, a frozen configuration field or
 * the current clock, and none of those can fail or be absent.
 *
 * @param {import('express').Request} req The incoming request. Intentionally
 *   unread: the response derives nothing from it and is identical for every
 *   caller. The parameter exists because Express supplies handler arguments
 *   positionally, so `res` cannot be reached without it.
 * @param {import('express').Response} res The response the JSON body is
 *   written to.
 * @returns {void} Nothing is returned to the caller; this handler's result is
 *   the response written to `res`.
 */
router.get('/', (req, res) => {
  // Key order is part of the documented contract rather than incidental:
  // JavaScript preserves object key insertion order through `JSON.stringify`,
  // and this is the order `server/README.md` and the HTTP contract publish.
  sendProbe(res, 200, {
    status: 'ok',

    // From configuration, never a string literal in this file. The same
    // string is declared independently in `server/package.json` (`name`) and
    // `server/ecosystem.config.js` (`name`, and therefore what `pm2 status`
    // shows), and reaches every log line through the same frozen object. All
    // of those surfaces must name one service, or a log line, a process
    // listing and this response disagree about what is running.
    service: config.serviceName,

    // Seconds since this process started, fractional and unrounded. Left as
    // the raw number `process.uptime()` returns: rounding it to an integer or
    // formatting it as a string would cost a consumer precision and force it
    // to parse, and this body is read by machines first.
    uptime: process.uptime(),

    // The operating-system process id. Included alongside `instance` rather
    // than in place of it because the two identify a worker differently: the
    // instance ordinal is stable across a restart while the pid is not, so a
    // pid that changed between two probes is how a caller sees that PM2
    // replaced the worker underneath it.
    pid: process.pid,

    // The PM2 cluster ordinal, supplied by configuration rather than by a
    // direct `NODE_APP_INSTANCE` read -- see the boundary note at the require
    // above. Configuration DEFAULTS it to 0 rather than omitting it, so a
    // process launched directly with no PM2 reports `instance: 0` and this
    // response has an identical shape however the service was started. A
    // consumer therefore never has to handle a missing field.
    instance: config.instance,

    // Generated per request, not at module load: a timestamp captured when
    // this file was required would freeze at start-up and silently report the
    // wrong instant on every subsequent probe.
    timestamp: new Date().toISOString()
  });
});

/*
 * WHY THE PROBE SHAPE IS FLAT, AND WHY THE 503 BYPASSES THE ERROR HANDLER.
 *
 * Both responses below are the flat `{ status: ... }` object, and the 503 is
 * written directly rather than delegated with `next(err)`. This is the single
 * most likely thing in this file to be "helpfully" refactored into the error
 * path, so the reasoning is recorded here.
 *
 * This service has three response shapes on purpose: the error envelope
 * `{ error: { status, message, requestId } }`, this flat probe object, and
 * Prometheus text at `/metrics`. The envelope is reserved for APPLICATION
 * FAILURES, and a service that is draining on an operator's instruction has
 * not failed -- it is doing exactly what it was told. Three things follow
 * from handing this 503 to `../middleware/error-handler.js`, and each is a
 * reason not to:
 *
 *   * SHAPE. A probe's consumer -- a reverse proxy, a supervisor, a `curl` in
 *     a shell loop -- matches on the status code plus a small, stable body.
 *     The handler replaces this one-field object with the three-field
 *     envelope, so reading a drain state would mean parsing the shape
 *     reserved for failures. One field is what makes the body cheap to match
 *     and impossible to misparse, which is why nothing diagnostic is added to
 *     it either.
 *   * MESSAGE. That handler masks 5xx messages in production and sends
 *     `Internal Server Error` in their place. A planned drain answered with
 *     that message tells the caller something untrue, and no message attached
 *     to an `HttpError` here would survive to correct it.
 *   * RECORD. That handler is this service's failure path, and it records
 *     every 5xx it resolves as a server-side failure. A drain the operator
 *     asked for is not a failure, and filing it as one puts a planned event
 *     into the record read to find faults.
 *
 * What does NOT differ is the access record from position 1 of the pipeline:
 * `../middleware/request-context.js` maps any status of 500 or above to
 * `error` level, so this direct 503 is recorded at that level exactly as a
 * delegated one would be. The access record is not a reason either way.
 *
 * WHY THE 503 IS REACHABLE AT ALL.
 *
 * `../server.js`'s operator drain (on SIGTERM/SIGINT) is two-phase, and phase
 * one exists for this route. It calls `beginShutdown()` -- flipping the flag
 * read below -- WHILE THE LISTENER IS STILL ACCEPTING, then waits
 * `DRAIN_DELAY_MS` (default 2000) before `server.close()`. That window is the
 * only time this 503 can be observed. Were the listener closed first, the
 * probe could not be answered at all: a poller would meet a refused
 * connection instead of a negative answer. The default 2000 ms window is
 * therefore what makes this answer observable rather than padding.
 * `DRAIN_DELAY_MS=0` is a permitted setting -- `../config/index.js` floors
 * the value at 0 -- and it does not break anything here; it removes the
 * window, so a poller meets that refused connection instead of this negative
 * answer.
 *
 * THE HONEST BOUND. Every PM2 cluster worker shares one listening socket, so
 * an external probe CANNOT choose which worker answers it. A 503 therefore
 * cannot be reliably observed on demand during a cluster reload -- the scrape
 * may well land on a healthy worker. This probe's value is in a
 * single-process deployment, and in a supervisor polling the service as a
 * whole while it stops. It does NOT let a load balancer drain individual
 * cluster workers; do not document it as though it does.
 */

/**
 * `GET /health/ready` -- the readiness probe.
 *
 * Reports whether this process should be sent new work. Two responses, and no
 * others:
 *
 *   * `200` `{ status: "ready" }` -- no drain has begun; the process is
 *     serving normally and may receive traffic.
 *   * `503` `{ status: "shutting_down" }` -- a drain has begun. The process is
 *     still alive and still accepting connections, and it will finish what it
 *     already holds, but a caller should stop sending it new requests. The
 *     state is a one-way latch: once this answer appears it never reverts to
 *     `200`, because a draining process does not return to service.
 *
 * The distinction from `/health` is the point of having two routes: liveness
 * stays `200` throughout a drain, so a consumer that only polls `/health`
 * keeps routing work to a process that is on its way out.
 *
 * Synchronous, with no failure path beyond the deliberate 503:
 * `isShuttingDown()` is a pure boolean read that cannot throw, so the handler
 * takes no `next` parameter and needs no try/catch.
 *
 * @param {import('express').Request} req The incoming request. Intentionally
 *   unread: the answer depends only on this process's drain state, never on
 *   anything the caller sends. The parameter is present because it is
 *   Express's handler signature.
 * @param {import('express').Response} res The response the flat status object
 *   is written to.
 * @returns {void} Nothing is returned to the caller; this handler's result is
 *   the response written to `res`.
 */
router.get('/ready', (req, res) => {
  // Read once per request rather than cached at module scope: the flag is
  // flipped by the signal handler at an arbitrary moment during the process's
  // life, so a value captured at require time would answer `200` forever.
  if (isShuttingDown()) {
    sendProbe(res, 503, { status: 'shutting_down' });
    return;
  }

  sendProbe(res, 200, { status: 'ready' });
});

module.exports = router;
