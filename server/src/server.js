// SPDX-License-Identifier: Apache-2.0
/**
 * The process layer for `hello-world-service`, and the entry point both PM2
 * and `npm start` boot.
 *
 * SINGLE RESPONSIBILITY. This module owns everything about the *process* and
 * nothing about the *application*: it loads configuration, builds the Express
 * app through the factory in `src/app.js`, binds the listener, reports
 * listener errors, performs the PM2 readiness handshake, and runs the two --
 * deliberately different -- termination paths. It declares no route, no
 * middleware and no response shape, and it must never grow one. The mirror of
 * that boundary is `src/app.js`, which knows nothing about ports, signals or
 * exit codes; between them the app is constructible and testable without ever
 * binding a socket.
 *
 * IT IS LOAD-BEARING BY NAME AND PATH. `server/ecosystem.config.js` declares
 * `script: 'src/server.js'` and `server/package.json` declares
 * `main: "src/server.js"` with `start` and `dev` pointing at it. Moving or
 * renaming this file breaks the PM2 descriptor and every `pm2:*` script, so
 * the two must change together.
 *
 * THE TWO TERMINATION PATHS, WHICH MUST NOT BE MERGED.
 *
 *   * `shutdown(signal)` -- for `SIGTERM`/`SIGINT`, which PM2 sends on stop
 *     and on reload. The process is healthy and the goal is to lose nothing,
 *     so it drains in two phases: deregister while still accepting, then stop
 *     accepting and finish what is already in flight.
 *   * `handleFatalError(error, origin)` -- for `uncaughtException` and
 *     `unhandledRejection`. The process state is undefined, so it does the
 *     minimum that is safe and exits at once. No drain, no waiting.
 *
 * Both converge on `terminate(code)`, the one place the mandatory
 * log -> flush -> disconnect -> exit sequence is implemented. It awaits the
 * flush through its callback, acts on a failure the flush reports, and bounds
 * the wait, so the final record is durable without the exit ever being able to
 * hang. `lib/logger.js` supplies the other half: a destination whose flush
 * reports a fact rather than a formality -- writing synchronously where this
 * process owns standard output, and reporting each write's completion where a
 * supervisor owns it.
 *
 * One branch cannot use `terminate()` and has its own helper: a configuration
 * failure happens before the logger exists, so `fatalExit(payload, code)`
 * writes one record synchronously to stderr and then performs the same IPC
 * release and explicit exit. Every terminal branch in this file goes through
 * one of those two, and both end in a `finally` so nothing can leave the
 * process running with its outcome unrecorded.
 *
 * @module server
 */

'use strict';

/*
 * Node built-ins, required before anything else. There are three, each needed
 * for one specific reason, and no external package is required anywhere in
 * this file:
 *
 *   * `node:fs`   -- `fs.writeSync()` is how `fatal()` puts a record on stderr
 *                    synchronously, with no logger and no stream buffering in
 *                    the way.
 *   * `node:http` -- the listener is created explicitly rather than via
 *                    `app.listen()` so that its `error` event can be
 *                    subscribed to BEFORE `listen()` is ever called. See the
 *                    error handler in `start()` for why that ordering matters.
 *   * `node:util` -- `util.inspect()` renders a non-`Error` rejection reason
 *                    legibly while normalising it, where `String(value)` would
 *                    flatten an object to `[object Object]` and lose the very
 *                    detail the fatal record exists to preserve.
 */
const fs = require('node:fs');
const http = require('node:http');
const util = require('node:util');

/**
 * Writes one JSON object synchronously to stderr, using no logger and no
 * transport.
 *
 * WHY THIS EXISTS AT ALL, AND WHY IT IS DELIBERATELY PRIMITIVE. A
 * configuration failure happens *before any logger exists* -- `lib/logger.js`
 * reads its level, identity and transport decision from the very
 * configuration module that just refused to load -- and that is precisely the
 * moment an operator most needs a legible message. Rather than let the failure
 * surface as a raw, multi-line stack trace from a failed `require`, this
 * function renders it as a single parseable record on the one stream that is
 * guaranteed to exist: file descriptor 2.
 *
 * `fs.writeSync` is used rather than `console.error` or a stream write because
 * the process is on its way out -- `fatalExit()` calls this, releases the IPC
 * channel and exits -- and an exit can truncate a buffered write. A synchronous
 * write to the descriptor cannot be truncated, so the record is on disk before
 * the process is gone, whatever the steps after it do.
 *
 * FOR CONFIGURATION VALIDATION FAILURES, AND FOR ONE OTHER CASE THAT IS ITS
 * MIRROR IMAGE. Every failure after configuration -- listener errors included,
 * which surface only once the logger, the app and `listen()` all exist -- goes
 * through the configured logger, so that the service has exactly one
 * structured log stream rather than two competing ones. The single exception is
 * a failure OF that stream: if the logger's own flush throws on the way out,
 * as `terminate()` allows for, then stderr is the only stream still known to
 * work and this is the only way the failure can be recorded at all. Both uses
 * share one property -- no usable logger exists at the instant of writing --
 * and that, rather than convenience, is what admits them. Do not reuse it for
 * anything else.
 *
 * @param {object} payload A plain, JSON-serialisable object. It must be flat
 *                         enough to survive `JSON.stringify` and small enough
 *                         to read at a glance.
 * @returns {void}
 */
