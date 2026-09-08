// SPDX-License-Identifier: Apache-2.0
/**
 * Request context for `hello-world-service`.
 *
 * Single responsibility: establish the observability context of a request --
 * one job stated three ways. Request IDENTITY (`req.id` plus the
 * `x-request-id` response header), the ACCESS RECORD (exactly one structured
 * line per request, with a child logger on `req.log`), and the request
 * COUNTERS in `../lib/metrics`, of which this module is the sole writer. It
 * formats no response, resolves no route and reads no configuration.
 *
 * POSITION 1 OF 8, AND IT MUST BE FIRST. The pipeline `src/app.js` owns is:
 * 1 requestContext -> 2 helmet() -> 3 compression() -> 4 express.json() ->
 * 5 express.urlencoded() -> 6 router tree and `options.extraRouters` ->
 * 7 notFound -> 8 errorHandler.
 *
 * WHY FIRST rather than merely early: a body rejected at position 4 and an
 * unmatched path turned into a 404 at position 7 must still receive a request
 * id, an access record and a counter increment -- that is exactly the traffic
 * someone is trying to explain when they read the logs. Registered any later,
 * this middleware would not run for those requests, and the gap would be
 * invisible: only successful requests would be observable.
 *
 * @module middleware/request-context
 */

'use strict';

// The access-log middleware factory, a declared dependency at 11.0.0. It owns
// the per-request child logger and the single completion record; this file owns
// only the three hooks handed to it below.
const pinoHttp = require('pino-http');

// The id generator, from a Node built-in. The `node:` prefix cannot resolve to
// a same-named package, so nothing in node_modules can shadow it. No id library
// is needed: there is no `uuid` or `nanoid` in server/package.json, and
// `randomUUID()` already produces the value this service's contract calls for.
const { randomUUID } = require('node:crypto');

// The one root logger for the process, exported as the bare pino instance
// rather than a facade, so `.child()` and the level methods stay intact.
const logger = require('../lib/logger');

// The write side of the counter store, and only the write side. `render()` is
// deliberately not imported: `../routes/metrics.routes.js` is the store's sole
// reader, and pulling the renderer in here would fuse measurement with
// transport in the one module built to keep them apart.
const { recordRequestStart, recordRequestEnd } = require('../lib/metrics');

/**
 * The correlation header, read from the request and written to the response.
 * Lower case because Node lower-cases incoming header names before they reach
 * `req.headers`; a mixed-case key would never match, and the service would
 * silently mint a fresh id for every request that supplied one.
 * @type {string}
 */
const REQUEST_ID_HEADER = 'x-request-id';

/**
 * The only inbound request-id shape this service echoes: 1-128 characters of
 * letters, digits, dot, underscore and hyphen. A contract constant, named for
 * readability and deliberately not configurable -- an operator able to widen it
 * could re-open the injection path `genReqId()` exists to close.
 * @type {RegExp}
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Status boundaries and level names for the access record. Protocol constants
 * fixed by the logging contract, not settings: the numbers are the HTTP status
 * classes and the names are pino's own.
 */
const SERVER_ERROR_STATUS = 500;
const CLIENT_ERROR_STATUS = 400;
const LEVEL_ERROR = 'error';
const LEVEL_WARN = 'warn';
const LEVEL_INFO = 'info';

/**
 * Resolve the request id -- echo a well-formed inbound value, otherwise
 * generate a fresh one -- and set the response header either way.
 *
 * WHY THE INBOUND VALUE IS VALIDATED RATHER THAN TRUSTED: this id is stamped on
 * every record correlated with the request and echoed in the failure envelope,
 * so accepting an arbitrary caller-supplied value would let a caller inject
 * unbounded or structured content into every one of those log lines. The
 * bounded character set and the 128-character ceiling remove both.
 *
 * The boundary of the guard: values that are not legal HTTP header content are
 * rejected by Node's HTTP parser before Express sees them and are outside this
 * contract. What arrives here is legal-but-hostile -- `abc def`, `abc;def`, a
 * 200-character string -- and each is REPLACED by a fresh UUID rather than
 * sanitised, since a rewritten value would correlate with nothing on either
 * side.
 *
 * WHY THE HEADER IS SET HERE: pino-http calls this hook before delegating to
 * `next()`, making it the only point where the header can be set with a
 * guarantee that no handler has begun a response -- setting it afterwards would
 * race the handler. The header is this hook's only side effect, so it stays
 * correct whenever pino-http chooses to call it.
 *
 * @param {import('http').IncomingMessage} req Inbound request; only
 *   `headers['x-request-id']` is read.
 * @param {import('http').ServerResponse} res Response, whose `x-request-id`
 *   header is set so EVERY response carries it -- including the 404 and the
 *   413, which never reach a route handler.
 * @returns {string} The request id, which pino-http assigns to `req.id`.
 */
