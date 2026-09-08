// SPDX-License-Identifier: Apache-2.0
/**
 * Centralised environment configuration for `hello-world-service`.
 *
 * SINGLE RESPONSIBILITY. This module is the only module in the entire
 * codebase that reads `process.env`. It loads `server/.env`, applies a default
 * for every operator-settable variable, validates every value that was
 * actually supplied, aggregates all failures into one thrown error, and
 * exports one frozen configuration object. Every other module --
 * `src/server.js`, `src/app.js`, `src/lib/logger.js`,
 * `src/middleware/error-handler.js`, `src/routes/health.routes.js` -- obtains
 * environment-derived values by requiring this file and reading that object,
 * never by touching `process.env` itself.
 *
 * WHY THE BOUNDARY IS ABSOLUTE. A second reader anywhere would create two
 * places that can disagree about what the environment says: one that
 * validates and one that does not. A typo would then be honoured by one
 * module and rejected by another, and the process would run half-configured
 * instead of refusing to start. Keeping the boundary at exactly one module
 * makes an invalid environment a single, loud, start-up-time failure, and
 * makes the effective configuration of a running process knowable by reading
 * one file.
 *
 * WHY THIS FILE IMPORTS NOTHING INTERNAL. In the service's dependency graph
 * this module is a leaf: every edge points at it and it has none of its own
 * beyond the external `dotenv` package. That is deliberate and must stay so.
 * `src/lib/logger.js` depends on this file for `logLevel`, `isProduction`,
 * `instance` and `serviceName`, so requiring the logger back from here would
 * close a CommonJS cycle -- and a CommonJS cycle does not throw. It resolves
 * to a partially initialised module object, so the failure would surface later
 * as an unexplained `undefined` rather than as a crash at start-up. There is
 * consequently no logger available in this file, which is precisely why this
 * file does not log: a configuration failure happens *before* any logger
 * exists.
 *
 * WHY IT THROWS INSTEAD OF EXITING. `src/server.js` performs its
 * `require('./config')` inside a try/catch, as the first require of any
 * internal module, and renders whatever this module throws as one parseable
 * JSON object on stderr through its logger-free `fatal()` fallback. Calling
 * `process.exit()` here would rob it of that chance and reduce a legible
 * operator message to a bare stack trace. Validation therefore runs during
 * module evaluation -- not inside an exported `load()` that a caller might
 * forget to invoke -- and throws synchronously, which is what guarantees that
 * an invalid value aborts the process before the listener ever binds.
 *
 * @module config
 */

'use strict';

/*
 * Load `server/.env` into `process.env` before anything is read.
 *
 * WHY `{ quiet: true }`, AND WHY IT IS NOT COSMETIC. Left to its default,
 * dotenv 17 prints a tips banner to STDOUT on every start (measured at 89
 * bytes with this version). Stdout is the stream this service writes
 * newline-delimited JSON to in production, and every consumer of that stream
 * parses it one line at a time -- so a banner line is not cosmetic noise, it
 * is a corrupt record at the head of the log. `quiet` is the only option
 * passed: no `path`, no `debug`, and deliberately no `override`.
 *
 * WHY NO `override`. dotenv defaults to `override: false`, and that default
 * *is* this service's specified precedence. PM2 injects its descriptor's `env`
 * block into a worker's real environment before any application code runs, so
 * the real environment wins, then `.env`, then the defaults below. The
 * descriptor carries only `NODE_ENV` precisely so that the remaining seven
 * variables stay `.env`-owned; passing `override: true` would invert that
 * settled decision and let a stale `.env` silently defeat the deployment.
 *
 * WHICH FILE IS ACTUALLY LOADED. dotenv resolves `.env` relative to
 * `process.cwd()`, which is invisible from this path and worth stating. Every
 * supported invocation gives `server/` as the cwd -- the npm scripts run from
 * the package directory, and PM2 defaults an application's cwd to its
 * ecosystem file's directory -- so the file read is `server/.env`. That file
 * is an operator artefact copied from the committed `server/.env.example` on
 * the host, and it is git-ignored, so no real value is ever committed. A
 * missing `.env` is not an error: dotenv reports it on the object it returns
 * rather than throwing, and every variable below has a default, so the
 * service starts cleanly with no file at all.
 */
require('dotenv').config({ quiet: true });

/*
 * ---------------------------------------------------------------------------
 * Identity
 * ---------------------------------------------------------------------------
 */

/**
 * The service's canonical name.
 *
 * A constant, deliberately -- not an environment read, and not a runtime read
 * of `package.json`. The same string is declared independently in
 * `server/package.json` (`name`) and `server/ecosystem.config.js` (`name`),
 * and it reaches every log line, the `/metrics` output and the `GET /health`
 * response through *this* object rather than through a manifest read. All
 * three declarations must therefore carry the same value, or `pm2 status`, the
 * logs and the health response will disagree about what is running.
 *
 * @type {string}
 */
