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
 * log -> flush -> disconnect -> exit sequence is implemented.
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
 * the very next statement is `process.exit(1)`, and an exit can truncate a
 * buffered write. A synchronous write to the descriptor cannot be truncated,
 * so the record is on disk before the process is gone.
 *
 * FOR CONFIGURATION VALIDATION FAILURES ONLY. Do not reuse it for anything
 * else. Every failure after configuration -- listener errors included, which
 * surface only once the logger, the app and `listen()` all exist -- goes
 * through the configured logger, so that the service has exactly one
 * structured log stream rather than two competing ones.
 *
 * @param {object} payload A plain, JSON-serialisable object. It must be flat
 *                         enough to survive `JSON.stringify` and small enough
 *                         to read at a glance.
 * @returns {void}
 */
function fatal(payload) {
  // `JSON.stringify` escapes any newline inside a value, so the record is
  // always exactly one line however ugly the underlying error message was.
  // That is what keeps it parseable by the same line-at-a-time tooling that
  // reads the service's ordinary output.
  fs.writeSync(2, `${JSON.stringify(payload)}\n`);
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
 * `lib/logger.js`, `lib/lifecycle.js` and `app.js` all reach that same
 * configuration module transitively, and in CommonJS `require` calls execute
 * in source order. Requiring any of them first would therefore trigger the
 * configuration throw OUTSIDE this try/catch, and the operator would get an
 * unformatted stack trace instead of the aggregated, machine-readable record
 * below. Placing the guarded require first is both necessary and sufficient.
 *
 * `process.exit(1)` here is correct and is not the `terminate()` sequence:
 * there is no logger to flush and no application state to unwind, because
 * nothing has been constructed yet. Exiting non-zero before the listener binds
 * is the whole point -- an invalid environment must never produce a running
 * service.
 */
let config;
try {
  config = require('./config');
} catch (error) {
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
    msg: 'Configuration validation failed; the listener was never bound',
    err: error instanceof Error ? error.message : String(error)
  };

  // The configuration module attaches every individual validation failure as
  // an array alongside the aggregated message. Passing it through gives a
  // consumer the failures structured, while `err` above stays sufficient on
  // its own for a human reading one line.
  if (error && Array.isArray(error.failures)) {
    payload.failures = error.failures.slice();
  }

  fatal(payload);
  process.exit(1);
}

/*
 * Only now that configuration has loaded successfully is it safe to require
 * the modules that depend on it.
 *
 * `logger` is the pino root instance itself, exported directly rather than
 * wrapped, which is what makes both `logger.flush()` and the level methods
 * available here. `beginShutdown` is destructured alone: its sibling
 * `isShuttingDown` is deliberately NOT imported, because this module is the
 * writer of the drain state and `src/routes/health.routes.js` is its reader.
 * Importing the reader here would invite someone to answer the readiness
 * question in the process layer, which is the route layer's job.
 */
const logger = require('./lib/logger');
const { beginShutdown } = require('./lib/lifecycle');
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
 * Whether `terminate()` has already run its flush.
 *
 * A re-entry guard rather than a status flag. Every exit path funnels through
 * one function, and if `logger.flush()` itself were to fail, the resulting
 * exception would arrive at the `uncaughtException` handler, which terminates
 * -- flushing again, failing again, unbounded. The guard makes the second
 * entry skip straight to the exit.
 *
 * @type {boolean}
 */
let terminating = false;

/**
 * Ends the process: flush the logger, release the PM2 IPC channel, exit.
 *
 * THIS SEQUENCE IS THE DETAIL MOST LIKELY TO BE SIMPLIFIED AWAY, AND BOTH
 * HALVES ARE MANDATORY. Each guards a different failure, and each failure
 * still looks correct in the source:
 *
 *   * THE FLUSH guarantees the record the caller just wrote is out of pino's
 *     hands before the process disappears. `process.exit()` does not drain a
 *     buffered destination, so with an asynchronous one the final line -- the
 *     one recording HOW the process ended -- is lost, and a drain that
 *     completed becomes indistinguishable from one that was killed. Measured
 *     honestly, this half is currently a safety net rather than a live fix:
 *     pino's default stdout destination writes synchronously, and removing the
 *     flush was verified NOT to lose the completion line today. It stays
 *     because it is the only thing standing between this service and that loss
 *     the moment the destination stops being synchronous -- a transport, an
 *     explicitly asynchronous destination, or a future pino default -- and
 *     because the cost of keeping it is one synchronous call on a path that is
 *     already ending.
 *   * THE DISCONNECT AND EXIT are load-bearing right now, and this was
 *     measured: with them removed, a PM2 cluster worker that had finished its
 *     drain did NOT exit -- the IPC channel stays referenced, so the worker
 *     lingered until PM2 `SIGKILL`ed it at `kill_timeout`, turning a clean
 *     2.2-second shutdown into a 12-second kill that PM2 reports as a failure.
 *     Letting the event loop "just drain" is therefore not an equivalent
 *     simplification; it is the bug.
 *
 * `logger.flush()` is used in its synchronous form on purpose. The callback
 * form was measured to work too, on both the production and development
 * transports, but a callback that failed to fire would leave the process alive
 * until PM2 killed it and would silently break the fatal path's guarantee of
 * an *immediate* exit. The form that cannot hang is the right one on a path
 * whose whole job is to end.
 *
 * `process.disconnect` is called optionally because a directly launched
 * process -- `npm start`, or a developer's terminal -- has no IPC channel and
 * therefore no `disconnect` method at all.
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
  if (!terminating) {
    terminating = true;
    logger.flush();
  }

  process.disconnect?.();
  process.exit(exitCode);
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
 * back once every request still in flight has finished, and
 * `server.closeIdleConnections()` sheds keep-alive sockets that are parked
 * between requests -- without it, an idle browser connection would hold the
 * close open for as long as its keep-alive allowed, turning an instant drain
 * into a forced one.
 *
 * `closeIdleConnections()` is called AFTER `close()` deliberately: `close()`
 * first marks the listener as closing, so a socket that goes idle during the
 * drain is then cleaned up rather than being handed another request.
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

    // THE PM2 READINESS HANDSHAKE. `server/ecosystem.config.js` sets
    // `wait_ready: true`, which makes PM2 treat a replacement worker as up only
    // once the worker itself says so over the IPC channel. Without this line
    // PM2 has nothing to wait for and falls back to waiting out
    // `listen_timeout` -- 8000 ms per worker -- before retiring the outgoing
    // worker, so every single reload stalls for no reason while looking
    // successful.
    //
    // The guard is required rather than defensive: a directly launched
    // process (`npm start`) has no IPC channel, so `process.send` is undefined
    // there, and calling it unconditionally would crash the very start-up it
    // is meant to announce.
    //
    // Note what this does NOT do. `wait_ready` is a process-lifecycle gate, not
    // an HTTP routing gate: PM2 is not a proxy withholding traffic from a
    // listening worker, and once `listen()` has resolved the cluster machinery
    // can hand this worker connections. Zero-downtime reload comes from the
    // OVERLAP between a ready replacement and a draining predecessor, not from
    // selective routing.
    if (process.send) {
      process.send('ready');
    }
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
 * merely required, nothing happens: no listener, no handlers, no side effects
 * beyond the module-level configuration load. That is what lets an
 * out-of-tree harness require this module, hand `start()` an app with its own
 * injected routes, and exercise the real lifecycle without a second listener
 * racing it.
 */
if (require.main === module) {
  start();
}
