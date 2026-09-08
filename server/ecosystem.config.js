// SPDX-License-Identifier: Apache-2.0
/**
 * The PM2 application descriptor for `hello-world-service` -- the operational
 * contract PM2 executes.
 *
 * SINGLE RESPONSIBILITY. This file declares the service's *process topology*
 * and nothing else: how many workers run and in which execution mode, how a
 * replacement worker is judged ready, how long a departing one has to finish,
 * where the two log streams land, and the one environment key the topology
 * itself owns. It holds no application logic, no route, no middleware and no
 * response shape; the application PM2 supervises begins at `src/server.js`,
 * which owns the process layer, and at `src/app.js`, which owns the pipeline.
 *
 * IT REQUIRES NOTHING, AND THAT IS DELIBERATE. Everywhere else in this service
 * application values are resolved through the frozen configuration object in
 * `src/config/index.js` rather than written as literals. Here the fields stay
 * literals, because PM2 reads this file -- in the PM2 CLI's own process --
 * *before any application code runs*. There is no service process yet to load
 * configuration into, so `require('./src/config')` would centralise nothing;
 * it would execute the service's environment validation inside the supervisor
 * and break the descriptor. The one value that genuinely spans both worlds is
 * the shutdown budget, and it is held together as a PAIRED OBLIGATION -- the
 * comment on `kill_timeout` below and the ceiling the configuration validator
 * enforces -- rather than by sharing code.
 *
 * COMMONJS, NOT ESM. PM2 loads this file with `require`, which is precisely
 * why `package.json` declares no `"type": "module"`. `module.exports` is the
 * only correct export form here; `export default` would fail to load.
 *
 * THREE FIELDS FAIL SILENTLY IF CHANGED, which is why each carries a comment
 * giving its reason rather than restating its value:
 *
 *   * `time`          -- a `true` here prefixes every captured line and makes
 *                        it invalid JSON, breaking NDJSON parsing.
 *   * `instances`     -- `'max'` collapses to a single worker on a
 *                        single-vCPU host, removing redundancy.
 *   * `kill_timeout`  -- a value below the application's drain budget lets the
 *                        supervisor `SIGKILL` a worker mid-drain.
 *
 * None of the three raises an error, and all three keep producing output that
 * looks correct. That is what makes them worth a comment.
 *
 * @module ecosystem.config
 */

'use strict';

/**
 * The PM2 ecosystem descriptor: exactly one application entry.
 *
 * PM2 consumes this object to start, reload, scale, stop and supervise the
 * service. It is always invoked from the `server/` directory, because every
 * path in it -- `script`, `out_file`, `error_file` -- is resolved relative to
 * the working directory PM2 is launched from. The `pm2:*` scripts in
 * `package.json` are the supported entry points:
 *
 *     npm run pm2:start     # pm2 start ecosystem.config.js
 *     npm run pm2:reload    # pm2 reload ecosystem.config.js --update-env
 *     npm run pm2:scale -- <n>
 *                           # pm2 scale hello-world-service <n>
 *     npm run pm2:stop      # pm2 stop ecosystem.config.js
 *     npm run pm2:delete    # pm2 delete ecosystem.config.js
 *
 * `pm2:reload` targets THIS FILE rather than the registered process name, and
 * passes `--update-env`, so that changed field and environment values are
 * re-read from here on every deploy instead of from PM2's already-registered
 * definition. Reload does NOT reconcile worker count, though: raising
 * `instances` and reloading stores the new value while leaving the existing
 * workers online, so a topology change additionally needs `pm2:scale` (or a
 * `pm2:delete` followed by `pm2:start`). Reload applies code and environment
 * changes; scale changes how many workers run.
 *
 * DELIBERATELY ABSENT: any `env_development`/`env_test` block, `watch` and
 * `ignore_watch`, `cron_restart`, `node_args`, `interpreter` and
 * `interpreter_args`, `cwd`, a second application entry, and a `deploy`
 * section. None is required by this service, and each would be one more field
 * an operator has to reason about when something goes wrong. PM2's own deploy
 * feature is unused -- the deployment procedure is the host prerequisites
 * documented in `README.md`.
 *
 * @type {{apps: Array<Object>}} A single-element `apps` array holding the
 *                               `hello-world-service` application definition.
 */