const SERVICE_NAME = 'hello-world-service';

/*
 * ---------------------------------------------------------------------------
 * Defaults
 * ---------------------------------------------------------------------------
 */

/**
 * The default for every operator-settable variable, plus the PM2-injected
 * instance ordinal.
 *
 * Nothing in this service is mandatory: a process started with no `.env` file
 * at all runs on exactly these values. They are literals *here* on purpose.
 * This module is the upstream source from which every other module resolves
 * its values, so there is nothing further upstream to resolve them from --
 * which is why no separate constants module exists and none should be added.
 * `server/.env.example` documents the same values as the committed operator
 * contract, and the two files must be changed together.
 *
 * @type {Readonly<{
 *   port: number,
 *   host: string,
 *   nodeEnv: string,
 *   logLevel: string,
 *   shutdownTimeoutMs: number,
 *   drainDelayMs: number,
 *   bodyLimit: string,
 *   trustProxy: boolean,
 *   instance: number
 * }>}
 */
const DEFAULTS = Object.freeze({
  port: 3000,
  host: '0.0.0.0',
  nodeEnv: 'development',
  logLevel: 'info',
  shutdownTimeoutMs: 10000,
  drainDelayMs: 2000,
  bodyLimit: '100kb',
  trustProxy: false,
  instance: 0
});

/*
 * ---------------------------------------------------------------------------
 * Bounds and grammars
 *
 * Each bound below carries the reason it holds the value it does. The reasons
 * are not derivable from the numbers, and every one of them describes a
 * failure that would otherwise be silent.
 * ---------------------------------------------------------------------------
 */

/**
 * Lowest and highest TCP port a listener may be asked to bind.
 *
 * Port 0 is excluded on purpose even though the operating system accepts it:
 * it means "allocate any free port", which would produce a service listening
 * somewhere nobody configured and no probe could find.
 *
 * @type {number}
 */
const PORT_MIN = 1;

/**
 * Highest valid TCP port number.
 *
 * @type {number}
 */
const PORT_MAX = 65535;

/**
 * Shortest acceptable total drain budget, in milliseconds.
 *
 * Below this there is no useful room for the two-phase drain: the
 * deregistration window plus `server.close()` would not both fit, so a
 * "graceful" shutdown would in practice always be a forced one.
 *
 * @type {number}
 */
const SHUTDOWN_TIMEOUT_MIN_MS = 3000;

/**
 * Longest acceptable total drain budget, in milliseconds.
 *
 * WHY IT IS CAPPED AT 10000. PM2's `kill_timeout` is fixed at 12000 in
 * `server/ecosystem.config.js`, and it is the point at which the supervisor
 * stops asking and sends `SIGKILL`. The application's own budget must stay
 * below it, leaving a 2000 ms margin, so that the *application* decides how a
 * drain ends -- logging its completion line, flushing the logger and
 * releasing the PM2 IPC channel -- rather than being killed mid-flush with
 * the outcome unrecorded. This validator is the enforcement half of that
 * relationship; the descriptor's `kill_timeout` is the other half, and the two
 * must be changed together. A comment describing the margin would not have
 * prevented an operator from setting 15000, which is why the bound is checked
 * rather than documented.
 *
 * @type {number}
 */
const SHUTDOWN_TIMEOUT_MAX_MS = 10000;

/**
 * Milliseconds of the drain budget reserved for phase two, and therefore the
 * amount by which the deregistration window must fall short of the whole
 * budget.
 *
 * WHY THE DRAIN DELAY'S CEILING IS DERIVED RATHER THAN FIXED. `src/server.js`
 * starts its force-exit timer at the moment the signal arrives, so
 * `SHUTDOWN_TIMEOUT_MS` is the *total* budget and the deregistration window is
 * consumed inside it, not added to it. If the window could equal the whole
 * budget, phase two -- `server.close()` plus `closeIdleConnections()`, then
 * the flush, the IPC disconnect and the exit -- would begin at the instant the
 * force-exit timer fired, so every shutdown would be a forced one no matter
 * how idle the process was. Reserving this margin guarantees at least a second
 * on the far side of the window, and deriving the ceiling from the effective
 * budget means the two values cannot be configured into contradiction.
 *
 * @type {number}
 */
const DRAIN_DELAY_HEADROOM_MS = 1000;

/**
 * Smallest acceptable deregistration window, in milliseconds.
 *
 * Zero is deliberately legal: an operator who wants shutdown to skip the
 * deregistration window entirely -- a single-process deployment with no
 * poller to notice a 503, for instance -- may ask for that, and it costs only
 * the readiness probe's observability, not correctness.
 *
 * @type {number}
 */
