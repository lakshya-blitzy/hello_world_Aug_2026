// SPDX-License-Identifier: Apache-2.0
/**
 * Route aggregator for `hello-world-service`.
 *
 * Single responsibility: compose the four route modules behind one mountable
 * `express.Router()`, and constrain that Router to the request TARGETS and
 * request METHODS the service declares. The four mount paths below are the
 * only place the URL prefixes appear -- each child module declares its paths
 * relative to the mount it is given here.
 *
 * Pipeline position 6 of 8 in `../app.js`, mounted as `app.use(routes)` ahead
 * of `options.extraRouters`, the terminal `notFound` and the error handler. It
 * declares no route handler and sends no response of its own: an unmatched
 * target, path or method leaves this Router, so position 7 owns the service's
 * one 404.
 *
 * WHY THE SERVED PATH SET IS NARROWED IN THIS FILE. The service's HTTP
 * contract declares exact paths and answers everything else with one 404
 * envelope, and that exactness is load-bearing rather than tidy: no route
 * authenticates its caller, so the only control over `GET /metrics` on a
 * reachable deployment is the reverse-proxy path rule an operator writes, and
 * a proxy matches paths case-sensitively and exactly. Every extra spelling
 * this Router would otherwise serve -- `/METRICS`, `/metrics/` -- is a way
 * past that rule. Two mechanisms close the gap and they are not
 * interchangeable: the Router's own `caseSensitive`/`strict` options, set
 * below, and the request-target gate above the mounts, which catches the one
 * case those options cannot see.
 */
'use strict';

const express = require('express');

const rootRoutes = require('./root.routes');
const healthRoutes = require('./health.routes');
const metricsRoutes = require('./metrics.routes');
const apiRoutes = require('./api.routes');

/**
 * The aggregated router this module exports: the two gates plus the four
 * mounts registered below, built once at require time. Exported by direct
 * assignment because `../app.js` hands this module's value straight to
 * `app.use()`, which needs a mountable Router and not a wrapper or a factory.
 *
 * BOTH OPTIONS ARE LOAD-BEARING AND NEITHER IS INHERITED. A Router takes its
 * matching behaviour from the options given HERE, at construction: the
 * `case sensitive routing` and `strict routing` settings on the application
 * configure only the router `../app.js` itself owns, and are not passed down
 * to a mounted Router. Measured, not assumed -- with this line left as a bare
 * `express.Router()`, those application settings change no response on any
 * path, and `/METRICS`, `/HEALTH` and `POST /API/V1/ECHO` all serve their real
 * handlers.
 *
 *   `caseSensitive: true`  makes the four mount paths below match exactly as
 *                          written, so `/metrics` is served and `/METRICS`,
 *                          `/Metrics` and `/mEtRiCs` leave this Router for the
 *                          404. This is the option that does the work here,
 *                          because every path this Router declares is a mount.
 *   `strict: true`         requires the exact trailing-slash form of any route
 *                          declared DIRECTLY on this Router. None is today --
 *                          this file mounts and gates, it does not route -- so
 *                          the option changes nothing on its own. It is set
 *                          because it is the pair of the one above and because
 *                          a route added directly here later would otherwise
 *                          silently accept `/thing/` as well as `/thing`.
 *
 * Each child Router repeats both options for its own leaf paths, for exactly
 * the same reason: `/health/READY` is matched by `./health.routes`, not here.
 *
 * @type {import('express').Router}
 */
const router = express.Router({ caseSensitive: true, strict: true });

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
 * Request-target gate: the first layer of this Router, registered ahead of the
 * method gate and the four mounts.
 *
 * WHAT IT REJECTS, and it is deliberately only these two shapes:
 *
 *   - a trailing slash on anything but the root -- `/metrics/`, `/health/`,
 *     `/health/ready/`, `/api/v1/echo/`
 *   - any empty path segment -- `//`, `/metrics//`, `/api/v1//echo`
 *
 * WHY THIS EXISTS WHEN `strict: true` IS ALREADY SET ABOVE. Because `strict`
 * cannot see the trailing slash on a mounted path, and this is the one detail
 * of the whole file that is impossible to reason out from the Express
 * documentation. Mounting a child Router at `/metrics` makes the router
 * package strip that prefix from the URL before the child is entered, and it
 * NORMALISES what is left: `/metrics` leaves the empty string, which becomes
 * `/`, and `/metrics/` leaves `/` directly. The child therefore sees the
 * identical path `/` in both cases and has nothing left to be strict about --
 * measured, and true for every combination of options on either Router. A
 * mounted service's trailing-slash spelling can only be caught before the
 * strip, which is what this gate is and why it cannot be replaced by a
 * setting.
 *
 * The empty-segment half is not covered by that argument -- a child's `strict`
 * option does reject `//` once it sees it -- and is checked here anyway, so
 * that one rule holds across every mount rather than depending on four child
 * modules each carrying the right option. `/api/v1//echo` is rejected here
 * whatever `./api.routes` is constructed with.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH. A query string: matching is on the
 * path, so `/metrics?x=1` is `GET /metrics` and is served, which is both the
 * contract's reading and what a path-based proxy rule matches. Percent-encoded
 * separators: `%2f` is not a path separator and `/metrics%2f` is simply an
 * unmatched path, answered by the same 404 as any other. Dot segments:
 * `/./metrics` matches no mount and needs no rule here -- note that a client
 * may resolve it away before sending, so a `curl http://host/./metrics` that
 * appears to succeed has actually requested `/metrics`.
 *
 * Contract: it never responds, exactly like the method gate below. A canonical
 * target continues into the mounts with `next()`; anything else exits this
 * Router with `next('router')`, which skips the mounts and returns control to
 * the application pipeline, where `../middleware/not-found.js` turns the
 * request into the service's single typed 404. Writing a status here would
 * give the service a second 404 producer with its own envelope.
 *
 * Exiting the Router rather than the pipeline also keeps `../app.js`'s
 * `options.extraRouters` seam reachable: it is registered after this Router
 * and before `notFound`, so an injected route is still entered for a target
 * this gate declines.
 *
 * @param {import('express').Request} req The inbound request; only `path` is
 *   read from it -- the URL's path component, already separated from the query
 *   string by Express and left percent-encoded as the client sent it.
 * @param {import('express').Response} res Unused, and it must stay declared:
 *   Express resolves middleware parameters positionally, so removing it would
 *   slide `next` into the `res` slot.
 * @param {import('express').NextFunction} next Continues into the method gate
 *   and the mounts, or exits this Router when passed the literal `'router'`.
 * @returns {void} Nothing is returned; the outcome is which call is made.
 */
function canonicalTargetGate(req, res, next) {
  const { path } = req;

  // The root is the one path whose trailing slash IS its canonical spelling,
  // so it is excluded from the first test rather than special-cased inside it.
  if (path !== '/' && (path.endsWith('/') || path.includes('//'))) {
    next('router');
    return;
  }

  next();
}

router.use(canonicalTargetGate);

/**
 * Method gate: the second layer of this Router, registered after the
 * request-target gate and ahead of the four mounts so no child router is
 * entered for a method the service does not declare.
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
