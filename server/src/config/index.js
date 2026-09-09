// SPDX-License-Identifier: Apache-2.0
/**
 * Centralised environment configuration for `hello-world-service`.
 *
 * SINGLE RESPONSIBILITY. This module is the only module in the entire
 * codebase that reads `process.env`. It loads `server/.env` with dotenv's
 * specified quiet call, applies a default for every operator-settable
 * variable, validates every value that was actually supplied, aggregates all
 * failures into one thrown error, and exports one frozen configuration
 * object. Every other module -- `src/server.js`, `src/app.js`,
 * `src/lib/logger.js`, `src/middleware/error-handler.js`,
 * `src/routes/health.routes.js` -- obtains environment-derived values by
 * requiring this file and reading that object, never by touching
 * `process.env` itself.
 *
 * THE CONTRACT IT ENFORCES IS THE SPECIFIED ONE, NOT ONE OF THIS MODULE'S
 * MAKING. Nothing is mandatory: a variable that is absent takes the
 * documented default recorded in `server/.env.example`. Anything supplied
 * must be valid -- including a variable supplied empty, which is present in
 * the environment holding a value no validator accepts and is therefore
 * reported rather than defaulted. Every failure is reported together rather
 * than one per restart. The specified rule for `HOST`, `non-empty string`,
 * lives in readRaw(), the single place a blank can be detected: what it
 * returns is a trimmed non-empty string, so the exported value is either that
 * or the documented default, never the empty string a listener could not
 * bind.
 *
 * THE NAMES IT CONSULTS ARE EXACTLY THE EIGHT OPERATOR VARIABLES PLUS
 * `NODE_APP_INSTANCE`. It reads no other environment name, writes none, and
 * alters none of dotenv's own behaviour: the load is that package's documented
 * one, called with the single specified option. So the service's configuration
 * contract is `server/.env.example` and nothing else -- there is no second,
 * private contract invented in this file for an operator to discover the hard
 * way.
 *
 * NO SUPPLIED VALUE IS EVER RENDERED INTO A DIAGNOSTIC. A rejection names the
 * variable, states the grammar or range that would have been accepted, and
 * adds only non-content metadata; the value itself is never copied into the
 * thrown message or into the `failures` array. `src/server.js` writes both to
 * stderr, and under PM2 that stream is a retained log file -- so echoing a
 * value would persist whatever a mistaken deployment substitution had put in
 * the environment, a bearer token or credential-bearing URL included, in a
 * file that outlives the failed start-up (CWE-532). An operator compares the
 * named variable against `server/.env` instead, which needs no echo.
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
 * beyond the external `dotenv` package and one Node built-in, `node:path`,
 * used only to name the file it loads in a diagnostic. That is deliberate and
 * must stay so.
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

const path = require('node:path');

const dotenv = require('dotenv');

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
 * and it reaches its two consumers through *this* object rather than through
 * a manifest read: the logger's base fields and the `GET /health` response.
 * All three declarations must therefore carry the same value, or `pm2 status`,
 * the logs and the health response will disagree about what is running.
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
 * Lowest TCP port a listener may be asked to bind.
 *
 * Port 0 is excluded on purpose even though the operating system accepts it:
 * it means "allocate any free port", which would produce a service listening
 * somewhere nobody configured and no probe could find.
 *
 * @type {number}
 */
const PORT_MIN = 1;

const PORT_MAX = 65535;

/**
 * Shortest total drain budget the configuration contract admits, in
 * milliseconds.
 *
 * This is the specified operational floor rather than a technical limit: a
 * drain can and often does finish well inside it -- a zero deregistration
 * window is legal, and `server.close()` on an idle process returns almost at
 * once. What the floor buys is headroom, so that a budget still leaves room
 * for the deregistration window plus phase two instead of being tuned to a
 * value where a shutdown would be forced as a matter of routine.
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
 * The accepted values for `TRUST_PROXY`, matched exactly against the trimmed
 * input.
 *
 * The keys are the two spellings the configuration contract admits, and they
 * are the only two: matching is case-sensitive for the same reason
 * NODE_ENV_VALUES is, and the failure message says "exactly", which a
 * case-folding lookup would have made untrue.
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

const MAX_DIAGNOSTIC_LENGTH = 64;

/*
 * ---------------------------------------------------------------------------
 * Environment file loading
 *
 * One call, exactly as specified: `dotenv.config({ quiet: true })`. This
 * module consults no environment name other than the eight operator variables
 * and `NODE_APP_INSTANCE`, and it changes none -- dotenv's own behaviour is
 * left at its documented defaults so that the load has one contract and it is
 * the published one. Only the outcome is inspected, because dotenv reports a
 * failed read on its return value rather than by throwing; see loadEnvFile().
 * ---------------------------------------------------------------------------
 */

