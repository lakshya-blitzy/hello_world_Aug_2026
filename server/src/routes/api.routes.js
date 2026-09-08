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
//   4. express.json({ limit, verify })     -- JSON parsing, bounded by
//                                             config.bodyLimit; its verify
//                                             hook records the consumed
//                                             payload length, which Check 2
//                                             below reads
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

// The typed error this handler raises for its own rejections.
//
// This import is load-bearing rather than decorative: POST /echo performs its
// own payload-presence, media-type and body-shape checks and signals each of
// them as HttpError(400), leaving src/middleware/error-handler.js -- which
// honours an HttpError at its own status -- to render the response.
//
// Required as a bare binding because src/lib/http-error.js exports the class
// itself (module.exports = HttpError). Destructuring it as
// `const { HttpError } = require('../lib/http-error')` would silently yield
// undefined, and the failure would surface only at the moment a 400 was
// raised -- that is, only on a request that was already going wrong.
const HttpError = require('../lib/http-error');

// The router this module exports. A plain express.Router() with no options: it
// needs no mergeParams (it declares no parameterised path) and no caseSensitive
// or strict override, so this Router uses its own defaults, both of which are
// disabled.
//
// AND NOT BECAUSE ANYTHING IS INHERITED. A Router's `caseSensitive` and
// `strict` come from the options object passed to express.Router() and from
// nowhere else; the application's `case sensitive routing` and `strict
// routing` settings are applied only when Express builds the application's own
// router, never to a Router created here. Matching is nevertheless consistent
// across the whole service, because no Router in src/routes/ passes either
// option and src/app.js enables neither setting -- so every mount matches
// case-insensitively and treats a trailing slash as equivalent.
const router = express.Router();

/**
 * Report whether the request declares the `application/json` media type.
 *
 * `req.is()` is the primary test and answers for every request that declares
 * a payload. It cannot answer for one that does not: `type-is` returns `null`
 * rather than `false` when a request carries no body, because it refuses to
 * classify a media type it has no payload to attach it to. A bodyless request
 * is therefore unclassified rather than mistyped, and the two are different
 * faults that deserve different messages.
 *
 * So when `req.is()` declines to classify, this falls back to the declared
 * `Content-Type` itself. That keeps the media-type check FIRST -- the order
 * the service's contract fixes -- while letting a bodyless request that
 * correctly declared `application/json` fall through to the payload check,
 * which names the fault it actually has. A bodyless `text/plain` request is
 * still a media-type failure, as it should be.
 *
 * The fallback compares the type and subtype only, lower-cased, with any
 * parameters such as `; charset=utf-8` stripped -- the same acceptance
 * `req.is('application/json')` applies. It is written out locally rather than
 * delegating to Express's transitive `type-is`, which is not a declared
 * dependency of this service and so must not be required directly.
 *
 * @param {import('express').Request} req The request to classify. Reads
 *   `req.is()` and the `Content-Type` header; no side effects.
 * @returns {boolean} `true` when the media type is `application/json`, whether
 *   or not the request carries a payload; `false` for any other declared type
 *   and for a request that declares none at all.
 */
