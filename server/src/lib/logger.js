// SPDX-License-Identifier: Apache-2.0
/**
 * The one pino root logger for this service.
 *
 * SINGLE RESPONSIBILITY: construct exactly one pino logger for the process and
 * export that instance. It owns the shape of a record -- the `base` identity
 * fields, the `redact` policy, the error allowlist with its length bound and
 * credential scrub, the rendering decision, and the destination together with
 * what happens when that destination fails. It holds no request state, no
 * counters and no files, and writes no record of its own except a diagnostic
 * about its own sink.
 *
 * ITS THREE CONSUMERS, and what each needs from it:
 *   * src/middleware/request-context.js -- passes this instance to pino-http
 *     for the per-request `req.log` child and the one access record per
 *     request. That child inherits `level`, `base`, `redact` and the hook from
 *     here; the `req`/`res` serializers are the one part it must own itself,
 *     because pino-http shadows those two keys (see the `serializers` key).
 *   * src/middleware/error-handler.js -- writes the exception record for a
 *     server-side failure, whose response message is masked in production, so
 *     the record is the only place the real one survives. Which failures reach
 *     it is that module's gate to state, not this one's.
 *   * src/server.js -- the start-up, listener-error and shutdown records, and
 *     the flush step of its log -> flush -> release the PM2 IPC channel -> exit
 *     sequence, which means something only because of the destination
 *     installed here.
 *
 * ONE INSTANCE, NO FACTORY: two root loggers would mean two identity blocks,
 * two redaction policies and two transport decisions able to drift apart with
 * nothing reporting the divergence. The configuration import is deliberately
 * unguarded -- a configuration failure has to surface through src/server.js's
 * logger-free stderr fallback, because this file IS the logger.
 *
 * @module lib/logger
 */

'use strict';

// The logging library, a declared runtime dependency present on every tree.
const pino = require('pino');

/*
 * `fs.writeSync()` is the only way to report that the log stream itself has
 * failed: it needs no logger, no transport and no turn of the event loop, so it
 * still works when the sink below does not. The `node:` prefix is used because
 * it cannot be shadowed by a package of the same name.
 */
const fs = require('node:fs');

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
 * The description names this MODULE rather than the service. Service identity
 * reaches a record only through `config.serviceName`, and a second copy of the
 * name here would be one more place a rename has to remember.
 *
 * @type {symbol}
 */
const SANITIZED_ERROR = Symbol('lib/logger.sanitized-error');

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
 * Longest error message kept, and the bound applied to every string argument
 * of a log call.
 *
 * A message that says what failed fits comfortably inside a kilobyte; past
 * that the string has stopped being a diagnosis and started being a payload --
 * a rejected request body, a rendered SQL statement, a base64 attachment. The
 * value is a module constant rather than a configured one on purpose: a bound
 * an operator can raise is a bound an incident can raise.
 *
 * @type {number}
 */
const MAX_MESSAGE_LENGTH = 1024;

/**
 * Longest stack kept, root frames and folded cause frames together. Four
 * kilobytes holds roughly forty frames, which is more than any diagnosis in
 * this service needs and far less than a runaway recursion produces.
 *
 * @type {number}
 */
const MAX_STACK_LENGTH = 4096;

/**
 * Longest `err.code` kept when the code is a string. Node's system codes and
 * body-parser's `entity.parse.failed` are tens of characters; a longer value
 * is a library using the field for something other than a code.
 *
 * @type {number}
 */
const MAX_CODE_LENGTH = 128;

/**
 * Longest `err.type` kept. A constructor or `name` this long is not a type
 * name, and the field must not become a second message channel.
 *
 * @type {number}
 */
const MAX_TYPE_LENGTH = 128;

/**
 * The substitute written in place of credential material found inside a
 * string. Spelled differently from pino's own `[Redacted]` censor deliberately:
 * a reader seeing this one knows the value was removed from INSIDE a message or
 * a stack by this module, not from a redacted path by pino.
 *
 * @type {string}
 */
const SECRET_PLACEHOLDER = '[REDACTED]';

/**
 * Credential material inside a URL: `scheme://user:pass@host`. Matched as the
 * whole userinfo component so both halves go, since a bare username is an
 * identifier this service has no business logging either.
 *
 * The scheme is bounded to 32 characters rather than left open. An unbounded
 * run followed by a required `://` backtracks from every position in the
 * string, which is quadratic in its length -- measured at 12 ms on a 4 KB stack
 * of name characters, against 0.5 ms bounded. A scrubber whose cost an
 * attacker can raise is not much of a defence against log amplification, and
 * no real scheme is anywhere near that long.
 *
 * @type {RegExp}
 */
