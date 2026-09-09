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
 *     and on reload. The process is healthy, so it drains in two phases:
 *     deregister while still accepting, then stop accepting and finish what is
 *     already in flight. The guarantee is bounded rather than absolute --
 *     requests that finish inside `SHUTDOWN_TIMEOUT_MS` finish, and a handler
 *     still executing when that budget expires is terminated by the force exit.
 *   * `handleFatalError(error, origin)` -- for `uncaughtException` and
 *     `unhandledRejection`. The process state is undefined, so it stops serving
 *     synchronously -- latch the drain state, close the listener, destroy every
 *     socket -- and then exits. No deregistration window, and no waiting on
 *     work in flight.
 *
 * Both converge on `terminate(code)`, the one place the mandatory
 * log -> flush -> disconnect -> exit sequence is implemented. It latches one
 * terminal outcome, so a later caller can neither replace it nor start a
 * competing exit; it awaits the flush through its callback and acts on a
 * failure the flush reports; and it bounds that wait by whatever remains of
 * `SHUTDOWN_TIMEOUT_MS`, so nothing is ever added to the budget an operator
 * set and the exit can never hang. At the budget boundary the remainder is
 * zero, so the final record is handed over without waiting for its report and
 * the non-zero exit status carries the outcome instead -- the trade is stated
 * in full on `terminate()`. `lib/logger.js` supplies the other half: a
 * destination whose flush
 * reports a fact rather than a formality -- writing synchronously where this
 * process owns standard output, and reporting each write's completion where a
 * supervisor owns it.
 *
 * One branch cannot use `terminate()` and has its own helper. A configuration
 * failure happens before the logger exists, so `fatalExit(payload, code)`
 * writes one record to this process's standard error and then performs the
 * same IPC release and explicit exit. That is the ONLY use of the logger-free
 * writer: every failure after configuration -- a listener error, a drain that
 * ends badly, an unrecoverable fault, a flush that reports a failure -- is
 * reported through the configured logger, so the service has one structured
 * stream rather than two competing ones. Every terminal branch in this file
 * goes through one of those two helpers, and both end in a `finally` so
 * nothing can leave the process running with its outcome unrecorded.
 *
 * @module server
 */

'use strict';

/*
 * Node built-ins, required before anything else. There are two, each needed
 * for one specific reason, and no external package is required anywhere in
 * this file:
 *
 *   * `node:fs`   -- `fs.writeSync()` is how `fatal()` puts a record on file
 *                    descriptor 2 when nothing outside this process owns
 *                    standard error, with no logger and no stream buffering in
 *                    the way.
 *   * `node:http` -- the listener is created explicitly rather than via
 *                    `app.listen()` so that its `error` event can be
 *                    subscribed to BEFORE `listen()` is ever called. See the
 *                    error handler in `start()` for why that ordering matters.
 *
 * `node:util` is deliberately absent. Rendering a thrown value with
 * `util.inspect()` into a log message is what put arbitrary rejected objects
 * -- request bodies, headers, configuration, credentials -- into fatal records
 * in clear text, past the logger's structured-field redaction. The reduction
 * of a thrown value belongs to the root error policy in `lib/logger.js`, which
 * bounds it; see `handleFatalError()`.
 */
const fs = require('node:fs');
const http = require('node:http');

/**
 * Whether something outside this process owns standard error.
 *
 * WHY THE QUESTION DECIDES WHERE THE RECORD LANDS, AND WHY GETTING IT WRONG IS
 * INVISIBLE. PM2 runs each worker inside a wrapper that REPLACES
 * `process.stderr.write` with its own function: that function forwards the line
 * to the PM2 daemon and writes it to the `error_file` the descriptor names. The
 * worker's own file descriptor 2 is inherited from the daemon and belongs to
 * the daemon's own log, not to `logs/error.log`. Measured from inside a PM2
 * 7.0.4 cluster worker: `fs.writeSync(2, ...)` appears in `$PM2_HOME/pm2.log`,
 * while the same line written through `process.stderr` appears in
 * `logs/error.log` -- which is the destination `server/ecosystem.config.js`
 * declares and the runbook tells an operator to read. Writing to the
 * descriptor under a supervisor therefore files the one record that explains a
 * refused start-up in the one place nobody was told to look.
 *
 * The test is the one `lib/logger.js` uses for the same purpose on standard
 * output: an untouched stream's `write` is the one on its constructor's
 * prototype, and a supervisor that has installed a hook no longer satisfies
 * that. It is evaluated once at load, which is safe because PM2 installs its
 * hooks before it requires the application script.
 *
 * @type {boolean}
 */
const stderrIsSupervised =
  process.stderr.write !== process.stderr.constructor.prototype.write;

/*
 * THERE IS NO TIMING CONSTANT IN THIS FILE, AND THAT IS DELIBERATE.
 *
 * Every duration this module waits comes from the frozen configuration object:
 * `config.drainDelayMs` for the deregistration window and
 * `config.shutdownTimeoutMs` for the total drain budget, both validated in
 * `src/config/index.js` against each other and against PM2's `kill_timeout`.
 * A local constant here -- however well commented -- would be a third
 * shutdown-budget value that no validator relates to the other two, so the
 * relationship could be inverted by editing one file and nothing would say so.
 *
 * What that costs is stated where it is paid: `terminate()` bounds its flush by
 * whatever remains of the budget rather than by a reserve of its own, so at the
 * budget boundary itself there is nothing left to wait inside, and the final
 * record is handed to the destination without waiting for its report. The
 * non-zero exit status is the signal that survives that, and `terminate()` says
 * so at length.
 */

