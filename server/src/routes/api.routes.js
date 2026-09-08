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
// WHAT RUNS BEFORE THIS ROUTER, and is therefore never repeated inside it.
// src/app.js registers the aggregated router at pipeline position 6, after:
//   1. requestContext (pino-http)          -- assigns req.id, echoed below
//   2. helmet()                            -- security response headers
//   3. compression()                       -- response compression
//   4. express.json({ limit })             -- JSON parsing, bounded by
//                                             config.bodyLimit
//   5. express.urlencoded({ extended: false, limit })
//                                          -- form parsing, same bound
// and before:
//   7. notFound                            -- any path or method this router
//                                             does not match, which is why no
//                                             405 handler is declared here
//   8. errorHandler (four-arity)           -- the single formatter for every
//                                             failure, and the only place the
//                                             { error: { status, message,
//                                             requestId } } envelope is built

'use strict';

// Required for express.Router() alone. This module declares routes; it never
// creates an application, binds a port or registers middleware of its own.
const express = require('express');

// The typed error this handler raises for its own two rejections.
//
// This import is load-bearing rather than decorative: POST /echo performs its
// own media-type and body-shape checks and signals both as HttpError(400),
// leaving src/middleware/error-handler.js -- which honours an HttpError at its
// own status -- to render the response.
//
// Required as a bare binding because src/lib/http-error.js exports the class
// itself (module.exports = HttpError). Destructuring it as
// `const { HttpError } = require('../lib/http-error')` would silently yield
// undefined, and the failure would surface only at the moment a 400 was
// raised -- that is, only on a request that was already going wrong.
const HttpError = require('../lib/http-error');

// The router this module exports. A plain express.Router() with no options: it
// needs no mergeParams (it declares no parameterised path) and no caseSensitive
// or strict override (it inherits the application's settings, which is what
// keeps behaviour consistent across every mount).
const router = express.Router();

/**
 * POST /echo -- validate a JSON request body and return it unchanged, together
 * with the correlation id of the request that carried it.
 *
 * Served at POST /api/v1/echo once src/routes/index.js has mounted this router.
 * The handler is deliberately synchronous: it performs two in-memory checks and
 * responds, so there is nothing to await. It carries no try/catch and needs no
 * async-error shim -- Express 5 forwards a rejected promise from an async
 * handler to the four-arity error middleware on its own, so a wrapper here
 * would be dead code.
 *
 * Statuses this handler produces itself:
 * - `200` with `{ echo: <parsed body>, requestId }` when both checks pass.
 * - `400` when the request is not `application/json`, or when the parsed body
 *   is absent, is not an object, or is an empty object. Every one of these is
 *   delegated with `next(err)`; none is written to the response here.
 *
 * Statuses produced upstream of this handler, and deliberately not implemented
 * in it: `413` for a body over the configured limit (`entity.too.large`) and
 * `415` for an unsupported `Content-Encoding` (`encoding.unsupported`). Both are
 * raised by the body parser at pipeline position 4 or 5, so this handler never
 * runs for such a request; error-handler.js maps them from `err.type`. A
 * request whose method or path this router does not match reaches notFound and
 * becomes a `404` -- which is why there is no 405 branch and no GET /echo.
 *
 * @param {import('express').Request} req The request. Reads `req.is()` for the
 *   media type, `req.body` as produced by the upstream parsers, and `req.id` for
 *   the correlation id.
 * @param {import('express').Response} res The response, used only on the
 *   success path.
 * @param {import('express').NextFunction} next Delegates a rejection to
 *   error-handler.js as an HttpError. Never called to continue the chain.
 * @returns {void} Nothing. The outcome is either a written response or a
 *   delegated error.
 */
router.post('/echo', (req, res, next) => {
  // CHECK 1 -- MEDIA TYPE, AND IT MUST RUN FIRST.
  //
  // WHY THIS IS NOT REDUNDANT WITH THE SHAPE CHECK BELOW. This is the single
  // most likely line in the file to be deleted as duplicated work, so the
  // reason is recorded here. express.urlencoded() at pipeline position 5 parses
  // an application/x-www-form-urlencoded body into a perfectly ordinary object.
  // Such a body would therefore pass every part of Check 2 and be echoed as a
  // success. This check is the only thing that makes the JSON-only contract
  // real; without it, `-H 'Content-Type: application/x-www-form-urlencoded'
  // -d 'a=1'` returns 200 instead of the specified 400.
  //
  // The single negated test covers all three of req.is()'s outcomes: it returns
  // the matched type string on a match, `false` on a mismatch, and `null` when
  // the request carries no body or no Content-Type at all.
  if (!req.is('application/json')) {
    return next(
      new HttpError(400, 'Request Content-Type must be application/json', {
        received: req.get('content-type') || null,
      }),
    );
  }

  // CHECK 2 -- BODY SHAPE. Three rejections, each for a distinct reason.

  // (a) No parsed body at all. Defensive rather than routine: it is reachable
  // if the JSON parser did not run for this request, and reading properties off
  // undefined below would otherwise throw a TypeError -- a masked 500 reported
  // for what is really a bad request.
  if (req.body === undefined || req.body === null) {
    return next(new HttpError(400, 'Request body is required'));
  }

  // (b) A bare scalar such as `42` or `"x"`.
  //
  // WHY THIS BRANCH LOOKS UNREACHABLE BUT IS KEPT. express.json() runs in
  // strict mode and already rejects a bare scalar as `entity.parse.failed`,
  // which error-handler.js maps to 400, so the parser is the primary defence
  // and this branch is belt-and-braces. It is retained on purpose: it keeps the
  // guarantee below -- that `echo` is always an object or an array -- a
  // property of this handler rather than an inherited side effect of a parser
  // option that a later change could flip.
  if (typeof req.body !== 'object') {
    return next(
      new HttpError(400, 'Request body must be a JSON object or array', {
        received: typeof req.body,
      }),
    );
  }

  // (c) A plain object with no own enumerable keys.
  //
  // WHY AN EMPTY OBJECT IS A 400. express.json() special-cases an empty payload
  // and yields `{}` for it instead of raising a parse error, so by the time
  // execution reaches here an absent body and a literal `{}` are
  // indistinguishable. Both must be rejected for "an empty body returns 400" to
  // hold, and rejecting `{}` is the only way to reject the absent one.
  //
  // Emptiness is judged on plain objects only. An empty array can arise solely
  // from a client explicitly sending `[]` -- never from an absent body -- so it
  // is a deliberate payload and is accepted, echoed back as `[]`.
  if (!Array.isArray(req.body) && Object.keys(req.body).length === 0) {
    return next(new HttpError(400, 'Request body must not be empty'));
  }

  // SUCCESS. `echo` is the parsed body, which both checks above guarantee is
  // present and is either an object or an array.
  //
  // `requestId` is req.id, assigned by the pino-http instance in
  // src/middleware/request-context.js via its genReqId. It is read, never
  // minted here: a locally generated id would disagree with the x-request-id
  // response header and with this request's access log record, destroying
  // exactly the correlation the pipeline exists to provide.
  res.status(200).json({ echo: req.body, requestId: req.id });
});

// Exported as the bare router, which is what src/routes/index.js mounts with
// router.use('/api/v1', apiRoutes). Not a factory and not wrapped in an object:
// either shape would break that mount.
module.exports = router;