function fatal(payload) {
  // `JSON.stringify` escapes any newline inside a value, so the record is
  // always exactly one line however ugly the underlying error message -- or
  // stack -- was. That is what keeps it parseable by the same line-at-a-time
  // tooling that reads the service's ordinary output.
  fs.writeSync(2, `${JSON.stringify(payload)}\n`);
}

/**
 * Ends the process from inside the pre-logger window: write the record,
 * release the PM2 IPC channel if there is one, exit.
 *
 * WHY THIS EXISTS SEPARATELY FROM `terminate()`. `terminate()` flushes the
 * configured logger, and in this window there is no configured logger to
 * flush -- the module that would have built it reads the configuration that
 * just refused to load. What the two paths DO share is the obligation to
 * release the IPC channel: PM2 forks a worker with a channel attached before
 * any application code runs, so a process that dies here without disconnecting
 * leaves the channel referenced and is `SIGKILL`ed at `kill_timeout` instead of
 * exiting, which PM2 reports as a failed worker rather than a rejected
 * configuration. Writing synchronously to stderr and then exiting is therefore
 * not sufficient on its own, and this helper is what keeps the pre-logger
 * branch from being the one exit path that skips a step.
 *
 * THE EXIT HAPPENS IN A `finally`, WHICH IS THE POINT. Neither the write nor
 * the disconnect may be able to prevent the process from ending with the code
 * this function was given: an already-disconnected channel throws
 * `ERR_IPC_DISCONNECTED` when disconnected again, and an invalid configuration
 * that also managed to leave a broken stderr must still exit non-zero rather
 * than fall through into a service that never validated its environment.
 *
 * @param {object} payload  The single record to write, in `fatal()`'s shape.
 * @param {number} exitCode The status to exit with. Always non-zero here --
 *                          nothing reaches this helper on a healthy path.
 * @returns {void} Never returns -- the process is gone.
 */
function fatalExit(payload, exitCode) {
  try {
    fatal(payload);

    // `process.connected` rather than a check that `disconnect` merely exists:
    // the method is present on any forked process, including one whose channel
    // has already gone, and calling it then throws.
    if (process.connected) {
      process.disconnect();
    }
  } catch (error) {
    // Losing the cleanup must not lose the diagnosis, so the failure is
    // recorded on the same stream by the same synchronous writer, and the exit
    // below still happens. This is the last thing this process can say.
    fatal({
      level: 'fatal',
      time: Date.now(),
      pid: process.pid,
      code: 'ERR_PRELOGGER_TERMINATION',
      msg: 'Pre-logger termination could not complete cleanly; exiting anyway',
      err: error instanceof Error ? error.message : String(error)
    });
  } finally {
    process.exit(exitCode);
  }
}

/*
 * THE GUARDED CONFIGURATION LOAD, WHICH MUST STAY THE FIRST REQUIRE OF ANY
 * INTERNAL MODULE.
 *
 * `src/config/index.js` validates during module evaluation and THROWS one
 * aggregated error naming every invalid variable at once -- a configuration
 * failure is a throw from `require`, not a returned error -- so the guard has
 * to be around the `require` itself.
 *
 * The ordering is a correctness constraint, not a stylistic preference.
 * `lib/logger.js` requires the configuration module directly and `app.js`
 * reaches it both directly and through its router tree, and in CommonJS
 * `require` calls execute in source order. Requiring either of them first
 * would therefore trigger the configuration throw OUTSIDE this try/catch, and
 * the operator would get an unformatted stack trace instead of the aggregated,
 * machine-readable record below. Placing the guarded require first is both
 * necessary and sufficient. (`lib/lifecycle.js`, required further down, is a
 * dependency-free leaf: it reaches the configuration module by no path at all,
 * which is exactly what makes it safe for the process layer and the route
 * layer to share.)
 *
 * Terminating here goes through `fatalExit()` rather than the `terminate()`
 * sequence: there is no logger to flush and no application state to unwind,
 * because nothing has been constructed yet -- but the PM2 IPC channel may
 * already exist, so the disconnect still has to happen. Exiting non-zero
 * before the listener binds is the whole point: an invalid environment must
 * never produce a running service.
 *
 * TWO DIFFERENT FAILURES ARRIVE IN THE SAME `catch`, AND REPORTING THEM AS ONE
 * IS A DIAGNOSTIC DEAD END. A rejected environment variable is an operator
 * error whose fix is in `server/.env`; anything else thrown while evaluating
 * that module -- a missing or damaged `dotenv` install, a syntax or
 * programming defect in the module itself -- is a defect whose fix is in the
 * code or the dependency tree, and whose stack is the only thing that locates
 * it. Labelling the second as "configuration validation failed" and dropping
 * its stack sends an operator to edit a file that is not the problem, so the
 * two are separated below on the discriminator the configuration module
 * attaches.
 */

/**
 * The `code` the configuration module puts on the aggregated validation error
 * it throws, and the only thing that distinguishes an invalid environment from
 * a broken configuration module.
 *
 * A paired obligation with `src/config/index.js`: it sets this exact string,
 * and the classification below reads it. A discriminator is used rather than
 * an `instanceof` check because the configuration module deliberately throws a
 * plain `Error` -- it exports a frozen object and no error class -- and rather
 * than a message match because a message is prose that will be reworded.
 *
 * @type {string}
 */
const CONFIG_VALIDATION_ERROR_CODE = 'ERR_CONFIG_VALIDATION';

