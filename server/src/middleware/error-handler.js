// SPDX-License-Identifier: Apache-2.0
/**
 * The terminal error handler for the request pipeline.
 *
 * SINGLE RESPONSIBILITY. This module is the only place in the service where a
 * failure response is formatted, so every failure whose response has not yet
 * begun -- a typed 404 or 400, a body-parser rejection, an async handler's
 * rejected promise, an unexpected throw -- leaves as the same
 * `{ error: { status, message, requestId } }` envelope. There is exactly one
 * exception, and it is a supported path rather than a gap: a failure arriving
 * after `res.headersSent` cannot have its response replaced, so it is recorded
 * and the connection is then closed deterministically on whatever was already
 * on the wire -- by this module itself, for the log-hygiene reason set out at
 * that branch, rather than by handing the error onward.
 *
 * POSITION 8 OF 8, REGISTERED LAST by src/app.js, which owns the pipeline
 * listing. This module registers nothing and imports nothing from app.js. The
 * position is contract rather than style: Express only dispatches an error to
 * four-arity middleware registered after the routes that raise it.
 *
 * @module middleware/error-handler
 */

'use strict';

/*
 * `../lib/http-error` exports the bare class, so it is bound directly and used
 * with `instanceof` as the first branch of status resolution below.
 */
const HttpError = require('../lib/http-error');

/*
 * The frozen configuration object. This file reads one field, `isProduction`,
 * which decides whether a 5xx message is masked below.
 */
const config = require('../config');

/*
 * The one root pino logger, used here for a single purpose: the exception
 * record for the 5xx class -- every failure this handler resolves to a
 * server-fault status, however it was raised. Its redaction policy and its
 * allowlisting `err` serializer are configured at the root and inherited, which
 * is what makes passing the raw delegated error below safe. Writing to the
 * process streams directly is not an alternative: stdout is the production
 * newline-delimited JSON stream, and one non-JSON line breaks any consumer
 * parsing it line by line.
 */
const logger = require('../lib/logger');

/**
 * The response message sent for a 5xx in production, and the reason phrase
 * used when an error carries no usable message of its own.
 *
 * @type {string}
 */
const INTERNAL_SERVER_ERROR_MESSAGE = 'Internal Server Error';

/**
 * Lowest status treated as a server fault, and therefore the boundary for both
 * decisions this file takes on that class: production masking of the response
 * message, and the exception record.
 *
 * One threshold rather than two because the two are halves of one policy -- a
 * message masked out of the response has to survive in the log or it is lost,
 * so whatever is masked is recorded.
 *
 * @type {number}
 */
const SERVER_ERROR_MIN_STATUS = 500;

/**
 * The status used for any failure that is neither an `HttpError` nor a
 * recognised parser failure.
 *
 * @type {number}
 */
const FALLBACK_STATUS = 500;

/**
 * Longest request path written to the exception record. The path is
 * caller-controlled, so its length is bounded here for the same reason every
 * other string this service logs is: one field in one record must not be able
 * to become an unbounded log line.
 *
 * @type {number}
 */
const MAX_LOGGED_PATH_LENGTH = 512;

/**
 * The range of statuses this handler is willing to send for a failure: the
 * client-error and server-error classes, inclusive.
 *
 * The bounds match `HttpError`'s own constructor validation, and restating
 * them here rather than importing them is deliberate on two counts. This
 * file's imports are fixed at three by its contract, and `lib/http-error.js`
 * exports the bare class so there is nothing else to import from it. More to
 * the point, the two checks answer different questions: the constructor's
 * decides whether such an error may be created, while this one decides whether
 * a status may be handed to `res.status()` -- which it must, because `status`
 * is a mutable public field that can be reassigned long after construction.
 * The pair is a consistency obligation: moving one bound means moving both.
 *
 * @type {number}
 */
const MIN_SENDABLE_ERROR_STATUS = 400;

/**
 * Upper bound of the sendable failure range. See `MIN_SENDABLE_ERROR_STATUS`.
 *
 * @type {number}
 */
