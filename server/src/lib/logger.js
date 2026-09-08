// SPDX-License-Identifier: Apache-2.0
/**
 * The one pino root logger for this service.
 *
 * SINGLE RESPONSIBILITY. This module constructs exactly one pino logger for
 * the process and exports that instance. It owns five things and nothing
 * else: the shared identity fields stamped on every record (`base`), the
 * redaction policy applied before any record is written (`redact`), the
 * allowlist that decides which fields of a logged error may be written at all
 * (`serializers.err` plus the `formatters.log` hook that keeps it in force on
 * derived loggers), the environment-aware rendering decision, and the
 * destination those records are written to -- which is also what decides
 * whether the process layer's flush can guarantee anything. It writes no
 * records of its own -- the modules listed below do that -- and it holds no
 * request state, no counters and no files.
 *
 * WHO CONSUMES THIS INSTANCE, and what each of them needs from it:
 *
 *   * src/middleware/request-context.js -- hands this instance to pino-http,
 *     which derives the per-request child logger on `req.log` and emits the
 *     one access record per request. That child inherits `level`, `base` and
 *     `redact` from here, which is why the redaction policy belongs on the
 *     root rather than being re-stated per request.
 *   * src/middleware/error-handler.js -- writes the exception record for the
 *     500 class, where the real message is masked out of the response and
 *     would otherwise be lost entirely.
 *   * src/server.js -- the start-up, listener-error and shutdown records, and
 *     the flush step of the log -> flush -> release the PM2 IPC channel ->
 *     exit sequence that every exit path in this service must follow. That
 *     module awaits the flush callback before it disconnects and exits, which
 *     only means something because of the destination this file installs.
 *
 * WHY PINO RATHER THAN WINSTON. pino emits newline-delimited JSON by default
 * -- `level`, `time`, `pid`, `hostname`, `msg` -- supports child loggers and
 * built-in redaction, and carries materially lower overhead, whereas
 * winston's JSON output requires explicit format configuration. Its
 * human-readable half, pino-pretty, is a development tool that must not run
 * in production, because it re-adds precisely the overhead pino exists to
 * avoid; the branch further down is where that is enforced.
 *
 * WHY THERE IS ONE INSTANCE AND NO FACTORY. A second root logger would mean
 * two identity blocks, two redaction policies and two transport decisions
 * that can drift apart, with nothing to report the divergence. Per-request
 * loggers are still created -- pino-http derives them as children of this one
 * -- so a caller wanting request-scoped fields uses `req.log`, never a second
 * root.
 *
 * WHY THE CONFIGURATION IMPORT IS NOT GUARDED HERE. src/config/index.js
 * validates during module evaluation and throws ONE aggregated error naming
 * every invalid variable at once. src/server.js performs the first internal
 * import of that module inside a try/catch and renders whatever it throws as
 * a single JSON object on stderr through its logger-free fatal() fallback --
 * which exists precisely because a configuration failure happens before any
 * logger does. Catching that error here would swallow the aggregated message
 * and leave an operator with less to act on, and there would be nothing to
 * report it with in any case: this file is the logger.
 *
 * @module lib/logger
 */

'use strict';

/*
 * The logging library itself, and one of only two imports in this file. pino
 * is a declared runtime dependency, so it is present on a production tree.
 * Its human-readable companion package is deliberately NOT imported at the top
 * of this file: it ships as a development dependency and is absent from a
 * production install, so a top-level import of it would crash the process at
 * start-up. The non-production branch further down is where that package is
 * required, inside the conditional, so the resolution never happens in
 * production.
 */
const pino = require('pino');

/*
 * The frozen configuration object, and the only source of environment-derived
 * values in this file. Exactly four of its fields are read -- `logLevel`,
 * `isProduction`, `instance` and `serviceName` -- and the raw environment is
 * never inspected here: src/config/index.js is the single reader of it in the
 * whole codebase, which is what makes an invalid environment one loud
 * start-up failure rather than several quiet disagreements.
 *
 * `config.isProduction` is what the rendering branch tests, rather than a
 * string comparison against the environment name. That predicate is derived
 * once in the configuration module specifically so that this file and
 * src/middleware/error-handler.js cannot answer the same question
 * differently.
 */
const config = require('../config');