/**
 * Name of the environment file this service reads, resolved against the
 * process's working directory.
 *
 * WHICH FILE IS ACTUALLY LOADED, since the path is invisible from here. dotenv
 * resolves `.env` relative to `process.cwd()`, and every supported invocation
 * gives `server/` as the cwd -- the npm scripts run from the package
 * directory, and PM2 defaults an application's cwd to its ecosystem file's
 * directory -- so the file read is `server/.env`. That file is an operator
 * artefact copied from the committed `server/.env.example` on the host. The
 * root `.gitignore` ignores it, which keeps it out of an ordinary `git add`
 * and off an accidental commit; it is not a guarantee -- `git add -f`, a
 * renamed copy or a path the rule does not cover would still stage real
 * values -- so the operating rule is that `server/.env` is never staged and
 * never committed.
 *
 * @type {string}
 */
const ENV_FILE_NAME = '.env';

/**
 * The `error.code` from a failed `.env` read that is NOT a failure: the file
 * simply is not there.
 *
 * Every variable in this module has a default, so a process with no `.env` at
 * all is fully configured. This is the one read outcome that is tolerated --
 * every other code means a file exists but could not be turned into
 * configuration, which is an operator error and must stop start-up.
 *
 * @type {string}
 */
const ENV_FILE_ABSENT_CODE = 'ENOENT';

/**
 * Loads `server/.env` into `process.env`, and records a failure for every load
 * problem that is not simply "no file".
 *
 * Called once, as the FIRST step of loadConfiguration(), because every reader
 * below observes `process.env` after this has run. It follows the same
 * never-throw contract as the readers: problems are pushed onto the
 * accumulator so they arrive in the one aggregated error alongside any invalid
 * value. That holds for a load that throws as well as for one that reports on
 * its return value -- the call is guarded, and both outcomes become failure
 * messages rather than exceptions.
 *
 * WHY `{ quiet: true }`, WHICH IS NOT COSMETIC. dotenv 17.4.2 otherwise
 * prints a tips banner with `console.log`, i.e. to STDOUT -- and stdout is the
 * stream this service writes newline-delimited JSON to in production, where
 * every consumer parses it one line at a time. A banner line there is not
 * noise, it is a corrupt record at the head of the log. `quiet` is the only
 * option passed: no `path`, no `override`, no `debug`.
 *
 * WHAT IT DELIBERATELY DOES NOT CHANGE. `override` is absent, so dotenv
 * keeps its default of `override: false`, and that default *is* this service's
 * specified precedence: PM2 injects its descriptor's `env` block into a
 * worker's real environment before any application code runs, so the real
 * environment wins, then `.env`, then the defaults above. The descriptor
 * carries only `NODE_ENV` precisely so the remaining seven variables stay
 * `.env`-owned; `override: true` would invert that settled decision and let a
 * stale `.env` silently defeat the deployment. `.env` values still land in
 * `process.env`, so nothing downstream of this module sees a different
 * environment than it would have.
 *
 * WHY THE RETURN VALUE IS INSPECTED. dotenv reports a failed read on the
 * object it returns rather than by throwing, so discarding that object makes
 * an existing-but-unusable `.env` -- wrong permissions, a directory of that
 * name, an I/O error -- indistinguishable from no file at all, and the service
 * would start on defaults the operator never chose. Only `ENOENT` is
 * tolerated; every other code is a failure.
 *
 * @param {string[]} failures Accumulator that failure messages are pushed onto.
 * @returns {void}
 */
