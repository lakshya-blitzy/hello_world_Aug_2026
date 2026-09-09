// SPDX-License-Identifier: Apache-2.0
//
// The versioned API surface for hello-world-service.
//
// Single responsibility: declare the routes served behind the /api/v1 mount.
// Today that is exactly one body-parsing reference endpoint, POST /echo. This
// module validates and echoes what the pipeline has already parsed. It does
// not parse a body of its own, and it does not format a failure response --
// both of those belong to other modules, named below.
//
// WHERE THE VERSION LIVES. src/routes/index.js mounts this router at
// '/api/v1', so the path declared below as '/echo' is served at
// POST /api/v1/echo. The version belongs to the mount point and deliberately
// never appears in this file: writing '/api/v1/echo' here would produce
// /api/v1/api/v1/echo. A future v2 is therefore an added mount in the
// aggregator rather than an edit to this file.
//
// WHY /echo EXISTS AT ALL. It is a reference endpoint chosen by the
// implementation plan, not a requested product capability. A versioned mount
// carrying one body-parsing endpoint is the smallest surface that makes the
// routing and the middleware pipeline verifiable end to end: it exercises the
// JSON parser, the configured body-size limit, three of the five body-parser
// statuses the error handler allowlists, request-id propagation, and -- given a
// response above the compression threshold -- response compression itself. It
// is expected to be replaced by real business routes, and nothing else in the
// service depends on it. It stays a single endpoint on purpose: a
// service-information route was considered and explicitly excluded, because an
// environment name and an exact Node version are unauthenticated
// fingerprinting with no requirement behind them.
//
// THE BODY CONTRACT THIS MODULE IMPLEMENTS, and all of it: the request must
// declare application/json, it must actually carry a payload, and the parsed
// body must then be a JSON object -- which may be empty -- or an array.
// Emptiness is judged on the RAW PAYLOAD BYTES rather than on the parsed
// value, because express.json() synthesises `{}` for a payload of no bytes,
// which makes an absent body and a literal `{}` the same parsed value; the
// byte count comes from the verify hook at pipeline position 4 in src/app.js.
// Nothing else is checked here, and nothing checked here is checked twice --
// reading a body off the wire is express.json()'s job, bounded by
// config.bodyLimit, and formatting a failure into the
// { error: { status, message, requestId } } envelope is
// src/middleware/error-handler.js's. That division is also why this file
// declares no 405 handler: a method or path this router does not match reaches
// the notFound middleware and becomes a 404.

'use strict';

const express = require('express');

// Required as a bare binding, not destructured: src/lib/http-error.js exports
// the class itself, so `const { HttpError } = require(...)` would silently
// yield undefined and fail only on a request that was already going wrong.
const HttpError = require('../lib/http-error');

/**
 * The `/api/v1` child Router: the versioned API surface, carrying POST /echo
 * and no other route.
 *
 * This module's sole export, and it is exported as the bare Router rather than
 * a factory or a wrapping object, because that is the shape
 * `src/routes/index.js` mounts with `router.use('/api/v1', apiRoutes)`. Either
 * other shape would break that mount, and the version stays in the mount path
 * rather than in any path declared here.
 *
 * @type {import('express').Router}
 */
const router = express.Router();