/*
 * WHY AN ERROR ALLOWLIST EXISTS AT ALL, AND WHY REDACTION CANNOT DO THIS JOB.
 *
 * pino's default `err` serializer (pino-std-serializers) emits the type, the
 * message and the stack -- and then copies EVERY other enumerable property of
 * the error into the record as well. That last part is the problem. Errors
 * routinely carry whole objects: an HTTP client's error carries `config`,
 * `request` and `response`; a transport error carries `headers`; and
 * body-parser's `entity.parse.failed` carries `body`, the raw request payload
 * it failed to parse. Serialised by default, an `Authorization` header or a
 * request body lands in the log at a path such as `err.headers.authorization`
 * or `err.request.headers.cookie` -- a live credential written to a stream
 * that is copied, shipped and retained far more freely than the request it
 * describes.
 *
 * The `redact` policy below cannot close that, and the reason is structural
 * rather than a matter of adding more paths: redaction names paths in advance,
 * and the paths an arbitrary error nests its data under are not knowable in
 * advance. Every new dependency, and every new error shape inside an existing
 * one, would be another path nobody remembered to add.
 *
 * So the policy is inverted for errors: instead of naming what must be
 * removed, `sanitizeError` names the only fields that may be written, and
 * everything else about the error is dropped before it reaches the stream.
 */

/**
 * Marks a value as already reduced by `sanitizeError`, which makes the policy
 * idempotent.
 *
 * The policy is applied at two points (see the `serializers` and `formatters`
 * keys below) and a value can therefore reach it twice for one record. A
 * symbol is used rather than a property so the tag can never appear in output:
 * `JSON.stringify` and `for...in` both ignore symbol keys, which is what pino
 * uses to build a record.
 *
 * @type {symbol}
 */
const SANITIZED_ERROR = Symbol('hello-world-service.sanitized-error');

/**
 * How many links of an `err.cause` chain are folded into the message and the
 * stack before the chain is reported as truncated. Deep chains are bounded
 * because an unbounded walk is an unbounded log line.
 *
 * @type {number}
 */
const MAX_CAUSE_DEPTH = 5;

/**
 * Longest rendering kept for a value that is not an error at all -- a string,
 * a number, or an object thrown or rejected in place of an `Error`. Bounded
 * for the same reason as the cause chain: the value is not this service's, so
 * its size is not this service's to trust.
 *
 * @type {number}
 */
const MAX_RENDERED_VALUE_LENGTH = 512;

/**
 * Renders a non-error value as a bounded, single string.
 *
 * @param {*} value The value logged under the `err` key.
 * @returns {string} Its string form, truncated with an explicit marker when it
 *   exceeds `MAX_RENDERED_VALUE_LENGTH`, or a fixed notice when the value
 *   cannot be converted to a string at all.
 */
function renderValue(value) {
  let rendered;

  try {
    rendered = String(value);
  } catch {
    // A value whose `toString` throws -- a deliberately hostile object, or a
    // proxy -- must not take the log call down with it. The record keeps its
    // shape and says plainly that the value could not be rendered. The binding
    // is omitted because the thrown value adds nothing: what matters is that
    // the original could not be rendered, which the notice already says.
    return 'value could not be converted to a string';
  }

  return rendered.length > MAX_RENDERED_VALUE_LENGTH
    ? `${rendered.slice(0, MAX_RENDERED_VALUE_LENGTH)}... (truncated)`
    : rendered;
}

/**
 * Names the kind of error, using the same rule pino itself uses so a record
 * from this service reads like a record from any other pino deployment: the
 * constructor's name when there is one, then `name`, then the bare type.
 *
 * @param {object} error The error-like value being reduced.
 * @returns {string} The value written as `err.type`.
 */
function resolveErrorType(error) {
  if (typeof error.constructor === 'function' && error.constructor.name) {
    return error.constructor.name;
  }

  return typeof error.name === 'string' && error.name.length > 0
    ? error.name
    : typeof error;
}

/**
 * Folds an `err.cause` chain into one message and one stack, in pino's own
 * format, and returns nothing else from the chain.
 *
 * WHY THE CHAIN IS FOLDED RATHER THAN NESTED. A nested `cause` object would
 * have to be reduced by this same allowlist at every level, and the result
 * would then be re-folded anyway by whichever serializer runs last on the
 * pino-http path -- so the record's shape would depend on which log call
 * produced it. Folding here produces one shape everywhere, and it is the shape
 * pino already documents: messages joined with `': '`, stacks joined with
 * `'\ncaused by: '`.
 *
 * Only the `message` and `stack` STRINGS of each cause are read. A cause's own
 * properties are not, which is what keeps the allowlist true for the whole
 * chain rather than only its first link.
 *
 * @param {object} error The error-like value being reduced.
 * @returns {{ message: string, stack: string }} The folded message and stack.
 *   Either may be empty, because a value can be error-like without carrying
 *   both; the fields are still written, so the record's shape never varies.
 */