module.exports = {
  apps: [
    {
      /*
       * THE CANONICAL IDENTITY, declared here and in three other places that
       * must agree. This is the handle `pm2 status`, `pm2 logs` and
       * `pm2 scale` address the application by -- the `pm2:scale` and
       * `pm2:logs` scripts name it literally. The same string is `name` in
       * `package.json`, the `service` field on every log line, and the
       * `service` value in the `GET /health` response; the latter two arrive
       * through the `SERVICE_NAME` constant in `src/config/index.js`, never
       * from a manifest read. If these declarations drift apart, a process
       * listing, a log line and a health response describe one process under
       * three different names.
       */
      name: 'hello-world-service',

      /*
       * The entry point, resolved relative to the directory PM2 is invoked
       * from -- always `server/`. `src/server.js` is the process layer:
       * binding, listener errors, the readiness handshake gated below, and the
       * two deliberately different termination paths.
       *
       * This is one of three references to that path -- the others are `main`
       * and the `start`/`dev` scripts in `package.json` -- so moving or
       * renaming the file breaks this descriptor and every `pm2:*` script with
       * it. The three move together.
       */
      script: 'src/server.js',

      /*
       * Cluster mode, so the service can survive losing a worker and can use
       * more than one core. PM2 forks the script through Node's own cluster
       * module: the workers share ONE listening socket and the runtime
       * distributes accepted connections across them round-robin, so there is
       * no per-worker port and no external load balancer in the picture.
       *
       * It is also what makes `pm2 reload` a drain rather than a cut -- fork
       * mode has no second worker to carry traffic while one is replaced.
       */
      exec_mode: 'cluster',

      /*
       * AN EXPLICIT COUNT, NOT `'max'`, and the reasons are about steady state
       * rather than about reload. Reload overlap is already observable at a
       * single instance, because PM2 starts a replacement before retiring even
       * one worker. Two workers buy two different things: REDUNDANCY, so a
       * worker that crashes does not take the service down while `autorestart`
       * replaces it, and LOAD DISTRIBUTION across cores.
       *
       * `'max'` is rejected because it resolves to the host's CPU count, which
       * on a single-vCPU host or a CPU-constrained container is ONE -- quietly
       * removing both properties while still reading like a throughput
       * setting. Nothing reports the degradation.
       *
       * This is the one field an operator routinely tunes. Raise it for
       * throughput, and remember that a change here needs `pm2:scale` as well
       * as `pm2:reload`, per the descriptor's JSDoc above.
       */
      instances: 2,

      /*
       * THE READINESS HANDSHAKE, AND THE MIS-DESCRIPTION IT IS WORTH
       * CORRECTING. This makes PM2 judge a replacement worker up only once the
       * application says so -- `src/server.js` sends `process.send('ready')`
       * inside its listen callback -- rather than treating the successful fork
       * as sufficient on its own.
       *
       * It is a PROCESS-LIFECYCLE GATE, NOT AN HTTP ROUTING GATE. PM2 is not a
       * proxy that withholds traffic from a listening worker: once a worker
       * calls `listen`, the cluster machinery can hand it connections. What
       * this option controls is when PM2 CONSIDERS THE REPLACEMENT UP, and
       * therefore when it retires the outgoing worker. Zero-downtime reload
       * comes from that overlap plus the outgoing worker's own drain, never
       * from selective routing.
       *
       * Do not conflate it with the service's other, unrelated notion of
       * readiness: `GET /health/ready` reports drain state from
       * `src/lib/lifecycle.js` over HTTP, and has nothing to do with this
       * field.
       */
      wait_ready: true,

      /*
       * The bound on that wait. If a worker never sends `ready` -- because the
       * handshake was removed, or start-up hung before the listen callback --
       * PM2 waits out this entire timeout before giving up and retiring the
       * outgoing worker anyway. A missing handshake therefore presents as
       * every reload stalling for eight seconds per worker while still
       * reporting success, which is why the handshake in `src/server.js` and
       * this field are read together.
       *
       * Generous enough for a slow or loaded host, short enough that the
       * fallback is noticed rather than mistaken for a hang, and comfortably
       * inside `kill_timeout` below.
       */
      listen_timeout: 8000,

      /*
       * THE SUPERVISOR'S HALF OF ONE SHARED BUDGET -- A MANDATORY
       * RELATIONSHIP, NOT MERELY A DURATION. This bounds how long a departing
       * worker has to finish after PM2 signals it, before PM2 escalates to
       * `SIGKILL`.
       *
       * IT MUST REMAIN ABOVE `SHUTDOWN_TIMEOUT_MS`, whose ceiling of 10000 is
       * enforced by the validator in `src/config/index.js`. The 2000 ms margin
       * that leaves is the entire point: THE APPLICATION, NOT THE SUPERVISOR,
       * DECIDES HOW A DRAIN ENDS. The service's own force-exit timer fires
       * first, logs the overrun and exits deliberately, instead of the worker
       * being killed mid-drain with nothing recorded and PM2 reporting a
       * failure where a clean stop belonged.
       *
       * The two values are two halves of one budget and move together: raising
       * `SHUTDOWN_TIMEOUT_MS` past this value, or lowering this value below
       * it, inverts the relationship the validator exists to protect. Nothing
       * detects the inversion at start-up, because it spans two processes --
       * PM2 never reads the application's configuration, and the application
       * never reads this file.
       */
      kill_timeout: 12000,

      /*
       * A ceiling on a leaking worker. PM2 restarts a worker whose resident
       * memory exceeds this, which converts an unbounded leak into a bounded
       * and visible restart rather than an out-of-memory kill that takes the
       * host's other processes with it. Sized far above the service's idle
       * footprint so that ordinary traffic never trips it, and low enough that
       * a genuine leak is caught while the host still has room.
       */
      max_memory_restart: '256M',

      /*
       * Restart a worker that exits unexpectedly, which is the correct
       * recovery for the fatal path in `src/server.js`: after an uncaught
       * exception or an unhandled rejection the process state is undefined, so
       * that path logs, flushes and exits IMMEDIATELY rather than draining,
       * and relies on being replaced. Without this the fatal path would simply
       * shrink the worker pool one crash at a time, with the service quietly
       * losing capacity until the last worker went.
       */
      autorestart: true,

      /*
       * Exponential backoff between restarts, starting at 100 ms. A worker
       * that fails during start-up -- an invalid `.env` value, a port already
       * bound -- would otherwise be restarted in a tight loop that burns CPU
       * and floods the log files with the same record until someone notices.
       * Backoff turns that into a slowing, readable sequence, while the first
       * retry stays fast enough that a genuinely transient failure costs
       * almost nothing.
       */
      exp_backoff_restart_delay: 100,

      /*
       * The two log destinations, resolved relative to `server/` like `script`
       * above, and pointing at the `server/logs/` path the repository root
       * `.gitignore` ignores -- PM2's output is a runtime artefact and is
       * never committed. The directory itself is deliberately NOT tracked:
       * PM2 creates the parent of `out_file`/`error_file` when it starts the
       * application, so a placeholder file would add something to version
       * control to solve a problem that does not exist.
       *
       * EXPECT AN UNEVEN SPLIT BETWEEN THE TWO. pino writes records at EVERY
       * level to stdout, so `out.log` carries the service's whole NDJSON
       * stream, `error`- and `fatal`-level records included. `error_file`
       * receives only what reaches the process's stderr -- in practice just
       * the pre-logger configuration-failure record that `src/server.js`
       * writes synchronously when validation fails -- so it is expected to be
       * EMPTY in a clean run. Service records appearing there mean the
       * logger's stream configuration has changed, not that the service is
       * failing.
       *
       * Retention is a host concern rather than a descriptor one: these are
       * persistent files that grow without bound, so `pm2-logrotate` or an
       * equivalent host policy is a REQUIRED deployment step, documented in
       * `README.md`.
       */
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',

      /*
       * Both workers write to the same pair of files instead of PM2 suffixing
       * a separate file per instance. One stream is what makes the logs
       * greppable and parseable as a whole, and merging loses nothing: every
       * record already carries `pid` and `instance` from pino's `base`, so
       * which worker produced a given line is recoverable from the line
       * itself.
       */
      merge_logs: true,

      /*
       * MUST STAY `false` -- MANDATORY, AND ITS FAILURE MODE IS SILENT. PM2's
       * `time: true` prefixes every captured line with a human-readable
       * timestamp. That prefix sits OUTSIDE the JSON object, so each line of
       * the service's NDJSON stream stops being valid JSON and line-by-line
       * parsing of `logs/out.log` breaks -- while the logs still appear, still
       * look right to a human skimming them, and raise no error anywhere. It
       * is exactly the kind of change that survives a review.
       *
       * The prefix is redundant as well as harmful: pino already stamps a
       * `time` field on every record, inside the object where a parser can
       * actually read it.
       */
      time: false,

      /*
       * EXACTLY ONE KEY, AND THE REASON IS PRECEDENCE. PM2 injects this block
       * into each worker's REAL environment before any application code runs,
       * and `src/config/index.js` loads `.env` through dotenv without
       * `override`, so a key present BOTH here and in `server/.env` is won by
       * PM2 and the `.env` value is SILENTLY IGNORED -- no warning, no error,
       * no trace in the logs.
       *
       * `NODE_ENV` is the one value the process topology genuinely owns:
       * starting under the production descriptor IS what makes the environment
       * production. It is also load-bearing beyond its name, selecting raw
       * NDJSON logging over the development pretty-printer -- which matters,
       * because `pino-pretty` is a devDependency that the production install
       * (`npm ci --omit=dev`) omits -- and masking 5xx messages in responses.
       *
       * Everything else belongs to `server/.env` and is documented in
       * `.env.example`, so DO NOT ADD `PORT`, `HOST`, `LOG_LEVEL`,
       * `SHUTDOWN_TIMEOUT_MS`, `DRAIN_DELAY_MS`, `BODY_LIMIT` or
       * `TRUST_PROXY` here: adding any one of them would disable its `.env`
       * counterpart with no diagnostic at all. For the same reason there is no
       * `env_development` or `env_test` block -- this descriptor exists to run
       * the service in production, and a developer runs `npm run dev`.
       *
       * The resulting precedence, in one sentence: the real environment (where
       * PM2 sets `NODE_ENV`) beats `.env`, which beats the built-in defaults
       * in `src/config/index.js`.
       */
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
