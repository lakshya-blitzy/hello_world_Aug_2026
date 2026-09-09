// SPDX-License-Identifier: Apache-2.0
/**
 * Request context for `hello-world-service`.
 *
 * Single responsibility: establish the observability context of a request --
 * one job stated three ways. Request IDENTITY (`req.id` plus the
 * `x-request-id` response header), the ACCESS RECORD (exactly one structured
 * line per request, with a child logger on `req.log`, and the serializers
 * deciding what that line may say about the request and the response), and the
 * request COUNTERS in `../lib/metrics`, of which this module is the sole
 * writer. It formats no response, resolves no route and reads no
 * configuration.
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
 * Longest request path written to a record. A path is the resource identifier
 * and is kept whole in normal traffic; the bound exists because its length is
 * the caller's choice, and an unbounded value in a field written once per
 * request is an unbounded log line.
 * @type {number}
 */
const MAX_LOGGED_PATH_LENGTH = 512;

/**
 * The only request headers written to a record, and the list is a contract
 * rather than a convenience.
 *
 * WHY AN ALLOWLIST RATHER THAN THE FULL HEADER MAP. pino's default request
 * serializer writes EVERY inbound header, which puts two different problems in
 * every access record: a header nobody vetted can carry a credential or a
 * personal identifier, and `X-Forwarded-For` / `X-Forwarded-Proto` are
 * caller-supplied strings that are only meaningful behind a proxy that
 * overwrites them -- written raw, a forged value reads in the log exactly like
 * a real one. The trust-aware `ip` and `protocol` fields below are where the
 * client's address and scheme come from instead, which is what makes
 * `TRUST_PROXY` govern the logged identity.
 *
 * `authorization` and `cookie` are on the list DELIBERATELY, and dropping them
 * would be the wrong kind of tidy: the root logger redacts exactly those two
 * paths (`req.headers.authorization`, `req.headers.cookie`), so what reaches
 * the stream is the key with `[Redacted]` in place of the value -- which
 * records that the request carried a credential, the one fact worth having,
 * without carrying the credential. Their values never appear in clear text.
 *
 * Everything else is excluded on purpose, including `referer` (which routinely
 * carries another URL's query string) and `x-request-id` (already `req.id`).
 * @type {readonly string[]}
 */
const LOGGED_HEADERS = Object.freeze([
  'host',
  'user-agent',
  'content-type',
  'content-length',
  'accept-encoding',
  'authorization',
  'cookie'
]);

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
 * Reduces a request URL to the path a record may carry: the pathname, bounded.
 *
 * WHY THE QUERY STRING IS DROPPED RATHER THAN REDACTED. A query string is
 * caller-controlled and routinely carries credentials -- `?access_token=...`,
 * a signed URL's signature, a password-reset token -- and a log stream is
 * copied, shipped and retained far more freely than the request it describes,
 * so one such record outlives the credential's usefulness by a long way. There
 * is no list of parameter names that could make keeping it safe, because the
 * names are the caller's to choose. The pathname is what identifies the
 * resource, and it is all this service needs to explain its own traffic.
 *
 * @param {*} url The URL as pino's request serializer resolved it -- Express's
 *   `originalUrl`, so a router mounted under a prefix still reports the path
 *   the client actually sent.
 * @returns {string} The pathname, truncated with an explicit marker beyond
 *   `MAX_LOGGED_PATH_LENGTH`, or the empty string when there is no URL to
 *   reduce -- the field is always present, so the record's shape never varies.
 */
function serializePath(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return '';
  }

  // The first `?` or `#`, whichever comes first, ends the pathname. A fragment
  // is not supposed to reach a server at all, so its presence is a sign of a
  // hand-built request rather than a browser's -- which is reason enough not to
  // write whatever follows it.
  const queryIndex = url.indexOf('?');
  const fragmentIndex = url.indexOf('#');
  let end = queryIndex === -1 ? url.length : queryIndex;

  if (fragmentIndex !== -1 && fragmentIndex < end) {
    end = fragmentIndex;
  }

  const pathname = url.slice(0, end);

  return pathname.length > MAX_LOGGED_PATH_LENGTH
    ? `${pathname.slice(0, MAX_LOGGED_PATH_LENGTH)}... (truncated)`
    : pathname;
}

/**
 * The request serializer for the access record: what may be written about an
 * inbound request, in place of pino's default "write everything".
 *
 * WHY THIS EXISTS, IN TWO PARTS. pino's default request serializer writes the
 * full URL including its query string, the parsed query object, and every
 * inbound header -- so `GET /health?access_token=live-secret` puts a live
 * credential in the access record, and an `X-Forwarded-For` a client invented
 * is written as though it were fact. Second, that default derives the client
 * address from the socket (`remoteAddress`) and records no scheme at all, so
 * `TRUST_PROXY` -- which governs Express's own `req.ip` and `req.protocol` --
 * would have no effect whatsoever on the logged identity. The comments in
 * `src/config/index.js` and `src/app.js` describing what that setting protects
 * are true because this serializer records those two fields.
 *
 * WHY IT IS CONFIGURED HERE RATHER THAN ON THE ROOT LOGGER. pino-http installs
 * its own `req` and `res` serializers on the child logger it derives, which
 * shadow anything the root declares for those two keys, so this is the only
 * place a request serializer takes effect for the access record. The root
 * keeps the redaction policy -- which still applies here, and is what turns
 * the two credential headers below into `[Redacted]`.
 *
 * @param {object} request The request as pino's DEFAULT serializer already
 *   reduced it -- pino-http wraps a custom serializer around that one, so the
 *   argument carries `id`, `method`, `url`, `query`, `params`, `headers`,
 *   `remoteAddress`, `remotePort`, plus a non-enumerable `raw` referring to the
 *   Express request itself. Only `id`, `method`, `url` and `raw` are read.
 * @returns {{ id: *, method: *, path: string, ip: *, protocol: string,
 *   headers: Record<string, string> }} The permitted fields, and no others:
 *   the request id, the method, the bounded pathname, the trust-aware client
 *   address and scheme, and the allowlisted headers.
 */