function foldCauseChain(error) {
  let message = typeof error.message === 'string' ? error.message : '';
  let stack = typeof error.stack === 'string' ? error.stack : '';

  // Guards against a chain that points back into itself: `err.cause = err`,
  // or two errors naming each other, would otherwise loop until the process
  // ran out of memory inside a log call.
  const visited = new Set([error]);
  let cause = error.cause;
  let depth = 0;

  // A link is followed only while it looks like an error: an object carrying a
  // string message. Anything else -- a string cause, a function cause of the
  // kind some libraries use -- ends the walk rather than being rendered, since
  // reading further would mean reading a value of unknown shape.
  while (
    cause !== null &&
    typeof cause === 'object' &&
    typeof cause.message === 'string'
  ) {
    if (visited.has(cause)) {
      message += ': ...';
      stack += '\ncauses have become circular...';
      break;
    }

    if (depth >= MAX_CAUSE_DEPTH) {
      message += ': ...';
      stack += '\ncauses have been truncated...';
      break;
    }

    visited.add(cause);
    message += `: ${cause.message}`;
    stack += `\ncaused by: ${
      typeof cause.stack === 'string' ? cause.stack : ''
    }`;
    cause = cause.cause;
    depth += 1;
  }

  return { message, stack };
}

/**
 * Reduces anything logged under the `err` key to the fields this service
 * permits in a log record, dropping everything else.
 *
 * WHAT IS EMITTED, AND WHY EACH FIELD IS ON THE LIST:
 * - `type`, `message`, `stack` -- the account of what failed, and the whole
 *   reason an error is logged at all.
 * - `code` -- a string or numeric code and nothing else. Node's system errors
 *   carry the diagnosis here rather than in the message class: `EADDRINUSE` on
 *   an occupied port is this field, and src/server.js's listener record would
 *   otherwise say only that binding failed.
 * - `status` -- an integer only. `HttpError` is this service's own typed error
 *   and its status is what explains a record written from a call site that
 *   does not add a status of its own.
 *
 * WHAT IS DROPPED, DELIBERATELY: everything else, including `details`. That
 * one is worth naming because `HttpError` supports it and dropping it looks
 * like an oversight: `details` is an arbitrary caller-supplied value, which is
 * precisely the channel this allowlist exists to close, and the failures that
 * carry it are 4xx failures that produce an access record rather than an
 * exception record (see src/middleware/error-handler.js). A route needing more
 * context in the log logs it at the raise site, where the value's shape is
 * known.
 *
 * @param {*} value Whatever was logged under `err`: an `Error`, an error-like
 *   object, or -- since `next(err)` and a rejected promise both accept any
 *   value -- something that is neither.
 * @returns {object} A prototype-less record carrying only the permitted
 *   fields. Returned unchanged when it has already been reduced.
 */
function sanitizeError(value) {
  // Already reduced, on the other of the two application points. Returning it
  // untouched keeps the field set stable and the work done once.
  if (
    value !== null &&
    typeof value === 'object' &&
    value[SANITIZED_ERROR] === true
  ) {
    return value;
  }

  // `Object.create(null)` rather than `{}`: the record inherits nothing, so no
  // prototype member can be mistaken for a field the error carried, and any
  // serializer that runs after this one finds only what is written here.
  const record = Object.create(null);
  record[SANITIZED_ERROR] = true;

  if (value === null || typeof value !== 'object') {
    // A thrown string, a rejected number, a symbol. There is no error to
    // reduce, so the value itself is rendered -- bounded -- and the record
    // keeps the same three mandatory fields as any other.
    record.type = value === null ? 'null' : typeof value;
    record.message = renderValue(value);
    record.stack = '';
    return record;
  }

  try {
    record.type = resolveErrorType(value);

    const folded = foldCauseChain(value);
    record.message = folded.message;
    record.stack = folded.stack;

    const code = value.code;
    if (typeof code === 'string' || typeof code === 'number') {
      record.code = code;
    }

    if (Number.isInteger(value.status)) {
      record.status = value.status;
    }
  } catch {
    // Every field above is a plain property read, and a property read is a
    // getter call on an object nobody here constructed. This function runs
    // inside every error log call -- including the one in the terminal error
    // handler, which is the pipeline's single exit -- so a throw escaping here
    // would abandon a request that had already failed. The record degrades to
    // the notice below instead.
    record.type = typeof value;
    record.message = 'error could not be serialised';
    record.stack = '';
  }

  return record;
}