/**
 * Writes one JSON object to this process's standard error, using no logger and
 * no transport.
 *
 * WHY THIS EXISTS AT ALL, AND WHY IT IS DELIBERATELY PRIMITIVE. A
 * configuration failure happens *before any logger exists* -- `lib/logger.js`
 * reads its level, identity and transport decision from the very
 * configuration module that just refused to load -- and that is precisely the
 * moment an operator most needs a legible message. Rather than let the failure
 * surface as a raw, multi-line stack trace from a failed `require`, this
 * function renders it as a single parseable record on the one stream that is
 * guaranteed to exist.
 *
 * FOR CONFIGURATION VALIDATION FAILURES, AND FOR NOTHING ELSE. Every failure
 * after configuration goes through the configured logger -- a listener error, a
 * drain that ends badly, an unrecoverable fault, and a terminal flush that
 * reports a failure -- so that the service has exactly one structured log
 * stream rather than two competing ones. The property that admits this single
 * use is that no usable logger exists at the instant of writing, and that is
 * true only in the window before the configuration module has returned. Do not
 * widen it: a second writer for post-configuration failures is how a stream an
 * operator greps stops being the whole story.
 *
 * TWO WAYS TO WRITE ONE RECORD, AND THE CHOICE IS NOT A PREFERENCE. Where a
 * supervisor owns standard error the line must go through its stream, because
 * that is the stream it collects into the `error_file` the PM2 descriptor
 * declares (see `stderrIsSupervised` above for what happens when it does not).
 * A supervisor's write is queued rather than complete when it returns, so the
 * callback is how a caller learns the bytes were accepted -- which matters
 * because the process is on its way out and an exit does not drain a queued
 * write. Where nothing owns standard error -- `npm start`, a developer's
 * terminal -- `fs.writeSync` hands the bytes to descriptor 2 before it returns,
 * so there is nothing to wait for and no callback is registered. A caller that
 * cannot wait gets that synchronous write in either case, which is why the
 * branch tests for a callback as well as for supervision.
 *
 * @param {object} payload A plain, JSON-serialisable object. It must be flat
 *                         enough to survive `JSON.stringify` and small enough
 *                         to read at a glance.
 * @param {(error?: Error) => void} [onWritten] Invoked once, when a
 *                         supervisor's stream reports the write accepted or
 *                         failed. Omit it when the caller cannot wait: the
 *                         record is then written synchronously to descriptor 2
 *                         instead.
 * @returns {boolean} `true` when the record was handed to a supervisor's stream
 *                    and `onWritten` will report its completion; `false` when
 *                    the record has already been written synchronously and
 *                    there is nothing left to wait for.
 * @throws {Error} When the payload cannot be serialised -- a circular
 *                 reference, or a `BigInt` -- or when the synchronous write
 *                 itself fails, which `fs.writeSync` reports by throwing
 *                 (`EBADF` on a closed descriptor, for instance). Callers
 *                 deliberately guard this: a process must still exit with the
 *                 status it was ending on even when its last words cannot be
 *                 written anywhere.
 */
function fatal(payload, onWritten) {
  // `JSON.stringify` escapes any newline inside a value, so the record is
  // always exactly one line however ugly the underlying error message -- or
  // stack -- was. That is what keeps it parseable by the same line-at-a-time
  // tooling that reads the service's ordinary output.
  const line = `${JSON.stringify(payload)}\n`;

  if (stderrIsSupervised && typeof onWritten === 'function') {
    // Three arguments, not two, and this is load-bearing under PM2: its
    // replacement for `process.stderr.write` has the signature
    // `(string, encoding, callback)` and forwards only its third argument to
    // the file it writes, so handing the callback in second would leave the
    // caller waiting for a completion report that was never going to arrive.
    process.stderr.write(line, undefined, onWritten);
    return true;
  }

  fs.writeSync(2, line);
  return false;
}

/**
 * Ends the process from inside the pre-logger window: write the record,
 * release the PM2 IPC channel if there is one, exit.
 *
 * WHY THIS EXISTS SEPARATELY FROM `terminate()`. `terminate()` flushes the
 * configured logger, and in this window there is no configured logger to
 * flush -- the module that would have built it reads the configuration that
 * just refused to load. What the two paths DO share is the obligation to
 * release the IPC channel before exiting: PM2 attaches a channel to every
 * worker before any application code runs, and disconnecting closes it
 * deliberately rather than leaving the supervisor to notice a peer that
 * vanished. The disconnect is cleanup, not the termination -- the explicit
 * `process.exit()` below ends the process whether or not a channel is open --
 * and this helper is what keeps the pre-logger branch from being the one exit
 * path that skips the step.
 *
 * THE EXIT IS DRIVEN BY THE RECORD, WHICH IS THE ONLY REASON THIS PROCESS IS
 * STILL RUNNING. Where a supervisor owns standard error the write is queued
 * rather than complete when it returns, so exiting on the next statement would
 * discard the one line that explains why this worker refused to start --
 * measured under PM2 7.0.4: with an immediate exit, `logs/error.log` was empty.
 * The exit therefore happens from the write's completion callback. Where
 * nothing owns standard error the bytes are already on descriptor 2 and the
 * exit happens at once.
 *
 * NO TIMER BOUNDS THAT WAIT, AND THE REASON IS THAT NOTHING HERE COULD SUPPLY
 * ITS DURATION HONESTLY. This runs because the configuration module refused to
 * load, so there is no validated budget to draw a bound from, and inventing one
 * would put a third shutdown-budget value in the file with no validator
 * relating it to `SHUTDOWN_TIMEOUT_MS` or `kill_timeout`. What stands in for it
 * is a contract rather than a guess: `Writable.write(chunk, encoding, callback)`
 * must invoke that callback with either an error or nothing, and PM2's stderr
 * hook forwards it to exactly such a write (verified against 7.0.4 -- the
 * callback arrived in 1 ms). The residual is worth naming: a supervisor that
 * accepted the chunk and never reported would leave this process waiting on it,
 * so the diagnosis would be sitting in a queue rather than in the file. That is
 * the trade this branch makes -- a record that reaches the operator, against a
 * bound no honest value exists for.
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
 * @returns {void} Returns while the exit is still pending when the record went
 *                 to a supervisor's stream: the process then ends from that
 *                 write's completion callback. Where the record was written
 *                 synchronously it does not return at all.
 */