function genReqId(req, res) {
  const inbound = req.headers[REQUEST_ID_HEADER];

  // A `typeof` test rather than a truthiness test: an absent header is
  // `undefined`, and duplicate headers arrive comma-joined -- a form the
  // pattern rejects on the comma, which is the correct outcome.
  const id =
    typeof inbound === 'string' && REQUEST_ID_PATTERN.test(inbound)
      ? inbound
      : randomUUID();

  res.setHeader(REQUEST_ID_HEADER, id);

  return id;
}

/**
 * Choose the level of the one access record emitted for this request.
 *
 * WHY THE MAPPING MATTERS BEYOND READABILITY: the level is how a reader
 * separates ordinary traffic from failures without a second, duplicate record
 * being written for the failures. It also reaches back into
 * `src/config/index.js`, which restricts `LOG_LEVEL` to `trace`, `debug` and
 * `info` for a reason invisible from this file -- a threshold of `warn` or
 * higher would filter the `info` record returned below for every successful
 * request, and the one-record-per-request guarantee would quietly become false
 * for the majority of traffic. Neither this function nor that validation can be
 * relaxed alone.
 *
 * `'silent'` is never returned: pino-http reads it as "emit nothing", which
 * would drop the access record outright and break the same guarantee.
 *
 * @param {import('http').IncomingMessage} req The request. Unused -- the level
 *   follows the response outcome -- but it must stay declared, because
 *   pino-http passes its arguments positionally.
 * @param {import('http').ServerResponse} res Response whose `statusCode` is
 *   read.
 * @param {Error} [err] Present when the response completed with an error.
 * @returns {'error'|'warn'|'info'} `'error'` for 5xx or any error, `'warn'` for
 *   4xx, `'info'` for everything below 400.
 */
function customLogLevel(req, res, err) {
  if (err || res.statusCode >= SERVER_ERROR_STATUS) {
    return LEVEL_ERROR;
  }

  if (res.statusCode >= CLIENT_ERROR_STATUS) {
    return LEVEL_WARN;
  }

  return LEVEL_INFO;
}

/**
 * The pino-http instance, built ONCE at module scope -- nothing in its
 * configuration depends on a request, so per-request construction would create
 * a fresh hook set and child-logger chain for no gain.
 *
 * WHY THE SHARED LOGGER IS PASSED IN AND NOTHING ELSE IS RESTATED:
 * `../lib/logger` already owns `level` (from configuration), `base`
 * (`{ pid, instance, service }`) and `redact` (`req.headers.authorization`,
 * `req.headers.cookie`). Handing over the instance is what applies all three to
 * every access record and to the `req.log` child derived from it. Re-declaring
 * `level`, `base`, `redact`, `transport` or `serializers` here would put the
 * redaction policy in two files, and that duplication does not fail loudly --
 * one copy drifts and starts logging an `Authorization` header in clear text.
 *
 * Three options are absent on purpose, each because setting it would break the
 * one-record-per-request guarantee or fail outright:
 *   * `useLevel` -- pino-http THROWS when it is passed alongside
 *     `customLogLevel`; the two are mutually exclusive. The upstream README
 *     shows them together, which is a trap.
 *   * `customReceivedMessage` / `customReceivedObject` -- either makes
 *     pino-http emit a SECOND, "request received" record per request.
 *   * `autoLogging` -- left at its default of `true`, which is what emits the
 *     single completion record. `false` removes the access record altogether,
 *     and the tempting `autoLogging.ignore` predicate for "health-check noise"
 *     would remove it for precisely the traffic worth recording when a probe
 *     starts failing.
 *
 * @type {import('pino-http').HttpLogger}
 */
const httpLogger = pinoHttp({ logger, genReqId, customLogLevel });

/**
 * Position 1 of 8 in the request pipeline: the FIRST middleware registered by
 * `src/app.js`, via `app.use(requestContext)`.
 *
 * CONTRACT -- for every request reaching the application, this middleware:
 *   * sets `req.id` to the validated-or-generated id and sets the
 *     `x-request-id` header on the response;
 *   * attaches a per-request child logger to `req.log`, inheriting the root
 *     logger's level, identity fields and redaction policy;
 *   * guarantees exactly ONE access record, emitted on response completion at
 *     the level `customLogLevel()` chooses;
 *   * writes the request counters, of which it is the sole writer, pairing
 *     every accepted request with exactly one finish -- supplying the response
 *     status for the status-class bucket only when the response actually
 *     completed, so an aborted connection is not tallied as a success.
 *
 * It never sends a response, never inspects a route and always delegates.
 *
 * @param {import('express').Request} req The inbound request; annotated with
 *   `id` and `log` by the time the next middleware runs.
 * @param {import('express').Response} res The response; receives the
 *   `x-request-id` header and carries the completion hook.
 * @param {import('express').NextFunction} next Passes control to position 2.
 * @returns {void} Nothing meaningful; the return forwards pino-http's own
 *   result, which is how control reaches `next()`.
 */