/**
 * The `formatters.log` hook: applies `sanitizeError` to a record's `err` field
 * before pino builds the line.
 *
 * WHY THIS EXISTS IN ADDITION TO `serializers.err`, AND WHY REMOVING IT
 * REOPENS THE LEAK. A serializer is inherited by child loggers only until a
 * child supplies its own, and pino-http does exactly that: it derives its
 * per-request child from this instance and installs its own wrapped copy of
 * pino's DEFAULT error serializer on it, unconditionally. The root policy
 * would therefore hold for every direct `{ err }` call in the service and be
 * silently replaced on the access-record path -- the one that carries the
 * request. What closes that gap is where a log formatter runs and what
 * pino-http does NOT pass: pino applies the inherited `formatters.log` hook
 * before the per-key serializers, and pino-http supplies no formatters of its
 * own, so its child inherits this one and a value reaching that child's
 * serializer has already been reduced. Reducing it a second time is a no-op,
 * which is what `SANITIZED_ERROR` guarantees.
 *
 * THE INVARIANT IS ABOUT THIS CHILD, NOT ABOUT CHILDREN IN GENERAL, AND THAT
 * IS THE MAINTENANCE OBLIGATION. A child that passes its own
 * `formatters: { log }` REPLACES this hook -- pino selects the child's
 * formatter ahead of the inherited one -- so a future child logger that
 * supplies both its own log formatter and its own `err` serializer would be
 * outside both halves of this policy. Any such child must either pass no log
 * formatter, or call `sanitizeError` itself. There is exactly one child in this
 * service today: the per-request logger pino-http derives in
 * src/middleware/request-context.js, which passes neither.
 *
 * THIS IS THE ONLY FORMATTER SET, AND `level` IS DELIBERATELY ABSENT. pino's
 * default numeric level output is part of this service's contract: its
 * acceptance criteria assert the access record at 40 for the 4xx class and 50
 * for the 5xx class, and a consumer filtering on `level >= 50` matches nothing
 * once the field becomes a string. Setting only `log` leaves the level and
 * bindings formatters at their defaults -- verified: captured output is
 * identical with and without this hook apart from the reduced `err` field.
 *
 * @param {object} record The merged object pino is about to write. pino
 *   normalises every call to an object, including a message-only call and the
 *   `logger.error(err)` shorthand, so there is nothing else to handle.
 * @returns {object} The record itself when it carries no error, or a shallow
 *   copy whose `err` has been reduced. A copy rather than a mutation, because
 *   the object belongs to the caller and a log call must not alter it.
 */
function sanitizeRecord(record) {
  if (
    record === null ||
    typeof record !== 'object' ||
    record.err === undefined
  ) {
    return record;
  }

  const sanitized = Object.assign({}, record);
  sanitized.err = sanitizeError(record.err);
  return sanitized;
}

/**
 * The options handed to pino, assembled in one place so the whole shape of a
 * log record is readable without tracing calls.
 *
 * Everything pino already defaults to sensibly is deliberately absent: the
 * `time` field, the `msg` message key, the serializers and the level's
 * numeric representation. Each absence below is a decision rather than an
 * oversight, and the ones a reader would otherwise undo carry their reasons
 * inline. The destination is the one default this file does NOT accept, and
 * it is passed to `pino()` as a second argument rather than set here -- the
 * block above it explains why.
 *
 * @type {import('pino').LoggerOptions}
 */
const options = {
  /*
   * The severity threshold, straight from configuration. The configuration
   * module restricts it to `trace`, `debug` and `info`: `warn` and above would
   * filter the `info`-level access record this service guarantees for every
   * successful request, making the one-record-per-request contract false. That
   * validation lives there, and this file only consumes the result -- a
   * literal threshold here would quietly defeat it.
   */
  level: config.logLevel,

  /*
   * The identity stamped on every record: which process wrote it, which
   * cluster worker that process is, and which service it belongs to.
   *
   * `base` REPLACES pino's default `{ pid, hostname }` rather than extending
   * it, which is why `pid` is listed explicitly -- omitting it here would drop
   * it from the stream altogether. `hostname` is deliberately not re-added:
   * these three fields are the identity this design specifies, and under PM2
   * every worker shares one host, so a hostname distinguishes nothing while
   * lengthening every line.
   *
   * `instance` is the ordinal PM2 injects into each cluster worker, parsed by
   * the configuration module as a non-negative integer that DEFAULTS TO 0 when
   * absent. A directly launched process therefore reports `instance: 0` rather
   * than omitting the field, so every record has the same shape whether or not
   * PM2 launched the process, and a query written against production logs
   * works unchanged against a developer's local run.
   *
   * `service` arrives through configuration on purpose -- never as a literal
   * here, and never as a manifest read at run time. The same name is declared
   * independently in the package manifest and in the PM2 descriptor, and
   * routing the log line's copy of it through configuration is what stops
   * `pm2 status`, these records and the health response from disagreeing about
   * what is running.
   */
  base: {
    pid: process.pid,
    instance: config.instance,
    service: config.serviceName
  },

  /*
   * WHY THESE TWO PATHS, AND WHY THEY ARE ROOTED AT `req.headers`. An
   * `Authorization` header carries a live credential and a `Cookie` header
   * carries a session, so neither may ever reach a log line in clear text --
   * logs are copied, shipped and retained far more freely than the requests
   * they describe, so one leaked record outlives the request by a long way.
   *
   * The paths are rooted at `req.headers` because that is where request
   * headers actually appear in this stream. This module never sees a request
   * itself; pino-http serializes the request under a `req` key on the access
   * record it emits, and the per-request child it uses inherits this policy
   * from the root. Configuring redaction here is therefore what makes it apply
   * to every record pino-http produces, with no middleware having to remember
   * to do it.
   *
   * pino's default censor -- the string `[Redacted]` -- is left in place: the
   * requirement is that these values never appear, not that the substitute
   * read a particular way, and a custom censor would be one more thing to keep
   * in step across two files.
   */
  redact: ['req.headers.authorization', 'req.headers.cookie'],

  /*
   * THE ERROR ALLOWLIST, AS THE ROOT'S OWN POLICY. This replaces pino's
   * default `err` serializer, which would copy every enumerable property of a
   * logged error into the record -- the leak explained at length above
   * `sanitizeError`. Configuring it here rather than at each call site is what
   * makes it hold for every `{ err }` payload in the service: the exception
   * record in src/middleware/error-handler.js, and the fatal, drain-failure
   * and listener records in src/server.js.
   *
   * `req` and `res` are deliberately NOT given serializers here. pino-http
   * installs its own for those two on the child it derives, and a root
   * serializer for them would be shadowed there while suggesting to a reader
   * that it governs the access record.
   */
  serializers: {
    err: sanitizeError
  },

  /*
   * AND THE SAME POLICY AS A RECORD HOOK, WHICH IS THE HALF THAT REACHES THE
   * PER-REQUEST CHILD. `sanitizeRecord`'s own documentation carries the
   * reasoning: pino-http replaces `serializers.err` on the child it derives
   * from this instance but passes no formatters, so that child inherits this
   * hook -- and pino runs an inherited log formatter before the per-key
   * serializers. The two keys together therefore cover every record this
   * process writes today. The obligation that comes with it, stated in full at
   * `sanitizeRecord`: a child CAN replace a log formatter by passing its own,
   * so a new child logger must pass none or reduce its own errors.
   *
   * `level` and `bindings` formatters are absent on purpose, leaving pino's
   * numeric levels and this file's `base` fields exactly as they are.
   */
  formatters: {
    log: sanitizeRecord
  }
};