function fatalExit(payload, exitCode) {
  let ended = false;

  /**
   * Performs the last two steps, once.
   *
   * Guarded rather than assumed single-entry: it is reachable both directly,
   * when the record was written synchronously, and from a supervisor's write
   * callback, and a second entry must not disconnect an already-disconnected
   * channel on its way to an exit that has already been requested.
   *
   * @returns {void} Never returns -- `process.exit()` runs before it can.
   */
  const end = () => {
    if (ended) {
      return;
    }

    ended = true;

    try {
      // `process.connected` rather than a check that `disconnect` merely
      // exists: the method is present on any forked process, including one
      // whose channel has already gone, and calling it then throws.
      if (process.connected) {
        process.disconnect();
      }
    } catch (error) {
      // Losing the cleanup must not lose the diagnosis, so the failure is
      // recorded on the same stream by the same writer -- with no callback,
      // because nothing is left to wait with once the exit below is a
      // statement away. A throw from this last record must not pre-empt that
      // exit either, which is what the inner guard is for.
      try {
        fatal({
          level: 'fatal',
          time: Date.now(),
          pid: process.pid,
          code: 'ERR_PRELOGGER_TERMINATION',
          msg: 'Pre-logger termination could not complete cleanly; exiting anyway',
          err: error instanceof Error ? error.message : String(error)
        });
      } catch {
        // Standard error has itself gone, so there is nowhere left to say so.
        // The exit in the `finally` is the only thing that still matters, and
        // it is not conditional on this record.
      }
    } finally {
      process.exit(exitCode);
    }
  };

  let completionPending = false;

  try {
    completionPending = fatal(payload, end);
  } catch {
    // The record could not be written at all -- an unserialisable payload, or a
    // standard error that is gone. That changes nothing about what has to
    // happen next: this process must still exit with the status it was ending
    // on rather than continue as a service that never validated its
    // environment.
    completionPending = false;
  }

  if (!completionPending) {
    end();
    return;
  }

  // Nothing further to do: the queued write holds the event loop open, and its
  // completion callback is `end`. Setting `process.exitCode` as well means that
  // if the loop were somehow to empty without that callback arriving -- the
  // write vanishing rather than reporting -- this process still ends non-zero
  // rather than looking like a clean start-up that produced no service.
  process.exitCode = exitCode;
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
    // stack is carried rather than discarded.
    payload.stack = error.stack;
  }

  fatalExit(payload, 1);

  // THE RETURN IS LOAD-BEARING, AND IT IS NOT DEFENSIVE TIDINESS. `fatalExit()`
  // does not always end the process before it returns: where a supervisor owns
  // standard error it hands the record to that stream and exits from the
  // write's completion callback, a fraction of a millisecond later. Without
  // this `return`, module evaluation would carry on into the requires below --
  // and `lib/logger.js` requires the configuration module, whose evaluation
  // has already failed, so CommonJS re-evaluates it and it throws the SAME
  // validation error a second time, this time outside the guard: the operator
  // gets a raw stack trace after the record, and the exit status becomes
  // whatever the runtime makes of an uncaught throw at module load. Measured
  // under PM2 7.0.4 before this guard existed: the worker produced no record
  // at all and PM2 reported exit code 0 -- an invalid configuration looking
  // like a clean stop.
  //
  // A top-level `return` is legal in CommonJS -- the module body is a function
  // -- and it is the only construct that stops evaluation here without throwing
  // something an operator would have to read past. The exports below are
  // therefore never assigned on this path, which is correct: a process that
  // failed configuration has no lifecycle to offer, and the exit is already
  // committed.
  return;
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
 * The HTTP listener, held in module scope because `shutdown()`,
 * `drainAndExit()` and the fatal path all need the same instance `start()`
 * created.
 *
 * `null` until `start()` runs, which is a state every terminal path handles
 * explicitly rather than assuming away.
 *
 * @type {import('node:http').Server|null}
 */
let server = null;

/**
 * Whether that listener is actually listening.
 *
 * WHY EXISTENCE IS NOT THE SAME QUESTION, AND WHY CONFLATING THEM COSTS AN
 * EXIT CODE. `server` becomes non-null the instant `http.createServer()`
 * returns, which is well before `listen()` has bound anything -- and the signal
 * handlers are installed before `listen()` is called, deliberately, so that a
 * signal arriving during the bind is handled rather than killing the process
 * outright. A drain that inferred "listening" from "non-null" would therefore
 * call `server.close()` on a listener that had never opened, and Node answers
 * that with `ERR_SERVER_NOT_RUNNING` in the close callback (verified on the
 * pinned runtime) -- which the drain would read as a failed close, turning an
 * expected operator stop into exit 1. This flag is set from the `listening`
 * event and cleared the moment a close is requested, so every terminal path
 * knows which of the two situations it is in.
 *
 * @type {boolean}
 */