function loadEnvFile(failures) {
  const envPath = path.resolve(process.cwd(), ENV_FILE_NAME);

  let result;

  try {
    result = dotenv.config({ quiet: true });
  } catch (error) {
    // The never-throw contract has to hold for the load as well as for the
    // readers, and dotenv does not report every problem on its return value:
    // its own vault route throws. The single call this function makes is
    // therefore guarded generically -- no dotenv control or file name is
    // inspected to predict which route ran -- so a thrown load failure joins
    // the aggregated error instead of escaping as a bootstrap defect and
    // abandoning every check that has not run yet.
    //
    // Only the error's IDENTITY is reported: its `code`, or its constructor
    // name when it carries none. A library's free-text message can embed
    // something derived from the environment, and the confidentiality rule for
    // these strings does not except a message merely because a dependency
    // composed it.
    const identity = typeof error?.code === 'string' && error.code.length > 0
      ? error.code
      : (error instanceof Error ? error.name : typeof error);

    failures.push(
      `${ENV_FILE_NAME} could not be loaded from ${envPath} ` +
        `(${describeDiagnostic(identity)}); resolve that condition or ` +
        `remove ${ENV_FILE_NAME}`
    );

    return;
  }

  const error = result.error;

  if (error !== undefined && error !== null &&
      error.code !== ENV_FILE_ABSENT_CODE) {
    // A Node file-system error's `message` already opens with its `code`
    // (`EISDIR: illegal operation on a directory, read`), so quoting both
    // prints the code twice; the message is the more informative of the two
    // and is used alone, with the code as the fallback if a thrown value ever
    // arrives without one.
    const detail = typeof error.message === 'string' && error.message.length > 0
      ? error.message
      : `code ${String(error.code)}`;

    failures.push(
      `${ENV_FILE_NAME} exists at ${envPath} but could not be read ` +
        `(${describeDiagnostic(detail)}); fix or remove the file`
    );
  }
}

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
 *
 * They share a second contract, and it is a confidentiality one: a failure
 * message names its variable, states what would have been accepted, and adds
 * nothing but non-content metadata. No reader interpolates the value it
 * rejected. The reason is in the module header -- these strings are persisted
 * to a retained stderr log by `src/server.js` -- and describeSupplied() is the
 * only rendering of a supplied value any of them may use.
 * ---------------------------------------------------------------------------
 */

/**
 * Renders the non-content metadata a rejection message is permitted to carry
 * about a supplied value.
 *
 * The length is reported and the characters are not. Length is enough to tell
 * a one-character typo apart from a pasted block or a whole file, and to
 * confirm that something was supplied at all, while nothing of what the
 * environment held reaches the message, the `failures` array, or the stderr
 * record `src/server.js` writes from them.
 *
 * @param {string} raw The supplied value as returned by readRaw(), so already
 *                     trimmed. Its content is never rendered; only its length
 *                     is measured.
 * @returns {string} A phrase such as `12 characters supplied`.
 */
function describeSupplied(raw) {
  const { length } = String(raw);

  return `${length} character${length === 1 ? '' : 's'} supplied`;
}

/**
 * Renders a diagnostic string for quoting inside a failure message.
 *
 * The input is a diagnostic produced by dotenv or by the file system: the
 * `message` of a failed `.env` read, which carries an error code and a path and
 * never any of the file's content, or the identity -- `code` or constructor
 * name -- of an exception the load threw. It is deliberately NOT an
 * environment value: a supplied value is never rendered anywhere (see the
 * module header and describeSupplied()), so nothing routes one here.
 *
 * Two properties matter, and both are about the message staying usable rather
 * than about presentation. First, the aggregated message must remain a SINGLE
 * line: `src/server.js` writes it into one JSON object on stderr, and an
 * embedded newline would split a record that an operator -- or a log parser --
 * reads as one unit, so interior whitespace is collapsed. Second, an
 * unexpectedly long diagnostic must not flood stderr and bury the other
 * failures, so the rendering is truncated.
 *
 * @param {string} diagnostic Any diagnostic string to render -- an error
 *                            message or code, not a configuration value.
 * @returns {string} A single-line, length-bounded rendering of `diagnostic`.
 */
function describeDiagnostic(diagnostic) {
  const collapsed = String(diagnostic).replace(/\s+/g, ' ');

  return collapsed.length > MAX_DIAGNOSTIC_LENGTH
    ? `${collapsed.slice(0, MAX_DIAGNOSTIC_LENGTH)}...`
    : collapsed;
}

