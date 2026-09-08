// SPDX-License-Identifier: Apache-2.0
//
// Single responsibility: turn a request that matched no route into a typed 404
// error and hand it to the error handler. Nothing else.
//
// Position 7 of 8 in the pipeline src/app.js owns -- after the mounted router
// tree and any `options.extraRouters`, immediately before the four-arity error
// handler. Being reached is itself the proof that nothing matched, so there is
// no condition to test here. app.js registers this module; it must never
// require app.js in return, an edge that would close a cycle onto its mounter.

'use strict';

// The service's own typed error, and the only dependency here. Deliberately not
// the similarly named `http-errors` npm package: express depends on it, so it
// would resolve from this tree today, yet it is absent from server/package.json
// and would break the moment hoisting changed.
const HttpError = require('../lib/http-error');

/**
 * Terminal 404 producer for the request pipeline.
 *
 * Runs at position 7 of 8 -- after the router tree and `options.extraRouters`,
 * before the error handler -- so every request it sees is one no route matched.
 * Contract: it never sends a response and always delegates, every invocation
 * ending in `next(err)`, which keeps `error-handler.js` the single exit for the
 * 404 path exactly as it is for every other failure.
 *
 * @param {express.Request} req The unmatched request; `method` and
 *   `originalUrl` are read from it to describe the failure.
 * @param {express.Response} res The response object. Unused on purpose, and it
 *   must stay declared: Express resolves middleware parameters positionally, so
 *   removing it would slide `next` into the `res` slot -- nothing would fail at
 *   load time, and the defect would surface only as a request that never ends.
 * @param {express.NextFunction} next Passes the error to the error handler.
 * @returns {void} Nothing is returned; the outcome is the delegated error.
 */
function notFound(req, res, next) {
  // `originalUrl`, not `url`: Express rewrites `req.url` relative to the mount
  // point of a router mounted under a prefix, so `url` can name a path the
  // client never sent. `originalUrl` is the URL as it arrived, which is the
  // only form worth reporting back or correlating with an access record.
  const message = `Cannot ${req.method} ${req.originalUrl}`;

  // An error rather than a response, and the indirection is the point:
  // error-handler.js formats it into the one
  // `{ error: { status, message, requestId } }` envelope every other failure
  // uses. Answering `res.status(404).json(...)` here would be shorter and would
  // produce a second, divergent shape carrying no request id.
  next(new HttpError(404, message));
}

// Assigned directly rather than wrapped: app.js pulls this module in as
// `notFound` and hands it straight to `app.use(notFound)`, so exporting
// `{ notFound }` would register an object instead of a handler.
module.exports = notFound;