let listening = false;

/**
 * The instant the drain budget expires, as an absolute `Date.now()` value, or
 * `null` while no drain is under way.
 *
 * The whole shutdown is measured against this one instant rather than against
 * a chain of relative delays, so the terminal sequence can ask how much of the
 * budget is left instead of assuming it has any.
 *
 * @type {number|null}
 */
let drainDeadline = null;

/**
 * The timer that ends the drain when its budget is spent, armed at signal
 * receipt and cleared when the listener closes in time.
 *
 * @type {NodeJS.Timeout|null}
 */
let forceExitTimer = null;

/**
 * The status this process has committed to exiting with, or `null` while no
 * terminal outcome has been decided.
 *
 * WHY THE OUTCOME IS LATCHED RATHER THAN CARRIED BY WHOEVER EXITS. Two
 * terminal events can genuinely race: the force point decides the drain has
 * overrun and begins ending the process with status 1, and the last in-flight
 * request then finishes, so `server.close()` calls back reporting a clean
 * drain. Letting the later caller supply the status would report an
 * over-budget, forcibly terminated drain as a clean stop -- a failure that
 * reads as a success in the log, in the exit code and in `pm2 status` alike.
 * The latch resolves it by severity rather than by arrival: the first outcome
 * stands, and only an escalation from `0` to non-zero may replace it. A
 * non-zero status is never downgraded.
 *
 * @type {number|null}
 */
let terminalExitCode = null;

/**
 * Whether `terminate()` has already begun the
 * log -> flush -> disconnect -> exit sequence.
 *
 * A re-entry guard rather than a status flag. Every exit path funnels through
 * one function, and that sequence is asynchronous while a supervisor's stream
 * is reporting the flush, so a second exit request can genuinely arrive while
 * the first is still in flight: the race described on `terminalExitCode`, a
 * `SIGTERM` during a fatal exit, or an exception thrown by the flush itself,
 * which would reach the `uncaughtException` handler and terminate again,
 * flushing again, unbounded. Every entry after the first records its outcome
 * and returns, leaving the sequence already under way to end the process
 * exactly once.
 *
 * @type {boolean}
 */
let terminating = false;

/**
 * Records the status this process will exit with, keeping the more severe of
 * what is already latched and what a caller is now reporting.
 *
 * The rule is severity, not arrival order. The first outcome stands, and only
 * an escalation from `0` to a non-zero status may replace it, so a
 * close-success arriving after a forced timeout cannot report the drain as
 * clean. Two non-zero outcomes keep the first, because the first is the one
 * that explains the second -- a forced timeout followed by a close error is one
 * story, not two.
 *
 * @param {number} exitCode The status the calling terminal path is reporting.
 * @returns {void}
 */
function latchTerminalOutcome(exitCode) {
  if (terminalExitCode === null || (terminalExitCode === 0 && exitCode !== 0)) {
    terminalExitCode = exitCode;
  }
}

/**
 * How long the terminal sequence may wait for the logger's flush, in
 * milliseconds, taken entirely from the validated configuration.
 *
 * DURING A DRAIN IT IS WHATEVER IS LEFT OF THE BUDGET, AND NOTHING MORE.
 * `SHUTDOWN_TIMEOUT_MS` is the total budget for ending this process, capped at
 * 10000 ms by the configuration validator against PM2's `kill_timeout` of
 * 12000 ms. Measuring the remainder against the deadline the signal set is what
 * makes the flush a use of that budget rather than an addition to it: an
 * ordinary drain that closed early has seconds of it left and the final record
 * lands comfortably; a drain that ran to its boundary has none left, and
 * `terminate()` then hands the record over without waiting for its report.
 * Zero is therefore a legitimate answer and not a refusal to flush -- a
 * synchronous destination still reports inside the flush call itself, before
 * anything could have waited.
 *
 * WITH NO DRAIN UNDER WAY -- a listener error, or a fatal fault -- the same
 * validated budget is the ceiling, measured from now. It is a ceiling and not a
 * delay: the process exits the instant the destination reports, which is inside
 * the flush call on a synchronous sink and about a millisecond under PM2. What
 * the ceiling buys is that a destination which reports NEITHER completion nor
 * failure cannot turn an exit into a hang, and it buys it without introducing a
 * timing value of this module's own.
 *
 * @returns {number} Milliseconds the flush may take, never negative.
 */
function terminalFlushBudgetMs() {
  if (drainDeadline === null) {
    return config.shutdownTimeoutMs;
  }

  return Math.max(0, drainDeadline - Date.now());
}

/**
 * Disarms the drain's force timer once the drain has resolved on its own.
 *
 * Clearing it is not tidiness. While it is armed the timer holds the event loop
 * open, and while it is armed it can still fire and report a forced timeout on
 * a drain that had already finished.
 *
 * The deadline itself is deliberately NOT cleared: it is what
 * `terminalFlushBudgetMs()` measures against, so the whole shutdown -- final
 * record included -- stays inside the budget the signal started.
 *
 * @returns {void}
 */
function clearForceExitTimer() {
  if (forceExitTimer !== null) {
    clearTimeout(forceExitTimer);
    forceExitTimer = null;
  }
}

