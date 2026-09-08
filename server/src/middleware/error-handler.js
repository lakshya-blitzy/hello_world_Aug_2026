// SPDX-License-Identifier: Apache-2.0
/**
 * The terminal error handler for the request pipeline.
 *
 * SINGLE RESPONSIBILITY. This module is the only place in the service where a
 * failure response is formatted. Every failure converges here -- the typed 404
 * from src/middleware/not-found.js, the HttpError(400) raised by
 * src/routes/api.routes.js on media type or body shape, a body-parser
 * rejection, an async handler's rejected promise, and an unexpected throw --
 * and every one of them leaves as the same
 * `{ error: { status, message, requestId } }` envelope. Nothing else in the
 * pipeline writes a failure body, which is what keeps that shape single and
 * every failure correlatable by request id.
 *
 * POSITION 8 OF 8, REGISTERED LAST. The pipeline src/app.js assembles is:
 *
 *   1 requestContext            (request id, access record, counters)
 *   2 helmet()                  (security headers)
 *   3 compression()             (response compression)
 *   4 express.json({ limit })
 *   5 express.urlencoded({ extended: false, limit })
 *   6 router tree + options.extraRouters
 *   7 notFound                  (unmatched path -> HttpError(404))
 *   8 THIS MODULE
 *
 * This module registers nothing and imports nothing from src/app.js: it
 * exports a handler, and app.js places it last. The position is part of the
 * contract rather than a stylistic ordering, because Express only dispatches
 * an error to middleware registered after the routes that raise it.
 *
 * WHAT THIS MODULE IS NOT. It is not the source of the
 * `503 { status: "shutting_down" }` that `GET /health/ready` answers while the
 * process drains. That body is deliberately a flat probe shape owned by
 * src/routes/health.routes.js, because a probe's consumer matches on the
 * status code plus a small stable body and has no use for an error envelope's
 * three fields. A reader who assumes every non-2xx in this service is built
 * here will look for that 503 in the wrong file.
 *
 * NO ASYNC SHIM, DELIBERATELY. Express 5 forwards a rejected promise from an
 * async handler to four-arity error middleware on its own -- the router awaits
 * what a handler returns and routes a rejection to `next` -- so a route needs
 * no try/catch wrapper and this service needs no `express-async-errors`
 * dependency. Adding either would be dead weight that also hides the mechanism
 * from the next reader, who would then have no way to tell which of the two
 * paths was actually carrying the error.
 *
 * @module middleware/error-handler
 */

'use strict';

/*
 * The typed error class, required as the class itself because the module
 * exports the class itself (`module.exports = HttpError`). Destructuring the
 * import as `const { HttpError } = ...` would yield undefined, and
 * `err instanceof undefined` throws -- inside the pipeline's single exit,
 * which is the worst possible place for a throw.
 *
 * It is the FIRST branch of status resolution below: an HttpError is an error
 * whose raiser chose the status deliberately, so that status is honoured.
 */
const HttpError = require('../lib/http-error');

/*
 * The frozen configuration object, of which this file reads EXACTLY ONE field:
 * `isProduction`. Nothing else here is configurable, and that is the correct
 * boundary -- the statuses, the masked phrase and the envelope's shape are
 * protocol constants fixed by this service's HTTP contract, not operator
 * settings.
 *
 * WHY `config.isProduction` AND NEVER A STRING COMPARISON. The raw environment
 * is read in exactly one module in this codebase, src/config/index.js, which
 * is what makes an invalid environment one loud start-up failure instead of
 * several quiet disagreements. `isProduction` is derived there once precisely
 * so that this file and src/lib/logger.js cannot answer "are we in
 * production?" differently -- one masking 5xx messages while the other
 * attaches a development transport would be a contradiction nothing reports.
 */
const config = require('../config');

/*
 * The one root pino logger, used here for a single purpose: the exception
 * record for the 500 class. Its redaction policy (`req.headers.authorization`,
 * `req.headers.cookie`) is configured at the root and inherited, so nothing
 * needs re-stating here; this module logs no headers and no bodies in any
 * case. Writing straight to the process streams is not an alternative --
 * stdout is the production newline-delimited JSON stream, and one non-JSON
 * line breaks any consumer parsing it line by line.
 */