const DRAIN_DELAY_MIN_MS = 0;

/**
 * Hard ceiling on the resolved request body limit, in bytes (1 MB).
 *
 * WHY THE LIMIT IS PARSED HERE, BY A LOCAL GRAMMAR, AND CAPPED. Two reasons,
 * and each rules out an easier option. First, Express resolves its own
 * `limit` option with the `bytes` package -- but `bytes` is only a transitive
 * of Express, not a declared dependency of this service, so requiring it here
 * would make start-up validation sensitive to how npm happened to hoist the
 * tree. The grammar below is small enough to own. Second, delegating the check
 * entirely would accept any size Express accepts, and an unbounded "valid"
 * size defeats the only thing the limit exists for: bounding how much memory
 * one request can make this process allocate. A ceiling that is enforced is
 * the difference between a memory bound and a suggestion.
 *
 * @type {number}
 */
const BODY_LIMIT_MAX_BYTES = 1048576;

/**
 * The accepted grammar for a body limit: digits, optionally suffixed `kb` or
 * `mb`, matched case-insensitively and anchored at both ends so no prefix of a
 * longer string can pass.
 *
 * Note which suffixes are absent: `gb` and above are not in the alternation,
 * so `10gb` fails on the grammar before the ceiling is ever consulted.
 *
 * @type {RegExp}
 */
const BODY_LIMIT_PATTERN = /^(\d+)(kb|mb)?$/i;

/**
 * Byte multiplier for each accepted body-limit suffix, keyed by the lower-cased
 * suffix. The empty key is the bare-digits case, which is already a byte count.
 *
 * Binary multiples (1024) rather than decimal (1000), matching what Express's
 * own parser does, so a value means the same thing to the validator here and
 * to the parser that finally enforces it.
 *
 * @type {Readonly<Object<string, number>>}
 */
const BODY_LIMIT_UNIT_BYTES = Object.freeze({
  '': 1,
  kb: 1024,
  mb: 1024 * 1024
});

/**
 * The one `NODE_ENV` value that selects production behaviour.
 *
 * Named once and used twice -- as a member of the accepted set below, and as
 * the comparison that derives `isProduction`. Two independent `'production'`
 * literals in one file is exactly the kind of near-duplicate that survives a
 * rename of one of them.
 *
 * @type {string}
 */
const NODE_ENV_PRODUCTION = 'production';

/**
 * The accepted values for `NODE_ENV`.
 *
 * Compared case-sensitively and exactly. The Node ecosystem tests this value
 * with `=== 'production'` all over, so silently normalising `Production` would
 * make this service disagree with its own dependencies about which mode it is
 * in. Rejecting the value instead turns that into a start-up failure an
 * operator can see and fix.
 *
 * @type {ReadonlyArray<string>}
 */
const NODE_ENV_VALUES = Object.freeze([
  'development',
  'test',
  NODE_ENV_PRODUCTION
]);

/**
 * The accepted values for `LOG_LEVEL`.
 *
 * WHY ONLY THESE THREE, WHEN PINO SUPPORTS MORE. The service guarantees
 * exactly one `info`-level access record for every successful request, and
 * that guarantee is what makes the log stream a complete account of traffic.
 * A threshold of `warn` or above would filter those records out, so the
 * guarantee would quietly become false while the configuration still looked
 * reasonable -- successful requests would simply stop appearing, and nothing
 * would report an error. `warn`, `error`, `fatal` and `silent` are therefore
 * rejected at start-up rather than accepted and later regretted. Narrowing
 * the range is the point: the levels that remain are the ones that cannot
 * break the contract.
 *
 * @type {ReadonlyArray<string>}
 */
const LOG_LEVEL_VALUES = Object.freeze(['trace', 'debug', 'info']);

/**
 * The accepted values for `TRUST_PROXY`, matched case-insensitively against
 * the lower-cased input.
 *
 * @type {Readonly<Object<string, boolean>>}
 */
const BOOLEAN_VALUES = Object.freeze({ true: true, false: false });

/**
 * A whole, optionally negative integer and nothing else.
 *
 * The sign is admitted so that a negative value reaches its range check and
 * earns an accurate message -- `-1` genuinely is an integer, and reporting it
 * as "not a whole number" would send an operator looking for the wrong
 * mistake. Anchored at both ends, which is what rejects `3000abc`.
 *
 * @type {RegExp}
 */
const INTEGER_PATTERN = /^-?\d+$/;

/**
 * Longest rendering of a supplied value that a failure message will quote.
 *
 * @type {number}
 */
const MAX_REPORTED_VALUE_LENGTH = 64;

