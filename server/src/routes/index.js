// SPDX-License-Identifier: Apache-2.0
/**
 * Route aggregator for `hello-world-service`.
 *
 * Single responsibility: compose the four route modules behind one mountable
 * `express.Router()`, and constrain that Router to the request methods the
 * service declares. The four mount paths below are the only place the URL
 * prefixes appear -- each child module declares its paths relative to the
 * mount it is given here.
 *
 * Pipeline position 6 of 8 in `../app.js`, mounted as `app.use(routes)` ahead
 * of `options.extraRouters`, the terminal `notFound` and the error handler. It
 * declares no route handler and sends no response of its own: an unmatched
 * path or method leaves this Router, so position 7 owns the service's one 404.
 */
'use strict';

const express = require('express');

const rootRoutes = require('./root.routes');
const healthRoutes = require('./health.routes');
const metricsRoutes = require('./metrics.routes');
const apiRoutes = require('./api.routes');

/**
 * The aggregated router this module exports: the method gate plus the four
 * mounts registered below, built once at require time. Exported by direct
 * assignment because `../app.js` hands this module's value straight to
 * `app.use()`, which needs a mountable Router and not a wrapper or a factory.
 *
 * @type {import('express').Router}
 */
const router = express.Router();

/**
 * The request methods this Router admits into the four mounts below -- `GET`
 * for the four read paths, `POST` for `/api/v1/echo`, and `HEAD`, which the
 * router package answers from those same `GET` routes.
 *
 * WHY `HEAD` IS IN THIS SET, and why removing it is a regression. RFC 9110
 * requires a general-purpose server to support `GET` and `HEAD`, and the two
 * are one contract rather than two: `HEAD` must return exactly the status and
 * headers its `GET` would, with no body. Withholding it does not narrow the
 * service's surface -- `/`, `/health`, `/health/ready` and `/metrics` are
 * MATCHED paths -- it makes those four paths answer `404` to a caller that
 * asked a question they can answer, which is a false negative rather than a
 * refusal. The practical cost is measured in operations: `curl -I` cannot
 * inspect a route (this is the only way to read `/metrics`' exposition media
 * type without downloading the document), and a reverse proxy, load balancer
 * or uptime monitor that probes with `HEAD` -- HAProxy's
 * `option httpchk HEAD /` and many CDN and LB defaults do -- reads `404` and
 * withdraws a worker that is serving `GET` traffic normally. That directly
 * undercuts the health check `server/README.md` section 8.4 tells an operator
 * to configure.
 *
 * No route module declares a `HEAD` handler, and none should: the router
 * package resolves `HEAD` against a path's `GET` route when no explicit
 * `HEAD` handler exists, and Node then suppresses the body while keeping the
 * headers the handler set. Admitting the method here is the whole change.
 *
 * WHAT IS DELIBERATELY ABSENT. `OPTIONS` and every write method other than
 * `POST` stay out, which is what keeps them exiting this Router -- see the
 * gate's contract below.
 *
 * Compared without normalising: Node's HTTP parser answers 400 to a method
 * token it does not recognise before Express sees the request, so `req.method`
 * is always canonical upper-case here.
 *
 * @type {ReadonlySet<string>}
 */
const SANCTIONED_METHODS = new Set(['GET', 'HEAD', 'POST']);

/**
 * Method gate: the first layer of this Router, registered ahead of the four
 * mounts so no child router is entered for a method the service does not
 * declare.
 *
 * WHAT IT IS FOR, stated narrowly. Ungated, the router package answers
 * `OPTIONS` on any path a route matched -- `200` with an `Allow` header
 * enumerating that path's methods -- which is a response this service does not
 * declare in its contract and a discovery surface it does not intend to
 * publish. Suppressing that is the gate's entire purpose. It is NOT a general
 * narrowing of HTTP: `HEAD` is sanctioned above precisely because the router
 * package's handling of it -- answering from the path's own `GET` route -- is
 * behaviour the contract wants rather than behaviour to suppress.
 *
 * Contract: it never responds. A sanctioned method (`GET`, `HEAD`, `POST`)
 * continues into the mounts with `next()`; any other method exits this Router
 * with `next('router')`, which skips the mounts and returns control to the
 * application pipeline, where `notFound` turns the request into the single
 * typed 404. No status, body or header -- `Allow` included -- is written here,
 * so no `405` is produced on any path and `OPTIONS` is a plain `404`.
 *
 * A sanctioned method is admitted, not guaranteed a route: `HEAD /api/v1/echo`
 * passes this gate and still ends at the same 404, because `./api.routes`
 * declares `POST /echo` only and there is no `GET` for a `HEAD` to mirror.
 * Matching a path remains the mounts' job.
 *
 * @param {import('express').Request} req The inbound request; only `method` is
 *   read from it.
 * @param {import('express').Response} res Unused, and it must stay declared:
 *   Express resolves middleware parameters positionally, so removing it would
 *   slide `next` into the `res` slot.
 * @param {import('express').NextFunction} next Continues into the mounts, or
 *   exits this Router when passed the literal `'router'`.
 * @returns {void} Nothing is returned; the outcome is which call is made.
 */
function methodGate(req, res, next) {
  if (SANCTIONED_METHODS.has(req.method)) {
    next();
    return;
  }

  next('router');
}

router.use(methodGate);

// `GET /` -- the service's root response, in `text/plain`.
router.use('/', rootRoutes);

// `GET /health` (liveness) and `GET /health/ready` (readiness, which answers
// 503 once a drain has begun).
router.use('/health', healthRoutes);

// `GET /metrics` -- the Prometheus exposition document, per worker.
router.use('/metrics', metricsRoutes);

// `POST /api/v1/echo` -- the versioned API surface. The version lives in this
// mount path and nowhere inside `./api.routes` or its handlers, so a future
// `/api/v2` is one added mount line here beside a new module rather than a
// version branch inside every handler that would check it.
router.use('/api/v1', apiRoutes);

module.exports = router;