/**
 * POST /echo -- validate a JSON request body and return it unchanged, together
 * with the correlation id of the request that carried it.
 *
 * Served at POST /api/v1/echo once src/routes/index.js has mounted this router.
 * Three checks run, in this order and no others: the declared media type, then
 * the raw payload's byte count, then the shape of the already-parsed body. All
 * three are in-memory, which is why the handler is synchronous with nothing to
 * await, and it carries no try/catch or async-error shim -- Express 5 forwards
 * a rejected promise from an async handler to the four-arity error middleware
 * on its own, so a wrapper here would be dead code.
 *
 * Statuses this handler produces itself, each rejection delegated with
 * `next(err)` as an HttpError rather than written to the response here:
 * - `200` with `{ echo: <parsed body>, requestId }` when all three checks
 *   pass, so `echo` is always present and is always an object or an array. An
 *   empty array and an empty object are both echoed: `[]` and `{}` are bodies
 *   a client sent deliberately, and neither is what "no body" means here.
 * - `400` when the request does not declare `application/json` -- a
 *   form-encoded body, which the urlencoded parser would otherwise hand over
 *   as a perfectly good object, included.
 * - `400` when the request carried no payload bytes: a zero-length payload, or
 *   a chunked message that streams nothing. Judged on the byte count recorded
 *   at pipeline position 4, never on the parsed value, which cannot tell that
 *   case apart from a literal `{}`.
 * - `400` when the parsed body is `null` or is not an object.
 *
 * Statuses produced upstream of this handler, and deliberately not implemented
 * in it. Each is raised by a body parser before the router is reached -- for a
 * JSON request, `express.json()` -- so this handler never runs for such a
 * request, and error-handler.js maps each from `err.type`:
 * - `400` for a malformed JSON body (`entity.parse.failed`), which under
 *   `express.json()`'s strict mode also covers a bare scalar such as `42`;
 *   that 400 therefore carries the JSON parser's own message rather than any
 *   message from this file.
 * - `413` for a body over the configured limit (`entity.too.large`).
 * - `415` for an unsupported `Content-Encoding` (`encoding.unsupported`).
 *
 * A request whose method or path this router does not match reaches notFound
 * and becomes a `404` -- which is why there is no 405 branch and no GET /echo.
 *
 * @param {import('express').Request} req The request. Reads
 *   `req.is('application/json')` for the declared media type,
 *   `req.rawBodyLength` -- the raw payload's byte count, recorded by the
 *   `verify` hook at pipeline position 4 in src/app.js and absent when no
 *   payload was read at all -- `req.body` as produced by the upstream JSON
 *   parser, and `req.id` for the correlation id.
 * @param {import('express').Response} res The response, used only on the
 *   success path.
 * @param {import('express').NextFunction} next Delegates a rejection to
 *   error-handler.js as an HttpError. Never called to continue the chain.
 * @returns {void} Nothing. The outcome is either a written response or a
 *   delegated error.
 */
router.post('/echo', (req, res, next) => {
  // MEDIA TYPE, AND IT RUNS FIRST -- WHICH IS NOT REDUNDANT WITH THE SHAPE
  // CHECK BELOW. This is the single most likely line in the file to be deleted
  // as duplicated work, so the reason is recorded here. express.urlencoded()
  // at pipeline position 5 parses an application/x-www-form-urlencoded body
  // into a perfectly ordinary object, which would pass the shape check and be
  // echoed as a success. This check is the only thing that makes the JSON-only
  // contract real; without it, `-H 'Content-Type:
  // application/x-www-form-urlencoded' -d 'a=1'` returns 200 instead of the
  // specified 400.
  if (!req.is('application/json')) {
    return next(
      new HttpError(400, 'Request Content-Type must be application/json'),
    );
  }

  // AN ABSENT PAYLOAD IS NOT A BODY, AND THE PARSED VALUE CANNOT SAY SO.
  // express.json() special-cases a payload of no bytes and yields `{}` for it
  // instead of failing to parse it, so `req.body` is `{}` both for a request
  // that sent nothing and for one that sent the two bytes `{}` -- and the
  // contract answers those differently: an empty object is a body, echoed at
  // 200, while no payload at all is this 400. The raw byte count recorded by
  // the `verify` hook at pipeline position 4 in src/app.js is the only signal
  // that separates them, which is why this guard reads it rather than
  // `Object.keys(req.body)`. Both empty-payload framings are rejected here: a
  // declared `Content-Length: 0` and a `Transfer-Encoding: chunked` message
  // that streams no bytes each arrive with a count of `0`.
  //
  // A count that is not a number means the JSON parser never read a payload
  // for this request -- body-parser skips the read, and therefore the hook,
  // when the request carries no payload framing at all -- so that case is an
  // absent body too and is rejected with the same message. The media-type
  // check above already answers it, since `req.is()` is `null` without
  // framing; this half is the belt and braces that keeps "no bytes read" from
  // ever reaching the shape check as a synthesised `{}`.
  if (typeof req.rawBodyLength !== 'number' || req.rawBodyLength === 0) {
    return next(new HttpError(400, 'Request body is required'));
  }

  // The parser's strict mode rejects a bare scalar of its own accord, so this
  // guard is not the primary defence. It is deliberate rather than dead: it
  // makes "echo is an object or an array" a property this handler enforces
  // itself rather than one inherited from a parser setting.
  if (req.body === null || typeof req.body !== 'object') {
    return next(
      new HttpError(400, 'Request body must be a JSON object or array'),
    );
  }

  // `requestId` is req.id, read and never minted here: a locally generated id
  // would disagree with the x-request-id response header and with this
  // request's access log record, destroying exactly the correlation the
  // pipeline exists to provide.
  res.status(200).json({ echo: req.body, requestId: req.id });
});

module.exports = router;