/*
 * WHY THE LEVEL IS LEFT EXACTLY AS PINO WRITES IT -- AS A NUMBER. Relabelling
 * the level to its string name looks like a free readability win, and it would
 * quietly break two things. This service's acceptance criteria assert the
 * access record NUMERICALLY -- 40 for the 4xx class, 50 for the 5xx class --
 * so labels would falsify them; and any consumer filtering on `level >= 50`
 * would match nothing at all once the field became a string, with no error to
 * show why. Readability in development is already handled by the pino-pretty
 * branch below, which renders the name from the number. Add no level
 * relabelling here.
 */

/**
 * The file descriptor every record is written to: standard output, for every
 * level.
 *
 * A literal rather than `process.stdout.fd` because the value is a POSIX
 * constant, not an environment-derived one, and because reading it off the
 * stream object would make the destination depend on whether Node happened to
 * wrap stdout as a TTY, a pipe or a file -- which is exactly the variability
 * the explicit destination below exists to remove.
 *
 * @type {number}
 */
const STDOUT_FD = 1;

/*
 * WHY THE DESTINATION IS CONSTRUCTED HERE AT ALL, RATHER THAN LEFT TO PINO'S
 * DEFAULT. This is the half of the process's termination guarantee that lives
 * in the logging module, and it is not optional. `src/server.js` ends every
 * exit path -- orderly drain, force timeout, listener error and fatal fault --
 * with the sequence log -> flush -> release the PM2 IPC channel -> exit, and
 * that sequence is only worth anything if the flush can actually establish
 * that the record has reached its destination. Pino's own `flush()` delegates
 * to `destination.flush(callback)`, so what the barrier MEANS is decided here,
 * by which destination is installed.
 *
 * Pino's default cannot provide it, and this was measured on the pinned
 * runtime rather than inferred: with no destination argument pino builds a
 * sonic-boom on fd 1 with `sync` unset, so writes go through asynchronous
 * `fs.write` and a record logged immediately before `process.exit()` is not on
 * the descriptor when the next statement runs. Worse, sonic-boom's
 * `flush(callback)` returns immediately whenever `minLength` is 0 -- the
 * default -- so even the callback form establishes nothing there.
 */

/**
 * Whether something outside this process owns standard output.
 *
 * WHY THIS QUESTION HAS TO BE ASKED, AND WHY GETTING IT WRONG IS INVISIBLE.
 * PM2 runs each cluster worker inside a wrapper that REPLACES
 * `process.stdout.write` with its own function: that function forwards the line
 * to the PM2 daemon (which is how `pm2 logs` sees it) and writes it to the
 * `out_file` the descriptor names. The worker's own file descriptor 1 belongs
 * to the daemon, not to `logs/out.log`. Measured from inside a PM2 7.0.4
 * cluster worker: a line written through `process.stdout` appears in
 * `logs/out.log`, while an `fs.writeSync(1, ...)` of the same line appears
 * NOWHERE. So a destination that talks to the descriptor directly silently
 * empties the log file the deployment reads -- the service looks healthy, every
 * record is gone, and nothing reports it.
 *
 * The test is the one pino itself uses for the same purpose: an untouched
 * stream's `write` is the one on its constructor's prototype, and a supervisor
 * that has installed a hook no longer satisfies that.
 *
 * @type {boolean}
 */