/**
 * Reads one environment variable, trimmed, distinguishing a variable that was
 * never set from one that was set to nothing.
 *
 * This is the single point at which this codebase touches `process.env` for a
 * configuration variable; every reader below goes through it, and no other
 * module has any business calling anything like it.
 *
 * WHY A SUPPLIED BLANK IS A FAILURE RATHER THAN AN ABSENCE. The rule is that
 * nothing is mandatory but ANYTHING SUPPLIED MUST BE VALID, and `PORT=` is
 * supplied: the name is present in the environment, holding a value that
 * satisfies no validator. Reading it as absence would make every per-variable
 * rule skippable by blanking the value instead of correcting it -- and a blank
 * is what a machine produces when a template placeholder goes unexpanded or a
 * substitution resolves against an unset variable, so the silent default would
 * be a port nobody chose, or the all-interfaces `HOST` where a deployment
 * meant loopback, both of which look like a healthy start-up. An operator who
 * wants the default deletes the assignment; that is what absence means and it
 * is the one line in `server/.env.example` to remove.
 *
 * WHY THIS IS ALSO WHERE `HOST`'S NON-EMPTY RULE LIVES. A blank can only be
 * seen here, so this is the only place that rule can be enforced; everything
 * this function returns is a trimmed, non-empty string, so `config.host` is
 * either that or the documented default and can never be the empty string a
 * listener could not bind.
 *
 * Trimming has a second effect worth stating: stray whitespace around an
 * otherwise valid value in a `.env` line can never turn it into a failure --
 * and a value that is nothing BUT whitespace is a blank, handled as above.
 *
 * @param {string} name The environment variable name, e.g. `'PORT'`.
 * @param {string[]} failures Accumulator that a failure message is pushed onto
 *                            when the variable is supplied but blank.
 * @returns {string|undefined} The trimmed, non-empty value; `undefined` when
 *                             the variable is unset, or when a failure was
 *                             recorded.
 */