/**
 * The last two steps of every exit: release the PM2 IPC channel, then exit
 * with the given code.
 *
 * WHY THE DISCONNECT IS HERE, AND WHAT IT IS NOT. It is cleanup: PM2 attaches
 * an IPC channel to every worker before any application code runs, and
 * disconnecting closes that channel deliberately instead of leaving the
 * supervisor to notice a peer that vanished. It is NOT what ends the process --
 * the explicit `process.exit()` below does that, and it does so whether or not
 * a channel is still open and whatever work is still pending. Keeping the two
 * apart matters because they are easy to conflate, and the conflation hides a
 * real measurement: a referenced IPC channel can keep a process alive when
 * NOTHING calls exit, which is why a PM2 cluster worker that had finished its
 * drain and was left to let its event loop empty did NOT exit -- it lingered
 * until PM2 `SIGKILL`ed it at `kill_timeout`, turning a clean 2.2-second
 * shutdown into a 12-second kill that PM2 reports as a failure. That is an
 * argument for calling exit explicitly, which this service always does; it is
 * not a claim that an open channel could delay an exit already under way.
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
 * @returns {void} Never returns -- `process.exit()` runs before it can.
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
 * Ends the process: latch the outcome, flush the logger, release the PM2 IPC
 * channel, exit.
 *
 * THIS SEQUENCE IS THE DETAIL MOST LIKELY TO BE SIMPLIFIED AWAY, AND EVERY
 * STEP IS MANDATORY. Each guards a different failure, and each failure still
 * looks correct in the source:
 *
 *   * THE LATCH keeps one terminal outcome for the whole process. See
 *     `terminalExitCode`: a close-success arriving after a forced timeout must
 *     not report an over-budget drain as a clean stop, and a second caller must
 *     not start a competing exit that abandons the flush already in flight.
 *   * THE FLUSH gets the record the caller just wrote out of pino's hands
 *     before the process disappears. `process.exit()` does not drain a queued
 *     destination, so with a supervisor's stream the final line -- the one
 *     recording HOW the process ended -- is lost, and a drain that completed
 *     becomes indistinguishable from one that was killed. That final record is
 *     frequently the only diagnostic there will ever be, because on the fatal
 *     path the process is gone before anything else can ask it a question.
 *   * THE DISCONNECT AND EXIT are cleanup and termination respectively, for the
 *     reasons given on `releaseIpcAndExit()` above.
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
 * the point at which the line has been accepted into `logs/out.log`. Either way
 * the flush also reports a FAILURE if the sink had one, which `finish()` below
 * acts on. A destination without that construction -- an asynchronous
 * sonic-boom, or a worker-thread transport -- would invoke this callback late,
 * once, or, as was measured with `transport: { target: 'pino-pretty' }`, never.
 * The two files are one repair and must stay in step.
 *
 * WHY THE WAIT IS BOUNDED, WHERE THE BOUND COMES FROM, AND WHAT IT COSTS AT
 * THE BOUNDARY. Because the flush is awaited, a destination that reports
 * nothing at all would hold the process open until PM2 `SIGKILL`ed it, turning
 * a clean stop into a reported failure. The bound is `terminalFlushBudgetMs()`,
 * which is the validated `SHUTDOWN_TIMEOUT_MS` and nothing else: during a drain
 * it is the remainder of that budget, and otherwise the budget itself. Nothing
 * is ever added to a budget an operator set, and no timing value of this
 * module's own participates in the relationship the configuration validator
 * enforces.
 *
 * The honest consequence is at the boundary. When the force point fires, the
 * budget is spent, so the remainder is zero: the overrun record is handed to
 * the destination and this sequence exits WITHOUT waiting for its report. On a
 * synchronous destination that costs nothing -- the report comes back inside
 * the flush call. On a supervisor's stream the record may not reach the log
 * file, and the non-zero exit status is then the signal that survives, which is
 * why the status is latched rather than recomputed and why the runbook tells an
 * operator to read a missing completion line together with a non-zero exit. The
 * alternative -- reserving part of the budget for the flush -- would take that
 * time away from the handlers the budget exists to protect, and the AAP gives
 * the whole of it to them.
 *
 * Whichever of the callback and the bound arrives first wins, so the exit is
 * never later than the budget and never earlier than a flush that had budget to
 * complete in. A synchronous throw from the flush takes the same route as a
 * reported failure, so no path can end here without exiting.
 *
 * Callers log their own message immediately before calling this; it writes no
 * record of its own, so that the reason for an exit always reads in the
 * caller's words.
 *
 * @param {number} exitCode The status this caller is ending on: `0` for a drain
 *                          that completed, non-zero for every other ending --
 *                          a force-timeout, a listener error, or an
 *                          unrecoverable fault. It is latched rather than
 *                          applied directly, so a non-zero status already
 *                          recorded is never replaced by a later `0`.
 * @returns {void} Returns while the exit is still pending. On a supervised
 *                 destination the process ends from the flush callback or from
 *                 the bound, and a re-entrant call returns immediately, leaving
 *                 the sequence already under way to end the process exactly
 *                 once.
 */