const URL_USERINFO_PATTERN = /([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#@]+@/gi;

/**
 * An HTTP authorization credential quoted inside a message or a stack --
 * `Bearer <token>`, `Basic <base64>`. The scheme is kept because it is
 * diagnostic; the credential after it is not.
 *
 * @type {RegExp}
 */
const AUTH_SCHEME_PATTERN = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;

/**
 * A `name=value` or `name: value` pair whose NAME ends in one of the words
 * this service treats as naming a credential -- the shape a query string, a
 * connection string, a header dump, a JSON body fragment and a key/value log
 * line all take.
 *
 * The name is matched as a run of name characters ENDING in one of the listed
 * words, so prefixed forms (`x_api_key`, `db_password`, `user.token`) are
 * covered rather than slipping through on their prefix. The cost is that a name
 * merely ending in one of the words -- `monkey` -- is scrubbed too, which is
 * the safe direction to be wrong in.
 *
 * QUOTES AROUND EITHER SIDE ARE OPTIONAL, AND THAT IS WHAT COVERS A BODY. A
 * serialized JSON body reaches a log line as `{"password":"live"}` -- the name
 * closes with a quote before the separator and the value opens with one after
 * it -- so a pattern that only accepted a bare `name=value` left every
 * request-body credential untouched, which is the shape a body-parser failure
 * or a client library's error message quotes most often. The optional quote is
 * matched as part of the separator so the value alone is replaced and the
 * surrounding JSON stays syntactically recognisable. Single quotes and
 * backticks are accepted too, because a message built by string interpolation
 * uses whichever the author happened to type.
 *
 * The value runs to the next delimiter: `&`, `;`, `,`, whitespace, a quote of
 * any kind, or a closing bracket, brace or parenthesis -- so a JSON value stops
 * at its own closing quote and a query parameter at its `&`.
 *
 * The prefix run is bounded to 64 characters for the cost reason given above
 * `URL_USERINFO_PATTERN` -- measured at 20 ms unbounded on a 4 KB pathological
 * string against 1.3 ms bounded -- and the bound loses nothing: the sensitive
 * word has to be at the END of the name, so only the tail of a longer name
 * decides the match.
 *
 * @type {RegExp}
 */
const SENSITIVE_PAIR_PATTERN =
  /([A-Za-z0-9_.[\]-]{0,64}(?:access_token|refresh_token|api[_-]?key|apikey|authorization|auth|credentials?|passphrase|passwd|password|pwd|secret|session[_-]?id|session|signature|sig|token|cookie|key))(["'`]?\s*[=:]\s*["'`]?)[^&;,\s'"`)\]}]+/gi;

/**
 * Removes credential material from a string before it can be written.
 *
 * WHY A STRING SCRUBBER EXISTS ALONGSIDE THE PATH-BASED `redact` POLICY.
 * `redact` removes a value that sits at a named path in the record, and
 * `sanitizeError` drops every error property that is not on its allowlist.
 * Neither reaches a secret that is INSIDE one of the strings that IS allowed:
 * a client library puts the full request URL in `err.message`, a connection
 * error quotes its connection string, a stack frame carries the argument it was
 * called with. Those are the strings this function cleans.
 *
 * THREE PATTERNS AND NO MORE, in this order, because over-scrubbing is its own
 * failure: a message rewritten past recognition costs an operator the incident.
 *   1. URL userinfo -- `https://u:p@host` becomes `https://[REDACTED]@host`.
 *   2. `Bearer`/`Basic` credentials -- applied BEFORE the pair pattern, so
 *      `authorization: Bearer abc` loses the token rather than losing only the
 *      word `Bearer` and leaving the token behind it.
 *   3. `name=value` pairs whose name names a credential.
 * Matching is case-insensitive throughout; header names, query keys and
 * environment-style keys all vary in case.
 *
 * @param {string} text The string about to be written.
 * @returns {string} The same string with credential material replaced by
 *   `SECRET_PLACEHOLDER`, or the input unchanged when it carries none.
 */
function scrubSecrets(text) {
  return text
    .replace(URL_USERINFO_PATTERN, `$1${SECRET_PLACEHOLDER}@`)
    .replace(AUTH_SCHEME_PATTERN, `$1 ${SECRET_PLACEHOLDER}`)
    .replace(SENSITIVE_PAIR_PATTERN, `$1$2${SECRET_PLACEHOLDER}`);
}

/**
 * Bounds a string and scrubs it: the one function every string this module
 * writes passes through.
 *
 * THE ORDER IS DELIBERATE -- BOUND FIRST, THEN SCRUB. Scrubbing first would
 * run three regular expressions across a value whose size this service does not
 * control, which is the CPU half of the same amplification the length cap
 * exists to prevent; a hostile ten-megabyte message must cost a slice, not a
 * scan. Cutting first is safe because a cut only ever removes a suffix: what
 * remains of `access_token=live-secret` after a cut is still a `name=value`
 * pair, and the scrub still removes it.
 *
 * @param {*} text The candidate string. A non-string -- an error whose
 *   `message` is an object, a `stack` a library replaced with a getter
 *   returning `undefined` -- yields the empty string, so the record's shape
 *   never varies.
 * @param {number} maxLength The most characters to keep, before the marker.
 * @returns {string} The bounded, scrubbed string, carrying the explicit
 *   `... (truncated)` marker when characters were dropped.
 */
function safeText(text, maxLength) {
  if (typeof text !== 'string' || text.length === 0 || maxLength <= 0) {
    return '';
  }

  const bounded = text.length > maxLength ? text.slice(0, maxLength) : text;
  const scrubbed = scrubSecrets(bounded);

  return bounded.length < text.length ? `${scrubbed}... (truncated)` : scrubbed;
}

/**
 * Renders a non-error value as a bounded, scrubbed, single string.
 *
 * @param {*} value The value logged under the `err` key.
 * @returns {string} Its string form, scrubbed of credential material and
 *   truncated with an explicit marker when it exceeds
 *   `MAX_RENDERED_VALUE_LENGTH`, or a fixed notice when the value cannot be
 *   converted to a string at all.
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

  return safeText(rendered, MAX_RENDERED_VALUE_LENGTH);
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
 * THE BUDGET IS SPENT AS THE WALK PROCEEDS, NOT CHECKED AT THE END, and that
 * distinction is the whole point rather than a refinement. Folding five links
 * first and cutting the result afterwards means five megabyte-scale strings are
 * concatenated in memory -- inside a log call, on the failure path, where the
 * process is least able to absorb it. Each link is therefore bounded by what
 * is LEFT of the budget before it is appended, and the walk stops as soon as
 * the budget is gone.
 *
 * @param {object} error The error-like value being reduced.
 * @returns {{ message: string, stack: string }} The folded message and stack,
 *   each scrubbed of credential material and bounded by `MAX_MESSAGE_LENGTH`
 *   and `MAX_STACK_LENGTH` respectively, plus the truncation markers. Either
 *   may be empty, because a value can be error-like without carrying both; the
 *   fields are still written, so the record's shape never varies.
 */
function foldCauseChain(error) {
  let message = safeText(error.message, MAX_MESSAGE_LENGTH);
  let stack = safeText(error.stack, MAX_STACK_LENGTH);

  // What is left to spend on the chain: the two caps less what the root link
  // has already used. The separators (`': '` and `'\ncaused by: '`) are
  // charged against the budget too, so a long chain of empty messages cannot
  // grow the line either.
  let messageBudget = MAX_MESSAGE_LENGTH - message.length;
  let stackBudget = MAX_STACK_LENGTH - stack.length;

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

    if (depth >= MAX_CAUSE_DEPTH || messageBudget <= 0 || stackBudget <= 0) {
      // Either the chain is deeper than this service reads, or what has been
      // folded already fills the line. Both are the same outcome for a reader
      // -- there was more -- and both carry the same marker.
      message += ': ...';
      stack += '\ncauses have been truncated...';
      break;
    }

    visited.add(cause);

    const linkMessage = safeText(cause.message, messageBudget);
    message += `: ${linkMessage}`;
    messageBudget -= linkMessage.length + 2;

    const linkStack = safeText(cause.stack, stackBudget);
    stack += `\ncaused by: ${linkStack}`;
    stackBudget -= linkStack.length + 12;

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
 * AND WHAT IS ALLOWED IS STILL NOT TRUSTED. An allowlist of field NAMES says
 * nothing about the field's contents: a library error's `message` routinely
 * quotes the URL it was called with, and a stack frame can carry an argument.
 * Every string on the list therefore goes through `safeText`, so each is
 * bounded and scrubbed of credential material before it is written -- `type`,
 * the folded `message` and `stack`, and a string `code`.
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
    record.type = safeText(resolveErrorType(value), MAX_TYPE_LENGTH);

    const folded = foldCauseChain(value);
    record.message = folded.message;
    record.stack = folded.stack;

    // The field keeps its type -- a string code stays a string and a numeric
    // one stays a number, because a consumer matching `err.code === 'EPIPE'`
    // or `err.code === 11` must keep working. Only the string form can carry
    // arbitrary text, so only the string form is bounded and scrubbed.
    const code = value.code;
    if (typeof code === 'string') {
      record.code = safeText(code, MAX_CODE_LENGTH);
    } else if (typeof code === 'number') {
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
 * WHAT IS LEFT AT PINO'S DEFAULT, and each absence is a decision rather than an
 * oversight: the `time` field and its epoch-millisecond format, the `msg`
 * message key, the numeric representation of `level` (asserted numerically by
 * this service's acceptance criteria -- see the note below this object), and
 * the `bindings` formatter, which would otherwise disturb the `base` fields.
 *
 * WHAT IS CONFIGURED HERE, all of it deliberate: the level and the identity
 * fields; the two redacted header paths; an `err` serializer that replaces
 * pino's default with this service's allowlist; a `log` formatter that keeps
 * that allowlist in force on a derived logger; and a `logMethod` hook that
 * bounds and scrubs the message channel, which neither of the other two can
 * reach. Each key carries its reasoning inline.
 *
 * The destination is the one default this file does NOT accept, and it is
 * passed to `pino()` as a second argument rather than set here -- the block
 * above it explains why.
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
   * THE POLICY IS NOT MADE REDUNDANT BY THE REQUEST SERIALIZER, and the two
   * halves depend on each other. `src/middleware/request-context.js` writes
   * only an allowlist of headers, and it keeps these two on that list SO THAT
   * this policy replaces their values: the record then says a credential was
   * presented without carrying it. Redaction is also the only gate left for a
   * `{ req }` payload logged directly through this instance, which no
   * pino-http serializer sees. Remove either half and clear-text credentials
   * become reachable again.
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
   * `req` and `res` are deliberately NOT given serializers here, and the
   * reason is mechanical rather than a division of taste: pino-http installs
   * its own for those two keys on the child it derives, so a root serializer
   * for them would be shadowed on the access record -- the one record that
   * actually carries a request -- while reading as though it governed it. The
   * request and response serializers therefore live where they take effect, in
   * `src/middleware/request-context.js`, and they are what keeps a query
   * string, a forged `X-Forwarded-*` header and the response's own headers out
   * of the access record while recording Express's trust-aware `req.ip` and
   * `req.protocol` in their place. What remains this module's business for
   * those two keys is the `redact` policy above, which applies after any
   * serializer has run.
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
   * serializers. The two keys together therefore reduce the `err` payload of
   * every record this process writes today; the message channel is the `hooks`
   * key below. The obligation that comes with it, stated in full at
   * `sanitizeRecord`: a child CAN replace a log formatter by passing its own,
   * so a new child logger must pass none or reduce its own errors.
   *
   * `level` and `bindings` formatters are absent on purpose, leaving pino's
   * numeric levels and this file's `base` fields exactly as they are.
   */
  formatters: {
    log: sanitizeRecord
  },

  /*
   * AND THE SAME POLICY ON THE MESSAGE CHANNEL, WHICH NEITHER OF THE TWO ABOVE
   * CAN REACH. `logger.info(obj, 'message')` hands pino its message as a
   * SEPARATE argument: it never appears in the merged object, so
   * `formatters.log` does not see it, and it is not a serialized key, so no
   * serializer sees it either. That channel carries real secrets in practice:
   * the message of a failure is exactly where a library quotes back the URL,
   * connection string or argument it was called with, and any caller may
   * interpolate a value into a message without a thought for where the record
   * is shipped and how long it is kept.
   *
   * A `logMethod` hook is the one place a log call can be intercepted before
   * pino formats it, so this is where every STRING argument is bounded and
   * scrubbed. Non-string arguments are passed through untouched -- the merged
   * object is the other two keys' business, and pino's own printf-style
   * interpolation values are handled by position.
   *
   * TWO OBLIGATIONS FOR ANYONE EDITING THIS HOOK. It must not reorder, drop or
   * add arguments: pino reads argument POSITION to decide what is the merged
   * object, what is the message and what are the interpolation values, so a
   * hook that shifts them silently changes every record's shape. And it must
   * return `method.apply(this, args)`; a hook that calls `method` without
   * returning its result breaks `logger.child()`'s own return value.
   *
   * Verified on the pinned runtime: a hook set here is inherited by
   * `logger.child()` and therefore by the per-request logger pino-http derives,
   * so it covers every record this process writes.
   */
  hooks: {
    /**
     * Bounds and scrubs every string argument of a log call.
     *
     * @param {unknown[]} args The arguments as the caller passed them, in
     *   order: optionally a merged object, then the message, then any
     *   interpolation values.
     * @param {Function} method The level method pino would have called.
     * @returns {*} Whatever `method` returns, so the call behaves exactly as an
     *   unhooked one.
     * @this {import('pino').Logger}
     */
    logMethod(args, method) {
      // Copy-on-write: the arguments array belongs to the caller's frame and a
      // call carrying no strings -- `logger.error({ err })` -- must not pay for
      // a copy it does not need.
      let scrubbed = null;

      for (let index = 0; index < args.length; index += 1) {
        if (typeof args[index] === 'string') {
          if (scrubbed === null) {
            scrubbed = args.slice();
          }

          scrubbed[index] = safeText(args[index], MAX_MESSAGE_LENGTH);
        }
      }

      return method.apply(this, scrubbed === null ? args : scrubbed);
    }
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
 * Standard output: the descriptor every record is written to, at every level.
 *
 * @type {number}
 */
const STDOUT_FD = 1;

/**
 * Standard error: the descriptor a failure OF the log stream is reported on.
 *
 * @type {number}
 */
const STDERR_FD = 2;

/**
 * How many times a synchronous descriptor write is retried when the kernel
 * reports the descriptor busy (`EAGAIN`) rather than broken. A pipe whose
 * reader is merely behind is not a failed sink, and a diagnostic must not be
 * abandoned for it; anything other than `EAGAIN` is not retried at all.
 *
 * @type {number}
 */
const MAX_SYNC_WRITE_ATTEMPTS = 3;

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
 * otherwise healthy. Silent no-op writes are not an acceptable resting state
 * either, which is what `writeToSink` detects and `handleSinkFailure` acts on.
 *
 * REASSIGNED ONCE, AT MOST: `handleSinkFailure` replaces this with a verified
 * fallback on standard error when the chosen sink fails.
 *
 * @type {import('node:stream').Writable|import('pino').DestinationStream|{ write: (chunk: string) => boolean }}
 */
let sink;

/**
 * Whether a write to `sink` is durable by the time it returns.
 *
 * True for the synchronous sonic-boom and for the descriptor-writing fallback,
 * false for a supervisor's stream and for the standard-error stream used as its
 * fallback, whose writes are queued and report completion through a callback.
 * It is what decides which of the two drain strategies below applies, so it is
 * updated with the sink whenever the fallback is installed.
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
 * WHY IT IS RETAINED AS WELL AS REPORTED. `handleSinkFailure` reports the
 * failure immediately, on file descriptor 2, because that is the one stream
 * that needs no logger -- writing a record about a broken sink TO that sink is
 * the record most likely to be lost. What the retention adds is the report at
 * the end: the drain hands this to `src/server.js`, which turns it into the
 * `ERR_TERMINAL_FLUSH` note on its way out, so an exit never claims the final
 * records were written when they were not. It survives a successful recovery
 * deliberately -- a record WAS lost -- and the FIRST failure is kept rather
 * than the last, because it is the one that explains the others.
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

/**
 * Whether the sink has already been switched to the fallback by
 * `handleSinkFailure`.
 *
 * It is what makes the switch happen at most once: a failure OF the fallback
 * must report itself, not start another switch, and a chain of switches would
 * hide the original failure behind the last one.
 *
 * @type {boolean}
 */
let sinkDegraded = false;

/**
 * Which destination the write accounting belongs to. Incremented when the sink
 * is switched, so a completion callback from the sink that has been abandoned
 * can be told apart from one belonging to the sink now in use.
 *
 * Without it, a stale callback would decrement `pendingWrites` a second time,
 * the count would never return to zero, and every later drain -- including the
 * one `src/server.js` waits on to exit -- would hang.
 *
 * @type {number}
 */
let sinkGeneration = 0;

/**
 * The rendering pipeline pino writes into instead of the façade below, when
 * there is one: the pino-pretty stream built on the non-production branch, and
 * `null` in production.
 *
 * It is tracked because it holds the sink INSTANCE rather than resolving it per
 * write, which is what makes a fallback unreachable through it -- see
 * `failClosedIfRenderPipelineIsDead`.
 *
 * @type {import('node:stream').Transform|null}
 */
let renderPipeline = null;

/**
 * Hands every waiting drain callback the current state of the sink and clears
 * the queue.
 *
 * @returns {void}
 */
function releaseDrainWaiters() {
  while (drainWaiters.length > 0) {
    drainWaiters.shift()(sinkFailure);
  }
}

/**
 * Writes one string straight to a descriptor, with no stream, no buffer and no
 * event loop in between.
 *
 * @param {number} fd The descriptor to write to.
 * @param {string} chunk The string to write, newline included.
 * @returns {boolean} `true` when the bytes were accepted by the descriptor,
 *   `false` when the write failed -- including after `MAX_SYNC_WRITE_ATTEMPTS`
 *   `EAGAIN` reports, which is a descriptor too busy to be relied on here.
 */
function writeToDescriptor(fd, chunk) {
  for (let attempt = 0; attempt < MAX_SYNC_WRITE_ATTEMPTS; attempt += 1) {
    try {
      fs.writeSync(fd, chunk);
      return true;
    } catch (error) {
      // `EAGAIN` says the descriptor is a non-blocking pipe whose reader is
      // behind -- the sink is not broken, the write simply did not fit, so it
      // is worth immediately retrying a bounded number of times. Anything else
      // is a real failure of this descriptor and retrying it would only delay
      // the report.
      if (error === null || typeof error !== 'object' || error.code !== 'EAGAIN') {
        return false;
      }
    }
  }

  return false;
}

/**
 * Renders the one-line JSON diagnostic that reports a failure of the log
 * stream itself.
 *
 * It carries the same three identity fields as every other record from this
 * process -- so it can be correlated with them -- plus a machine-readable code
 * and the failure's own message, bounded and scrubbed like any other string
 * this module writes. `JSON.stringify` escapes every newline, so the result is
 * exactly one line for the same line-at-a-time tooling that reads the service's
 * ordinary output.
 *
 * @param {string} code The machine-readable code: `ERR_LOG_SINK_FAILURE` for
 *   the first failure, `ERR_LOG_FALLBACK_FAILURE` for a failure of the
 *   fallback, `ERR_LOG_SINK_UNAVAILABLE` when no sink is left at all, and
 *   `ERR_LOG_SINK_UNREACHABLE` when a sink exists but pino can no longer reach
 *   it.
 * @param {string} message The short human-readable account.
 * @param {Error} failure The failure being reported.
 * @returns {string} One line of JSON, newline included.
 */
function buildSinkDiagnostic(code, message, failure) {
  return `${JSON.stringify({
    level: 'fatal',
    time: Date.now(),
    pid: process.pid,
    instance: config.instance,
    service: config.serviceName,
    code,
    msg: message,
    err: safeText(failure.message, MAX_MESSAGE_LENGTH)
  })}\n`;
}

/**
 * The synchronous fallback destination: standard error, written straight to the
 * descriptor.
 *
 * Used when nothing outside this process owns standard output, in which case a
 * descriptor write is the strongest thing available -- durable by the time it
 * returns, exactly like the sonic-boom it replaces, so the flush barrier keeps
 * meaning what it meant.
 *
 * @type {{ write: (chunk: string) => boolean }}
 */
const synchronousStderrSink = {
  write(chunk) {
    if (writeToDescriptor(STDERR_FD, chunk)) {
      return true;
    }

    // The fallback has failed too, which ends the process: the handler knows
    // the sink is already degraded, and its answer to a failed fallback is to
    // fail closed rather than keep serving with nothing recording it. The
    // `return` below is unreachable in practice and kept so this method's
    // contract stays a boolean-returning `write`.
    handleSinkFailure(new Error(
      `the fallback log sink could not write to file descriptor ${STDERR_FD}`
    ));

    return false;
  }
};

/**
 * Ends the process because it can no longer produce an audit trail.
 *
 * WHY EXITING IS THE CORRECT LAST RESORT, AND WHY IT IS ONLY THE LAST RESORT.
 * A service that keeps answering requests with no access and no exception
 * records is serving blind: nothing is left to establish what it did, who
 * asked, or that it failed -- which is the state the fallback above exists to
 * avoid, and the state this function is for when the fallback cannot be
 * established either. Exiting non-zero hands the decision to the supervisor:
 * PM2's `autorestart` replaces the worker with one that has a working sink,
 * which is a bounded, visible outage instead of an unbounded invisible one. The
 * IPC channel is released first for the reason `src/server.js` documents at
 * length: a PM2 worker that dies with the channel attached is reported as a
 * crash and can be `SIGKILL`ed at `kill_timeout` rather than exiting cleanly.
 *
 * @param {string} code The machine-readable code for the reason no sink is
 *   left: `ERR_LOG_SINK_UNAVAILABLE` when no fallback could be verified,
 *   `ERR_LOG_FALLBACK_FAILURE` when the fallback in use has itself failed, and
 *   `ERR_LOG_SINK_UNREACHABLE` when a verified fallback exists but pino can no
 *   longer reach it.
 * @param {string} message The short human-readable account of that reason.
 * @param {Error} failure The failure that left the process with no sink.
 * @returns {never} Never returns -- the process is gone.
 */
function failClosed(code, message, failure) {
  // Best-effort, and deliberately not conditional on success: there may be no
  // descriptor left to report on, and the exit must happen either way.
  writeToDescriptor(STDERR_FD, buildSinkDiagnostic(code, message, failure));

  try {
    process.disconnect?.();
  } catch (disconnectFailure) {
    // A channel that is already gone is the outcome this call wanted. It is
    // retained rather than ignored so that, if the exit below is ever made
    // conditional, the reason is still on record.
    retainSinkFailure(disconnectFailure);
  }

  process.exit(1);
}

/**
 * Whether a stream can be trusted to carry the log records from here on, tested
 * by writing the diagnostic through it rather than by inspecting it.
 *
 * VERIFICATION HAS TWO HALVES, AND ONLY ONE OF THEM CAN BE ANSWERED HERE. The
 * synchronous half is this function: the stream reports itself writable, is not
 * destroyed, and accepts the line without throwing. The asynchronous half is
 * the write's own completion callback, and it is the half that matters under a
 * supervisor -- PM2 replaces `process.stderr.write` with a wrapper that accepts
 * the line, forwards it to the file its descriptor names, and reports a failure
 * of THAT write only through the callback, leaving the wrapper object's
 * `writable` and `destroyed` flags untouched. A fallback declared verified on
 * those flags alone is a fallback that can be discarding every line while
 * looking healthy. So the callback is passed here and routed back into
 * `handleSinkFailure`, which by then knows the sink is degraded and fails
 * closed rather than trusting the flags a second time.
 *
 * The line written to verify is the diagnostic itself, so verification costs
 * nothing extra and leaves the report on the stream an operator will actually
 * read -- under a supervisor that is `error_file`, where the descriptor write
 * does not arrive. Where the descriptor and the stream happen to be the same
 * destination the line appears twice, which is a great deal better than a
 * fallback that was assumed rather than tested.
 *
 * @param {import('node:stream').Writable} stream The candidate fallback.
 * @param {string} diagnostic The line to verify it with.
 * @returns {boolean} `true` when the stream is writable and accepted the line
 *   synchronously. A later failure reported through the callback is not a
 *   return value: it ends the process.
 */
function verifyStreamFallback(stream, diagnostic) {
  if (
    stream === null ||
    typeof stream !== 'object' ||
    typeof stream.write !== 'function' ||
    stream.writable !== true ||
    stream.destroyed === true
  ) {
    return false;
  }

  try {
    // The three-argument form for the reason `writeToSink` documents: PM2's
    // replacement takes `(string, encoding, callback)` and forwards only its
    // third argument to the file write, so a callback passed second would never
    // be called and this verification would have no asynchronous half at all.
    stream.write(diagnostic, undefined, (error) => {
      if (error) {
        handleSinkFailure(error);
      }
    });

    return true;
  } catch {
    // A stream that throws on a write is not a fallback. The binding is omitted
    // because the caller's next step does not depend on which error it was:
    // there is one candidate, and it has just disqualified itself.
    return false;
  }
}

/**
 * Ends the process when the switch to the fallback cannot reach pino, because
 * a rendering pipeline stands between them and has died with the sink.
 *
 * WHY THE SWITCH IS NOT ALWAYS ENOUGH. The façade this module hands pino
 * resolves the sink on every write, so switching the variable is all that is
 * needed wherever pino writes through that façade -- every production run. On
 * the non-production branch pino writes into the pino-pretty pipeline instead,
 * and that pipeline was given the sink INSTANCE. Measured on the pinned
 * runtime: when the sink fails, the pipeline is destroyed with it
 * (`destroyed === true`, `writable === false`) and records written afterwards
 * reach no sink at all -- redirecting the failed instance does not help,
 * because nothing is left to write to it. That is the fail-open state this
 * whole mechanism exists to prevent, so the process fails closed instead: the
 * diagnostic is already on the descriptor, and exiting makes the loss visible
 * rather than silent.
 *
 * The check is deferred by one turn of the event loop because the teardown is
 * not synchronous with the `error` event that reports the failure -- measured:
 * the pipeline is still marked writable at the instant the listener runs.
 *
 * @param {Error} failure The failure that broke the sink.
 * @returns {void}
 */
function failClosedIfRenderPipelineIsDead(failure) {
  if (renderPipeline === null) {
    return;
  }

  setImmediate(() => {
    if (renderPipeline.destroyed === true || renderPipeline.writable === false) {
      failClosed(
        'ERR_LOG_SINK_UNREACHABLE',
        'The rendering pipeline died with the log sink, so records can no ' +
          'longer reach any sink; exiting rather than serving with no records',
        failure
      );
    }
  });
}

/**
 * Handles a failure of the log stream: report it, keep serving from a verified
 * fallback, and end the process only if there is no fallback to be had.
 *
 * WHY A FAILED SINK IS NOT SOMETHING TO NOTE AND CARRY ON WITH. `ENOSPC`, a
 * revoked descriptor or a reader that went away leaves this process answering
 * requests with no access records and no exception records -- an audit trail
 * that stops without anything saying so, which is worse than an outage because
 * nothing reports it. Retention alone is not enough for the same reason: it
 * reports the loss only once the process is already exiting, possibly hours
 * later, and says nothing to the operator in between.
 *
 * SO THE FAILURE IS ACTED ON IMMEDIATELY, IN THIS ORDER:
 *   1. One minimal JSON diagnostic straight to file descriptor 2 -- no logger,
 *      no transport, no event loop, because the thing that failed is the one
 *      that would otherwise carry the report.
 *   2. A switch to a fallback that has been VERIFIED by that write: standard
 *      error's STREAM under a supervisor, which collects it into the
 *      descriptor's `error_file`, and the descriptor directly otherwise. Under
 *      a supervisor a raw descriptor write is owned by the daemon and vanishes,
 *      which is why the two cases do not share one answer.
 *   3. Failing closed -- `failClosed()` above -- only when no fallback can be
 *      verified.
 *
 * THE RETAINED FAILURE IS DELIBERATELY NOT CLEARED BY A SUCCESSFUL RECOVERY,
 * and this is worth stating plainly so nobody "fixes" it: at least one record
 * WAS lost, so `drainSink` must still hand the failure to `src/server.js`,
 * which writes its `ERR_TERMINAL_FLUSH` note at exit. A recovered sink means
 * the service kept its audit trail from that point on, not that the gap never
 * happened.
 *
 * @param {unknown} error The failure, from the sink's `error` event, from a
 *   write callback, or synthesised by `writeToSink` when it detects a sink that
 *   has been silently neutralised.
 * @returns {void}
 */
function handleSinkFailure(error) {
  retainSinkFailure(error);

  const failure = error instanceof Error ? error : new Error(String(error));

  if (sinkDegraded) {
    // ALREADY ON THE FALLBACK, AND THE FALLBACK HAS NOW FAILED: THE PROCESS
    // ENDS, UNCONDITIONALLY. There is nothing left to switch to -- the switch
    // happens at most once by design -- and there is nothing left to consult
    // either. A wrapper's `writable`/`destroyed` flags are exactly what cannot
    // be trusted at this point: PM2's replacement for a standard stream reports
    // a failure of the file write it performs through the callback alone and
    // leaves those flags reading healthy, so a process that kept serving on
    // them would be discarding every record while its own state said the sink
    // was fine. That is the fail-open outcome this whole mechanism exists to
    // prevent, and the second failure is the last evidence anyone gets of it.
    failClosed(
      'ERR_LOG_FALLBACK_FAILURE',
      'The fallback log sink failed as well, so nothing is left to record ' +
        'what this worker serves; exiting so the supervisor can replace it',
      failure
    );

    return;
  }

  sinkDegraded = true;

  const diagnostic = buildSinkDiagnostic(
    'ERR_LOG_SINK_FAILURE',
    'The log sink failed and at least one record was lost; switching to ' +
      'standard error',
    failure
  );
  const reportedToDescriptor = writeToDescriptor(STDERR_FD, diagnostic);

  if (stdoutIsSupervised) {
    if (!verifyStreamFallback(process.stderr, diagnostic)) {
      failClosed(
        'ERR_LOG_SINK_UNAVAILABLE',
        'The log sink failed and the standard error stream could not be ' +
          'verified as a fallback; exiting so the supervisor can replace a ' +
          'worker that cannot record what it serves',
        failure
      );
      return;
    }

    sink = process.stderr;
    sinkIsSynchronous = false;

    // The fallback needs the same protection the original sink had: an `error`
    // event with no listener is thrown, and this handler is what turns it into
    // a report instead of a crash.
    sink.on('error', handleSinkFailure);
  } else if (reportedToDescriptor) {
    sink = synchronousStderrSink;
    sinkIsSynchronous = true;
  } else {
    // Standard error is as broken as standard output -- which is what happens
    // when both were the same pipe, and is exactly why the fallback is verified
    // by a real write rather than assumed.
    failClosed(
      'ERR_LOG_SINK_UNAVAILABLE',
      'Both standard output and standard error are unavailable; exiting so ' +
        'the supervisor can replace a worker that cannot record what it serves',
      failure
    );
    return;
  }

  // The abandoned sink's completion callbacks will never arrive, so the
  // accounting that was waiting for them is settled here. Anything already
  // waiting on a drain is answered now -- with the retained failure, because
  // that is what happened -- rather than waiting for a callback from a sink
  // nothing writes to any more.
  sinkGeneration += 1;
  pendingWrites = 0;
  releaseDrainWaiters();

  failClosedIfRenderPipelineIsDead(failure);
}

/*
 * THE SINK'S `error` EVENT, WHICH IS ONE OF THE TWO CHANNELS A FAILURE ARRIVES
 * ON -- the other being a write callback. Both go to the same handler, so a
 * full or revoked descriptor is acted on the same way whichever channel reports
 * it.
 *
 * Subscribing also keeps the event from being unhandled: an `error` event with
 * no listener is thrown, which would kill a process whose only real problem was
 * that it could not write a log line. Pino's own broken-pipe filter is
 * registered first on this same event -- it neutralises the sink on `EPIPE` and
 * re-emits anything else -- and both listeners run on the original emit, so
 * this handler sees an `EPIPE` once and any other failure TWICE, on the emit
 * and on the re-emit. That is one of the reasons the handler is idempotent.
 */
sink.on('error', handleSinkFailure);

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
 * IT ALSO DETECTS A SINK THAT HAS BEEN SILENTLY NEUTRALISED, which is the one
 * failure mode that reaches neither the `error` event nor a write callback.
 * When the reader of a pipe goes away, pino's broken-pipe filter replaces the
 * sonic-boom's `write` with a no-op -- returning `undefined` instead of a
 * backpressure boolean -- and every subsequent record disappears with nothing
 * reporting it. Measured on the pinned runtime: the write that triggers
 * `EPIPE` still returns `true`, and the next one returns `undefined`. So on the
 * synchronous branch a non-boolean result IS the failure report, and it is
 * routed to the same handler as the other two channels. The test is applied on
 * that branch only: a supervisor's `process.stdout.write` replacement
 * legitimately returns `undefined`, and treating that as a failure would
 * degrade a perfectly healthy production sink on its first record.
 *
 * @param {string} chunk The serialized record, newline included, exactly as
 *                       pino produced it.
 * @returns {boolean|undefined} What the sink reported about backpressure, and
 *                    the two branches differ. The synchronous branch always
 *                    answers with a boolean -- sonic-boom's own, or `false`
 *                    when the write was found to have gone nowhere. The
 *                    supervised branch returns whatever the stream returned,
 *                    which is `undefined` for PM2's `process.stdout.write`
 *                    replacement. Pino acts on neither; the value is passed
 *                    through rather than swallowed so this function is an
 *                    honest stand-in for the sink's own `write`.
 */
function writeToSink(chunk) {
  if (sinkIsSynchronous) {
    const generation = sinkGeneration;
    const accepted = sink.write(chunk);

    if (typeof accepted === 'boolean') {
      return accepted;
    }

    handleSinkFailure(new Error(
      'the log sink stopped reporting backpressure, which is how a ' +
        'broken-pipe filter neutralises a sink whose reader has gone away; ' +
        'records written to it are being discarded'
    ));

    // Re-issue the record through whatever the handler switched to, so the
    // record that exposed the failure is not the one record lost to it. Bounded
    // by construction: the switch happens at most once, so `sinkGeneration` can
    // differ at most once and this recurses at most one level deep.
    return sinkGeneration !== generation ? writeToSink(chunk) : false;
  }

  const generation = sinkGeneration;

  pendingWrites += 1;

  return sink.write(chunk, undefined, (error) => {
    // The callback reports EITHER completion or failure, and treating the two
    // alike is what turns a lost record into a silent success. A sink that
    // reports an error for every write and puts no bytes anywhere would
    // otherwise satisfy the drain below and let the process exit reporting a
    // clean flush.
    if (error) {
      handleSinkFailure(error);
    }

    // A callback from a sink that has since been abandoned must not touch the
    // accounting: `handleSinkFailure` settled that generation's writes when it
    // switched, and decrementing again would put the count below zero, where it
    // would never return to zero and every later drain would hang.
    if (generation !== sinkGeneration) {
      return;
    }

    pendingWrites -= 1;

    if (pendingWrites === 0) {
      releaseDrainWaiters();
    }
  });
}

/**
 * The drain `logger.flush(callback)` resolves to: reports when every record
 * written so far has reached the sink.
 *
 * On a synchronous sink -- the sonic-boom, or the descriptor-writing fallback --
 * there is by definition nothing outstanding, so the callback runs at once. On
 * a stream sink the callback is held until the last write in flight has
 * reported completion; PM2's `process.stdout.write` replacement forwards this
 * very callback to the write it performs for `out_file`, so what is being
 * awaited is that write's own completion report. Either way the answer is
 * derived from the sink's own behaviour rather than from a delay chosen by
 * guesswork.
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
 * THE FLUSH CALLBACK REPORTS FAILURE, AND ITS ARGUMENT IS PART OF THE CONTRACT
 * rather than an implementation detail: `drainSink` hands it the first failure
 * the sink reported, or nothing at all when every write completed.
 * `src/server.js` types its own `finish(flushFailure)` on exactly that and
 * writes an `ERR_TERMINAL_FLUSH` record to stderr when the argument is present,
 * so a callback typed as taking no arguments would make the process exit as
 * though the final records had been written. The argument survives a recovered
 * sink failure too -- a record was lost, and that is what the note says.
 *
 * @type {{
 *   write: (chunk: string) => boolean|undefined,
 *   flush: (callback?: (error?: Error) => void) => void
 * }}
 */
let target = { write: writeToSink, flush: drainSink };

/*
 * PINO-PRETTY IS BUILT ONLY ON THE NON-PRODUCTION BRANCH, AND THE `require`
 * MUST STAY INSIDE IT. pino-pretty is a devDependency and a production host
 * installs with `npm ci --omit=dev`, so the package is not on disk there; an
 * unconditional reference -- a top-level import, or a transport target named in
 * the options object -- is resolved while the logger is being constructed and
 * kills a production start-up before the listener binds, even though its value
 * would never be used.
 *
 * The in-process stream form is used rather than a worker-thread transport
 * because a worker transport is not drainable on the way out: measured on the
 * pinned runtime, `logger.flush(callback)` was never invoked at all behind
 * `transport: { target: 'pino-pretty' }`, which would silently remove the
 * barrier `src/server.js` builds its termination on. `destination` is handed
 * the sink INSTANCE for the same reason -- pino-pretty would otherwise build
 * its own, asynchronous by default.
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

  /*
   * Recorded as the pipeline pino writes through, because it holds the sink
   * INSTANCE: a fallback installed after a sink failure cannot be reached
   * through it, which is what `failClosedIfRenderPipelineIsDead` acts on.
   */
  renderPipeline = prettyStream;

  target = prettyStream;
}

/**
 * The process-wide root logger.
 *
 * WHAT EVERY RECORD FROM IT CARRIES: the three identity fields from `base` --
 * `pid`, `instance` and `service` -- alongside pino's own `level` (a number),
 * `time` and `msg`.
 *
 * WHAT IT WILL NOT WRITE: `req.headers.authorization` and `req.headers.cookie`,
 * redacted at the root so every child inherits the policy; any property of a
 * logged error outside `sanitizeError`'s allowlist -- type, message, stack, and
 * a code or status where the error carries one; and, inside the strings it does
 * write, credential material matching the patterns above `scrubSecrets`. Every
 * such string is length-bounded, message and stack included.
 *
 * WHERE THOSE RECORDS GO: one destination, every level, standard output for as
 * long as it works. Error-level records are deliberately NOT routed to a second
 * stream. In production the bytes are newline-delimited JSON, one complete
 * object per line; outside production the same records are rendered as
 * human-readable text by pino-pretty. If the destination fails, this module
 * reports the failure on file descriptor 2, continues from a verified fallback
 * where one exists, and exits non-zero where none does -- so a lost record is
 * always reported somewhere.
 *
 * WHAT `logger.flush(callback)` REPORTS, since `src/server.js` builds its whole
 * termination sequence on it: the callback runs once the sink has reported
 * every record written so far complete -- immediately for the synchronous
 * descriptor write, and on the stream's own completion callback for a
 * supervised stream. It is handed the first failure the sink reported, or
 * nothing at all if there was none, so "the records are out" and "records were
 * lost" are distinguishable. Neither case rests on timing.
 *
 * WHAT HAPPENS TO THE BYTES AFTERWARDS IS THE DEPLOYMENT'S BUSINESS, NOT THIS
 * MODULE'S CLAIM. Under the PM2 descriptor this service ships, standard output
 * is expected to be collected into `logs/out.log` and standard error into
 * `logs/error.log`, so `error.log` should stay empty in a clean run and a
 * service record appearing there means either the stream configuration changed
 * or the sink failed over. That is an assumption about the supervisor's
 * configuration; what this module establishes is only that the sink reported
 * the write complete.
 *
 * A future change that installs a destination without a drain -- an
 * asynchronous sonic-boom, or a worker-thread transport -- removes the
 * reporting above silently, so it has to bring a drain the process layer can
 * await with it.
 *
 * @type {import('pino').Logger}
 */
const logger = pino(options, target);

/*
 * The RAW instance -- not a facade and not `{ logger }` -- because two of its
 * members are load-bearing: `flush(callback)` is the middle step of
 * src/server.js's log -> flush -> release the PM2 IPC channel -> exit sequence,
 * and `child()` is what pino-http calls to derive `req.log`. A facade would
 * drop both, silently.
 */
module.exports = logger;

/*
 * THE STRING BOUND, SHARED RATHER THAN COPIED.
 *
 * WHY THIS IS EXPORTED AT ALL. `safeText` is the record's whole string policy
 * -- bound first, then scrub, with an explicit `... (truncated)` marker when
 * characters were dropped -- and this module is no longer its only consumer.
 * The access record assembled by src/middleware/request-context.js carries
 * fields whose length is the CALLER's choice: the allowlisted request-header
 * values, and the trust-aware `ip` and `protocol` that a proxy's
 * `X-Forwarded-*` headers supply once `TRUST_PROXY` is on. Those are strings
 * this module writes to the stream, so they answer to the same policy as an
 * error message and a stack. Handing over the function keeps that ONE policy:
 * a second implementation of "cut, then scrub, then mark" is how the two
 * copies drift until one of them stops bounding anything.
 *
 * WHY A NAMED PROPERTY ON THE INSTANCE AND NOT `{ logger, safeText }`. The
 * export above must stay the bare pino instance -- `src/server.js` calls
 * `.flush()` on it and pino-http calls `.child()` -- so a wrapper object would
 * break every existing consumer at load time to add one function. A property
 * hung on the instance adds the second export without disturbing the first,
 * which is exactly the shape `src/middleware/request-context.js` already uses
 * to publish `serializePath` beside its middleware.
 *
 * The `MAX_*` constants stay PRIVATE on purpose. Each one bounds a field of
 * this module's own records -- a message, a stack, a code, a type -- and a
 * consumer choosing its own limit for its own field is the correct arrangement:
 * what is shared is the mechanism, not a number that means something different
 * in each record.
 */
module.exports.safeText = safeText;
