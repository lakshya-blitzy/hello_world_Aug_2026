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
// JSON parser, the configured body-size limit, four of the six body-parser
// statuses the error handler allowlists, request-id propagation, and -- given a
// response above the compression threshold -- response compression itself. It
// is expected to be replaced by real business routes, and nothing else in the
// service depends on it. It stays a single endpoint on purpose: a
// service-information route was considered and explicitly excluded, because an
// environment name and an exact Node version are unauthenticated
// fingerprinting with no requirement behind them.
//
// THE BODY CONTRACT THIS MODULE IMPLEMENTS, and all of it: the request must
// declare application/json, it must actually carry a payload, the parsed body
// must then be a JSON object -- which may be empty -- or an array, and that
// body must not nest deeper than MAX_BODY_DEPTH levels.
// Emptiness is judged on the RAW PAYLOAD BYTES rather than on the parsed
// value, because express.json() synthesises `{}` for a payload of no bytes,
// which makes an absent body and a literal `{}` the same parsed value; the
// byte count comes from the verify hook at pipeline position 4 in src/app.js.
// The depth bound exists because this module ECHOES the body: serialising an
// unbounded client-supplied structure fails inside the response writer, and
// that failure would be reported as a server fault rather than as the client
// error it is -- the reasoning is recorded at MAX_BODY_DEPTH below.
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
 * Deepest nesting this endpoint will echo, counted in containers: the body
 * itself is level 1, a container inside it is level 2, and so on. The bound is
 * INCLUSIVE -- a body at exactly this depth is echoed at 200, one level deeper
 * is the 400 raised below.
 *
 * WHY A BOUND EXISTS AT ALL, AND WHY IT BELONGS HERE. `res.json()` serialises
 * through `JSON.stringify`, which recurses once per nesting level, so a body
 * nested deeply enough exhausts the V8 stack INSIDE the response writer. The
 * resulting `RangeError` carries no `err.type` and makes no exposable claim
 * about the request, so src/middleware/error-handler.js resolves it to a
 * masked 500 -- which is exactly right for an untyped error, because an
 * untyped error is a defect in this service rather than a client's mistake,
 * and that policy is what stops a real bug being reported to a caller as its
 * own fault. The consequence is that the fault has to be prevented at the
 * edge instead of mapped at the exit: left unguarded, one unauthenticated
 * request writes an error-level exception record and moves the
 * `http_requests_by_status_class_total{status_class="5xx"}` counter that
 * src/lib/metrics.js publishes as the service-failure signal, letting any
 * client drive the operator's alerting interface. Bounding the body here keeps
 * such a request in the 4xx class it belongs to, and keeps AAP 0.5.3's failure
 * column -- 400, 413, 415 and nothing else -- true.
 *
 * WHY 64, AND DELIBERATELY NOT THE MEASURED LIMIT. Measured on this tree
 * (Node 24.20.0, express 5.2.1): in-request array depth 4200 and 4300 echo at
 * 200 while 4400 overflows; object nesting echoes at 4000 and overflows at
 * 8000; and `JSON.stringify` on a clean stack fails at 4457. Those numbers are
 * a stack-HEADROOM property rather than a contract -- they move with V8's stack
 * budget, a `--stack-size` flag, the depth of the async chain the request
 * arrives on, and any middleware added ahead of this route -- so a bound set
 * near them would make one identical request answer 200 or 400 depending on
 * conditions nobody controls. 64 sits roughly 67x below the 4300-4400 onset,
 * margin that no plausible headroom change consumes; it is also the strictest
 * mainstream default, matching System.Text.Json's `MaxDepth` of 64 where
 * PHP's `json_decode` uses 512 and Jackson's read constraints 1000. The
 * response this handler builds, `{ echo, requestId }`, wraps the body in one
 * more object, so an accepted body puts at most 65 levels through
 * `JSON.stringify` -- which is the figure the margin above has to hold for.
 *
 * A MODULE CONSTANT AND NOT A NINTH ENVIRONMENT VARIABLE. AAP 0.5.1 and 0.6.5
 * fix the operator-settable set at exactly the eight variables `.env.example`
 * lists, and this is a property of the endpoint's HTTP contract -- documented
 * in README.md section 6 -- rather than a per-deployment tuning knob.
 *
 * @type {number}
 */
const MAX_BODY_DEPTH = 64;

/**
 * Reports whether a parsed JSON value nests deeper than `maxDepth` containers.
 *
 * ITERATIVE, NEVER RECURSIVE, AND THAT IS THE WHOLE POINT. A recursive depth
 * walk would consume one stack frame per level and so would overflow on
 * precisely the payload this function exists to reject -- failing the same way
 * `JSON.stringify` does and turning the guard into a second source of the
 * fault it prevents. This walks breadth-first instead: each pass collects the
 * container children of the current level into the next level and counts that
 * level once, so stack use is constant however deep the input is.
 *
 * EARLY EXIT, WHICH IS WHAT MAKES THE REJECTION CHEAP. The walk stops the
 * moment a container is found past the bound, so a depth-5000 attack payload
 * costs about 65 iterations rather than a traversal of all 5000 levels, and a
 * hostile client cannot make the guard itself expensive.
 *
 * ONLY OBJECTS AND ARRAYS ADD DEPTH. Strings, numbers, booleans and `null` are
 * leaves; `null` is excluded explicitly because `typeof null === 'object'`.
 *
 * The depth cap is also what makes the walk TERMINATE ON A CYCLIC GRAPH, where
 * an unbounded descent would not: the count only ever rises, so a cycle is cut
 * at the bound. `JSON.parse` output cannot contain a cycle, so that is
 * robustness for a value this function was not expected to receive rather than
 * a live case -- it takes any value and must not hang on any of them.
 *
 * COST. One additional traversal beside the two the request already performs
 * -- `JSON.parse` on the way in, `JSON.stringify` on the way out -- over a
 * structure whose size is bounded by `config.bodyLimit`, and only for a body
 * that has already passed the three cheaper checks.
 *
 * @param {*} value The parsed body, or any value: a non-container is answered
 *   without a single iteration.
 * @param {number} maxDepth Deepest level accepted, inclusive. Passed in rather
 *   than read from the module constant, so the bound a rejection reports is
 *   the bound the call site chose.
 * @returns {boolean} True when some container sits deeper than `maxDepth`, and
 *   the body must therefore be rejected rather than echoed.
 */