const stdoutIsSupervised =
  process.stdout.write !== process.stdout.constructor.prototype.write;

/**
 * Where bytes actually land.
 *
 * TWO SINKS, AND THE CHOICE BETWEEN THEM IS NOT A PREFERENCE. In production
 * under a supervisor the records must go through the supervisor's stream, for
 * the reason above -- that is the stream whose output the PM2 descriptor
 * collects into `logs/out.log`. Everywhere else -- production without a
 * supervisor, and every non-production run, whose prettified output is for a
 * terminal rather than for a log file -- a synchronous sonic-boom on the
 * descriptor is both simpler and stronger: `sync: true` moves the write to
 * `fs.writeSync`, so the record is durable at the instant `logger.info()`
 * returns and the flush below is a barrier that is true by construction.
 *
 * `pino.destination()` is used rather than a bare `SonicBoom` so that sink
 * keeps pino's broken-pipe protection: if the reader of the pipe goes away,
 * writes become no-ops instead of an `EPIPE` crash on a process that is
 * otherwise healthy.
 *
 * @type {import('node:stream').Writable|import('pino').DestinationStream}
 */
let sink;

/**
 * Whether a write to `sink` is durable by the time it returns.
 *
 * True for the synchronous sonic-boom, false for a supervisor's stream, whose
 * writes are queued and report completion through a callback. It is what
 * decides which of the two drain strategies below applies.
 *
 * @type {boolean}
 */
let sinkIsSynchronous;

if (config.isProduction && stdoutIsSupervised) {
  sink = process.stdout;
  sinkIsSynchronous = false;
} else {
  sink = pino.destination({ dest: STDOUT_FD, sync: true });
  sinkIsSynchronous = true;
}

/**
 * How many writes handed to an asynchronous sink have not yet reported
 * completion. Always 0 while `sinkIsSynchronous` is true.
 *
 * @type {number}
 */
let pendingWrites = 0;

/**
 * Callbacks waiting for `pendingWrites` to reach zero.
 *
 * @type {Array<(error?: Error) => void>}
 */
const drainWaiters = [];

/**
 * The first failure the sink has reported, retained so that a drain can report
 * it rather than answer as though the write had succeeded.
 *
 * WHY IT IS RETAINED RATHER THAN LOGGED. The thing that failed is the log
 * stream, so there is nowhere useful to write this from inside the logging
 * module: a record about a broken sink, written to that sink, is the record
 * most likely to be lost. The drain hands it to `src/server.js` instead, which
 * has a logger-free synchronous stderr writer for exactly this case. The FIRST
 * failure is kept rather than the last, because it is the one that explains the
 * others.
 *
 * @type {Error|undefined}
 */
let sinkFailure;

/**
 * Retains a sink failure, keeping the first one reported.
 *
 * @param {unknown} error The failure as the sink reported it. Normalised to an
 *                        `Error` so a consumer can rely on `message`.
 * @returns {void}
 */
function retainSinkFailure(error) {
  if (sinkFailure !== undefined) {
    return;
  }

  sinkFailure = error instanceof Error ? error : new Error(String(error));
}

/*
 * A LISTENER ON THE SINK'S `error` EVENT, WHICH DOES TWO JOBS AT ONCE.
 *
 * It records a failure that arrives on the event channel rather than on a write
 * callback -- a full or revoked file descriptor, for instance -- so the drain
 * can report it. And it keeps that event from being unhandled: pino's own
 * broken-pipe filter swallows `EPIPE` but RE-EMITS anything else, and an
 * `error` event with no listener is thrown, which would kill a process whose
 * only real problem was that it could not write a log line.
 */
sink.on('error', retainSinkFailure);

/**
 * Writes one serialized record to the sink, keeping count of what is still in
 * flight.
 *
 * The three-argument call is deliberate and load-bearing under PM2: its
 * replacement for `process.stdout.write` has the signature
 * `(string, encoding, callback)` and passes only its third argument on to the
 * file it writes, so handing the callback in as the second argument would
 * leave this module waiting for a completion report that was never going to
 * arrive.
 *
 * @param {string} chunk The serialized record, newline included, exactly as
 *                       pino produced it.
 * @returns {boolean} Whatever the sink reports about backpressure. Pino does
 *                    not act on it; it is returned rather than swallowed so
 *                    this function is an honest stand-in for the sink's own
 *                    `write`.
 */