function serializeRequest(request) {
  // `raw` is the Express request, and it is what makes `ip` and `protocol`
  // trust-aware: both are Express getters that consult the application's
  // `trust proxy` setting. Falling back to the serialized object keeps this
  // function total if it is ever handed something without a `raw`.
  const raw =
    request.raw === null || request.raw === undefined ? request : request.raw;

  const inbound =
    raw.headers === null || typeof raw.headers !== 'object'
      ? request.headers
      : raw.headers;

  const headers = {};

  if (inbound !== null && typeof inbound === 'object') {
    for (const name of LOGGED_HEADERS) {
      const value = inbound[name];

      // A string test rather than a truthiness test: a duplicated header
      // arrives comma-joined (still a string, and still worth recording),
      // while an absent one is `undefined` and is left out entirely rather
      // than written as null.
      if (typeof value === 'string') {
        headers[name] = value;
      }
    }
  }

  // The scheme, resolved before the record is assembled so the fallback is
  // readable. `raw.protocol` is Express's trust-aware value -- `http` unless a
  // proxy this service has been told to trust declared otherwise -- and the
  // socket's own encryption state is what the answer would be if Express were
  // not in the path at all.
  let protocol = 'http';

  if (typeof raw.protocol === 'string') {
    protocol = raw.protocol;
  } else if (
    raw.socket !== null &&
    typeof raw.socket === 'object' &&
    raw.socket.encrypted === true
  ) {
    protocol = 'https';
  }

  return {
    id: request.id,
    method: request.method,
    path: serializePath(request.url),
    // `raw.ip` is Express's trust-aware address: the socket's peer while
    // `TRUST_PROXY` is `false`, and the left-most address the trusted proxy
    // chain vouches for once it is `true`. The socket address is the fallback
    // for a request that never passed through Express.
    ip: typeof raw.ip === 'string' ? raw.ip : request.remoteAddress,
    protocol,
    headers
  };
}

/**
 * The response serializer for the access record: the status, and nothing else.
 *
 * pino's default also writes every response header, which serves no purpose
 * here and carries real risk: `Set-Cookie` is a credential, and the rest are
 * this service's own fixed security headers, identical on every response and
 * therefore pure repetition in a stream someone pays to retain. The status is
 * the outcome the record is about, and `responseTime` -- which pino-http adds
 * alongside this object -- is the other half of it.
 *
 * @param {object} response The response as pino's default serializer reduced
 *   it; only `statusCode` is read.
 * @returns {{ statusCode: * }} The status the response carried when it closed
 *   -- `null` for a connection destroyed before any status was sent, which is
 *   the same outcome the counter store is told about as an abort.
 */
function serializeResponse(response) {
  return { statusCode: response.statusCode };
}

/**
 * The pino-http instance, built ONCE at module scope -- nothing in its
 * configuration depends on a request, so per-request construction would create
 * a fresh hook set and child-logger chain for no gain.
 *
 * WHY THE SHARED LOGGER IS PASSED IN AND ALMOST NOTHING IS RESTATED:
 * `../lib/logger` already owns `level` (from configuration), `base`
 * (`{ pid, instance, service }`), `redact` (`req.headers.authorization`,
 * `req.headers.cookie`), the `err` allowlist and the string bound and scrub.
 * Handing over the instance is what applies all of them to every access record
 * and to the `req.log` child derived from it. Re-declaring `level`, `base`,
 * `redact` or `transport` here would put one policy in two files, and that
 * duplication does not fail loudly -- one copy drifts and starts logging an
 * `Authorization` header in clear text.
 *
 * THE ONE EXCEPTION IS `serializers`, AND IT HAS TO BE HERE. pino-http
 * installs its own `req` and `res` serializers on the child it derives, which
 * shadow whatever the root declares for those two keys -- so a request
 * serializer set on the root would look authoritative and govern nothing.
 * `err` is deliberately absent from this object: the root's allowlist reaches
 * the access record through the inherited log formatter, and naming it again
 * here would be the duplication the paragraph above warns about.
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
const httpLogger = pinoHttp({
  logger,
  genReqId,
  customLogLevel,
  serializers: { req: serializeRequest, res: serializeResponse }
});

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
 *     the level `customLogLevel()` chooses, carrying the request id, method,
 *     pathname, trust-aware client address and scheme, allowlisted headers,
 *     status and response time -- and no query string, no forwarded header and
 *     no response header;
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

    // Exactly one end for every start, including for a request the client
    // aborts: Node emits `'close'` once whether the response completed or the
    // connection was destroyed first. `res.writableFinished` is what
    // distinguishes the two -- it turns true only once the response has been
    // flushed to the socket, which is the "completed" the status-class family
    // counts. A response that did not finish is reported as `undefined`, the
    // store's abort signal: it lowers the in-flight gauge and tallies no
    // status class. Passing `res.statusCode` unconditionally would file
    // abandoned requests under Node's untouched default of 200.
    recordRequestEnd(res.writableFinished ? res.statusCode : undefined);
  });

  return httpLogger(req, res, next);
}

module.exports = requestContext;
