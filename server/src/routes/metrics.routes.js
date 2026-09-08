// SPDX-License-Identifier: Apache-2.0
/**
 * Prometheus scrape endpoint for `hello-world-service`.
 *
 * Single responsibility: serve the metric exposition document that
 * `../lib/metrics.js` renders, under the content type a Prometheus scraper
 * expects. That is the whole of this module -- it is pure transport, and it
 * holds no measurement of its own.
 *
 * WHY THIS FILE CONTAINS NO COUNTING LOGIC, and must keep containing none.
 * The counter store in `../lib/metrics.js` has exactly one writer and exactly
 * one reader:
 *
 *   * writer -- `../middleware/request-context.js`, at position 1 of the
 *     middleware pipeline, which calls the store's two recording functions:
 *     one on the way in, one when the request finishes -- whether its response
 *     completed or the client abandoned it
 *   * reader -- this module, which calls `render()` and writes the result to
 *     the response
 *
 * That split is what keeps measurement separate from transport, and it is the
 * reason this file imports the store's read function and nothing else of it.
 * The natural instinct when adding a metric is to increment it here, next to
 * the code that serves it; doing so couples the two halves and makes the
 * counters depend on whether a scrape happened. Add the counter to
 * `../lib/metrics.js`, increment it from the request-context middleware, and
 * let it appear here for free.
 *
 * WHY THIS FILE READS CONFIGURATION AND THE COUNTER STORE DOES NOT. Every
 * sample in the exposition carries the process's identity -- `service` and
 * `instance` -- so `GET /health`, the metrics output and every log line
 * describe the same process the same way, with `instance` present and `0` even
 * when PM2 did not launch it. Those two values may only come from
 * `../config`: it is the sole module permitted to read the environment, and
 * `NODE_APP_INSTANCE` is injected by PM2 rather than being a constant anyone
 * else could know. `../lib/metrics.js` is a dependency-free leaf and must stay
 * one, so it cannot fetch them -- it takes them as the `identity` argument of
 * `render()` instead, and this module, the reader, supplies them. That is
 * exactly the arrangement `./health.routes.js` uses for the `GET /health`
 * payload, and for the same reason: the identity belongs to the transport
 * boundary, and the only alternative -- reading the environment directly from
 * a route -- is prohibited, since `../config` is the service's single
 * environment boundary.
 *
 * So the split above is unchanged. Measurement still lives entirely in the
 * store; what this file adds is the label set the store is not allowed to
 * look up.
 *
 * WHY THE NUMBERS ARE PER-WORKER, and why no aggregation belongs here. Under
 * PM2 cluster mode each worker is its own OS process with its own copy of the
 * counter store, and all workers share one listening socket. A scrape reaches
 * whichever worker the socket assigns it to, so one scrape shows one worker's
 * numbers and consecutive scrapes may show different ones. This is inherent to
 * counting in-process behind a shared port, not a defect to correct here; the
 * only correct fix is an aggregator in front of the workers, which is out of
 * scope for this service. `server/README.md` states the same caveat for
 * operators.
 *
 * MOUNTING. `./index.js` -- the route aggregator -- mounts this router at
 * `/metrics`, so the route below is declared at `'/'` and the effective path
 * is `GET /metrics`. Declaring `'/metrics'` here would produce
 * `/metrics/metrics`.
 *
 * ACCESS CONTROL. This endpoint is unauthenticated, like every other route in
 * this service, and deliberately so: authentication and authorization are out
 * of scope, and the exposition body carries counts, process figures and the
 * process's own identity only -- never request content. The identity is the
 * service name and the cluster ordinal, both of which `GET /health` already
 * returns unauthenticated. An operator exposing the service publicly restricts
 * `/metrics` at the reverse proxy, which is documented in `server/README.md`
 * rather than implemented here.
 */
'use strict';

// `express` is required solely for `express.Router()` below; no other part of
// its surface is used here.
const express = require('express');

// Only `render` is destructured. The store's two recording functions are its
// write side and belong exclusively to `../middleware/request-context.js`;
// importing either here would be dead code and a standing invitation to break
// the reader/writer split described above.
const { render } = require('../lib/metrics');

// The frozen configuration object, for the two identity values every sample
// carries. Only `serviceName` and `instance` are read; nothing else in the
// exposition depends on configuration, and no value is read from the
// environment here -- `../config` is the only module allowed to do that.
const config = require('../config');