const MAX_SENDABLE_ERROR_STATUS = 599;

/**
 * Upper bound of the CLIENT-error class, and therefore the ceiling on the one
 * status this file will accept from an error it did not create -- see
 * `resolveExposedClientStatus`.
 *
 * It is deliberately narrower than `MAX_SENDABLE_ERROR_STATUS`: a foreign
 * error may say "the caller got this wrong", which is a claim about the request
 * and safe to relay, but it may never say "this service failed", because a
 * server fault is precisely what the exception record and the production mask
 * exist to handle. Anything at 500 or above from a foreign error resolves to
 * `FALLBACK_STATUS` on the same path as an unrecognised failure, so it is
 * recorded rather than quietly relayed.
 *
 * @type {number}
 */
const MAX_CLIENT_ERROR_STATUS = 499;

/**
 * The discriminator allowlist: `err.type` values the body-parser family sets,
 * mapped to the status each one deserves.
 *
 * This is the whole policy for untyped errors, written as data so a reviewer
 * can check it against the service's HTTP contract row by row rather than
 * tracing a chain of conditionals:
 *
 *   entity.parse.failed   -> 400  malformed JSON body
 *   entity.too.large      -> 413  body over BODY_LIMIT
 *   parameters.too.many   -> 413  urlencoded body with too many fields
 *   encoding.unsupported  -> 415  unsupported Content-Encoding
 *   charset.unsupported   -> 415  unsupported charset on the Content-Type
 *   request.aborted       -> 400  client went away mid-body
 *
 * WHY A DISCRIMINATOR AND NOT AN ERROR CLASS. A malformed JSON body arrives
 * here as a `SyntaxError` -- and so would a programming defect in a handler.
 * Branching on `err instanceof SyntaxError` would therefore report a bug in
 * this service's own code as a client error, sending 400 for a fault the
 * client did not cause and hiding a defect that needs fixing. `err.type` is
 * set by the parser and never by application code, which is exactly what makes
 * it a safe discriminator: its presence is evidence of where the failure came
 * from, which the class is not.
 *
 * WHY EVERY ROW AND NOT JUST THE TWO OBVIOUS ONES. Mapping only
 * `entity.parse.failed` and `entity.too.large` -- the two a developer meets
 * first -- silently turns an ordinary oversized form submission
 * (`parameters.too.many`) into a masked 500: a real client error reported as a
 * server fault, with the cause hidden from the client and the operator alike.
 * `encoding.unsupported`, `charset.unsupported` and `request.aborted` fail the
 * same way. Every row is load-bearing; none is decoration.
 *
 * WHY `charset.unsupported` SITS BESIDE `encoding.unsupported` RATHER THAN
 * BEING COVERED BY IT. They are two different headers and two different
 * rejections, and only their status coincides. `encoding.unsupported` is a
 * `Content-Encoding` the parser cannot decompress at all; `charset.unsupported`
 * is a `Content-Type` charset parameter -- `application/json; charset=...` --
 * that it cannot decode, raised from three separate sites in body-parser's
 * reader, and it is a distinct token that a lookup on the other one never
 * matches. Naming only one of the pair left an ordinary bad charset resolving
 * to a masked 500 while its sibling answered 415 correctly, which is the
 * asymmetry this row closes.
 *
 * WHAT IS DELIBERATELY ABSENT. The parser family also raises
 * `stream.encoding.set` and `stream.not.readable`, both of which mean this
 * service misused the request stream rather than that the client sent anything
 * wrong. They carry no row, so they fall through to `FALLBACK_STATUS` and are
 * recorded as the defects they are.
 *
 * @type {Readonly<Record<string, number>>}
 */
const PARSER_STATUS_BY_TYPE = Object.freeze({
  'entity.parse.failed': 400,
  'entity.too.large': 413,
  'parameters.too.many': 413,
  'encoding.unsupported': 415,
  'charset.unsupported': 415,
  'request.aborted': 400
});

