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
// declare application/json, and the parsed body must then be a JSON object
// with at least one key, or an array. Nothing else is checked here, and
// nothing checked here is checked twice -- reading a body off the wire is
// express.json()'s job, bounded by config.bodyLimit, and formatting a failure
// into the { error: { status, message, requestId } } envelope is
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
 * Two checks run, in this order and no others: the declared media type, then
 * the shape of the already-parsed body. Both are in-memory, which is why the
 * handler is synchronous with nothing to await, and it carries no try/catch or
 * async-error shim -- Express 5 forwards a rejected promise from an async
 * handler to the four-arity error middleware on its own, so a wrapper here
 * would be dead code.
 *
 * Statuses this handler produces itself, each rejection delegated with
 * `next(err)` as an HttpError rather than written to the response here:
 * - `200` with `{ echo: <parsed body>, requestId }` when both checks pass, so
 *   `echo` is always present and is always an object with at least one key or
 *   an array. An empty array is echoed; an empty object is not a body and is
 *   rejected below.
 * - `400` when the request does not declare `application/json` -- a
 *   form-encoded body, which the urlencoded parser would otherwise hand over
 *   as a perfectly good object, included.
 * - `400` when the parsed body is absent, `null`, not an object, or a plain
 *   object with no keys.
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
 *   `req.is('application/json')` for the declared media type, `req.body` as
 *   produced by the upstream JSON parser, and `req.id` for the correlation id.
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

  // The parser's strict mode rejects a bare scalar of its own accord, so this
  // guard is not the primary defence. It is deliberate rather than dead: it
  // makes "echo is an object or an array" a property this handler enforces
  // itself rather than one inherited from a parser setting.
  if (req.body === null || typeof req.body !== 'object') {
    return next(
      new HttpError(400, 'Request body must be a JSON object or array'),
    );
  }

  // AN EMPTY OBJECT IS NOT A BODY. Plan sections 0.5.3 and 0.9 both require
  // 400 for an empty body, and 0.5.1 pins position 4 as exactly
  // `express.json({ limit })`: with no `verify` hook the parser yields `{}`
  // for an empty payload, so no bytes and the two bytes `{}` are one value
  // here. Rejecting a zero-key plain object is the only way to satisfy 0.9
  // under those pinned options; a `verify` byte-count hook was considered and
  // declined as a 0.5.1 deviation. An empty ARRAY is different in kind: only
  // ever sent deliberately, never synthesised, so `[]` is echoed unchanged.
  if (!Array.isArray(req.body) && Object.keys(req.body).length === 0) {
    return next(new HttpError(400, 'Request body is required'));
  }

  // `requestId` is req.id, read and never minted here: a locally generated id
  // would disagree with the x-request-id response header and with this
  // request's access log record, destroying exactly the correlation the
  // pipeline exists to provide.
  res.status(200).json({ echo: req.body, requestId: req.id });
});

module.exports = router;