function declaresJsonMediaType(req) {
  const matched = req.is('application/json');

  // `null` means "no payload to classify", which is the one case req.is()
  // cannot answer. Everything else is already decided: the matched type string
  // on a match, `false` on a mismatch or on a missing Content-Type.
  if (matched !== null) {
    return matched !== false;
  }

  const declaredType = (req.get('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();

  return declaredType === 'application/json';
}

/**
 * Report whether the request actually carried payload bytes.
 *
 * WHY THIS CANNOT BE ASKED OF `req.body`, AND WHY NOT OF THE HEADERS EITHER.
 * `express.json()` special-cases an empty payload and yields `{}` for it
 * rather than raising a parse error, so a request that carried no bytes and a
 * request that carried the two bytes `{}` reach this handler as equal values.
 * The framing headers are no better on their own: they answer exactly for a
 * request that declared `Content-Length`, but a `Transfer-Encoding: chunked`
 * message declares no length at all, so a zero-byte chunked payload is
 * invisible in them.
 *
 * The byte count therefore comes from the one place it exists -- the parser.
 * `src/app.js`'s `verify` hook at pipeline position 4 records what
 * `express.json()` consumed as `req.jsonPayloadLength`, before the value that
 * loses the distinction is produced. Every framing is then judged exactly:
 * no `Content-Length`, `Content-Length: 0` and an empty chunked message all
 * report no payload, while `{}` and `[]` report the bytes they carried.
 *
 * ABSENCE MEANS NO PAYLOAD, DELIBERATELY. The property is missing only when
 * the parser did not run, and body-parser skips a request precisely when it
 * declares no framing headers -- that is, when it carried nothing. Reading its
 * absence as "no payload" is therefore correct, and it fails loudly rather
 * than silently if the hook is ever removed: every JSON-bodied request would
 * be rejected as bodyless, instead of the empty-payload case quietly
 * succeeding again. See the consistency obligation on the hook in
 * `src/app.js`.
 *
 * @param {import('express').Request} req The request to judge. Reads only the
 *   `jsonPayloadLength` recorded at position 4; it does not touch `req.body`
 *   and has no side effects.
 * @returns {boolean} `true` when the parser consumed at least one byte;
 *   `false` when it consumed none, or when it did not run at all.
 */
function carriesRequestPayload(req) {
  if (typeof req.jsonPayloadLength !== 'number') {
    return false;
  }

  return req.jsonPayloadLength > 0;
}

/**
 * POST /echo -- validate a JSON request body and return it unchanged, together
 * with the correlation id of the request that carried it.
 *
 * Served at POST /api/v1/echo once src/routes/index.js has mounted this router.
 * The handler is deliberately synchronous: it performs three in-memory checks
 * -- the media type, the payload byte count recorded at pipeline position 4,
 * and the shape of the already-parsed body -- and responds, so there is
 * nothing to await. It carries no try/catch and needs no async-error shim --
 * Express 5 forwards a rejected promise from an async handler to the
 * four-arity error middleware on its own, so a wrapper here would be dead
 * code.
 *
 * Statuses this handler produces itself, each delegated with `next(err)` and
 * none written to the response here:
 * - `200` with `{ echo: <parsed body>, requestId }` when all three checks
 *   pass. A literal `{}` and a literal `[]` are valid object bodies and are
 *   echoed back unchanged with this status; emptiness that fails is emptiness
 *   of the *payload*, not of the object.
 * - `400` for exactly three faults, and no others, checked in this order:
 *   (a) the media type is not `application/json`, a form-encoded body and a
 *   bodyless request of any other type included, which is the case the
 *   media-type check exists for; (b) the request carried no payload bytes --
 *   no `Content-Length`, `Content-Length: 0`, or an empty chunked message;
 *   (c) the parsed body is neither an object nor an array, with a `null` or
 *   absent body sharing (b)'s message on the defensive branch below.
 *
 * Statuses produced upstream of this handler, and deliberately not implemented
 * in it. All three are raised by the body parser at pipeline position 4 or 5,
 * so this handler never runs for such a request, and error-handler.js maps
 * each from `err.type`:
 * - `400` for a malformed JSON body (`entity.parse.failed`). This is an
 *   upstream outcome, not one of the three above: `express.json()` rejects the
 *   payload before the router is reached, and under its strict mode that also
 *   covers a bare scalar such as `42`, whose 400 therefore carries the JSON
 *   parser's own message rather than any message from this file.
 * - `413` for a body over the configured limit (`entity.too.large`).
 * - `415` for an unsupported `Content-Encoding` (`encoding.unsupported`).
 *
 * A request whose method or path this router does not match reaches notFound
 * and becomes a `404` -- which is why there is no 405 branch and no GET /echo.
 *
 * @param {import('express').Request} req The request. Reads the framing
 *   headers via carriesRequestPayload for payload presence, `req.is()` for the
 *   media type, `req.body` as produced by the upstream parsers, and `req.id`
 *   for the correlation id.
 * @param {import('express').Response} res The response, used only on the
 *   success path.
 * @param {import('express').NextFunction} next Delegates a rejection to
 *   error-handler.js as an HttpError. Never called to continue the chain.
 * @returns {void} Nothing. The outcome is either a written response or a
 *   delegated error.
 */
router.post('/echo', (req, res, next) => {
  // CHECK 1 -- MEDIA TYPE, AND IT RUNS FIRST.
  //
  // WHY THIS IS NOT REDUNDANT WITH THE SHAPE CHECK BELOW. This is the single
  // most likely line in the file to be deleted as duplicated work, so the
  // reason is recorded here. express.urlencoded() at pipeline position 5 parses
  // an application/x-www-form-urlencoded body into a perfectly ordinary object.
  // Such a body would therefore pass every part of Check 3 and be echoed as a
  // success. This check is the only thing that makes the JSON-only contract
  // real; without it, `-H 'Content-Type: application/x-www-form-urlencoded'
  // -d 'a=1'` returns 200 instead of the specified 400.
  //
  // WHY IT IS ROUTED THROUGH declaresJsonMediaType RATHER THAN `req.is()`
  // ALONE. A bare `!req.is('application/json')` treats a bodyless request as
  // a media-type failure, because `req.is()` returns `null` for it whatever
  // the request declared -- so a caller that correctly sent
  // `Content-Type: application/json` and forgot the body was told its media
  // type was wrong, a reason it could not act on. The helper keeps `req.is()`
  // as the test and only distinguishes that one unclassifiable case, so the
  // media type is still what this handler checks first and a genuinely
  // mistyped request -- bodyless or not -- is still rejected here.
  if (!declaresJsonMediaType(req)) {
    return next(
      new HttpError(400, 'Request Content-Type must be application/json', {
        received: req.get('content-type') || null,
      }),
    );
  }

  // CHECK 2 -- PAYLOAD PRESENCE.
  //
  // An empty payload is a 400, and it is judged on the byte count the parser
  // recorded at pipeline position 4 rather than on `req.body`: express.json()
  // turns a zero-length payload into `{}`, so by the time execution reaches
  // here an empty payload and a literal `{}` have equal parsed values. Reading
  // the recorded length is what lets `{}` succeed as the deliberate empty
  // object it is while a request carrying no bytes fails -- the two outcomes
  // the contract requires to hold at the same time -- and it holds for every
  // framing, including a chunked message that declares no length at all. See
  // carriesRequestPayload above.
  if (!carriesRequestPayload(req)) {
    return next(new HttpError(400, 'Request body is required'));
  }

  // CHECK 3 -- BODY SHAPE. Two rejections, each for a distinct reason.

  // (a) No parsed body at all. Purely defensive now that Check 2 has
  // established the parser consumed bytes for a JSON media type, which means
  // it left a value here. The branch is kept because a `null` or absent
  // `req.body` would otherwise be read as an object on the success path and
  // echoed as `null`, and because a future change to the parser configuration
  // must not be able to turn that into a masked 500 from a route handler.
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

  // NO KEY-COUNT CHECK. An empty object and an empty array are both valid
  // JSON bodies and are echoed back as `{}` and `[]` with a 200. Emptiness of
  // the *payload* -- a request that carried no bytes -- is Check 2's question
  // and is answered there, from the byte count the parser recorded, where the
  // answer actually exists. Counting keys here would repeat that question
  // against a value that cannot distinguish the two cases, which is what
  // previously made a deliberate `{}` fail.

  // SUCCESS. `echo` is the parsed body, which the checks above guarantee is
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