/**
 * Tests whether a status may be sent for a failure.
 *
 * Two distinct failures are prevented, and only one of them is loud. Express 5
 * throws from `res.status()` for anything that is not an integer from 100 to
 * 999 -- and it would throw inside this handler, which has nothing after it,
 * so the request would end with no envelope at all. A value inside Express's
 * range but outside the failure classes is worse for being silent: a 204 or a
 * 302 would answer a failure as a success or a redirect, and nothing would
 * report the contradiction.
 *
 * @param {*} status The status an error declared for itself.
 * @returns {boolean} True when it is an integer in the client-error or
 *   server-error class and may therefore be sent as it stands.
 */
function isSendableErrorStatus(status) {
  return (
    Number.isInteger(status) &&
    status >= MIN_SENDABLE_ERROR_STATUS &&
    status <= MAX_SENDABLE_ERROR_STATUS
  );
}

/**
 * Reads the status a FOREIGN error declared for itself, but only where that
 * error also declares the claim safe to relay to the caller and the claim is a
 * client error.
 *
 * WHY THIS EXISTS AT ALL -- THE HOLE IT CLOSES. The `err.type` allowlist above
 * covers the failures body-parser labels, and a labelled failure is the easy
 * case. It does not cover the failures the parser produces WITHOUT a label,
 * and there is a reachable class of them: a request body that declares a
 * `Content-Encoding` the parser genuinely supports -- gzip, deflate or br --
 * and then cannot be decompressed. body-parser wraps the raw zlib or brotli
 * error with `createError(400, error)`, which yields `status`/`statusCode` 400
 * and `expose` true but carries NO `err.type` of its own, because the type it
 * would have had belongs to the decompressor rather than to the parser. With
 * only the allowlist to consult, every such request answered a masked 500: a
 * corrupt or truncated upload -- the client's fault, entirely ordinary -- was
 * reported as this service failing, an exception record was written for it, and
 * the per-status-class counter in src/lib/metrics.js recorded it in the 5xx
 * bucket, which is the signal an operator uses to decide whether the service
 * itself is broken. One bad upload could raise that signal.
 *
 * WHY TWO CONDITIONS AND NOT ONE, WHICH IS THE WHOLE OF THE CARE HERE.
 * Trusting `err.status` alone would dissolve the allowlist: any error from any
 * dependency could then choose this service's response status, and a bare
 * `SyntaxError` -- the shape a programming defect in a handler arrives in --
 * would only need a stray `status` property to be reported to a client as its
 * own mistake. So both must hold:
 *
 *   1. `err.expose === true` -- the producing library's own statement that the
 *      status and message describe the REQUEST and may be shown to whoever
 *      sent it. http-errors sets it, and sets it to `status < 500`, so a
 *      library reporting its own fault can never satisfy this.
 *   2. The declared status is an integer in the client-error class, 400 to
 *      `MAX_CLIENT_ERROR_STATUS`. A foreign error may not select a 5xx: see
 *      that constant.
 *
 * A bare `SyntaxError` has neither field, so it still resolves to a masked 500.
 * That is the hole this must not reopen, and it stays closed.
 *
 * WHY A VALUE TEST RATHER THAN AN OWN-PROPERTY TEST, unlike the allowlist
 * lookup. http-errors defines `expose` on the PROTOTYPE of its generated
 * classes -- verified: an `UnsupportedMediaTypeError` inherits it, while an
 * error wrapped by `createError(400, err)` carries it directly -- so
 * `Object.hasOwn` would reject exactly half of the library's own errors. A
 * strict `=== true` comparison is safe here where a bare lookup was not in the
 * allowlist: the allowlist's risk was resolving an inherited FUNCTION from
 * `Object.prototype` and handing it to `res.status()`, whereas nothing on
 * `Object.prototype` is the boolean `true`, and the status is then range-checked
 * regardless.
 *
 * @param {*} err The delegated failure, of any shape. Nothing is assumed: a
 *   nullish or primitive value short-circuits to `undefined`.
 * @returns {number|undefined} The client-error status to send, or `undefined`
 *   when the error made no relayable claim -- in which case the caller falls
 *   through to `FALLBACK_STATUS`.
 */
