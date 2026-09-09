// SPDX-License-Identifier: Apache-2.0
/**
 * The PM2 application descriptor for `hello-world-service`.
 *
 * SINGLE RESPONSIBILITY: declare the service's process topology and nothing
 * else -- worker count and execution mode, the readiness handshake, the drain
 * budget, the two log destinations, and the one environment key the topology
 * owns. No application logic lives here; what PM2 supervises begins at
 * `src/server.js`.
 *
 * IT REQUIRES NOTHING, AND THE FIELDS STAY LITERALS. Everywhere else in this
 * service values are resolved through the frozen configuration object in
 * `src/config/index.js`, but PM2 reads this file in the CLI's own process
 * before any application code runs, so `require('./src/config')` would
 * centralise nothing -- it would run the service's environment validation
 * inside the supervisor. The one value spanning both worlds, the shutdown
 * budget, is a paired obligation instead: see `kill_timeout` below.
 *
 * COMMONJS, NOT ESM: PM2 loads this file with `require`, which is why
 * `package.json` declares no `"type": "module"`.
 *
 * `time`, `instances` and `kill_timeout` each fail SILENTLY if changed, so the
 * reason each holds its value is stated beside the field.
 *
 * @module ecosystem.config
 */

'use strict';

/**
 * The PM2 ecosystem descriptor: exactly one application entry.
 *
 * PM2 consumes this object to start, reload, scale, stop and supervise the
 * service, and must be invoked from the `server/` directory -- `script`,
 * `out_file` and `error_file` all resolve against PM2's working directory. The
 * `pm2:*` scripts in `package.json` are the supported entry points.
 *
 * RELOAD VERSUS SCALE. `pm2:reload` targets this file with `--update-env`, so
 * changed field and environment values are re-read from here on every deploy
 * rather than from PM2's already-registered definition -- but reload does not
 * reconcile worker count. Raising `instances` and reloading stores the new
 * value while leaving the existing workers online, so a topology change
 * additionally needs `pm2:scale` (or `pm2:delete` then `pm2:start`).
 *
 * @type {{apps: Array<Object>}} A single-element `apps` array holding the
 *                               `hello-world-service` application definition.
 */