function terminate(exitCode) {
  latchTerminalOutcome(exitCode);

  if (terminating) {
    // A second exit request while the first sequence is in flight, and it must
    // NOT exit from here. Exiting would abandon the flush that is still
    // running and discard the record it was getting out -- and, if this caller
    // were the close-success arriving after a forced timeout, it would exit 0
    // on a drain that had already failed. The outcome was latched above, so
    // the sequence already under way ends the process with the right status.
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
   * introduced to prevent, wearing the appearance of a fix.
   *
   * WHAT A FLUSH FAILURE DOES INSTEAD, AND WHY IT IS NOT THE PRE-LOGGER
   * WRITER'S JOB. The failure is reported through the configured logger, like
   * every other post-configuration failure, and the exit status is escalated to
   * non-zero. The escalation is the load-bearing half: the thing that failed is
   * the log stream, so a record about it is the record most likely to be lost,
   * and an exit code cannot be lost. That is what makes a broken log
   * destination visible in `pm2 status` and in a supervisor's exit report even
   * when the line explaining it never arrives. Routing this to the logger-free
   * stderr writer instead would give the service a second competing stream for
   * post-configuration failures, which is exactly the scope `fatal()` refuses.
   *
   * @param {Error} [flushFailure] What the destination reported, if it reported
   *                        a failure, or the bound's own expiry.
   * @returns {void} Never returns -- `releaseIpcAndExit()` exits before it can.
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

    if (flushFailure) {
      latchTerminalOutcome(1);

      try {
        logger.error(
          {
            err: flushFailure instanceof Error
              ? flushFailure
              : new Error(String(flushFailure)),
            code: 'ERR_TERMINAL_FLUSH'
          },
          'The final log records could not be flushed; the account of how ' +
            'this process ended may be incomplete'
        );
      } catch {
        // The log call itself threw on a destination that had already failed.
        // There is nothing further to try -- flushing again is how a controlled
        // exit turns into a loop -- and the escalated status below is what
        // carries the failure out of this process regardless.
      }
    }

    releaseIpcAndExit(terminalExitCode ?? exitCode);
  };

  const flushBudgetMs = terminalFlushBudgetMs();

  if (flushBudgetMs > 0) {
    // Deliberately NOT `unref()`d. This timer is what holds the event loop open
    // until the termination resolves; unreferenced, an otherwise idle loop would
    // let the process exit on its own with status 0 and quietly discard the
    // non-zero code a force-exit, listener error or fatal fault was reporting.
    drainTimer = setTimeout(() => {
      finish(new Error(
        `the log destination reported neither completion nor failure within ${flushBudgetMs} ms`
      ));
    }, flushBudgetMs);
  }

  try {
    logger.flush(finish);
  } catch (error) {
    // A flush that throws synchronously must not become an uncaught exception
    // on the way out -- that would re-enter the fatal handler. It is the same
    // outcome as a reported failure, so it takes the same path.
    finish(error instanceof Error ? error : new Error(String(error)));
  }

  // No budget left to wait inside, and the flush did not report synchronously:
  // the record has been handed to the destination and this process goes now.
  // Deliberately NOT reported as a flush failure -- nothing failed, there was
  // simply nothing left of the budget to wait in, and labelling that an
  // `ERR_TERMINAL_FLUSH` would raise a log-durability alarm on every ordinary
  // forced timeout. `finish()` is a no-op if the flush already settled inside
  // the call above, which is what happens on a synchronous destination.
  if (flushBudgetMs === 0) {
    finish();
  }
}

/**
 * Stops this process serving HTTP, synchronously and irreversibly.
 *
 * WHY IT IS SYNCHRONOUS, AND WHY THAT IS THE WHOLE POINT. It runs on the fatal
 * path, where the process state is undefined and the only safe thing left is
 * to stop being a server. Every step completes before this function returns
 * and before anything can yield to the event loop: the drain latch flips, so
 * `GET /health/ready` answers 503 and no PM2 readiness message can be sent;
 * the listener stops accepting; and every socket -- idle or mid-request -- is
 * destroyed. Nothing that follows can therefore be paid for in requests served
 * by a process that has already failed, however long the terminal record takes
 * to report.
 *
 * `closeAllConnections()` rather than `closeIdleConnections()`, and that is
 * exactly what separates this from the orderly drain: a request in flight here
 * is being served by an unknown-state process, so finishing it is not a
 * kindness. `drainAndExit()` makes the opposite choice for the opposite reason.
 *
 * Both calls are safe on a listener that was never bound and on one already
 * closing -- no-ops rather than throws, verified on the pinned runtime -- which
 * is what lets the fatal path run at any point in the process's life without
 * having to test how far start-up got. A failure is nevertheless recorded
 * rather than assumed impossible, because abandoning the fatal record would
 * cost more than a listener that could not be closed.
 *
 * @returns {void}
 */
function stopServingImmediately() {
  // `beginShutdown()` reports whether this call flipped the latch. Nothing here
  // needs the answer: on this path the process is ending either way, and the
  // only thing that matters is that the latch is set before anything yields.
  beginShutdown();

  listening = false;

  if (server === null) {
    return;
  }

  try {
    server.close();
    server.closeAllConnections();
  } catch (error) {
    // Recorded, not swallowed, and deliberately not rethrown: a rethrow here
    // would re-enter the very handler that called this and abandon the record
    // of the original fault. A listener that cannot be stopped is information
    // for whoever reads the log; the exit that follows happens regardless.
    logger.error(
      { err: error },
      'Could not stop the listener on the fatal path; exiting regardless'
    );
  }
}