/*
 * ---------------------------------------------------------------------------
 * Readers and validators
 *
 * Every reader below shares one contract, and it is the contract that makes
 * aggregation possible: a reader NEVER throws. It returns the validated value,
 * or `undefined` when the variable is absent, or `undefined` after pushing its
 * own failure message onto the caller's accumulator. Throwing from inside a
 * reader would abandon every check that had not run yet, and an operator with
 * three bad values would be shown one of them -- which is exactly the
 * behaviour aggregation exists to prevent.
 * ---------------------------------------------------------------------------
 */

/**
 * Renders a supplied value for quoting inside a failure message.
 *
 * Two properties matter, and both are about the message staying usable rather
 * than about presentation. First, the aggregated message must remain a SINGLE
 * line: `src/server.js` writes it into one JSON object on stderr, and an
 * embedded newline would split a record that an operator -- or a log parser --
 * reads as one unit, so interior whitespace is collapsed. Second, an
 * accidentally enormous value (a pasted certificate, a whole file) must not
 * flood stderr and bury the other failures, so the rendering is truncated.
 *
 * @param {string} raw The value as supplied, already trimmed by readRaw().
 * @returns {string} A single-line, length-bounded rendering of `raw`.
 */
function describeValue(raw) {
  const collapsed = String(raw).replace(/\s+/g, ' ');

  return collapsed.length > MAX_REPORTED_VALUE_LENGTH
    ? `${collapsed.slice(0, MAX_REPORTED_VALUE_LENGTH)}...`
    : collapsed;
}

/**
 * Reads one environment variable, trimmed, treating "supplied but empty" as
 * absent.
 *
 * This is the single point at which this codebase touches `process.env`; every
 * reader below goes through it, and no other module has any business calling
 * anything like it.
 *
 * WHY EMPTY MEANS ABSENT. An operator who leaves `PORT=` in a `.env` file
 * means "I did not set this", and aborting start-up over an empty assignment
 * would be a hostile reading of it -- commenting a line out and blanking its
 * value are the same intent expressed two ways. A value that is empty or
 * whitespace-only after trimming is therefore treated exactly as if the
 * variable had never been set, and the documented default applies: `PORT=`
 * yields 3000, it does not yield a validation failure. This is a deliberate
 * decision about how to read an ambiguous input, not a side effect of the
 * parsing.
 *
 * Every value is trimmed before validation, so stray whitespace around an
 * otherwise valid value in a `.env` line can never turn it into a failure.
 *
 * @param {string} name The environment variable name, e.g. `'PORT'`.
 * @returns {string|undefined} The trimmed value, or `undefined` when the
 *                             variable is unset, empty or whitespace-only.
 */