const logger = require('../lib/logger');

/**
 * The response message sent for a 5xx in production, and the reason phrase
 * used when an error carries no usable message of its own.
 *
 * A protocol constant, deliberately not a configuration key: an operator who
 * could re-word it could also make a masked failure claim something untrue,
 * and the value has to match what the acceptance criteria assert byte for
 * byte.
 *
 * @type {string}
 */
const INTERNAL_SERVER_ERROR_MESSAGE = 'Internal Server Error';

/**
 * Lowest status treated as a server fault, and therefore the threshold for
 * production masking.
 *
 * It is NOT the threshold for the exception record. That record is gated on
 * whether the failure was unexpected, which the status cannot express -- see
 * `resolveFailure` and the record itself.
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
 * WHY ALL FIVE ROWS AND NOT JUST THE TWO OBVIOUS ONES. Mapping only
 * `entity.parse.failed` and `entity.too.large` -- the two a developer meets
 * first -- silently turns an ordinary oversized form submission
 * (`parameters.too.many`) into a masked 500: a real client error reported as a
 * server fault, with the cause hidden from the client and the operator alike.
 * `encoding.unsupported` and `request.aborted` fail the same way. Every row is
 * load-bearing; none is decoration.
 *
 * @type {Readonly<Record<string, number>>}
 */