/**
 * The fatal path: stop serving, record an unrecoverable fault, and exit.
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
 * WHAT "IMMEDIATELY" MEANS HERE, EXACTLY, AND WHY STOPPING COMES FIRST. This
 * path skips the drain entirely: no deregistration window, no waiting on
 * requests in flight. The one thing it waits for is the terminal log barrier in
 * `terminate()`, and how long that takes is a property of the destination.
 * Where this process owns standard output -- a direct run, and every
 * non-production run -- the sink writes synchronously and the flush callback
 * fires inside the flush call, so the process exits in the tick the fault
 * arrived. Where a supervisor owns standard output -- production under PM2 --
 * it waits for that one write to report completion, which was a single
 * millisecond when measured; it is a log write rather than a drain, and it is
 * the difference between an operator seeing why the worker died and seeing
 * nothing at all. `SHUTDOWN_TIMEOUT_MS` is the ceiling on that wait and not a
 * delay within it -- no fatal exit spends it, and its only job is to stop a
 * destination that reports NOTHING from turning this exit into a hang, since a
 * hung worker is one PM2's `autorestart` cannot replace.
 *
 * A wait, however short, is still a wait -- so `stopServingImmediately()` runs
 * BEFORE it, synchronously. That ordering is the difference between a worker
 * writing its last line and a worker still accepting and executing requests
 * while it does so, with its state already undefined. It is not an
 * optimisation, and it must not be reordered or made conditional.
 *
 * WHAT THE RECORD CARRIES, AND WHAT IT DELIBERATELY DOES NOT (CWE-532). A
 * GENUINE `Error` is handed to the logger as `err` and reduced there by the
 * root error policy in `lib/logger.js` -- type, message, stack, code, status,
 * and nothing else. ANYTHING ELSE IS NOT PASSED AS `err` AT ALL, and that
 * asymmetry is the point rather than an oversight:
 *
 *   * Rendering the value into the message here -- which this path used to do
 *     with `util.inspect` -- serialised any rejected object whole into a field
 *     the policy preserves.
 *   * Handing the raw value over as `err` is not sufficient either. The error
 *     policy renders a non-object value's own content, and it copies `message`
 *     and `stack` from ANY object that has them -- so a rejected string, or an
 *     object carrying attacker- or caller-controlled `message`/`stack`
 *     properties, still reaches the log in clear text.
 *
 * Since any value can be thrown or used to reject, that content can be a
 * request body, a set of headers, a configuration object or a live credential,
 * and logs are copied, shipped and retained far more freely than the data they
 * describe -- one such record outlives the request by a long way. So a
 * non-`Error` contributes exactly one thing to the record: `errorType`, the
 * kind of value that arrived, drawn from `typeof` and therefore one of a fixed
 * set of words. What locates the defect is `origin` plus the code, not the
 * value: a rejection that is not an `Error` is a programming fault, and the
 * fault is in the code that produced it.
 *
 * @param {unknown} error  The thrown value or rejection reason. Only passed to
 *                         the logger when it is a genuine `Error`; any other
 *                         value -- including `null` and `undefined` -- is
 *                         reported by kind alone.
 * @param {string}  origin Where the fault surfaced -- `'uncaughtException'` or
 *                         `'unhandledRejection'`. Recorded so the two are
 *                         still distinguishable in the log even though the
 *                         policy is one.
 * @returns {void} Returns while the exit is still pending: `terminate()` ends
 *                 the process from the flush callback or from its bound. By the
 *                 time it returns this process is already serving nothing.
 */