function resolveExposedClientStatus(err) {
  if (!err || err.expose !== true) {
    return undefined;
  }

  // Both spellings are read because they are not equivalent in general:
  // http-errors sets the pair, but a library that sets only `statusCode` is
  // making the same claim and is honoured on the same terms. `status` is
  // preferred when both are usable, matching the precedence http-errors itself
  // applies when it derives one from an existing error.
  for (const declared of [err.status, err.statusCode]) {
    if (
      Number.isInteger(declared) &&
      declared >= MIN_SENDABLE_ERROR_STATUS &&
      declared <= MAX_CLIENT_ERROR_STATUS
    ) {
      return declared;
    }
  }

  return undefined;
}

/**
 * Resolves the HTTP status a failure should produce, in strict precedence
 * order: a typed `HttpError`'s own status, then the parser allowlist keyed on
 * `err.type`, then a foreign error's own exposed client-error status, then the
 * masked fallback.
 *
 * WHY AN UNRECOGNISED ERROR STAYS A 500. A bare `SyntaxError` -- or anything
 * else that neither carries an allowlisted `err.type` nor satisfies both
 * conditions in `resolveExposedClientStatus` -- did not come from the parser
 * and makes no relayable claim about the request, so it is a defect in this
 * service's code rather than bad input, and a defect must never be reported to
 * a client as its own mistake. The status stays 500 and the real message is
 * masked in production, while the exception record keeps it for whoever has to
 * fix it.
 *
 * WHY A TYPED ERROR'S STATUS IS CHECKED BEFORE IT IS TRUSTED. `err.status` is
 * an ordinary public field: `HttpError`'s constructor validates what it is
 * given, but nothing stops a later assignment, and an `instanceof` test says
 * nothing about the field's current value. An unusable status is therefore
 * treated as exactly what it is -- a defect in this service -- and resolves to
 * the fallback, which both keeps the envelope intact and, being a 5xx, records
 * the fault instead of letting it through as a response nobody can explain.
 *
 * `err.status` and `err.statusCode` on a NON-`HttpError` error are consulted
 * only through `resolveExposedClientStatus`, and only on its two conditions
 * together. Honouring them on their own would look like a harmless
 * generalisation and would dissolve the allowlist: any third-party error
 * carrying a `status` property could then choose this service's response
 * status, including a 4xx for what is really a server fault. Requiring the
 * producing library to have marked the error exposable AND the status to be a
 * client error keeps that closed while covering the parser failures that carry
 * no type of their own -- which is the difference between a corrupt upload
 * answered as the client error it is and one reported as this service failing.
 *
 * @param {*} err The delegated failure. Typically an `Error`, but a handler is
 *   free to call `next()` with any truthy value, so nothing about its shape is
 *   assumed.
 * @returns {number} The status to send, and the one both the production
 *   masking decision and the exception record are taken against.
 */
function resolveFailure(err) {
  if (err instanceof HttpError) {
    return isSendableErrorStatus(err.status) ? err.status : FALLBACK_STATUS;
  }

  // Short-circuited rather than accessed directly: a handler may delegate a
  // primitive or a nullish value, and a throw inside the pipeline's single
  // exit would leave the request with no response at all.
  const type = err && err.type;

  // An own-property test rather than a bare lookup, because a bare lookup
  // reaches the prototype chain: an `err.type` of 'constructor' or 'toString'
  // would resolve to an inherited function and be handed to res.status(),
  // which throws. Only the rows declared above may decide a status this way.
  if (typeof type === 'string' && Object.hasOwn(PARSER_STATUS_BY_TYPE, type)) {
    return PARSER_STATUS_BY_TYPE[type];
  }

  // Last before the fallback, and last deliberately: an allowlisted type is a
  // stronger statement about a failure than a status property is, so where a
  // parser error carries both, the row above decides and this cannot override
  // it. This branch only ever sees failures the rows do not name.
  const exposedClientStatus = resolveExposedClientStatus(err);

  if (exposedClientStatus !== undefined) {
    return exposedClientStatus;
  }

  return FALLBACK_STATUS;
}