function writeToSink(chunk) {
  if (sinkIsSynchronous) {
    return sink.write(chunk);
  }

  pendingWrites += 1;

  return sink.write(chunk, undefined, (error) => {
    // The callback reports EITHER completion or failure, and treating the two
    // alike is what turns a lost record into a silent success. A sink that
    // reports an error for every write and puts no bytes anywhere would
    // otherwise satisfy the drain below and let the process exit reporting a
    // clean flush.
    if (error) {
      retainSinkFailure(error);
    }

    pendingWrites -= 1;

    if (pendingWrites === 0) {
      while (drainWaiters.length > 0) {
        drainWaiters.shift()(sinkFailure);
      }
    }
  });
}

/**
 * The drain `logger.flush(callback)` resolves to: reports when every record
 * written so far has reached the sink.
 *
 * On the synchronous sink there is by definition nothing outstanding, so the
 * callback runs at once. On a supervisor's stream the callback is held until
 * the last write in flight has reported completion -- which, for PM2, is the
 * point at which the line is in `logs/out.log`, because its hook forwards this
 * very callback to the file write. Either way the answer is derived from the
 * sink's own behaviour rather than from a delay chosen by guesswork.
 *
 * IT REPORTS FAILURE AS WELL AS COMPLETION, which is the difference between a
 * barrier and a formality. If any write has failed, or the sink has emitted an
 * error, the retained failure is handed to the callback -- so
 * `logger.flush(callback)` distinguishes "the records are out" from "the records
 * are gone", and the process layer can say so on a stream that still works
 * instead of exiting as though nothing had happened.
 *
 * It never throws and never ends the sink: the caller is a process on its way
 * out, and a drain that closed the stream would silently stop all logging if
 * anything ever drained mid-life. `src/server.js` bounds the wait, so a sink
 * that reports neither completion nor failure delays an exit rather than
 * preventing it.
 *
 * @param {(error?: Error) => void} [callback] Invoked once, when nothing is
 *                        outstanding, with the first failure the sink reported
 *                        or nothing at all if every write succeeded.
 * @returns {void}
 */
function drainSink(callback) {
  const settle = typeof callback === 'function' ? callback : () => {};

  if (sinkIsSynchronous || pendingWrites === 0) {
    settle(sinkFailure);
    return;
  }

  drainWaiters.push(settle);
}

/**
 * The destination pino writes to: a thin, explicitly drainable façade over
 * whichever sink was chosen.
 *
 * Pino asks a destination for exactly two things -- `write(chunk)` for every
 * record and `flush(callback)` when someone needs a barrier -- so this pair is
 * the whole contract, and expressing it as a façade rather than handing pino
 * the sink itself is what lets the drain above exist at all: a supervisor's
 * stream has no `flush`, and pino's flush silently degrades to "call the
 * callback and touch nothing" against a destination that lacks one.
 *
 * Reassigned on the non-production branch below, where pino-pretty becomes the
 * destination and renders into the same sink.
 *
 * @type {{ write: (chunk: string) => boolean, flush: (callback?: () => void) => void }}
 */
let target = { write: writeToSink, flush: drainSink };

/*
 * PINO-PRETTY IS BUILT ONLY ON THE NON-PRODUCTION BRANCH, AND THIS
 * CONDITIONAL MUST NOT BE FLATTENED.
 *
 * pino-pretty is a devDependency, and a production host installs with
 * `npm ci --omit=dev`, so the package is simply not on disk there. The
 * `require` therefore lives INSIDE this branch: a top-level import, or a
 * transport target named unconditionally in the options object, is resolved
 * while the logger is being CONSTRUCTED and so kills a production start-up
 * before the listener binds, naming a module nobody expected it to need. An
 * unconditional reference is fatal even where its value would never be used.
 *
 * This is the mistake the service's production-tree validation stage exists to
 * catch: it installs with `--omit=dev`, confirms pino-pretty is absent from the
 * tree, and then starts the service under PM2 with the environment set to
 * production. If the service reaches `online` and serves a request, this
 * branch is correct.
 *
 * WHY THE IN-PROCESS STREAM FORM RATHER THAN A WORKER-THREAD TRANSPORT, which
 * is the other way to attach pino-pretty. A worker transport is not drainable
 * on the way out, and that was measured on the pinned runtime: with
 * `transport: { target: 'pino-pretty' }` installed, `logger.flush(callback)`
 * was observed NOT to invoke its callback at all -- the process exited with the
 * callback still pending -- because the flush is queued behind a worker thread
 * that does not hold the event loop open. A callback-driven termination
 * sequence built on that either hangs until the supervisor kills the worker or
 * silently skips its own barrier, and both outcomes look correct in the source.
 * Building pino-pretty as an in-process stream over the synchronous sink above
 * keeps the whole write path inside this process and inside one turn of the
 * event loop: measured, the prettified bytes are on the descriptor before
 * `logger.info()` returns. That matches a production run that owns standard
 * output; the supervised production sink is the one case where a write is
 * queued instead and reported through its callback, and it never reaches this
 * branch.
 *
 * The options are kept minimal on purpose. `colorize` and `translateTime`
 * change presentation only; nothing here uses `ignore`, because the three
 * `base` identity fields are exactly what a reader needs to see, and hiding
 * them would make development output describe a different record from the one
 * production writes. `destination` is handed the sink INSTANCE rather than a
 * file descriptor deliberately: pino-pretty writes to an instance it is given
 * and would otherwise build its own, asynchronous by default, which would put
 * an undrainable buffer back into the very path this branch keeps synchronous.
 */
