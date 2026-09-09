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
 * The request methods the service's declared contracts use -- `GET` for the
 * four read paths, `POST` for `/api/v1/echo`. Compared without normalising:
 * Node's HTTP parser answers 400 to a method token it does not recognise
 * before Express sees the request, so `req.method` is always canonical
 * upper-case here.
 *
 * @type {ReadonlySet<string>}
 */
const SANCTIONED_METHODS = new Set(['GET', 'POST']);

/**
 * Method gate: the first layer of this Router, registered ahead of the four
 * mounts so no child router is entered for a method the service does not
 * declare. Ungated, the router package widens the surface on its own -- it
 * answers HEAD from a GET route, and answers OPTIONS on any path a route
 * matched with 200 and an `Allow` header.
 *
 * Contract: it never responds. A sanctioned method continues into the mounts
 * with `next()`; any other method exits this Router with `next('router')`,
 * which skips the mounts and returns control to the application pipeline,
 * where `notFound` turns the request into the single typed 404. No status,
 * body or header -- `Allow` included -- is written here.
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