/**
 * Resolves the message the client is shown for a failure, applying production
 * masking to the server-fault class.
 *
 * WHY A 5xx MESSAGE IS MASKED IN PRODUCTION, AND WHY THE REAL ONE IS NOT LOST.
 * A server-fault message is written by whatever actually failed -- a parser, a
 * library, a call three frames deep -- and can name an internal path, a query
 * or a host that a client has no business seeing and an attacker can build on.
 * It is replaced here, not discarded: the exception record in `errorHandler`
 * below is emitted for every status this masks, so the real message and stack
 * stay in the log, correlatable to this response by request id. Outside
 * production the real message IS returned, which is what makes local debugging
 * workable without tailing a log alongside every request.
 *
 * 4xx messages are never masked, in any environment. They describe what the
 * caller did wrong -- "Request body must be a JSON object or array" -- and
 * withholding that would leave a client unable to work out the correct
 * request, which is the entire purpose of a 4xx.
 *
 * @param {*} err The delegated failure, of any shape.
 * @param {number} status The status already resolved by `resolveFailure`.
 * @returns {string} The message for the response envelope. Always a non-empty
 *   string, so the envelope never loses a field.
 */
function resolveMessage(err, status) {
  if (config.isProduction && status >= SERVER_ERROR_MIN_STATUS) {
    return INTERNAL_SERVER_ERROR_MESSAGE;
  }

  const message =
    err && typeof err.message === 'string' ? err.message.trim() : '';

  // A fallback rather than an absent field: `message: undefined` is dropped
  // entirely by JSON.stringify, leaving a consumer two envelope shapes to
  // branch on. Reaching this line means the delegated value carried no usable
  // message -- `next('boom')`, or an HttpError raised without one -- which is a
  // defect at the call site rather than something the client can act on, so
  // the generic phrase is the honest text for it.
  return message.length > 0 ? message : INTERNAL_SERVER_ERROR_MESSAGE;
}

/**
 * The terminal error handler: turns every failure in the pipeline into this
 * service's one failure envelope, and writes an exception record for every
 * failure it resolves to the 5xx class.
 *
 * POSITION 8 OF 8, AND LAST. It is registered by src/app.js after the router
 * tree and after `notFound`, so everything reaching it has already failed and
 * there is nothing after it to fall through to. Because `notFound` and this
 * handler are both in place by the time `createApp()` returns, a caller cannot
 * mount a route on the returned app -- the request would 404 before reaching
 * it -- which is why `createApp` takes an `options.extraRouters` seam instead.
 *
 * FOUR PARAMETERS ARE THE DISPATCH MECHANISM, AND GETTING IT WRONG FAILS
 * SILENTLY. Express identifies error middleware by arity alone: router's
 * `Layer.handleError` tests `fn.length !== 4` and, for anything whose arity is
 * not four, skips the layer and forwards the error with `next(error)` under the
 * comment "not a standard error handler". A three-parameter
 * version of this function is therefore registered as ORDINARY middleware and
 * simply never receives an error -- no exception, no warning, nothing at
 * start-up to tell anyone. Every failure would instead reach Express's default
 * handler and answer an HTML body carrying no request id, and the only symptom
 * would be responses in the wrong shape. `next` must stay declared for that
 * reason ALONE -- no path calls it, and the arity it contributes is its entire
 * purpose, so deleting it as an unused parameter is the one edit to this file
 * that breaks everything while looking like a tidy-up. `err` must stay first.
 *
 * CONTRACT. It always ends the request, in one of exactly two ways: by sending
 * the envelope, or -- when the response has already begun and cannot be
 * replaced -- by destroying the connection after recording the failure. It
 * never calls `next` at all, in either role: there is no chain left to continue
 * and, per the branch that ends the request, nothing is gained by handing the
 * error onward. It sets no header by hand and leaves helmet's headers from
 * position 2 alone, reads no request body, and touches no counters:
 * src/middleware/request-context.js is the sole writer to src/lib/metrics.js
 * and counts by status on its own 'close' hook, so incrementing anything here
 * would double-count every failure.
 *
 * @param {*} err The delegated failure. An `HttpError` from `not-found.js` or
 *   `api.routes.js`, a body-parser error carrying `err.type`, a rejection from
 *   an async handler, or an unexpected throw. Any truthy value is accepted,
 *   because `next()` accepts any. A rejection arrives here with no try/catch
 *   and no shim in the chain: Express 5 forwards a rejected promise from an
 *   async handler to four-arity error middleware itself, which is why this
 *   service declares no `express-async-errors` dependency.
 * @param {import('express').Request} req The request. `id` supplies the
 *   envelope's `requestId`; `method` and `path` -- the pathname, never the
 *   query string -- describe the failure in the log.
 * @param {import('express').Response} res The response. `headersSent` decides
 *   between sending the envelope and destroying the connection, and both are
 *   done through it.
 * @param {import('express').NextFunction} next DECLARED BUT NEVER CALLED, and
 *   it must never be removed: the four-parameter arity is what makes Express
 *   dispatch errors here at all, so dropping this parameter -- the obvious
 *   thing to do with one nothing references -- silently unregisters this
 *   handler as an error handler altogether, per the note above. It is retained
 *   as the dispatch contract rather than as an unused argument.
 * @returns {void} Nothing is returned; the outcome is the response sent, or the
 *   connection destroyed after the failure was recorded.
 */