let config;
try {
  config = require('./config');
} catch (error) {
  const isValidationFailure = Boolean(error) &&
    error.code === CONFIG_VALIDATION_ERROR_CODE;

  const payload = {
    // A human-readable label rather than pino's numeric level, because this is
    // the one record in the service that pino does not write: it goes to
    // stderr, is read by a person watching a start-up fail, and belongs to no
    // stream that filters on `level >= 50`. The numeric-level contract in
    // `lib/logger.js` governs the NDJSON stdout stream, which at this instant
    // does not exist.
    level: 'fatal',
    time: Date.now(),
    pid: process.pid,
    code: isValidationFailure
      ? CONFIG_VALIDATION_ERROR_CODE
      : (typeof error?.code === 'string' ? error.code : 'ERR_CONFIG_BOOTSTRAP'),
    msg: isValidationFailure
      ? 'Configuration validation failed; the listener was never bound'
      : 'Configuration module failed to load; the listener was never bound',
    err: error instanceof Error ? error.message : String(error)
  };

  if (isValidationFailure) {
    // The configuration module attaches every individual validation failure as
    // an array alongside the aggregated message. Passing it through gives a
    // consumer the failures structured, while `err` above stays sufficient on
    // its own for a human reading one line.
    if (Array.isArray(error.failures)) {
      payload.failures = error.failures.slice();
    }
  } else if (error instanceof Error && typeof error.stack === 'string') {
    // A bootstrap defect is located by its stack and by nothing else, so the
    // stack is carried rather than discarded. It stays one line because
    // `JSON.stringify` escapes the newlines inside it, so the record is still
    // parseable by whatever reads the stream.
    payload.stack = error.stack;
  }

  fatalExit(payload, 1);
}

/*
 * Only now that configuration has loaded successfully is it safe to require
 * the modules that depend on it.
 *
 * `logger` is the pino root instance itself, exported directly rather than
 * wrapped, which is what makes both `logger.flush()` and the level methods
 * available here.
 *
 * BOTH HALVES OF THE LIFECYCLE LATCH ARE IMPORTED, AND EACH IS USED FOR ONE
 * THING ONLY. `beginShutdown()` is the write: this module is the sole writer of
 * the drain state, from its signal handler. `isShuttingDown()` is read at
 * exactly one place -- the listen callback, which must not announce a worker to
 * PM2 as ready when a signal has already begun draining it while the bind was
 * still pending. That is a process-lifecycle decision, not the HTTP readiness
 * answer: the 200/503 response stays entirely with
 * `src/routes/health.routes.js`, which is the latch's other reader, and
 * nothing in this file formats a probe response.
 */
const logger = require('./lib/logger');
const { beginShutdown, isShuttingDown } = require('./lib/lifecycle');
const { createApp } = require('./app');

/**
 * The bound HTTP listener, held in module scope because `shutdown()` and
 * `drainAndExit()` need the same instance `start()` created.
 *
 * `null` until `start()` runs, which is a state the drain path handles
 * explicitly rather than assuming away.
 *
 * @type {import('node:http').Server|null}
 */
let server = null;

/**
 * The force-exit timer that bounds the whole drain, armed at signal receipt
 * and cleared when the listener closes in time.
 *
 * @type {NodeJS.Timeout|null}
 */
let forceExitTimer = null;

/**
 * Whether `terminate()` has already begun its log drain.
 *
 * A re-entry guard rather than a status flag. Every exit path funnels through
 * one function, and the drain is now asynchronous -- it waits for the logger's
 * flush callback -- so a second exit request can genuinely arrive while the
 * first is still in flight: a `SIGTERM` during a fatal exit, or an exception
 * thrown by the flush itself, which would reach the `uncaughtException`
 * handler and terminate again, flushing again, unbounded. The guard makes
 * every entry after the first skip the drain and go straight to the exit, so
 * the recursion is impossible rather than merely unlikely.
 *
 * @type {boolean}
 */
let terminating = false;

/**
 * How long `terminate()` will wait for the logger's flush callback before
 * exiting regardless, in milliseconds.
 *
 * WHY A FIXED BOUND, AND WHY THIS SIZE. The whole point of awaiting the flush
 * is that the last record survives; the point of bounding the wait is that a
 * destination which never calls back must not turn an exit into a hang. A hung
 * exit is strictly worse than a lost line: PM2 waits out `kill_timeout` and
 * then `SIGKILL`s the worker, reporting a clean shutdown as a failure.
 *
 * The size is derived from the budget rather than chosen: `ecosystem.config.js`
 * fixes `kill_timeout` at 12000 ms and the configuration validator caps
 * `SHUTDOWN_TIMEOUT_MS` at 10000 ms, so the application owns a 2000 ms margin.
 * One second of it is spent here at the very worst, which leaves the margin
 * intact even when a force-exit at the full budget is what called this. It is
 * deliberately NOT derived from `config.shutdownTimeoutMs` at run time: this
 * bound protects the margin, so it must not grow when an operator raises the
 * budget it is protecting.
 *
 * @type {number}
 */
const TERMINAL_DRAIN_TIMEOUT_MS = 1000;