function readRaw(name) {
  const raw = process.env[name];

  if (typeof raw !== 'string') {
    return undefined;
  }

  const trimmed = raw.trim();

  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Reads a variable as an integer, rejecting anything that is not an integer in
 * its entirety.
 *
 * WHY NOT `parseInt`. `parseInt('3000abc')` returns 3000: it parses a leading
 * prefix and discards the rest, so a typo would be accepted silently and the
 * operator would never learn that their value had been misread. The whole
 * trimmed string must match the integer grammar, and the result must be
 * exactly representable as a JavaScript integer, or the value is a failure.
 *
 * @param {string} name The environment variable name.
 * @param {string[]} failures Accumulator that a failure message is pushed onto.
 * @returns {number|undefined} The parsed integer; `undefined` when the
 *                             variable is absent, or when a failure was
 *                             recorded.
 */
function readInteger(name, failures) {
  const raw = readRaw(name);

  if (raw === undefined) {
    return undefined;
  }

  if (!INTEGER_PATTERN.test(raw)) {
    failures.push(
      `${name} must be a whole number (received "${describeValue(raw)}")`
    );

    return undefined;
  }

  const value = Number(raw);

  // A digit string can be syntactically perfect and still exceed the range in
  // which JavaScript integers are exact, at which point every comparison below
  // would be made against an approximation of what the operator wrote.
  if (!Number.isSafeInteger(value)) {
    failures.push(
      `${name} must be a whole number small enough to be represented exactly ` +
        `(received "${describeValue(raw)}")`
    );

    return undefined;
  }

  return value;
}

/**
 * Reads a variable as an integer confined to an inclusive range.
 *
 * Both bounds are inclusive, and the message quotes them, so a rejected value
 * tells the operator what would have been accepted instead of only that their
 * value was wrong.
 *
 * @param {string} name The environment variable name.
 * @param {number} min Lowest accepted value, inclusive.
 * @param {number} max Highest accepted value, inclusive.
 * @param {string[]} failures Accumulator that a failure message is pushed onto.
 * @returns {number|undefined} The validated integer; `undefined` when the
 *                             variable is absent, or when a failure was
 *                             recorded.
 */
function readBoundedInteger(name, min, max, failures) {
  const value = readInteger(name, failures);

  // `undefined` here means either "absent" or "already reported by
  // readInteger". Neither case may produce a second message for the same
  // variable, so the range check is simply skipped.
  if (value === undefined) {
    return undefined;
  }

  if (value < min || value > max) {
    failures.push(
      `${name} must be an integer between ${min} and ${max} inclusive ` +
        `(received ${value})`
    );

    return undefined;
  }

  return value;
}

/**
 * Reads a variable as a non-negative integer, with no upper bound beyond
 * exact representability.
 *
 * Used for the cluster instance ordinal, which has no meaningful maximum -- a
 * host may run as many workers as it has capacity for -- but for which a
 * negative value is nonsense.
 *
 * @param {string} name The environment variable name.
 * @param {string[]} failures Accumulator that a failure message is pushed onto.
 * @returns {number|undefined} The validated integer; `undefined` when the
 *                             variable is absent, or when a failure was
 *                             recorded.
 */
function readNonNegativeInteger(name, failures) {
  const value = readInteger(name, failures);

  if (value === undefined) {
    return undefined;
  }

  if (value < 0) {
    failures.push(
      `${name} must be a non-negative integer (received ${value})`
    );

    return undefined;
  }

  return value;
}

/**
 * Reads a variable that must be one of a fixed set of exact strings.
 *
 * The comparison is case-sensitive by design; see the note on
 * NODE_ENV_VALUES for why normalising would be worse than rejecting.
 *
 * @param {string} name The environment variable name.
 * @param {ReadonlyArray<string>} allowed The permitted values, quoted verbatim
 *                                        in the failure message.
 * @param {string[]} failures Accumulator that a failure message is pushed onto.
 * @returns {string|undefined} The validated value; `undefined` when the
 *                             variable is absent, or when a failure was
 *                             recorded.
 */
function readEnum(name, allowed, failures) {
  const raw = readRaw(name);

  if (raw === undefined) {
    return undefined;
  }

  if (!allowed.includes(raw)) {
    failures.push(
      `${name} must be one of ${allowed.join(', ')} ` +
        `(received "${describeValue(raw)}")`
    );

    return undefined;
  }

  return raw;
}

/**
 * Reads a variable as a strict boolean, accepting only the exact words `true`
 * and `false` (case-insensitively) and returning a real boolean.
 *
 * WHY THE COERCION IS STRICT RATHER THAN CONVENIENT. `1`, `0`, `yes`, `no`,
 * `on` and `off` are all rejected, and the returned value is a genuine
 * boolean rather than the string that was read. Both halves guard the same
 * failure. `src/app.js` calls `app.set('trust proxy', config.trustProxy)`, and
 * every non-empty string -- including `'false'` -- is truthy in JavaScript, so
 * a lenient reader that passed the raw text through would silently *enable*
 * proxy trust for an operator who had explicitly written `false`. A typo such
 * as `TRUST_PROXY=flase` gets the same treatment: rejected loudly at start-up,
 * rather than guessed at and quietly resolved to the dangerous side.
 *
 * @param {string} name The environment variable name.
 * @param {string[]} failures Accumulator that a failure message is pushed onto.
 * @returns {boolean|undefined} The parsed boolean; `undefined` when the
 *                              variable is absent, or when a failure was
 *                              recorded.
 */
function readBoolean(name, failures) {
  const raw = readRaw(name);

  if (raw === undefined) {
    return undefined;
  }

  const normalised = raw.toLowerCase();

  if (Object.prototype.hasOwnProperty.call(BOOLEAN_VALUES, normalised)) {
    return BOOLEAN_VALUES[normalised];
  }

  failures.push(
    `${name} must be exactly "true" or "false" ` +
      `(received "${describeValue(raw)}")`
  );

  return undefined;
}

/**
 * Reads a variable that must be a non-empty string.
 *
 * The emptiness check looks redundant against readRaw(), which already maps an
 * empty or whitespace-only value to `undefined`, and today it can never fire.
 * It is kept as an explicit guard rather than removed because it states the
 * invariant the consumer depends on -- `config.host` is never the empty
 * string, and a listener is never asked to bind nothing. If readRaw's
 * empty-means-absent rule is ever revisited, this check is what stops that
 * change from reaching the socket.
 *
 * @param {string} name The environment variable name.
 * @param {string[]} failures Accumulator that a failure message is pushed onto.
 * @returns {string|undefined} The validated string; `undefined` when the
 *                             variable is absent, or when a failure was
 *                             recorded.
 */
function readNonEmptyString(name, failures) {
  const raw = readRaw(name);

  if (raw === undefined) {
    return undefined;
  }

  if (raw.length === 0) {
    failures.push(`${name} must be a non-empty string`);

    return undefined;
  }

  return raw;
}

/**
 * Resolves a body-limit string to a byte count.
 *
 * The byte count exists solely so the ceiling can be enforced; it is a local
 * quantity for the check and is never what gets exported. See readBodyLimit().
 *
 * @param {string} raw The trimmed candidate value, e.g. `'100kb'`.
 * @returns {number|null} The resolved byte count, or `null` when `raw` does
 *                        not match the accepted grammar.
 */
function resolveBodyLimitBytes(raw) {
  const match = BODY_LIMIT_PATTERN.exec(raw);

  if (match === null) {
    return null;
  }

  const magnitude = Number(match[1]);
  const suffix = match[2] === undefined ? '' : match[2].toLowerCase();

  return magnitude * BODY_LIMIT_UNIT_BYTES[suffix];
}

/**
 * Reads the request body limit: validated against the local grammar and the
 * 1 MB ceiling, then returned AS THE SUPPLIED STRING.
 *
 * The return type is load-bearing and easy to get wrong. `src/app.js` passes
 * this value straight through to `express.json({ limit })` and
 * `express.urlencoded({ extended: false, limit })`, both of which accept the
 * suffixed string form and resolve it themselves. Exporting the byte count
 * computed here would still work numerically, but it would discard the units
 * the operator wrote and make the value in `/health`-adjacent diagnostics and
 * in the log stream harder to relate back to `.env`. The string is what is
 * exported; the byte count never leaves this function.
 *
 * Three distinct rejections, in the order they are checked:
 *   1. the grammar -- `10gb` and `abc` fail here, before any arithmetic;
 *   2. zero -- see below;
 *   3. the ceiling -- `2mb` is well-formed and still refused, while `1mb`
 *      resolves to exactly the ceiling and is accepted.
 *
 * WHY ZERO IS REFUSED. This is a local decision rather than a requirement
 * handed down: a limit of zero bytes would reject every request that carried
 * a body at all, turning a memory bound into a blanket kill switch for the
 * service's only write endpoint. No operator wants that outcome from a field
 * named "limit", so `0` and `0kb` are treated as configuration mistakes. An
 * operator who genuinely wants to refuse bodies has route-level and
 * proxy-level ways to say so that do not disguise themselves as a size.
 *
 * @param {string} name The environment variable name.
 * @param {string[]} failures Accumulator that a failure message is pushed onto.
 * @returns {string|undefined} The validated limit as a string; `undefined`
 *                             when the variable is absent, or when a failure
 *                             was recorded.
 */
function readBodyLimit(name, failures) {
  const raw = readRaw(name);

  if (raw === undefined) {
    return undefined;
  }

  const bytes = resolveBodyLimitBytes(raw);

  if (bytes === null) {
    failures.push(
      `${name} must be a byte count optionally suffixed with kb or mb, ` +
        `matching ^\\d+(kb|mb)?$ case-insensitively ` +
        `(received "${describeValue(raw)}")`
    );

    return undefined;
  }

  if (bytes === 0) {
    failures.push(
      `${name} must resolve to at least one byte ` +
        `(received "${describeValue(raw)}")`
    );

    return undefined;
  }

  if (bytes > BODY_LIMIT_MAX_BYTES) {
    failures.push(
      `${name} must resolve to at most ${BODY_LIMIT_MAX_BYTES} bytes (1 MB), ` +
        `but "${describeValue(raw)}" resolves to ${bytes} bytes`
    );

    return undefined;
  }

  return raw;
}


/*
 * ---------------------------------------------------------------------------
 * The exported shape
 * ---------------------------------------------------------------------------
 */

/**
 * The service's resolved configuration: eleven primitive fields, frozen.
 *
 * This is the contract every consumer codes against, so the field names and
 * types below are the authoritative record of it -- `src/server.js`,
 * `src/app.js`, `src/lib/logger.js`, `src/middleware/error-handler.js` and
 * `src/routes/health.routes.js` all read this object and nothing else.
 *
 * Two of the types are worth calling out because getting them wrong breaks a
 * consumer silently rather than loudly:
 *
 *   * `bodyLimit` is a STRING such as `'100kb'`, not a byte count. It is
 *     handed verbatim to Express's body parsers, which resolve the suffix
 *     themselves.
 *   * `trustProxy` is a REAL BOOLEAN, never the string `'false'`, which would
 *     be truthy and would enable exactly the proxy trust the default exists
 *     to withhold.
 *
 * @typedef {object} ServiceConfig
 * @property {number} port TCP port the HTTP listener binds. From `PORT`;
 *           default 3000; an integer in 1-65535.
 * @property {string} host Address the listener binds to. From `HOST`; default
 *           `'0.0.0.0'`; guaranteed non-empty.
 * @property {string} nodeEnv Environment name. From `NODE_ENV`; default
 *           `'development'`; one of `development`, `test`, `production`.
 * @property {boolean} isProduction Whether `nodeEnv` is `'production'`.
 *           Derived here, deliberately: `src/lib/logger.js` branches on it to
 *           attach the `pino-pretty` transport only outside production, and
 *           `src/middleware/error-handler.js` branches on it to mask 5xx
 *           messages. Deriving it once means those two cannot drift apart by
 *           each re-comparing environment strings in slightly different ways.
 * @property {string} logLevel Level of the pino root logger. From `LOG_LEVEL`;
 *           default `'info'`; one of `trace`, `debug`, `info` only.
 * @property {number} shutdownTimeoutMs Total drain budget in milliseconds,
 *           measured from receipt of the signal. From `SHUTDOWN_TIMEOUT_MS`;
 *           default 10000; 3000-10000 inclusive.
 * @property {number} drainDelayMs Deregistration window in milliseconds,
 *           consumed inside the drain budget. From `DRAIN_DELAY_MS`; default
 *           2000; 0 to `shutdownTimeoutMs - 1000`.
 * @property {string} bodyLimit Maximum request body size, as a string for
 *           Express's parsers. From `BODY_LIMIT`; default `'100kb'`; resolves
 *           to at most 1048576 bytes and at least one byte.
 * @property {boolean} trustProxy Whether Express trusts `X-Forwarded-*`
 *           headers. From `TRUST_PROXY`; default `false`.
 * @property {number} instance Cluster worker ordinal. From
 *           `NODE_APP_INSTANCE`, which PM2 injects; default 0; non-negative.
 * @property {string} serviceName The service's canonical name, a constant.
 */

/*
 * ---------------------------------------------------------------------------
 * Aggregation
 * ---------------------------------------------------------------------------
 */

/**
 * Reads, validates and assembles the whole configuration, reporting every
 * problem it finds in one error.
 *
 * Invoked once, during module evaluation, immediately below -- not exported
 * and not deferred. Two behaviours define it:
 *
 *   * NOTHING IS MANDATORY. Every variable has a default, so a process with no
 *     `.env` file and an empty environment is fully configured and starts
 *     cleanly.
 *   * ANYTHING SUPPLIED MUST BE VALID, AND ALL FAILURES ARE REPORTED TOGETHER.
 *     Each reader records its own problem and returns `undefined` instead of
 *     throwing, so validation always runs to completion. An operator who has
 *     mistyped three variables is told about three, not asked to fix one and
 *     restart to discover the next.
 *
 * `??` is used throughout rather than `||`, and the distinction is not
 * stylistic: `drainDelayMs` may legitimately be 0 and `trustProxy` may
 * legitimately be `false`, and `||` would discard both in favour of the
 * default. Only genuine absence -- or a recorded failure, which is moot
 * because the error is about to be thrown -- falls back.
 *
 * @returns {ServiceConfig} The fully resolved configuration, not yet frozen.
 * @throws {Error} If any supplied value is invalid. The message is a single
 *                 line naming every failing variable and why; a frozen
 *                 `failures` array of the individual messages is attached for
 *                 a caller that wants them separately.
 */
function loadConfiguration() {
  /** @type {string[]} */
  const failures = [];

  const port = readBoundedInteger('PORT', PORT_MIN, PORT_MAX, failures) ??
    DEFAULTS.port;
  const host = readNonEmptyString('HOST', failures) ?? DEFAULTS.host;
  const nodeEnv = readEnum('NODE_ENV', NODE_ENV_VALUES, failures) ??
    DEFAULTS.nodeEnv;
  const logLevel = readEnum('LOG_LEVEL', LOG_LEVEL_VALUES, failures) ??
    DEFAULTS.logLevel;

  // ORDER MATTERS HERE, in one direction only: the drain delay's ceiling is
  // derived from the *effective* shutdown budget, so the budget has to be
  // resolved first.
  const shutdownTimeoutMs = readBoundedInteger(
    'SHUTDOWN_TIMEOUT_MS',
    SHUTDOWN_TIMEOUT_MIN_MS,
    SHUTDOWN_TIMEOUT_MAX_MS,
    failures
  ) ?? DEFAULTS.shutdownTimeoutMs;

  // WHY THE FALLBACK ABOVE IS LOAD-BEARING RATHER THAN INCIDENTAL. When
  // SHUTDOWN_TIMEOUT_MS is itself invalid, `shutdownTimeoutMs` becomes the
  // default purely so that a ceiling still exists and DRAIN_DELAY_MS can still
  // be checked -- which is what lands BOTH failures in the one aggregated
  // error. Skipping the second check whenever the first failed would show an
  // operator with two bad values only one of them. The substituted value never
  // escapes: a non-empty `failures` array means this function throws rather
  // than returns.
  //
  // The derived ceiling cannot contradict the defaults, and that is checkable
  // rather than hopeful: the smallest budget the validator admits is 3000, so
  // the smallest possible ceiling is 2000, which is exactly the default drain
  // delay. A default configuration is therefore always internally consistent,
  // whatever the operator does to the budget alone.
  const drainDelayCeilingMs = shutdownTimeoutMs - DRAIN_DELAY_HEADROOM_MS;
  const drainDelayMs = readBoundedInteger(
    'DRAIN_DELAY_MS',
    DRAIN_DELAY_MIN_MS,
    drainDelayCeilingMs,
    failures
  ) ?? DEFAULTS.drainDelayMs;

  const bodyLimit = readBodyLimit('BODY_LIMIT', failures) ??
    DEFAULTS.bodyLimit;

  // WHY TRUST_PROXY DEFAULTS TO `false`. With no known network topology,
  // trusting forwarded headers means any client that can reach this process
  // directly may forge `X-Forwarded-For` and `X-Forwarded-Proto` -- and
  // Express would then report the forged address and scheme as the real ones,
  // which is what the access log records and what any future rate limit or
  // audit trail would attribute the request to. Spoofing the client identity
  // in the log would become a matter of setting a header. The safe value is
  // therefore the default, and enabling trust is a deliberate host step: an
  // operator sets `TRUST_PROXY=true` only when a reverse proxy is genuinely in
  // front of the service, is the sole path to it, and OVERWRITES rather than
  // appends client-supplied `X-Forwarded-*` headers.
  const trustProxy = readBoolean('TRUST_PROXY', failures) ??
    DEFAULTS.trustProxy;

  // WHY NODE_APP_INSTANCE IS READ HERE BUT IS ABSENT FROM `.env.example`. PM2
  // injects it into each cluster worker, so it is not an operator-settable
  // variable and templating it would invite someone to set it by hand and
  // desynchronise the workers' identities. It is documented here instead --
  // this comment is its contract. It is still validated, because the rule that
  // anything supplied must be valid applies uniformly, and a malformed value
  // means something is wrong with how the process was launched.
  //
  // WHY IT DEFAULTS TO 0 RATHER THAN BEING OMITTED. A directly launched
  // process reports `instance: 0` rather than dropping the field, so the
  // `GET /health` response, the `/metrics` output and every log line have the
  // SAME SHAPE whether or not PM2 launched the process. A consumer parsing
  // those never has to handle an absent field, and a query written against
  // production logs works unchanged against a developer's local run.
  const instance = readNonNegativeInteger('NODE_APP_INSTANCE', failures) ??
    DEFAULTS.instance;

  if (failures.length > 0) {
    // One error, one line. `src/server.js` catches this and writes it as a
    // single JSON object on stderr through its logger-free fallback -- there is
    // no logger yet at this point in start-up -- so the message has to be
    // self-sufficient, has to name every offending variable, and must not
    // contain newlines that would split the record. Every individual message
    // is also attached as an array for a caller that wants them structured,
    // but the message alone is enough to act on.
    const error = new Error(
      `Invalid environment configuration: ${failures.join('; ')}. ` +
        'Every variable is optional and falls back to a documented default, ' +
        'so remove the offending assignment or correct it; ' +
        'server/.env.example is the contract.'
    );

    error.failures = Object.freeze(failures.slice());

    throw error;
  }

  return {
    port,
    host,
    nodeEnv,
    isProduction: nodeEnv === NODE_ENV_PRODUCTION,
    logLevel,
    shutdownTimeoutMs,
    drainDelayMs,
    bodyLimit,
    trustProxy,
    instance,
    serviceName: SERVICE_NAME
  };
}

/*
 * ---------------------------------------------------------------------------
 * Export
 * ---------------------------------------------------------------------------
 */

/*
 * The frozen configuration object is the module's entire public surface, and
 * it is assigned directly: a consumer writes
 * `const config = require('../config')` and then `config.port`, with no
 * nesting and no accessor to call.
 *
 * `Object.freeze` is shallow, and that is fully sufficient here rather than a
 * compromise -- all eleven values are primitives, with no nested object or
 * array for a consumer to reach into and mutate. Deep-freeze machinery would
 * be dead code guarding against a shape this module does not have.
 *
 * Freezing matters because configuration flows one way only: it is read once
 * at start-up, validated, and thereafter treated as a fact about the process.
 * A module that could assign to `config.isProduction` at request time could
 * make the logger and the error handler disagree about which environment they
 * are in, and nothing would report it. In strict mode -- which this file
 * enables -- such an assignment throws instead.
 *
 * @type {Readonly<ServiceConfig>}
 */
module.exports = Object.freeze(loadConfiguration());