function errorHandler(err, req, res, next) {
  // Resolved once and reused. The status decides the masking, the exception
  // record and the response, and re-deriving it at each use is how those
  // decisions come to disagree about the same failure.
  const status = resolveFailure(err);

  // THE EXCEPTION RECORD, FOR THE 5xx CLASS ONLY, GATED ON THE RESOLVED STATUS
  // RATHER THAN ON WHERE THE FAILURE CAME FROM. Every request already produces
  // exactly one access record from `requestContext` at position 1, at a level
  // derived from the status -- `warn` for a 4xx -- so a 404 or a rejected body
  // is ordinary traffic that is already recorded, and repeating it here at
  // `error` would bury real faults in routine client mistakes. A 5xx is
  // different for a concrete reason: in production its message is masked out
  // of the response below, so without this record the only account of what
  // actually failed would be discarded at the moment it mattered. That is as
  // true of a deliberate `HttpError(503)` as of an unrecognised throw, and a
  // gate that asked which of the two it was would lose exactly the deliberate
  // one.
  //
  // `requestId` is set explicitly because it must be the same value the access
  // record carries, so the two lines describing one failed request can be
  // joined. This logger's bindings do not supply it -- the access record gets
  // it through pino-http's serialized `req.id` -- so leaving it implicit would
  // leave the field absent here and the correlation impossible.
  if (status >= SERVER_ERROR_MIN_STATUS) {
    logger.error(
      {
        err,
        requestId: req.id,
        method: req.method,
        // THE PATHNAME ONLY, AND NEVER THE QUERY STRING. `req.originalUrl`
        // carries the query as the client sent it, and a query string is
        // caller-controlled: `?access_token=...`, a reset token, a signed
        // URL's signature. A log stream is copied, shipped and retained far
        // more freely than the request it describes, so a credential written
        // here outlives its own usefulness -- and no list of parameter names
        // could make keeping it safe, because the names are the caller's to
        // choose. The access record's request serializer in
        // src/middleware/request-context.js drops it for the same reason, and
        // these two records must describe one request the same way.
        //
        // `req.path` is Express's pathname of the ORIGINAL url, not the
        // mount-relative one: verified on Express 5.2.1 that a failure raised
        // inside a router mounted at `/api/v1` reaches this handler with
        // `req.url` already restored, so `req.path` is the full path the
        // client sent. It is bounded and type-guarded because this handler is
        // the pipeline's single exit and must not itself throw.
        path:
          typeof req.path === 'string'
            ? req.path.slice(0, MAX_LOGGED_PATH_LENGTH)
            : '',
        status
      },
      'Request failed with a server error'
    );
  }

  // THE RECORD ABOVE IS WRITTEN BEFORE THIS CHECK, AND THE ORDER IS THE POINT.
  // A failure arriving after the response has already begun is still a failure
  // worth recording -- it is in fact the hardest class of bug to diagnose,
  // because the client saw a plausible response and no envelope was ever sent.
  // Testing `headersSent` first and returning early would discard exactly those
  // records and leave nothing behind but a truncated response.
  //
  // ONCE HEADERS ARE OUT, THE ONLY REMAINING ACT IS TO END THE CONNECTION.
  // The status and the body are already on the wire and cannot be replaced:
  // `res.end()` or a second `res.json()` here would throw
  // ERR_HTTP_HEADERS_SENT and turn a bad response into an unhandled error
  // inside the pipeline's single exit. `res.destroy()` writes nothing, so it
  // raises nothing -- verified -- and it closes the connection on whatever the
  // client already received, which is exactly the outcome this path can offer.
  //
  // WHY THIS SERVICE DESTROYS THE CONNECTION ITSELF INSTEAD OF DELEGATING WITH
  // `next(err)`. Delegating from the last error handler reaches Express's
  // default final handler, and that handler does two things: it `console.error`s
  // the raw `err.stack` -- and then destroys the socket anyway. The transport
  // outcome is therefore identical either way; the only difference delegation
  // makes is the console write, and that write is a contract violation on this
  // service's terms. In production stdout is the newline-delimited JSON stream
  // and standard error carries exactly one thing, the pre-logger
  // configuration-failure record. A multi-line plain-text stack on standard
  // error is unparseable by a consumer reading the stream a line at a time,
  // carries no request id to correlate it with anything, and -- the reason this
  // is a log-hygiene control rather than a formatting preference -- bypasses
  // src/lib/logger.js entirely: neither its length bound nor its string
  // scrubber applies, so a credential inside an error message that the
  // structured record above correctly reduces to `[REDACTED]` would appear on
  // standard error in clear text, in a stream that is captured to a file and
  // retained. The record above is the account of this failure, it is complete,
  // and one account is what this path should produce.
  //
  // No argument is passed to `res.destroy()`, and that is deliberate: an
  // argument makes the response emit `'error'`, which would change the single
  // access record src/middleware/request-context.js writes for this request
  // from the outcome the client actually saw into an error-level record about
  // the abort. Destroying without one emits only `'close'`, which is the event
  // that both that access record and the in-flight counter already pair on.
  if (res.headersSent) {
    res.destroy();
    return;
  }

  // The envelope, exactly three fields.
  //
  // No `stack`: a stack in a response body hands a caller the service's
  // internal layout, and it is already in the exception record where it is
  // useful. No `details` either, even where an `HttpError` carries them -- the
  // HTTP contract fixes this shape at three fields, and a field that appears
  // only sometimes is one every consumer has to branch on.
  //
  // This is also the only failure body the service builds. The flat
  // `503 { status: "shutting_down" }` that `GET /health/ready` answers while
  // the process drains is a probe shape owned by src/routes/health.routes.js,
  // not an envelope produced here.
  //
  // `requestId` comes from `req.id`, established by `requestContext` at
  // position 1. That is precisely why that middleware runs first: `req.id` is
  // guaranteed present here even for a request that never reached a route or
  // whose body failed to parse, and it is what ties this response to the access
  // record written for the same request.
  //
  // `res.status().json()` sets status, JSON content type and body in one call.
  // Content-Type is deliberately not set by hand: doing so risks disagreeing
  // with the serialiser that actually writes the body.
  res.status(status).json({
    error: {
      status,
      message: resolveMessage(err, status),
      requestId: req.id
    }
  });
}

module.exports = errorHandler;
