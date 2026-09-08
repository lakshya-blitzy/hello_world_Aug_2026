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
 *     one on the way in, one when the response completes
 *   * reader -- this module, which calls `render()` and writes the result to
 *     the response
 *
 * That split is what keeps measurement separate from transport, and it is the
 * reason this file imports `render` and nothing else. The natural instinct
 * when adding a metric is to increment it here, next to the code that serves
 * it; doing so couples the two halves and makes the counters depend on whether
 * a scrape happened. Add the counter to `../lib/metrics.js`, increment it from
 * the request-context middleware, and let it appear here for free.
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
 * of scope, and the exposition body carries counts and process figures only --
 * never request content. An operator exposing the service publicly restricts
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

// The router this module exports. One instance per process, created at require
// time: an `express.Router()` is stateless with respect to requests, so a
// single shared instance is correct and a factory would buy nothing.
const router = express.Router();

/**
 * Serve the current metric exposition document.
 *
 * Mounted at `/metrics`, so the effective request is `GET /metrics`. Responds
 * `200` with `Content-Type: text/plain; version=0.0.4` and the string
 * `render()` returns as the body, byte for byte.
 *
 * There is no failure response and therefore no validation and no try/catch:
 * the route takes no input, and `render()` reads module-local state plus three
 * `process` figures, none of which can fail. The handler is synchronous for
 * the same reason -- there is nothing to await. (Were that to change, Express
 * 5 forwards a rejected promise from a handler to the four-arity error
 * middleware on its own, so no wrapper would be needed even then.)
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
  // `text/plain; version=0.0.4; charset=utf-8`. That value is harmless to a
  // scraper -- it is in fact the canonical Prometheus exposition type -- but
  // the service's HTTP contract names `text/plain; version=0.0.4` exactly, and
  // `res.setHeader()` is the only setter that leaves it byte for byte as
  // written. Do not "simplify" this to `res.set()`: it compiles, it looks
  // tidier, and it silently changes the advertised content type.
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
  // No `Content-Length` accompanies the body, and that is expected rather than
  // a gap: `compression()` at position 3 of the pipeline wraps `res.end`, so
  // the response is sent with `Transfer-Encoding: chunked` -- gzip-encoded when
  // the client offered gzip, plain when it did not. Chunked transfer is
  // unremarkable to a scraper, and arranging the compression is the pipeline's
  // job, not this route's.
  res.end(render());
});

// Exported as the bare router, not wrapped in an object and not behind a
// factory, because the aggregator in `./index.js` mounts the value directly
// with `router.use('/metrics', metricsRoutes)`.
module.exports = router;