/**
 * The last two steps of every exit: release the PM2 IPC channel, then exit
 * with the given code.
 *
 * WHY THE DISCONNECT IS LOAD-BEARING, which was measured: with it removed, a
 * PM2 cluster worker that had finished its drain did NOT exit -- the IPC
 * channel stays referenced, so the worker lingered until PM2 `SIGKILL`ed it at
 * `kill_timeout`, turning a clean 2.2-second shutdown into a 12-second kill
 * that PM2 reports as a failure. Letting the event loop "just drain" is not an
 * equivalent simplification; it is the bug.
 *
 * WHY `process.connected` RATHER THAN AN OPTIONAL CALL. `process.disconnect?.()`
 * tests only that the method exists, and it exists on every forked process --
 * including one whose channel has already gone. Calling it then throws
 * `ERR_IPC_DISCONNECTED` (verified on the pinned runtime: a second
 * `disconnect()` throws "IPC channel is already disconnected"), and a throw
 * here is genuinely dangerous rather than untidy: it would pre-empt the
 * `process.exit()` below, surface as an uncaught exception, and re-enter the
 * fatal handler that had very likely just called this. `process.connected` is
 * `false` once the channel is gone, so it answers the question the optional
 * call only appeared to ask. A directly launched process -- `npm start`, or a
 * developer's terminal -- has no channel at all and is covered by the same
 * test.
 *
 * WHY THE EXIT IS IN A `finally`. Ending the process with the code its caller
 * asked for is the one thing that must not be conditional on anything above
 * it: not on the disconnect succeeding, not on the failure record being
 * writable. A `finally` is what makes "controlled exit" true regardless of what
 * the IPC cleanup does.
 *
 * @param {number} exitCode `0` for a drain that completed, non-zero for every
 *                          other ending: a force-timeout, a listener error, or
 *                          an unrecoverable fault.
 * @returns {void} Never returns -- the process is gone.
 */
function releaseIpcAndExit(exitCode) {
  try {
    if (process.connected) {
      process.disconnect();
    }
  } catch (error) {
    // Recorded through the configured logger rather than swallowed, and NOT
    // rethrown: an IPC channel that cannot be released is information for
    // whoever reads the log, never a reason to abandon the exit. On a
    // synchronous destination the record is on the descriptor before the exit
    // takes effect; on a supervised one it is queued ahead of it, which is as
    // much as can honestly be claimed at this point -- draining again from
    // inside the step that ends the process is how a controlled exit turns into
    // a loop.
    logger.error(
      { err: error instanceof Error ? error : new Error(String(error)) },
      'Releasing the PM2 IPC channel failed; exiting anyway'
    );
  } finally {
    process.exit(exitCode);
  }
}

/**
 * Ends the process: flush the logger, release the PM2 IPC channel, exit.
 *
 * THIS SEQUENCE IS THE DETAIL MOST LIKELY TO BE SIMPLIFIED AWAY, AND EVERY
 * STEP IS MANDATORY. Each guards a different failure, and each failure still
 * looks correct in the source:
 *
 *   * THE FLUSH guarantees the record the caller just wrote is out of pino's
 *     hands before the process disappears. `process.exit()` does not drain a
 *     buffered destination, so with an asynchronous one the final line -- the
 *     one recording HOW the process ended -- is lost, and a drain that
 *     completed becomes indistinguishable from one that was killed. That final
 *     record is frequently the only diagnostic there will ever be, because on
 *     the fatal path the process is gone before anything else can ask it a
 *     question.
 *   * THE DISCONNECT AND EXIT are load-bearing right now, for the measured
 *     reason given on `releaseIpcAndExit()` above.
 *
 * WHY THE FLUSH IS AWAITED THROUGH ITS CALLBACK, AND WHY THAT IS NOT OPTIONAL.
 * `logger.flush()` is asynchronous by contract -- pino delegates it to
 * `destination.flush(callback)` -- so calling it and exiting on the next
 * statement establishes nothing at all about durability; it merely looks like
 * it does. Awaiting the callback is what makes the step real. The other half of
 * that guarantee lives in `lib/logger.js`, whose destination is built so this
 * callback carries a fact rather than a formality, in one of two shapes: where
 * this process owns standard output the sink writes synchronously, so the bytes
 * are already on the descriptor and the callback runs inside the flush call;
 * where a supervisor owns it -- production under PM2 -- the sink reports each
 * write's completion, and the callback waits for the last one, which for PM2 is
 * the point at which the line is in `logs/out.log`. Either way the flush also
 * reports a FAILURE if the sink had one, which `finish()` below acts on. A
 * destination without that construction -- an asynchronous sonic-boom, or a
 * worker-thread transport -- would invoke this callback late, once, or, as was
 * measured with `transport: { target: 'pino-pretty' }`, never. The two files
 * are one repair and must stay in step.
 *
 * WHY THE WAIT IS BOUNDED. Because the flush is awaited, a destination that
 * reports nothing at all would hold the process open until PM2 `SIGKILL`ed it,
 * which would turn a clean stop into a reported failure and break the fatal
 * path's guarantee of a prompt exit. `TERMINAL_DRAIN_TIMEOUT_MS` caps that
 * wait, and whichever of the callback and the timer arrives first wins: the
 * exit is therefore never later than the bound and never earlier than the
 * flush it was able to complete. A synchronous throw from the flush takes the
 * same route as a reported failure, so no path can end here without exiting.
 *
 * Callers log their own message immediately before calling this; it writes no
 * record of its own, so that the reason for an exit always reads in the
 * caller's words.
 *
 * @param {number} exitCode `0` for a drain that completed, non-zero for every
 *                          other ending: a force-timeout, a listener error, or
 *                          an unrecoverable fault.
 * @returns {void} Never returns -- the process is gone.
 */