function exceedsMaxDepth(value, maxDepth) {
  // The same "object or array, but not null" test the shape check applies to
  // the body itself, applied here to every child.
  const isContainer = (candidate) =>
    candidate !== null && typeof candidate === 'object';

  // The frontier: every container found at the level about to be counted. A
  // scalar body starts it empty, so the loop below never runs for one.
  let level = isContainer(value) ? [value] : [];
  let depth = 0;

  while (level.length > 0) {
    depth += 1;

    // Checked before this level's children are collected, so nothing beyond
    // the bound is ever walked.
    if (depth > maxDepth) {
      return true;
    }

    const next = [];

    for (const container of level) {
      // `Object.values` covers both container kinds in one branch -- on an
      // array it yields the elements -- and reads own enumerable properties
      // only, so nothing reached through a prototype is counted as depth.
      for (const child of Object.values(container)) {
        if (isContainer(child)) {
          next.push(child);
        }
      }
    }

    level = next;
  }

  return false;
}

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
 * `caseSensitive: true` is what makes `/echo` the one spelling of this leaf
 * that reaches the handler: without it `POST /api/v1/ECHO` matches and echoes,
 * so the served set would be wider than the contract table declares and wider
 * than section 6 of `server/README.md` states. A Router's matching options are
 * fixed when it is constructed, so the application settings in `src/app.js`
 * cannot reach this decision -- it has to be made here, exactly as the three
 * other leaf Routers make it.
 *
 * `strict: true` is its pair, and its effect here is defence in depth rather
 * than a distinct behaviour: `POST /api/v1/echo/` is already refused before
 * this Router is entered, by `./index.js`'s request-target gate, which has to
 * own that spelling because mounting strips the `/api/v1` prefix and
 * normalises what is left. Setting `strict` here keeps the exactness true for
 * any leaf path added later and independently of that gate's rules.
 *
 * @type {import('express').Router}
 */
const router = express.Router({ caseSensitive: true, strict: true });

/**
 * POST /echo -- validate a JSON request body and return it unchanged, together
 * with the correlation id of the request that carried it.
 *
 * Served at POST /api/v1/echo once src/routes/index.js has mounted this router.
 * Four checks run, in this order and no others: the declared media type, then
 * the raw payload's byte count, then the shape of the already-parsed body, then
 * its nesting depth. All four are in-memory, which is why the handler is
 * synchronous with nothing to await, and it carries no try/catch or async-error
 * shim -- Express 5 forwards a rejected promise from an async handler to the
 * four-arity error middleware on its own, so a wrapper here would be dead code.
 * A try/catch around `res.json()` would be dead code for a second reason: the
 * depth check ahead of it removes the one client-reachable way that call can
 * throw, and catching a stack overflow instead of preventing it would make the
 * same request answer 200 or 400 according to how much stack happened to be
 * left.
 *
 * Statuses this handler produces itself, each rejection delegated with
 * `next(err)` as an HttpError rather than written to the response here:
 * - `200` with `{ echo: <parsed body>, requestId }` when all four checks
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
 * - `400` when the parsed body nests deeper than `MAX_BODY_DEPTH` levels. The
 *   message names the bound, because it is the only thing that lets a client
 *   flatten the request and try again -- and a 4xx message is never masked, in
 *   any environment.
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

  // NESTING DEPTH, AND IT RUNS LAST BECAUSE IT IS THE ONLY CHECK THAT COSTS A
  // TRAVERSAL -- the three above are constant-time, so nothing pays for this
  // one until a request has otherwise earned a 200. It guards the very next
  // line: `res.json()` serialises with `JSON.stringify`, one recursion per
  // level, so an unbounded client-supplied structure overflows the stack
  // inside the response writer and arrives at the terminal handler as an
  // untyped `RangeError` -- a masked 500, an error-level exception record and
  // a 5xx counter increment for what is only a client sending a body this
  // endpoint declines to echo. Rejecting it here is what makes the outcome a
  // named 400 instead. See MAX_BODY_DEPTH for the bound and its margin.
  if (exceedsMaxDepth(req.body, MAX_BODY_DEPTH)) {
    return next(
      new HttpError(
        400,
        `Request body must not nest deeper than ${MAX_BODY_DEPTH} levels`,
      ),
    );
  }

  // `requestId` is req.id, read and never minted here: a locally generated id
  // would disagree with the x-request-id response header and with this
  // request's access log record, destroying exactly the correlation the
  // pipeline exists to provide.
  res.status(200).json({ echo: req.body, requestId: req.id });
});

module.exports = router;
