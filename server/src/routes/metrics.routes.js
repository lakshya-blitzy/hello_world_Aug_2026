// SPDX-License-Identifier: Apache-2.0
/**
 * Prometheus scrape endpoint for `hello-world-service`.
 *
 * Single responsibility: serve the metric exposition document that
 * `../lib/metrics.js` renders, under the content type a Prometheus scraper
 * expects. Pure transport -- this module holds no measurement of its own and
 * reads neither configuration nor anything from the request.
 *
 * WHY THIS FILE CONTAINS NO COUNTING LOGIC, and must keep containing none. The
 * counter store in `../lib/metrics.js` has exactly one writer --
 * `../middleware/request-context.js`, at position 1 of the middleware
 * pipeline, which calls its two recording functions -- and exactly one reader,
 * this module, which calls `render()` and writes the result to the response.
 * That split is what keeps measurement separate from transport. Incrementing a
 * new metric here, beside the code that serves it, would couple the two halves
 * and make the counters depend on whether a scrape happened: add it to the
 * store, increment it from that middleware, and it appears here for free.
 *
 * WHY THE NUMBERS ARE PER-WORKER, and why no aggregation belongs here. Each
 * PM2 cluster worker is its own OS process with its own copy of the counter
 * store, and all workers share one listening socket, so a scrape reaches
 * whichever worker the socket assigns it to: one scrape shows one worker's
 * numbers and consecutive scrapes may show different ones. That is inherent to
 * counting in-process behind a shared port, not a defect to correct here --
 * the only real fix is an aggregator in front of the workers, which is out of
 * scope for this service and is recorded for operators in `server/README.md`.
 *
 * MOUNTING. `./index.js` -- the route aggregator -- mounts this router at
 * `/metrics`, so the route below is declared at `'/'`; declaring `'/metrics'`
 * here would produce `/metrics/metrics`.
 *
 * ACCESS CONTROL. This endpoint is unauthenticated, like every other route in
 * this service, and deliberately so: authentication and authorization are out
 * of scope, and the exposition body carries request counts and process figures
 * only -- never request content, and no configuration-derived value.
 * Restricting `/metrics` on a public deployment belongs at the reverse proxy,
 * which is documented in `server/README.md` rather than implemented here.
 */
'use strict';

const express = require('express');

// Only `render` is destructured: the store's two recording functions are its
// write side and belong exclusively to `../middleware/request-context.js`.
const { render } = require('../lib/metrics');

/**
 * The router this module exports.
 *
 * A bare `express.Router()` carrying the one route registered below. One
 * instance per process, created at require time: a Router is stateless with
 * respect to requests, so a single shared instance is correct and a factory
 * would buy nothing. It is exported by direct assignment
 * (`module.exports = router`) because the aggregator in `./index.js` mounts
 * the required value directly, with `router.use('/metrics', metricsRoutes)`,
 * which needs a mountable Router -- not a wrapper object, not `{ router }`,
 * and not a factory that has to be invoked first. Any other export shape
 * breaks that mount.
 *
 * @type {import('express').Router}
 */
const router = express.Router();

/**
 * Serve the current metric exposition document.
 *
 * Mounted at `/metrics`, so the effective request is `GET /metrics`. The HTTP
 * contract is fixed and has one shape only: `200`, the content type
 * `text/plain; version=0.0.4`, and the string `render()` returns as the body,
 * served byte for byte.
 *
 * `render()` is called with NO arguments, which is the whole of the read side:
 * it takes its numbers from the counter store's module-local state and from
 * three `process` figures, and needs nothing from the request, from this
 * handler or from configuration. There is consequently no failure response,
 * and therefore no input validation and no try/catch -- the route accepts no
 * input and nothing in the render path can fail. The handler is synchronous
 * for the same reason: there is nothing to await. (Were that to change,
 * Express 5 forwards a rejected promise from a handler to the four-arity error
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
  res.status(200);

  // The raw Node setter, not `res.set()`/`res.type()`: both Express helpers
  // append a charset to a `text/*` content type (verified on express 5.2.1),
  // while this service's contract names exactly `text/plain; version=0.0.4`
  // and only `setHeader()` leaves it byte for byte. Do not "simplify" it.
  res.setHeader('Content-Type', 'text/plain; version=0.0.4');

  // `res.end()` rather than `res.send()`: on a string body `res.send()`
  // rewrites an already-set Content-Type through `setCharset`, undoing the
  // header above. `render()` returns the complete document -- its own
  // `# HELP`/`# TYPE` lines and the trailing newline the text format requires
  // included -- so nothing is prepended, appended or trimmed here.
  res.end(render());
});

module.exports = router;
