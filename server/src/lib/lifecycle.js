// SPDX-License-Identifier: Apache-2.0
//
// Drain state for hello-world-service.
//
// Single responsibility: hold the one guarded flag recording whether this
// process has begun draining, and expose it as a pure read (isShuttingDown)
// plus a guarded one-way transition (beginShutdown). This module holds state,
// never policy. The drain *timing* values (DRAIN_DELAY_MS,
// SHUTDOWN_TIMEOUT_MS) are configuration, and they are read by src/server.js,
// which owns the drain itself.
//
// Two layers share this flag, and they sit on opposite sides of the
// application:
//
//   * src/server.js                -- the SIGTERM/SIGINT handler, which SETS it
//   * src/routes/health.routes.js  -- the readiness route, which READS it to
//                                     answer 200 "ready" or 503
//                                     "shutting_down"
//
// WHY THIS MODULE EXISTS AT ALL. Do not "tidy up" by folding the flag into
// src/server.js. Doing so forces the readiness route to import the process
// entry point, which closes this cycle:
//
//     server.js -> app.js -> routes/index.js -> health.routes.js -> server.js
//
// In CommonJS that cycle does NOT throw. It resolves to a partially
// initialised module object, so isShuttingDown would be undefined at the
// moment the route called it: a runtime failure under load rather than a crash
// at start-up, which is the hardest kind of failure to diagnose. Holding the
// state in a module both layers can depend on removes the cycle entirely.
//
// WHY THIS FILE IMPORTS NOTHING. Being a dependency-free leaf is precisely
// what makes it safe for the process layer and the route layer to consume in
// either order. Any require here -- configuration, the logger, even a Node
// built-in -- would give this module edges of its own and put the cycle back
// within reach. There are deliberately no imports below.

'use strict';

/**
 * Whether a drain has begun on this process.
 *
 * Deliberately private to the module: exporting the binding itself would let a
 * consumer assign to it directly and bypass the guard in beginShutdown(), and
 * that one-way guard is the whole contract. Every read and every write goes
 * through the two exported functions.
 *
 * @type {boolean}
 */
let shuttingDown = false;

/**
 * Reports whether this process has begun draining.
 *
 * A pure read with no side effects: calling it never starts, advances or
 * cancels a drain, so it is safe to call on every request.
 *
 * src/routes/health.routes.js calls this to choose between the two readiness
 * responses. `false` yields 200 `{ status: "ready" }`; `true` yields 503
 * `{ status: "shutting_down" }` while the listener is still accepting, which is
 * what lets a poller observe the negative answer and stop sending new work
 * before the socket closes.
 *
 * @returns {boolean} `true` once a drain has begun, otherwise `false`.
 */
function isShuttingDown() {
  return shuttingDown;
}

/**
 * Begins the drain, exactly once.
 *
 * A guarded one-way latch. The first call flips the flag and reports that it
 * did so; every later call changes nothing and reports that a drain was
 * already under way. There is no path back to `false`, which is deliberate: a
 * process that has begun draining never returns to service, and PM2's
 * `autorestart` supplies a fresh worker instead.
 *
 * The return value is load-bearing rather than informational. src/server.js
 * calls this from its SIGTERM/SIGINT handler and returns immediately when the
 * result is `false`, which is what makes repeated signals idempotent: two
 * signals in quick succession must produce one drain, not two.
 *
 * @returns {boolean} `true` if this call began the drain, `false` if one was
 *                    already under way.
 */
function beginShutdown() {
  if (shuttingDown) {
    return false;
  }

  shuttingDown = true;
  return true;
}

// The public surface is exactly these two functions: one read, one guarded
// transition. The flag above is deliberately not exported, so this is the only
// way in or out of the drain state.
module.exports = { isShuttingDown, beginShutdown };