function terminate(exitCode) {
  if (terminating) {
    // A second exit request while the first drain is in flight. The record is
    // already being flushed by the entry that got here first, so this one goes
    // straight to the exit rather than starting a competing drain.
    releaseIpcAndExit(exitCode);
    return;
  }

  terminating = true;

  let settled = false;
  let drainTimer = null;

  /**
   * Completes the termination exactly once, whichever of the three outcomes
   * reaches it first: the flush reporting success, the flush reporting a
   * failure, or the bound expiring with the flush having reported nothing.
   *
   * A REPORTED FAILURE IS NOT SILENTLY TREATED AS SUCCESS, which is the whole
   * reason the parameter exists. `logger.flush(callback)` hands its callback
   * whatever the destination reported, and a sink that fails every write while
   * reporting nothing back would otherwise let this process exit as though the
   * final record had been written -- the exact outcome the awaited flush was
   * introduced to prevent, wearing the appearance of a fix. When the flush
   * failed, the account of how this process ended is written instead to the one
   * stream that needs no logger, synchronously and once. It cannot recurse:
   * `fatal()` is an `fs.writeSync` to file descriptor 2 with no logger, no
   * transport and no event loop involved.
   *
   * @param {Error} [flushFailure] What the destination reported, if it reported
   *                        a failure, or the bound's own expiry.
   * @returns {void} Never returns -- the process is gone.
   */
  const finish = (flushFailure) => {
    if (settled) {
      return;
    }

    settled = true;

    if (drainTimer !== null) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }

    try {
      if (flushFailure) {
        fatal({
          level: 'fatal',
          time: Date.now(),
          pid: process.pid,
          code: 'ERR_TERMINAL_FLUSH',
          msg: 'The final log records could not be flushed; the account of ' +
            'how this process ended may be incomplete',
          err: flushFailure instanceof Error
            ? flushFailure.message
            : String(flushFailure),
          exitCode
        });
      }
    } finally {
      // In a `finally` because the report is best-effort and the exit is not:
      // a stderr that has itself gone away must not leave this process running
      // with its outcome undecided.
      releaseIpcAndExit(exitCode);
    }
  };

  // Deliberately NOT `unref()`d. This timer is what holds the event loop open
  // until the termination resolves; unreferenced, an otherwise idle loop would
  // let the process exit on its own with status 0 and quietly discard the
  // non-zero code a force-exit, listener error or fatal fault was reporting.
  drainTimer = setTimeout(() => {
    finish(new Error(
      `the log destination reported neither completion nor failure within ${TERMINAL_DRAIN_TIMEOUT_MS} ms`
    ));
  }, TERMINAL_DRAIN_TIMEOUT_MS);

  try {
    logger.flush(finish);
  } catch (error) {
    // A flush that throws synchronously must not become an uncaught exception
    // on the way out -- that would re-enter the fatal handler. It is the same
    // outcome as a reported failure, so it takes the same path.
    finish(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * The fatal path: record an unrecoverable fault and exit at once.
 *
 * WHY THIS PATH DOES NOT DRAIN, AND MUST NEVER BE MERGED WITH `shutdown()`.
 * After an uncaught exception the process state is undefined -- a handler
 * abandoned midway may have left a half-mutated object, a half-written
 * response or a lock nobody will release. Running the operator drain from here
 * would mean continuing to ACCEPT NEW REQUESTS for the whole deregistration
 * window and then performing asynchronous cleanup, which is serving traffic
 * from a process that has already failed. Exiting immediately is not the
 * cruder option, it is the correct one: PM2's `autorestart` replaces the
 * worker with one whose state is known, and that is the only sound recovery
 * for a process whose state is not.
 *
 * `uncaughtException` and `unhandledRejection` are handled identically so that
 * there is one fatal policy rather than two that can drift. Node escalates an
 * unhandled rejection to an uncaught exception by default in any case, so
 * treating them differently would only mean the same fault was recorded two
 * different ways depending on how it happened to reach the top.
 *
 * WHAT "IMMEDIATELY" MEANS HERE, EXACTLY. This path skips the drain entirely:
 * no deregistration window, no `server.close()`, no waiting on requests. The
 * one thing it does wait for is the terminal log barrier in `terminate()`, and
 * how long that takes is a property of the destination. Where this process owns
 * standard output -- a direct run, and every non-production run -- the sink
 * writes synchronously and the flush callback fires inside the flush call, so
 * the process exits in the tick the fault arrived. Where a supervisor owns
 * standard output -- production under PM2 -- the wait is for that one write to
 * report completion, bounded by `TERMINAL_DRAIN_TIMEOUT_MS`; it is a log write,
 * not a drain, and it is the difference between an operator seeing why the
 * worker died and seeing nothing at all.
 *
 * @param {unknown} error  The thrown value or rejection reason. Not
 *                         necessarily an `Error`: any value can be thrown or
 *                         used to reject, so it is normalised below before
 *                         being logged.
 * @param {string}  origin Where the fault surfaced -- `'uncaughtException'` or
 *                         `'unhandledRejection'`. Recorded so the two are
 *                         still distinguishable in the log even though the
 *                         policy is one.
 * @returns {void} Never returns -- the process is gone.
 */
function handleFatalError(error, origin) {
  // Normalising a non-`Error` value matters because pino's error serializer
  // needs a real `Error` to extract a message, type and stack from. A bare
  // `throw 'boom'` or `Promise.reject({ code: 7 })` would otherwise be logged
  // as an unhelpful empty object -- losing the only evidence of why the
  // process died. `util.inspect` keeps the original value readable inside the
  // synthesised message.
  const failure = error instanceof Error
    ? error
    : new Error(`Non-Error value thrown or rejected: ${util.inspect(error)}`);

  logger.fatal(
    { err: failure, origin },
    'Unrecoverable error; exiting immediately without draining'
  );

  terminate(1);
}

/**
 * Phase two of the operator drain: stop accepting, shed idle sockets, and
 * exit.
 *
 * By the time this runs, the deregistration window has elapsed, so anything
 * polling the readiness probe has had its chance to see the 503 and stop
 * sending work. `server.close()` stops accepting new connections and calls
 * back once every request still in flight has finished.
 *
 * WHAT `server.closeIdleConnections()` ACTUALLY CONTRIBUTES ON THE PINNED
 * RUNTIME, stated accurately because the intuitive rationale for it is false
 * here. Since Node 19, `server.close()` closes idle connections itself, and
 * that was measured on this service's pinned 24.20.0: with an idle keep-alive
 * socket parked and no `closeIdleConnections()` call at all, the close callback
 * fired in 1 ms rather than waiting out the keep-alive timeout. So this call is
 * NOT what stops an idle connection from holding the drain open -- nothing has
 * to, on Node 19 or later. It is retained as explicit, version-independent
 * defence: it states the intent in the code instead of inheriting it from a
 * runtime default, it costs nothing on a listener that has already shed those
 * sockets, and it keeps the drain bounded on any runtime where that default
 * does not hold.
 *
 * It is called AFTER `close()` deliberately, and that ordering does still
 * matter: `close()` first marks the listener as closing, so a socket that goes
 * idle during the drain is then cleaned up rather than being handed another
 * request. Calling it first would leave that window open.
 *
 * @param {string} signal The signal that began the drain, carried through to
 *                        the completion record so the whole shutdown reads as
 *                        one correlated story.
 * @returns {void}
 */
function drainAndExit(signal) {
  // A signal can arrive before `start()` ever bound a listener -- PM2 stopping
  // a worker that is still booting, for instance. There is nothing to close in
  // that case, so the drain reduces to the termination sequence rather than
  // dereferencing a listener that does not exist.
  if (server === null) {
    clearTimeout(forceExitTimer);
    forceExitTimer = null;
    logger.info({ signal }, 'Drain complete; no listener was bound');
    terminate(0);
    return;
  }

  server.close((closeError) => {
    // The drain finished inside its budget, so the force-exit timer must not
    // fire. Clearing it also releases the event loop, which is what lets the
    // process reach its exit rather than idling until PM2 loses patience.
    clearTimeout(forceExitTimer);
    forceExitTimer = null;

    if (closeError) {
      logger.error(
        { err: closeError, signal },
        'Drain complete with error; exiting'
      );
      terminate(1);
      return;
    }

    logger.info({ signal }, 'Drain complete; exiting');
    terminate(0);
  });

  server.closeIdleConnections();
}

/**
 * The operator drain: `SIGTERM`/`SIGINT`, two phases, nothing lost.
 *
 * PM2 signals `SIGINT` on both stop and reload, so this is the path every
 * ordinary deployment takes. It is idempotent, bounded, and it makes the
 * readiness probe's negative answer observable before the socket closes.
 *
 * THE TIMEOUT BUDGET, AND WHY THE FORCE-EXIT TIMER IS ARMED AT SIGNAL RECEIPT
 * RATHER THAN AT PHASE TWO. `SHUTDOWN_TIMEOUT_MS` is the TOTAL drain budget
 * and `DRAIN_DELAY_MS` is the deregistration window consumed INSIDE it, not
 * added to it. The configuration validator caps the budget at 10000 ms
 * precisely because `server/ecosystem.config.js` fixes PM2's `kill_timeout` at
 * 12000 ms, leaving a 2000 ms margin so that the APPLICATION -- not the
 * supervisor -- decides how a drain ends, with its completion line written and
 * its logger flushed. Arming the timer at phase two instead would make the
 * worst case the delay PLUS the budget, which reaches `kill_timeout` exactly
 * and destroys that margin: the process would be `SIGKILL`ed mid-flush and the
 * outcome would go unrecorded. Arming it here caps the entire shutdown at the
 * budget and preserves the margin. The timer is deliberately NOT `unref()`d --
 * it must be able to fire, and until the drain resolves one way or the other
 * it is what holds the event loop open.
 *
 * @param {string} signal The received signal name, recorded on every line of
 *                        the drain and passed through to phase two.
 * @returns {void}
 */
function shutdown(signal) {
  // IDEMPOTENCY, AND WHY THE STATE LIVES IN `lib/lifecycle.js`. The latch is
  // the single source of truth for "is this process draining": this module
  // sets it and the readiness route reads it. `beginShutdown()` returns `true`
  // only for the call that actually began the drain, so a second signal
  // arriving while the first drain is running changes nothing -- two `SIGTERM`s
  // in quick succession produce one drain, not two overlapping ones with two
  // force-exit timers racing each other.
  if (!beginShutdown()) {
    // Recorded at `debug` so the default `info` stream carries exactly one
    // drain-started and one drain-complete line per shutdown, while an
    // operator investigating signal handling can still see the ignored one.
    logger.debug({ signal }, 'Signal ignored; a drain is already under way');
    return;
  }

  logger.info(
    {
      signal,
      drainDelayMs: config.drainDelayMs,
      shutdownTimeoutMs: config.shutdownTimeoutMs
    },
    'Drain started'
  );

  forceExitTimer = setTimeout(() => {
    logger.error(
      { signal, shutdownTimeoutMs: config.shutdownTimeoutMs },
      'Drain budget exhausted; forcing exit'
    );
    terminate(1);
  }, config.shutdownTimeoutMs);

  // PHASE ONE -- DEREGISTRATION, AND WHY THE WINDOW EXISTS.
  //
  // `beginShutdown()` above has already flipped the state, so
  // `GET /health/ready` is answering 503 `{ status: "shutting_down" }` from
  // this instant -- WHILE THE LISTENER IS STILL ACCEPTING. That combination is
  // the entire point. Close the listener immediately instead and the probe can
  // never be answered at all: the connection is REFUSED rather than answered
  // negatively, so a poller learns nothing except that something is wrong, and
  // the 503 half of the readiness contract becomes unreachable code. The
  // window is the interval in which a proxy or supervisor polling readiness
  // observes the negative answer and stops sending new work, before phase two
  // takes the socket away.
  //
  // A window of 0 is a legal, validated configuration -- a single-process
  // deployment with nothing polling readiness has no use for it -- and
  // `setTimeout` handles it as an immediate deferral, so phase two simply runs
  // on the next turn of the loop.
  setTimeout(() => drainAndExit(signal), config.drainDelayMs);
}

/**
 * Tells PM2 this worker is up, over the IPC channel, if there is one to tell.
 *
 * THE PM2 READINESS HANDSHAKE. `server/ecosystem.config.js` sets
 * `wait_ready: true`, which makes PM2 treat a replacement worker as up only
 * once the worker itself says so. Without this message PM2 has nothing to wait
 * for and falls back to waiting out `listen_timeout` -- 8000 ms per worker --
 * before retiring the outgoing worker, so every single reload stalls for no
 * reason while looking successful.
 *
 * Note what the message does NOT do. `wait_ready` is a process-lifecycle gate,
 * not an HTTP routing gate: PM2 is not a proxy withholding traffic from a
 * listening worker, and once `listen()` has resolved the cluster machinery can
 * hand this worker connections. Zero-downtime reload comes from the OVERLAP
 * between a ready replacement and a draining predecessor, not from selective
 * routing.
 *
 * BOTH CONDITIONS BELOW ARE REQUIRED, AND THEY ARE NOT THE SAME CHECK.
 * `typeof process.send === 'function'` asks whether this process was forked
 * with a channel at all -- a directly launched process (`npm start`) has none,
 * and calling `send` there would crash the very start-up it announces.
 * `process.connected` asks whether that channel is still open, which the first
 * test cannot answer: `send` remains a function after a disconnect, and sending
 * on a closed channel does not throw -- it schedules `ERR_IPC_CHANNEL_CLOSED`
 * on the process `error` event (verified on the pinned runtime), where nothing
 * is listening, which is how a routine announcement becomes an unhandled
 * error.
 *
 * The callback is what makes an IPC failure deterministic rather than
 * invisible: with one supplied, a delivery failure arrives here as an argument
 * and is recorded, instead of surfacing asynchronously somewhere else with no
 * indication of which send caused it. A failure is logged and nothing more --
 * the service is listening and serving whether or not PM2 heard about it, and
 * PM2's own `listen_timeout` already covers the case where it did not.
 *
 * @returns {void}
 */
function announceReady() {
  if (typeof process.send !== 'function' || !process.connected) {
    return;
  }

  process.send('ready', undefined, undefined, (error) => {
    if (error) {
      logger.warn(
        { err: error },
        'Readiness message could not be delivered to PM2; the service is listening regardless'
      );
    }
  });
}


/**
 * Builds the application, binds the listener, and installs the process-level
 * handlers.
 *
 * @param {object} [options] Start-up options. Production calls `start()` with
 *                           nothing at all, so the default is the production
 *                           path.
 * @param {import('express').Express} [options.app] A pre-built application to
 *                           serve instead of constructing one. This is the
 *                           seam an out-of-tree harness uses to drive the REAL
 *                           lifecycle -- these signal handlers, this force-exit
 *                           timer, this two-phase drain -- against an app
 *                           carrying routes the service does not ship, rather
 *                           than reimplementing the lifecycle and testing a
 *                           copy of it.
 * @param {Array<Function>} [options.extraRouters] Forwarded verbatim to
 *                           `createApp()`, which mounts the routers after the
 *                           service's own and before the terminal 404 producer.
 *                           Any remaining option is forwarded the same way, so
 *                           this module never has to know the factory's full
 *                           option set.
 * @returns {import('node:http').Server} The bound listener, so a caller can
 *                           read the resolved address or attach its own
 *                           listeners.
 */
function start({ app: providedApp, ...appOptions } = {}) {
  const app = providedApp ?? createApp(appOptions);

  server = http.createServer(app);

  // WHY LISTENER ERRORS ARE CAUGHT ON THE `error` EVENT AND NOT IN THE
  // `listen()` CALLBACK. The listen callback fires only on SUCCESS. A port
  // already in use (`EADDRINUSE`), a privileged port bound without the
  // capability to do so (`EACCES`), or an unassignable host address
  // (`EADDRNOTAVAIL`) all surface as an `error` EVENT on the server instead --
  // so a service that only inspected the callback would report nothing at all
  // and exit zero, looking to PM2 like a worker that started and then vanished.
  // Subscribing before `listen()` is what guarantees the event cannot be
  // emitted before there is something to hear it.
  //
  // This reports through the CONFIGURED LOGGER, not through `fatal()`: by this
  // point configuration has loaded, the logger exists and the record belongs in
  // the same structured stream as everything else. `fatal()` is only for the
  // window before a logger exists.
  server.on('error', (error) => {
    logger.error(
      { err: error, port: config.port, host: config.host },
      'Listener error; exiting'
    );
    terminate(1);
  });

  /*
   * THE PROCESS HANDLERS ARE REGISTERED HERE, INSIDE `start()`, RATHER THAN AT
   * MODULE SCOPE. Merely requiring this module then installs no process-wide
   * handlers and hijacks nobody's signals, which is what lets a harness -- or
   * any future consumer -- import `start` and `shutdown` cleanly and decide for
   * itself when the process layer takes over. Anything that actually runs the
   * service calls `start()`, so the handlers are always installed by the time a
   * signal could matter.
   *
   * They are registered BEFORE `listen()` so that a signal arriving during the
   * bind is handled rather than killing the process outright.
   */
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (error, origin) => {
    handleFatalError(error, origin ?? 'uncaughtException');
  });
  // Node passes `(reason, promise)` here. The promise is deliberately dropped:
  // it serialises to nothing useful, and the origin label is what makes the
  // record distinguishable from an uncaught exception.
  process.on('unhandledRejection', (reason) => {
    handleFatalError(reason, 'unhandledRejection');
  });

  server.listen(config.port, config.host, () => {
    // THE SIGNAL-DURING-BIND PATH, WHICH HAS EXACTLY ONE OUTCOME.
    //
    // `listen()` is asynchronous and the signal handlers above are already
    // installed, so a `SIGTERM` or `SIGINT` can be handled while the bind is
    // still pending -- PM2 stopping a worker that is only just booting is the
    // ordinary way it happens. The drain then begins, and THIS callback can
    // still run afterwards. Announcing a listening service and advertising
    // readiness from here would be false on both counts: the readiness probe is
    // already answering 503, the listener is scheduled to close, and PM2 --
    // whose `wait_ready` gate is satisfied by the message alone -- would mark
    // the worker up and retire a healthy predecessor in favour of one that is
    // on its way out. The drain already owns this process from that point, so
    // the only correct thing to do here is record the collision and leave it
    // alone.
    if (isShuttingDown()) {
      logger.warn(
        {
          port: config.port,
          host: config.host,
          environment: config.nodeEnv
        },
        'Listener bound after a drain began; readiness withheld and the drain continues'
      );
      return;
    }

    // The cluster instance is deliberately NOT restated here. `lib/logger.js`
    // stamps `instance` -- along with `pid` and `service` -- onto EVERY record
    // through pino's `base`, so this line already carries it; adding it to the
    // payload as well emitted a duplicate JSON key (measured: `"instance":0`
    // twice on the same line), which a strict parser is entitled to reject and
    // a reader is entitled to distrust. Port, host and environment are not in
    // `base`, so they belong here.
    logger.info(
      {
        port: config.port,
        host: config.host,
        environment: config.nodeEnv
      },
      'Service listening'
    );

    announceReady();
  });

  return server;
}

/*
 * The public surface is exactly these two functions: one to bring the process
 * up, one to take it down. Assigned before the entry-point guard below so that
 * the exports exist however this module is reached.
 */
module.exports = { start, shutdown };

/*
 * THE ENTRY-POINT GUARD. When this file is the process's main module -- `pm2
 * start ecosystem.config.js` resolving `script: 'src/server.js'`, or
 * `npm start` running `node src/server.js` -- the service boots. When it is
 * merely required, the guarantee is narrower and worth stating exactly: NO
 * LISTENER IS BOUND, NO PROCESS HANDLERS ARE INSTALLED, and no lifecycle path
 * runs. That is what lets an out-of-tree harness require this module, hand
 * `start()` an app with its own injected routes, and exercise the real
 * lifecycle without a second listener racing it or a stray signal handler
 * hijacking its process.
 *
 * WHAT REQUIRING IT DOES DO, because "no side effects" would be false and the
 * difference decides how a check has to be run. Reaching this line has already
 * evaluated the configuration module -- which reads `.env`, validates the
 * environment and freezes the result -- built the process-wide pino instance
 * together with its destination, whose shape was chosen then and there from the
 * environment and from who owns standard output, and, outside production, its
 * pino-pretty pipeline, and initialised `app.js` and the router and middleware
 * singletons it caches. All of that is module-level state, cached by
 * CommonJS's own module registry and not reconstructed on a second `require`.
 * So a check that varies the environment, or that drives a drain to its exit,
 * MUST run in its own process: within one process the configuration is frozen
 * from the first require, the logger's destination cannot be re-chosen, and the
 * lifecycle latch in `lib/lifecycle.js` is deliberately one-way with no reset.
 */
if (require.main === module) {
  start();
}