module.exports = {
  apps: [
    {
      /*
       * THE CANONICAL IDENTITY: equal to `name` in `package.json` and to
       * `SERVICE_NAME` in `src/config/index.js`, which puts the same string on
       * every log line and in `GET /health`; `pm2:scale` and `pm2:logs`
       * address the application by this literal.
       */
      name: 'hello-world-service',

      /*
       * The entry point -- the process layer -- resolved against PM2's working
       * directory, always `server/`. `main` and the `start`/`dev` scripts in
       * `package.json` name the same path, so the three move together: rename
       * the file and this descriptor and every `pm2:*` script break with it.
       */
      script: 'src/server.js',

      /*
       * Cluster mode, for redundancy and load distribution: the workers share
       * ONE listening socket, which is also what lets `pm2 reload` drain one
       * worker while another carries the traffic rather than cutting.
       */
      exec_mode: 'cluster',

      /*
       * AN EXPLICIT COUNT, NOT `'max'`, for steady state rather than reload.
       * Two workers buy REDUNDANCY -- a crashing worker does not take the
       * service down while `autorestart` replaces it -- and LOAD DISTRIBUTION
       * across cores. `'max'` resolves to the host's CPU count, which on a
       * single-vCPU host or a CPU-constrained container is ONE, quietly
       * removing both while still reading like a throughput setting.
       *
       * The one field an operator routinely tunes, and a change here needs
       * `pm2:scale` as well as `pm2:reload`.
       */
      instances: 2,

      /*
       * THE READINESS HANDSHAKE: PM2 judges a replacement worker up only once
       * `src/server.js` sends `process.send('ready')` from its listen
       * callback, rather than treating the successful fork as sufficient.
       *
       * It is a PROCESS-LIFECYCLE GATE, NOT AN HTTP ROUTING GATE -- once a
       * worker calls `listen` the cluster machinery can hand it connections,
       * and what this option controls is when PM2 RETIRES THE OUTGOING WORKER.
       * Zero-downtime reload comes from that overlap plus the outgoing
       * worker's own drain, never from selective routing. Unrelated to
       * `GET /health/ready`, which reports drain state over HTTP from
       * `src/lib/lifecycle.js`.
       */
      wait_ready: true,

      /*
       * The readiness bound: eight seconds, inside `kill_timeout` below. With
       * the handshake missing, every worker reload waits it out in full and
       * PM2 retires the outgoing worker anyway, still reporting success.
       */
      listen_timeout: 8000,

      /*
       * THE SUPERVISOR'S HALF OF ONE SHARED BUDGET. Keep it above the 10000 ms
       * `SHUTDOWN_TIMEOUT_MS` maximum the validator in `src/config/index.js`
       * enforces: the 2000 ms margin is what makes the application terminate
       * first, on its own force-exit timer, instead of being `SIGKILL`ed
       * mid-drain. Change the two together -- neither process reads the
       * other's value, so an inversion goes undetected.
       */
      kill_timeout: 12000,

      /*
       * A POLLED RESTART THRESHOLD FOR A LEAKING WORKER -- NOT A HARD CEILING.
       * PM2 samples resident memory on its worker interval (30 s by default)
       * and restarts at the first sample above this figure, which turns a slow
       * leak into a RECORDED restart in `pm2 status`. It does not bound
       * memory: a worker allocating faster than the interval overshoots
       * between samples, and the kernel's OOM killer can arrive first. A limit
       * that cannot be overshot is a host concern -- cgroup, systemd
       * `MemoryMax=`, container limit -- and belongs to `README.md`.
       */
      max_memory_restart: '256M',

      /*
       * Replace a worker that exits unexpectedly: the fatal path in
       * `src/server.js` exits immediately and relies on that replacement.
       */
      autorestart: true,

      /*
       * Exponential backoff from 100 ms, so a worker failing at start-up -- an
       * invalid `.env` value, a port already bound -- turns a crash loop that
       * would burn CPU and flood the log files into a slowing, readable
       * sequence, while a transient failure still recovers almost instantly.
       */
      exp_backoff_restart_delay: 100,

      /*
       * The two log destinations, resolved against PM2's working directory
       * like `script`, under the `server/logs/` path the root `.gitignore`
       * ignores. PM2 creates the directory on start, so nothing in it is
       * tracked; rotation is a required host step, documented in `README.md`.
       *
       * WHERE RECORDS LAND, WHICH IS NOT SYMMETRICAL. pino writes EVERY level
       * to stdout, so `out.log` carries the whole NDJSON stream, `error` and
       * `fatal` included, and `error.log` is expected to be EMPTY in a clean
       * run. PM2 fills `error_file` by wrapping `process.stderr.write`, so
       * only writes through that stream reach it: a record written straight to
       * file descriptor 2 -- which in a cluster worker belongs to the PM2
       * daemon -- would bypass the wrapper and land in the daemon's own log,
       * `$PM2_HOME/pm2.log`, readable with `pm2 logs PM2` and NOT with
       * `npm run pm2:logs`, which filters to this application's two files.
       * Nothing in this service takes that path under PM2: the pre-logger
       * writer in `src/server.js` tests whether a supervisor owns standard
       * error and routes through `process.stderr.write` when one does,
       * reserving the descriptor-2 write for a direct run, where descriptor 2
       * is the operator's own terminal. The configuration-failure record
       * therefore reaches `error.log`, which is where `README.md`'s
       * troubleshooting section reads it.
       */
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',

      /*
       * One pair of files for both workers rather than a file per instance,
       * and merging loses nothing: every record carries `pid` and `instance`
       * from pino's `base`, so the worker that produced a line stays
       * attributable from the line itself.
       */
      merge_logs: true,

      /*
       * MUST STAY `false`, AND ITS FAILURE MODE IS SILENT. PM2's `time: true`
       * prefixes each captured line with a timestamp OUTSIDE the JSON object,
       * so every line of the NDJSON stream stops being valid JSON and
       * line-by-line parsing of `logs/out.log` breaks -- while the logs still
       * appear and still look right to a human. The prefix is redundant
       * anyway: pino already stamps `time` inside the object, where a parser
       * can read it.
       */
      time: false,

      /*
       * EXACTLY ONE KEY, AND THE REASON IS PRECEDENCE. PM2 injects this block
       * into each worker's REAL environment before any application code runs,
       * and `src/config/index.js` loads `.env` through dotenv without
       * `override`, so a key present both here and in `server/.env` is won by
       * PM2 and the `.env` value is SILENTLY IGNORED. `NODE_ENV` is the one
       * value the process topology genuinely owns: starting under this
       * descriptor IS what makes the environment production.
       *
       * Every other variable belongs to `server/.env`, documented in
       * `.env.example`, so adding one here -- `PORT`, `HOST`, `LOG_LEVEL`,
       * either timeout, `BODY_LIMIT`, `TRUST_PROXY` -- would disable its
       * `.env` counterpart with no diagnostic. The precedence, in one
       * sentence: the real environment (where PM2 sets `NODE_ENV`) beats
       * `.env`, which beats the defaults in `src/config/index.js`.
       */
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