function handleFatalError(error, origin) {
  stopServingImmediately();

  // `errorType` carries the value's KIND and never its content: `typeof`
  // yields one of a fixed set of words, and `null` is spelled out because
  // `typeof null` is the useless `'object'`. It is the whole of what a
  // non-`Error` contributes, and for a genuine `Error` it says which branch
  // the reader is looking at without having to infer it from the presence of
  // `err`.
  const isError = error instanceof Error;

  logger.fatal(
    isError
      ? { err: error, origin, errorType: 'Error' }
      : { origin, errorType: error === null ? 'null' : typeof error },
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
  // A TERMINAL SEQUENCE ALREADY UNDER WAY OWNS THIS PROCESS, AND PHASE TWO MUST
  // NOT SPEAK OVER IT. A fatal fault arriving during the deregistration window
  // is the way this happens: `terminate()` is already flushing and exiting, and
  // running phase two on top of it would close a listener the fatal path has
  // already destroyed and then report a drain outcome for a process that is
  // ending for an entirely different reason.
  if (terminating) {
    return;
  }

  // WHETHER THERE IS ANYTHING TO CLOSE IS A QUESTION ABOUT `listening`, NOT
  // ABOUT `server`. A signal can arrive before `start()` ever bound a
  // listener -- PM2 stopping a worker that is still booting is the ordinary way
  // it happens -- and `server` has been non-null since the instant it was
  // constructed, well before the bind completed. Asking `server.close()` to
  // close a listener that never opened produces `ERR_SERVER_NOT_RUNNING` in the
  // callback, which the branch below would read as a failed close and turn an
  // expected operator stop into exit 1. So the drain reduces to the termination
  // sequence whenever no listener is open, whichever of the two reasons applies.
  if (server === null || !listening) {
    clearForceExitTimer();
    logger.info({ signal }, 'Drain complete; no listener was bound');
    terminate(0);
    return;
  }

  // Cleared before the close is requested rather than after it completes: from
  // this instant the listener is closing, so nothing may treat it as open
  // again -- including a fatal path that arrives mid-drain and would otherwise
  // try to close it a second time.
  listening = false;

  server.close((closeError) => {
    // The drain finished inside its budget, so the force-exit timer must not
    // fire. Clearing it also releases the event loop, which is what lets the
    // process reach its exit rather than idling until PM2 loses patience.
    clearForceExitTimer();

    // ONCE A TERMINAL SEQUENCE HAS WON, THIS CALLBACK IS INERT -- IT MUST NOT
    // LOG AND MUST NOT REPORT AN OUTCOME. The close can complete after the
    // force point has already declared the drain over, or after a fatal fault
    // destroyed the sockets it was waiting on. Logging `Drain complete;
    // exiting` then would write a clean-completion record for a shutdown that
    // was forcibly terminated -- a false success in the log, whatever the exit
    // status says -- and would add another write to a barrier already in
    // flight. The latch in `terminate()` protects the exit STATUS; this guard
    // protects the ACCOUNT, and both are needed because a reader believes the
    // record.
    if (terminating) {
      return;
    }

    // `ERR_SERVER_NOT_RUNNING` is not a failure here: it means the listener was
    // already closed -- the fatal path stopped it, or a close raced this one --
    // and a drain that finds nothing left to close has finished rather than
    // failed. Every other close error is real and exits non-zero.
    if (closeError && closeError.code !== 'ERR_SERVER_NOT_RUNNING') {
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
 * The operator drain: `SIGTERM`/`SIGINT`, two phases, and one bounded
 * guarantee.
 *
 * PM2 signals `SIGINT` on both stop and reload, so this is the path every
 * ordinary deployment takes. It is idempotent, bounded, and it makes the
 * readiness probe's negative answer observable before the socket closes.
 *
 * WHAT IT GUARANTEES, STATED EXACTLY, BECAUSE THE ABSOLUTE VERSION IS FALSE.
 * A request that finishes within `SHUTDOWN_TIMEOUT_MS` of the signal finishes:
 * the listener keeps accepting through the deregistration window, and
 * `server.close()` then waits for everything already in flight, right up to
 * that boundary. A handler STILL EXECUTING at the boundary is terminated by the
 * force exit. Handlers get the whole of the budget and nothing is reserved out
 * of it -- what the terminal sequence needs, it takes from whatever the drain
 * did not use, which is why `terminate()` bounds its flush by the remainder and
 * not by a slice held back from the start.
 *
 * The bound is honest rather than removable: Node's `server.requestTimeout`
 * limits how long a request may take to ARRIVE, not how long a handler may run,
 * so it cannot cap handler execution, and bounding long-running work would need
 * per-handler deadlines and cancellation of whatever downstream call is slow.
 *
 * THE TIMEOUT BUDGET, AND WHY THE FORCE POINT IS ARMED AT SIGNAL RECEIPT
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
 * The force point fires at the budget itself and not a moment before it. An
 * earlier one would look tidier -- it would leave room for the overrun record
 * to be flushed inside the budget -- but the time it would take is time the
 * budget promised to handlers: a request that would have completed at 2500 ms
 * under a 3000 ms budget would be cut off at 2000 ms, which is the guarantee
 * above turned into a falsehood for the sake of a log line. The record loses
 * instead, and `terminate()` says exactly how.
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

  // The deadline is fixed here, once, and everything downstream measures
  // against it: the force point below, and the bounded flush in `terminate()`.
  // One absolute instant rather than a chain of relative delays is what lets
  // the terminal sequence ask how much budget is left instead of assuming it
  // has any.
  drainDeadline = Date.now() + config.shutdownTimeoutMs;

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
 * @returns {import('node:http').Server} The listener, with its bind INITIATED
 *                           rather than complete. `listen()` is asynchronous,
 *                           so this returns before the `listening` event and
 *                           `server.address()` is still `null` at that point: a
 *                           caller that needs the resolved address must wait
 *                           for `listening` first. What the returned object is
 *                           immediately good for is attaching listeners of its
 *                           own.
 * @throws {TypeError} Forwarded synchronously from `createApp()` when
 *                           `options.extraRouters` is not an array of mountable
 *                           routers. It is deliberately not caught here: a
 *                           caller that mis-specifies the seam has a defect in
 *                           its own code, and failing at the call is what makes
 *                           that visible instead of binding a listener that
 *                           silently lacks the routes it was asked for.
 */
function start({ app: providedApp, ...appOptions } = {}) {
  const app = providedApp ?? createApp(appOptions);

  server = http.createServer(app);

  // Set from the `listening` EVENT rather than from the `listen()` callback
  // below, because the two are not interchangeable: that callback returns early
  // when a drain has already begun, and the drain still has to know a listener
  // was opened and therefore has to be closed. Registering here also runs it
  // first, since `listen()`'s callback is itself a `listening` listener added
  // after this one.
  server.on('listening', () => {
    listening = true;
  });

  // WHY LISTENER ERRORS ARE CAUGHT ON THE `error` EVENT AND NOT IN THE
  // `listen()` CALLBACK. The listen callback fires only on SUCCESS. A port
  // already in use (`EADDRINUSE`), a privileged port bound without the
  // capability to do so (`EACCES`), or an unassignable host address
  // (`EADDRNOTAVAIL`) all surface as an `error` EVENT on the server instead, so
  // a service that only inspected the callback would never hear about them.
  // Subscribing before `listen()` is what guarantees the event cannot be
  // emitted before there is something to hear it.
  //
  // WHAT THIS HANDLER CHANGES, STATED ACCURATELY: not whether the process ends.
  // An `error` event with no listener is THROWN by Node, which terminates the
  // process through an uncaught exception and a non-zero status -- the
  // alternative is a crash, not a silent success. What the handler buys is the
  // difference between that uncontrolled path and this one: the failure is
  // recorded as one structured line naming the port and host, and the exit runs
  // the service's own flush -> disconnect -> exit sequence rather than Node's
  // default crash, which would bypass both and leave PM2 with a worker that
  // died without explaining itself.
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

// Assigned before the entry-point guard below, so the exports exist however
// this module is reached.
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
