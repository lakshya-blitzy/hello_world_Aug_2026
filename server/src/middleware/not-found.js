// SPDX-License-Identifier: Apache-2.0
//
// Single responsibility: turn a request no route handled -- an unmatched path,
// or a method the router tree's gate does not admit -- into a typed 404 error
// and hand it to the error handler. Nothing else.
//
// Position 7 of 8 in the pipeline src/app.js owns. Being reached is itself the
// proof that nothing handled the request, so there is no condition to test
// here. app.js registers this module; it must never require app.js in return,
// an edge that would close a cycle onto its mounter.

'use strict';

const HttpError = require('../lib/http-error');

// The path policy this service already applies to what it logs, reused here for
// what it SAYS. `./request-context.js` exports `serializePath` as a named
// property on its middleware export precisely so this file can share the one
// implementation instead of restating its 512-char bound and its
// `... (truncated)` marker -- a copy of either would let the message and the
// access record for the same request disagree. No cycle: request-context
// requires only pino-http, node:crypto, ../lib/logger and ../lib/metrics, and
// nothing in that set reaches back here.
const { serializePath } = require('./request-context');

/**
 * Terminal 404 producer for the request pipeline.
 *
 * Runs at position 7 of 8 -- after the router tree and `options.extraRouters`,
 * before the error handler -- so every request it sees is one nothing handled:
 * either no route matched the path, or the router tree's method gate refused
 * the method and skipped its mounts. Contract: it never sends a response and
 * always delegates, every invocation ending in `next(err)`, which keeps
 * `error-handler.js` the single exit for the 404 path exactly as it is for
 * every other failure.
 *
 * The message it carries names the method and the request's PATHNAME, reduced
 * by `./request-context.js`'s `serializePath` -- query string and fragment
 * removed, bounded at 512 characters with an explicit `... (truncated)` marker
 * -- so the value reflected to the caller is the same value this service
 * permits itself to log.
 *
 * @param {import('express').Request} req The unhandled request; `method` and
 *   `originalUrl` are read from it to describe the failure.
 * @param {import('express').Response} res The response object. Unused on
 *   purpose, and it must stay declared: Express resolves middleware parameters
 *   positionally, so removing it would slide `next` into the `res` slot --
 *   nothing would fail at load time, and the defect would surface only as a
 *   request that never ends.
 * @param {import('express').NextFunction} next Passes the error to the
 *   error handler.
 * @returns {void} Nothing is returned; the outcome is the delegated error.
 */
function notFound(req, res, next) {
  // `originalUrl`, not `url`: Express rewrites `req.url` relative to the mount
  // point of a router mounted under a prefix, so `url` can name a path the
  // client never sent. `originalUrl` is the URL as it arrived, which is the
  // only form worth reporting back or correlating with an access record.
  //
  // PUT THROUGH `serializePath` RATHER THAN INTERPOLATED RAW, on three counts.
  // The contract is a 404 naming the method and the PATH, while `originalUrl`
  // is path PLUS query string, so the raw value says more than was specified.
  // A response body is captured by proxies, CDNs and APM agents as freely as a
  // log stream is shipped and retained, so a value this service deliberately
  // keeps out of its own records -- a `?access_token=...`, a signed URL's
  // signature -- must not be handed to the caller instead; keeping it out of
  // one and reflecting it from the other guards nothing. And the bound decides
  // WHO sizes this string: unbounded, a caller picks it, and a request-line-
  // sized path becomes a same-sized message in every 404 body.
  const message = `Cannot ${req.method} ${serializePath(req.originalUrl)}`;

  // An error rather than a response, and the indirection is the point:
  // error-handler.js formats it into the one
  // `{ error: { status, message, requestId } }` envelope every other failure
  // uses. Answering `res.status(404).json(...)` here would be shorter and would
  // produce a second, divergent shape carrying no request id.
  next(new HttpError(404, message));
}

module.exports = notFound;