// The router this module exports. One instance per process, created at require
// time: an `express.Router()` is stateless with respect to requests, so a
// single shared instance is correct and a factory would buy nothing.
const router = express.Router();

/**
 * Serve the current metric exposition document.
 *
 * Mounted at `/metrics`, so the effective request is `GET /metrics`. Responds
 * `200` with `Content-Type: text/plain; version=0.0.4` and the string
 * `render()` returns as the body, byte for byte. Every sample in that body
 * carries `service` and `instance` labels, from the two configuration values
 * this handler passes to `render()`.
 *
 * There is no failure response and therefore no validation and no try/catch:
 * the route takes no input, and `render()` reads module-local state plus three
 * `process` figures, none of which can fail. Its one precondition -- a
 * well-formed identity argument -- is satisfied by construction, because both
 * values come from the frozen configuration object rather than from the
 * request. The handler is synchronous for the same reason -- there is nothing
 * to await. (Were that to change, Express 5 forwards a rejected promise from a
 * handler to the four-arity error middleware on its own, so no wrapper would
 * be needed even then.)
 *
 * @param {import('express').Request} req Incoming request. Unused: the
 *   exposition document is the same for every caller, and no query parameter,
 *   header or body affects it. The parameter is present because it is Express's
 *   handler signature.
 * @param {import('express').Response} res Response the exposition body is
 *   written to.
 * @returns {void}
 */
router.get('/', (req, res) => {
  // Set explicitly even though 200 is Node's default: the HTTP contract names
  // the status, so the code states it rather than inheriting it.
  res.status(200);

  // `res.setHeader(...)` -- the raw Node setter -- rather than Express's
  // `res.set(...)` or `res.type(...)`, and the reason is verified against
  // express 5.2.1 rather than assumed: BOTH Express helpers pass a
  // Content-Type value through `mime.contentType()`, which appends a charset
  // to any `text/*` type, so either one turns this header into
  // `text/plain; version=0.0.4; charset=utf-8`.
  //
  // That variant is not corrupt -- a Prometheus server parses the media type
  // and version parameter and ignores the extra charset, so a scrape would
  // still succeed -- but it is NOT the documented type, and it is worth being
  // precise because the opposite is easy to assume. The exposition format's
  // documented content type for version 0.0.4 is exactly
  // `text/plain; version=0.0.4`, with no charset parameter; only the
  // OpenMetrics content types carry `charset=utf-8`. That documented value is
  // also what this service's HTTP contract names and what its acceptance check
  // compares against, byte for byte, and `res.setHeader()` is the only setter
  // that leaves it as written. Do not "simplify" this to `res.set()`: it
  // compiles, it looks tidier, and it silently changes the advertised content
  // type to one the contract does not name.
  res.setHeader('Content-Type', 'text/plain; version=0.0.4');

  // `res.end(...)` rather than `res.send(...)`, for the same header reason:
  // given a string payload, Express 5's `res.send()` re-writes an
  // already-set Content-Type through `setCharset(type, 'utf-8')` and would undo
  // the line above. `res.end()` writes the body and touches no header.
  //
  // `render()` returns the complete document, already carrying the `# HELP`
  // and `# TYPE` lines for every family and terminated by the newline the text
  // format requires. It is served verbatim: nothing is prepended, appended or
  // trimmed here.
  //
  // The identity argument is the store's only input, and it is assembled here
  // rather than inside the store for the reason given in the module header.
  // Both values come from the frozen configuration object -- validated once at
  // start-up and constant thereafter -- so this call cannot fail its
  // precondition check at request time, which is why the handler needs no
  // try/catch around it.
  //
  // No `Content-Length` accompanies the body, and that is expected rather than
  // a gap: `compression()` at position 3 of the pipeline wraps `res.end`, so
  // the response is sent with `Transfer-Encoding: chunked` -- gzip-encoded when
  // the client offered gzip, plain when it did not. Chunked transfer is
  // unremarkable to a scraper, and arranging the compression is the pipeline's
  // job, not this route's.
  res.end(render({ service: config.serviceName, instance: config.instance }));
});

// Exported as the bare router, not wrapped in an object and not behind a
// factory, because the aggregator in `./index.js` mounts the value directly
// with `router.use('/metrics', metricsRoutes)`.
module.exports = router;