function requestContext(req, res, next) {
  // Counted as accepted here, before anything can reject it, for the same
  // reason this middleware sits at position 1: a body-parse failure and a 404
  // are both requests the service handled and must appear in the totals.
  recordRequestStart();

  /*
   * THE PAIRING OBLIGATION, AND WHY IT IS DISCHARGED ON `'close'`.
   *
   * `../lib/metrics` requires exactly one `recordRequestEnd()` per
   * `recordRequestStart()`, INCLUDING for requests the client aborts. A missed
   * completion drifts the in-flight gauge permanently upward -- no error, no
   * failed request, and no symptom until someone reads `/metrics` and finds a
   * gauge that only ever rises. A doubled one drives it negative while a status
   * bucket over-counts.
   *
   * Node emits `'close'` on the response exactly once, either after the
   * response completes or when the connection was destroyed before it could.
   * That one event covers both outcomes, which is what makes an aborted request
   * pair correctly; a `'finish'`-only hook never fires for an abort and leaks
   * the gauge on the traffic hardest to notice.
   *
   * WHY NOT COUNT FROM A PINO-HTTP HOOK -- `customLogLevel`,
   * `customSuccessMessage` or `customErrorMessage`. Not because those hooks
   * fail to run: in pino-http 11.0.0 the object and message providers are
   * evaluated while the log call's arguments are being assembled, BEFORE
   * `log[level](...)` is reached, so ordinary level filtering does not skip
   * them. The reason is that they are part of the AUTO-LOGGING configuration,
   * and measurement must not be. Every one of them stops being called if
   * `autoLogging` is ever set to `false` or given an `ignore` predicate -- the
   * "skip health-check noise" change someone will eventually propose -- and
   * the counters would then go quietly wrong with no failing request and no
   * error to notice. Separately, `customLogLevel` is a level-DECISION function,
   * and giving it a side effect fuses two unrelated concerns in a callback
   * whose contract is to return a string. Measurement stays on the response's
   * own lifecycle event, which no logging option can switch off.
   */
  let counted = false;

  res.on('close', () => {
    // The guard is for gauge integrity, not caution: one extra invocation would
    // double-decrement the in-flight gauge and over-count a bucket, and the
    // corruption would persist for the life of the worker. Enforcing "at most
    // once" here makes the obligation local and checkable rather than dependent
    // on which events Node happens to emit.
    if (counted) {
      return;
    }
    counted = true;

    // A STATUS ONLY FOR A RESPONSE THAT ACTUALLY COMPLETED, and this gate is
    // the whole reason the `'close'` event can serve both outcomes.
    //
    // `'close'` fires for a completed response AND for a connection the client
    // destroyed mid-flight, which is what makes the pairing above correct --
    // but the two cases carry very different status codes. On a completed
    // response `res.statusCode` is the final status the client saw, exactly
    // what the per-class bucket needs. On an abort it is whatever the value
    // happened to be when the socket died, and if the handler had not responded
    // yet, that is Node's UNTOUCHED DEFAULT OF 200 -- so passing it
    // unconditionally files abandoned requests in the `2xx` bucket and reports
    // dropped traffic as success.
    //
    // `res.writableFinished` is the discriminator: it turns true only once the
    // response has been fully flushed to the socket, so it is precisely the
    // "completed" that `http_requests_by_status_class_total` claims to count.
    // `undefined` is the store's documented abort signal -- it lowers the
    // in-flight gauge and tallies no bucket. Note the deliberate boundary: a
    // client that aborts after the headers were sent but before the body
    // finished is also counted as not completed, even though a status did reach
    // it. That is the honest reading of "completed", and it keeps this gate a
    // single unambiguous test rather than a guess about how much of the
    // response the client actually received.
    recordRequestEnd(res.writableFinished ? res.statusCode : undefined);
  });

  // Delegate last, so identity and counting are established for the request
  // before pino-http calls `next()`.
  return httpLogger(req, res, next);
}

// Assigned directly, not wrapped: `src/app.js` hands this value straight to
// `app.use()`, so exporting `{ requestContext }` would register an object where
// a handler belongs. A factory would be equally wrong -- there is one pipeline
// and one pino-http instance per process, and both exist by the time this line
// runs.
module.exports = requestContext;