if (!config.isProduction) {
  const pinoPretty = require('pino-pretty');

  const prettyStream = pinoPretty({
    colorize: true,
    translateTime: 'SYS:standard',
    destination: sink
  });

  /*
   * The same drain, attached to the pipeline pino now writes into.
   *
   * pino calls `destination.flush(callback)` when the destination has one, and
   * a pino-abstract-transport stream -- which is what pino-pretty returns --
   * has none, so without this assignment pino would invoke the callback and
   * touch nothing. Assigning `drainSink` is exact rather than approximate on
   * this branch: the sink here is always the synchronous sonic-boom (the
   * supervised stream is chosen only in production), so by the time pino's
   * write call returns, the prettified bytes are already on the descriptor and
   * the drain has nothing left to wait for.
   *
   * It is deliberately NOT an `end()` or `close()` of the pipeline. This runs
   * on the terminal path today, but a flush that destroyed the stream would
   * silently stop all logging if anything ever drained mid-life.
   */
  prettyStream.flush = drainSink;

  target = prettyStream;
}

/**
 * The process-wide root logger.
 *
 * Every record it writes carries the three identity fields from `base` --
 * `pid`, `instance` and `service` -- alongside pino's own `level`, `time` and
 * `msg`. `req.headers.authorization` and `req.headers.cookie` are redacted
 * before anything is written, at the root, so every child inherits the policy,
 * and anything logged under `err` is reduced to the fields `sanitizeError`
 * permits -- type, message, stack, and a code or status where the error
 * carries one -- so no other property of an error can reach the stream.
 * In production the instance writes raw newline-delimited JSON, one complete
 * JSON object per line; outside production the same records are rendered as
 * human-readable text by pino-pretty.
 *
 * ALL LEVELS GO TO STDOUT, through the destination built above. No second
 * stream is configured and error-level records are deliberately NOT routed to
 * stderr: the PM2 descriptor sends stdout to `logs/out.log` and stderr to
 * `logs/error.log`, and `error.log` is expected to be empty in a clean run
 * precisely because pino writes every level to stdout. A service record
 * appearing there would mean this stream configuration had changed.
 *
 * WHAT `logger.flush(callback)` GUARANTEES ON THIS INSTANCE, since
 * `src/server.js` builds its whole termination sequence on it: the callback
 * runs once every record written so far has reached the sink -- the
 * descriptor for the synchronous sonic-boom, and `logs/out.log` for a
 * supervised stream, whose own completion callback is what this waits on.
 * Neither case rests on timing: one is durable at write time and the other
 * reports completion explicitly. A future change that installs a destination
 * without a drain -- an asynchronous sonic-boom, or a worker-thread transport
 * -- breaks that guarantee silently, so it has to bring a drain the process
 * layer can await with it.
 *
 * @type {import('pino').Logger}
 */
const logger = pino(options, target);

/*
 * THE RAW INSTANCE IS EXPORTED -- NOT A FACADE, AND NOT `{ logger }`.
 *
 * Wrapping it in an object exposing only `info`, `warn` and `error` would drop
 * two members this service depends on, and both failures are silent ones.
 *
 * `logger.flush(callback)` is the middle step of the log -> flush -> release
 * the PM2 IPC channel -> exit sequence src/server.js runs on every exit path,
 * orderly drain and fatal alike, and it is meaningful here only because the
 * destination above was chosen to make it so. A destination that buffers
 * asynchronously turns the same call into a no-op barrier, and the final line
 * -- the one recording how the process ended -- disappears while the code that
 * wrote it still looks correct.
 *
 * `logger.child()` is what pino-http calls to derive the per-request logger on
 * `req.log`, so a facade would take the access record with it.
 *
 * Nothing else is exported, and nothing else should be added: no wrapper
 * around the `flush` that already exists, no named per-module loggers, and no
 * factory. There is exactly one root logger per process, and this is it. The
 * drain the process layer needs is provided by the destination, which is why
 * it is not a second export.
 */
module.exports = logger;