function readRaw(name, failures) {
  const raw = process.env[name];

  if (typeof raw !== 'string') {
    return undefined;
  }

  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    // Only the variable-specific fact belongs here. The aggregated message
    // this is folded into already tells the operator that every variable is
    // optional and that removing the assignment is the fix, so repeating it
    // per failure would say it three times for three blank variables.
    failures.push(
      `${name} was supplied but is empty; blanking a value is not the same ` +
        'as omitting it'
    );

    return undefined;
  }

  return trimmed;
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
  const raw = readRaw(name, failures);

  if (raw === undefined) {
    return undefined;
  }

  if (!INTEGER_PATTERN.test(raw)) {
    // The grammar is quoted exactly as it is enforced. "Optionally signed"
    // would be wrong: the pattern admits a leading minus and nothing else, so
    // `+3000` is rejected and a message implying otherwise would send an
    // operator looking for a different mistake.
    failures.push(
      `${name} must be a whole number matching ^-?\\d+$ -- digits, ` +
        `optionally preceded by a minus sign, and nothing else ` +
        `(${describeSupplied(raw)})`
    );

    return undefined;
  }

  const value = Number(raw);

  // A digit string can be syntactically perfect and still exceed the range in
  // which JavaScript integers are exact, at which point every comparison below
  // would be made against an approximation of what the operator wrote.
  if (!Number.isSafeInteger(value)) {
    // Stated as a magnitude, because the bound is two-sided:
    // `-9007199254740992` is rejected as well, and "at most
    // 9007199254740991" would describe that value as acceptable.
    failures.push(
      `${name} must be a whole number whose magnitude is at most ` +
        `${Number.MAX_SAFE_INTEGER}, so that it is represented exactly ` +
        `(${describeSupplied(raw)})`
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
    // The bounds are quoted and the supplied number is not. Both halves are
    // deliberate: the range is what the operator needs in order to correct the
    // value, while the value itself is environment content and stays out of a
    // message that is persisted to stderr (see the module header). An integer
    // is no exception -- a numeric secret substituted into the wrong variable
    // would be echoed just as faithfully as a word.
    failures.push(
      `${name} must be an integer between ${min} and ${max} inclusive; ` +
        'the supplied value is outside that range'
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
      `${name} must be a non-negative integer; the supplied value is negative`
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
  const raw = readRaw(name, failures);

  if (raw === undefined) {
    return undefined;
  }

  if (!allowed.includes(raw)) {
    failures.push(
      `${name} must be exactly one of ${allowed.join(', ')}, matched ` +
        `case-sensitively (${describeSupplied(raw)})`
    );

    return undefined;
  }

  return raw;
}

/**
 * Reads a variable as a strict boolean, accepting only the exact lowercase
 * words `true` and `false` and returning a real boolean.
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
 * WHY THE MATCH IS CASE-SENSITIVE. The configuration contract admits the two
 * spellings `true` and `false` and no others, and this function's own failure
 * message promises exactly that -- so folding `TRUE` or `FaLsE` into an
 * accepted value would make the code disagree both with the contract it
 * implements and with the message it prints. It would also make this the one
 * variable read leniently while `NODE_ENV` and `LOG_LEVEL` are compared
 * exactly, and that local inconsistency is what turns a rejected
 * `NODE_ENV=Production` into a surprise. A spelling this rejects is a
 * one-character fix the operator is told about at start-up.
 *
 * @param {string} name The environment variable name.
 * @param {string[]} failures Accumulator that a failure message is pushed onto.
 * @returns {boolean|undefined} The parsed boolean; `undefined` when the
 *                              variable is absent, or when a failure was
 *                              recorded.
 */
function readBoolean(name, failures) {
  const raw = readRaw(name, failures);

  if (raw === undefined) {
    return undefined;
  }

  if (Object.prototype.hasOwnProperty.call(BOOLEAN_VALUES, raw)) {
    return BOOLEAN_VALUES[raw];
  }

  failures.push(
    `${name} must be exactly "true" or "false", lower-case ` +
      `(${describeSupplied(raw)})`
  );

  return undefined;
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
 * suffixed string form and resolve it themselves -- those two parsers are the
 * whole of its consumption. Exporting the byte count computed here would
 * still work numerically, but it would discard the units the operator wrote
 * and hand the parsers a value that no longer matches the `.env` line it came
 * from. The string is what is exported; the byte count never leaves this
 * function.
 *
 * Two distinct rejections, in the order they are checked:
 *   1. the grammar -- `10gb` and `abc` fail here, before any arithmetic;
 *   2. the ceiling -- `2mb` is well-formed and still refused, while `1mb`
 *      resolves to exactly the ceiling and is accepted.
 *
 * AND NOTHING ELSE. The contract for this variable is the grammar plus the
 * ceiling, so every value those two admit is accepted -- `0` and `0kb`
 * included. A zero limit is an unusual choice rather than an invalid one: it
 * makes the parsers reject any request carrying a body, which is a coherent
 * thing for an operator to ask of a size limit and is reported to the caller
 * as the ordinary 413 that any oversized body earns. Adding a local one-byte
 * minimum here would refuse a start-up the specified contract permits, and a
 * validator that is stricter than the contract it enforces is a defect
 * whichever direction it errs in.
 *
 * @param {string} name The environment variable name.
 * @param {string[]} failures Accumulator that a failure message is pushed onto.
 * @returns {string|undefined} The validated limit as a string; `undefined`
 *                             when the variable is absent, or when a failure
 *                             was recorded.
 */
function readBodyLimit(name, failures) {
  const raw = readRaw(name, failures);

  if (raw === undefined) {
    return undefined;
  }

  const bytes = resolveBodyLimitBytes(raw);

  if (bytes === null) {
    failures.push(
      `${name} must be a byte count optionally suffixed with kb or mb, ` +
        `matching ^\\d+(kb|mb)?$ case-insensitively ` +
        `(${describeSupplied(raw)})`
    );

    return undefined;
  }

  if (bytes > BODY_LIMIT_MAX_BYTES) {
    // Neither the value nor the byte count it resolved to is quoted. The count
    // would be as good as the value here: this grammar is small enough that a
    // reader inverts `2097152 bytes` back to `2mb` without effort, so printing
    // it would put environment content into the stderr record by another
    // route.
    failures.push(
      `${name} must resolve to at most ${BODY_LIMIT_MAX_BYTES} bytes (1 MB); ` +
        'the supplied value resolves to more than that'
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
 *           Express's parsers. From `BODY_LIMIT`; default `'100kb'`; matches
 *           `^\d+(kb|mb)?$` case-insensitively and resolves to at most
 *           1048576 bytes.
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
 * and not deferred. It loads `.env` first, then reads every variable. Two
 * behaviours define it:
 *
 *   * NOTHING IS MANDATORY. Every variable has a default, so a process with no
 *     `.env` file and an empty environment is fully configured and starts
 *     cleanly. Absence -- a deleted assignment or an unset name -- is what
 *     selects a documented default.
 *   * ANYTHING SUPPLIED MUST BE VALID, AND ALL FAILURES ARE REPORTED TOGETHER.
 *     Each reader records its own problem and returns `undefined` instead of
 *     throwing, so validation always runs to completion. An operator who has
 *     mistyped three variables is told about three, not asked to fix one and
 *     restart to discover the next. "Supplied" includes supplied empty: a
 *     name present in the environment holding a blank value is a failure, not
 *     an absence -- see readRaw().
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
 *                 a caller that wants them separately; and `code` is set to
 *                 `ERR_CONFIG_VALIDATION` so a caller can tell this
 *                 deliberate rejection apart from a failure to load this
 *                 module at all.
 */
function loadConfiguration() {
  /** @type {string[]} */
  const failures = [];

  // FIRST, and necessarily first: every reader below observes `process.env`,
  // so `.env` has to be in it before any of them run. A load problem is
  // pushed onto the same accumulator as an invalid value, so an operator whose
  // `.env` is unreadable AND whose real environment holds a bad `PORT` is told
  // about both at once.
  loadEnvFile(failures);

  const port = readBoundedInteger('PORT', PORT_MIN, PORT_MAX, failures) ??
    DEFAULTS.port;

  // `HOST`'s rule in the configuration contract is "non-empty string", and
  // readRaw() is where that rule is enforced: it trims, and it records a
  // failure for a value that is empty or whitespace-only rather than falling
  // back to the default. Everything it returns is therefore already a trimmed,
  // non-empty string, so `config.host` is never the empty string and a
  // listener is never asked to bind nothing. A second emptiness check here
  // would be unreachable, which is why no separate non-empty-string reader
  // exists for it.
  const host = readRaw('HOST', failures) ?? DEFAULTS.host;

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
  // Express would then report the forged address and scheme as the real ones
  // through `req.ip` and `req.protocol`, which is precisely what the access
  // record writes as its `req.ip` and `req.protocol` fields (the request
  // serializer in `src/middleware/request-context.js` records those two and
  // drops the raw forwarded headers), and what any future rate limit or audit
  // trail would attribute the request to. Spoofing the client identity in the
  // log would become a matter of setting a header. The safe value is
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
  // `GET /health` response and every log line have the SAME SHAPE whether or
  // not PM2 launched the process. A consumer parsing those never has to handle
  // an absent field, and a query written against production logs works
  // unchanged against a developer's local run.
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
    //
    // The closing sentence states the omission rather than leaving an operator
    // to wonder whether the value was lost: no supplied value appears in
    // either the message or the array, because both are persisted to a
    // retained stderr log (see the module header). Naming the variable is what
    // makes that omission costless -- the value is in `server/.env`, where the
    // operator can read it without it being copied anywhere.
    const error = new Error(
      `Invalid environment configuration: ${failures.join('; ')}. ` +
        'Every variable is optional and falls back to a documented default, ' +
        'so remove the offending assignment or correct it; ' +
        'server/.env.example is the contract. The supplied values are ' +
        'deliberately not echoed here -- compare each variable named above ' +
        'against server/.env.'
    );

    // THE DISCRIMINATOR, WHICH IS A PAIRED OBLIGATION WITH `src/server.js`.
    // That module guards this require and has to tell an invalid environment
    // -- an operator error, fixed in `server/.env` -- apart from anything else
    // thrown while this module is evaluated, such as a missing `dotenv` or a
    // defect in the code here, which is fixed in the tree and located by its
    // stack. Without a stable marker the two are indistinguishable in the
    // catch, and the second gets reported as the first with its stack thrown
    // away. `code` carries it, in the Node convention, because this is
    // deliberately a plain `Error`: this module exports a frozen object and no
    // error class, so there is nothing for an `instanceof` check to test, and
    // the message is prose that will eventually be reworded.
    error.code = 'ERR_CONFIG_VALIDATION';
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

/**
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