const PARSER_STATUS_BY_TYPE = Object.freeze({
  'entity.parse.failed': 400,
  'entity.too.large': 413,
  'parameters.too.many': 413,
  'encoding.unsupported': 415,
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
 * Resolves both the HTTP status a failure should produce and whether the
 * failure was expected, in strict precedence order: a typed `HttpError`'s own
 * status, then the parser allowlist keyed on `err.type`, then the masked
 * fallback.
 *
 * WHY THE ORIGIN IS RETURNED ALONGSIDE THE STATUS, AND NOT DERIVED FROM IT.
 * The status alone cannot say whether a failure was expected: a deliberate
 * `HttpError(503)` and an unexpected throw both resolve to the 5xx class, and
 * they are opposite kinds of event -- one is a decision this service made, the
 * other is a defect. The exception record below is reserved for the second,
 * and this function is the only place that still knows which branch was taken,
 * so it reports it rather than leaving the caller to guess from a number.
 *
 * WHY AN UNRECOGNISED ERROR STAYS A 500. A bare `SyntaxError` -- or anything
 * else carrying no `err.type` -- did not come from the parser, so it is a
 * defect in this service's code rather than bad input, and a defect must never
 * be reported to a client as its own mistake. The status stays 500 and the
 * real message is masked in production, while the exception record keeps it
 * for whoever has to fix it.
 *
 * WHY A TYPED ERROR'S STATUS IS CHECKED BEFORE IT IS TRUSTED. `err.status` is
 * an ordinary public field: `HttpError`'s constructor validates what it is
 * given, but nothing stops a later assignment, and an `instanceof` test says
 * nothing about the field's current value. An unusable status is therefore
 * treated as exactly what it is -- a defect in this service -- and resolves to
 * the unexpected fallback, which both keeps the envelope intact and records
 * the fault instead of letting it through as a response nobody can explain.
 *
 * `err.status` and `err.statusCode` on a NON-`HttpError` error are pointedly
 * not consulted. Honouring them would look like a harmless generalisation and
 * would dissolve the allowlist: any third-party error carrying a `status`
 * property could then choose this service's response status, including a 4xx
 * for what is really a server fault. Only the two recognised sources decide.
 *
 * @param {*} err The delegated failure. Typically an `Error`, but a handler is
 *   free to call `next()` with any truthy value, so nothing about its shape is
 *   assumed.
 * @returns {{ status: number, unexpected: boolean }} `status` is the value to
 *   send, and the one the masking decision is taken against. `unexpected` is
 *   true only for the fallback branch -- an unrecognised failure, or a typed
 *   one whose status cannot be sent -- and is what gates the exception record.
 */
function resolveFailure(err) {
  // Branch one: the raiser chose the status, so it is honoured -- once it has
  // been confirmed sendable. This covers the 404 from not-found.js and every
  // HttpError(400) from api.routes.js.
  if (err instanceof HttpError) {
    return isSendableErrorStatus(err.status)
      ? { status: err.status, unexpected: false }
      : { status: FALLBACK_STATUS, unexpected: true };
  }

  // Short-circuited rather than accessed directly: a handler may delegate a
  // primitive or a nullish value, and a throw inside the pipeline's single
  // exit would leave the request with no response at all.
  const type = err && err.type;

  // An own-property test rather than a bare lookup, because a bare lookup
  // reaches the prototype chain: an `err.type` of 'constructor' or 'toString'
  // would resolve to an inherited function and be handed to res.status(),
  // which throws. Only the five rows declared above may decide a status.
  if (typeof type === 'string' && Object.hasOwn(PARSER_STATUS_BY_TYPE, type)) {
    return { status: PARSER_STATUS_BY_TYPE[type], unexpected: false };
  }

  return { status: FALLBACK_STATUS, unexpected: true };
}

/**
 * Resolves the message the client is shown for a failure, applying production
 * masking to the server-fault class.
 *
 * WHY A 5xx MESSAGE IS MASKED IN PRODUCTION, AND WHY THE REAL ONE IS NOT LOST.
 * An unexpected failure's message is written by whatever actually failed -- a
 * parser, a library, a call three frames deep -- and can name an internal
 * path, a query or a host that a client has no business seeing and an attacker
 * can build on. It is replaced here, not discarded: the exception record in
 * `errorHandler` below carries the error itself, so the real message and stack
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
 * service's one failure envelope, and records the ones that indicate a fault
 * in the service itself.
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
 * reason alone even though exactly one path uses it, and `err` must stay
 * first.
 *
 * CONTRACT. It always ends the request, in one of exactly two ways: by sending
 * the envelope, or -- when the response has already begun -- by delegating to
 * Express's default handler with `next(err)`. It never calls `next()` to
 * continue a chain, because there is no chain left. It sets no header by hand
 * and leaves helmet's headers from position 2 alone, reads no request body,
 * and touches no counters: src/middleware/request-context.js is the sole
 * writer to src/lib/metrics.js and counts by status on its own 'close' hook,
 * so incrementing anything here would double-count every failure.
 *
 * @param {*} err The delegated failure. An `HttpError` from `not-found.js` or
 *   `api.routes.js`, a body-parser error carrying `err.type`, a rejection from
 *   an async handler, or an unexpected throw. Any truthy value is accepted,
 *   because `next()` accepts any.
 * @param {express.Request} req The request. `id` supplies the envelope's
 *   `requestId`; `method` and `originalUrl` describe the failure in the log.
 * @param {express.Response} res The response. `headersSent` decides between
 *   sending and delegating; the envelope is sent through it.
 * @param {express.NextFunction} next Used on exactly one path -- when headers
 *   are already sent -- and it must never be removed: dropping it changes the
 *   function's arity and, per the note above, silently unregisters this handler
 *   as an error handler altogether.
 * @returns {void} Nothing is returned; the outcome is the response sent or the
 *   error delegated.
 */
function errorHandler(err, req, res, next) {
  // Resolved once and reused. The status decides the masking and the response,
  // and re-deriving it at each use is how two of those decisions come to
  // disagree about the same failure. `unexpected` travels with it because the
  // record below is about the KIND of failure, which the status cannot express.
  const { status, unexpected } = resolveFailure(err);

  // THE EXCEPTION RECORD, FOR UNEXPECTED FAILURES ONLY.
  //
  // WHY NOT EVERY FAILURE. Every request already produces exactly one access
  // record from `requestContext` at position 1, emitted on response completion
  // at a level derived from the status -- `warn` for a 4xx, `error` for a 5xx.
  // A 404 or a rejected body is therefore already recorded, and it is ordinary
  // traffic rather than an incident: duplicating it here at `error` would fill
  // the error stream with routine client mistakes and make it useless for
  // spotting a real fault. An unexpected failure is genuinely different, and
  // for a concrete reason -- its message has just been masked out of the
  // response, so without this record the only account of what actually failed
  // would be discarded at the moment it mattered.
  //
  // WHY THE GATE IS THE ORIGIN AND NOT THE STATUS CLASS. Gating on `status >=
  // 500` catches every unexpected failure, and one thing besides: a deliberate
  // `HttpError` in the 5xx class, which is a handled outcome and would then be
  // reported twice -- once as ordinary traffic by the access record and once as
  // an incident here. That is the whole distinction the two-record taxonomy
  // rests on, so the gate is `unexpected`, which is true for exactly the
  // fallback branch of `resolveFailure`: an unrecognised failure, or a typed
  // one whose declared status could not be sent.
  //
  // THE CONSEQUENCE, STATED SO IT IS NOT DISCOVERED. A route that deliberately
  // raises a 5xx `HttpError` gets no exception record, and in production its
  // message is masked out of the response -- so a route needing that message
  // preserved must log it at the raise site, where the failure's context is
  // still in hand. No route in this service raises a 5xx today; every one of
  // them is a 404 or a 400.
  //
  // WHY `requestId` IS SET EXPLICITLY. It has to be the same value the access
  // record carries, so the two lines describing one failed request can be
  // joined. The access record gets it through pino-http's serialized `req.id`,
  // which says nothing about the bindings of this logger; relying on those
  // bindings to supply it implicitly would leave the field absent here and the
  // correlation impossible. The shared root instance is used rather than
  // `req.log` for the same predictability: one record shape, whatever state the
  // request object is in by the time a failure arrives.
  //
  // WHY PASSING THE RAW ERROR UNDER `err` IS SAFE, WHICH IT WOULD NOT BE BY
  // DEFAULT. pino's own `err` serializer emits the type, message and stack --
  // and then copies every other enumerable property of the error into the
  // record, which is how a nested `headers`, `config` or body-parser `body`
  // reaches a log line with a credential or a payload inside it. This delegated
  // error is arbitrary: it comes from a route, a library or a parser. What
  // makes this call site safe is that src/lib/logger.js replaces that default
  // with an allowlist emitting only type, message, stack and a code or status
  // -- so the reduction happens once, at the root, for this record and every
  // other. Nothing else about the request is logged here: no headers, no body.
  if (unexpected) {
    logger.error(
      {
        err,
        requestId: req.id,
        method: req.method,
        // `originalUrl`, not `url`: Express rewrites `req.url` relative to the
        // mount point of a router mounted under a prefix, so `url` can name a
        // path the client never sent -- useless for correlating a failure with
        // the access record, which reports the URL as it arrived.
        path: req.originalUrl,
        status
      },
      'Request failed with an unhandled server error'
    );
  }

  // THE RECORD ABOVE IS WRITTEN BEFORE THIS CHECK, AND THE ORDER IS THE POINT.
  // A failure arriving after the response has already begun is still a failure
  // worth recording -- it is in fact the hardest class of bug to diagnose,
  // because the client saw a plausible response and no envelope was ever sent.
  // Testing `headersSent` first and returning early would discard exactly those
  // records and leave nothing behind but a truncated response.
  //
  // Delegation is the only correct action once headers are out: the status and
  // the body are already on the wire and cannot be replaced, so Express's
  // default handler takes over and closes the connection. `res.end()` or a
  // second `res.json()` here would throw ERR_HTTP_HEADERS_SENT and turn a bad
  // response into an unhandled error inside the error handler. This is the one
  // path that uses `next`.
  if (res.headersSent) {
    return next(err);
  }

  // The envelope, exactly three fields.
  //
  // No `stack`: a stack in a response body hands a caller the service's
  // internal layout, and it is already in the exception record where it is
  // useful. No `details` either, even where an `HttpError` carries them -- the
  // HTTP contract fixes this shape at three fields, and a field that appears
  // only sometimes is one every consumer has to branch on.
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

// Assigned directly rather than wrapped. src/app.js pulls this module in as
// `errorHandler` and hands it straight to `app.use(errorHandler)`, so
// exporting `{ errorHandler }` would register an object -- and an object has no
// `length`, so the arity test above would fail and the whole error path would
// go quiet. A factory would be no better: there is nothing to configure here,
// since `isProduction` is read from the frozen configuration at call time.
module.exports = errorHandler;
