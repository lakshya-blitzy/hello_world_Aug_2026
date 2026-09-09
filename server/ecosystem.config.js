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
 * inside the supervisor. The values spanning both worlds are paired
 * obligations instead, and there are TWO of them: the SHUTDOWN budget
 * (`kill_timeout` here against the `SHUTDOWN_TIMEOUT_MS` ceiling the
 * configuration validator enforces) and the MEMORY budget (`node_args` here
 * against `max_memory_restart` here). Nothing checks either relationship at
 * run time, which is why each is stated beside its fields below.
 *
 * COMMONJS, NOT ESM: PM2 loads this file with `require`, which is why
 * `package.json` declares no `"type": "module"`.
 *
 * `time`, `instances`, `kill_timeout` and the `node_args` heap figure each
 * fail SILENTLY if changed, so the reason each holds its value is stated
 * beside the field -- including the newest of them: a heap figure raised
 * above `max_memory_restart` leaves nothing bounding V8's growth below the
 * restart threshold, which silently converts that threshold from a safety net
 * into an operational trigger that restarts healthy workers under load.
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
       * THE HEAP HALF OF ONE MEMORY BUDGET, WHOSE OTHER HALF IS
       * `max_memory_restart` DIRECTLY BELOW. Without this flag V8 sizes its
       * heap from HOST memory: 4288 MiB of `heap_size_limit` on the host these
       * figures were measured on, 16.7x the 256 MiB restart threshold. V8
       * therefore has no reason to collect anywhere near the threshold, and
       * whatever headroom the service keeps under load is a property of how
       * much memory the host happens to have rather than of anything declared
       * here. Declaring the figure is what makes the margin a decision.
       *
       * 192 MB of old space yields a `heap_size_limit` of 384 MiB on Node
       * 24.20.0 -- old space plus the other spaces -- and under sustained
       * large-body `POST /api/v1/echo` load a worker then holds a FLAT plateau
       * at roughly 134 MiB on PM2's own measurement source (52% of the
       * threshold) and 155 MiB resident (61%), against roughly 168 MiB and
       * 240 MiB before, the latter being 93.7% of the threshold. PM2 compares
       * its OWN figure against the threshold, so both sources are quoted:
       * `README.md` section 7 carries the measurements and their provenance.
       *
       * IT DOES NOT HARD-BOUND RESIDENT MEMORY, which is heap plus external
       * buffers plus native allocation: this bounds the dominant term, not the
       * total, so `max_memory_restart` stays the safety net and an OS-level
       * limit stays the only figure that cannot be overshot. It also binds
       * ONLY the workers PM2 launches -- PM2 7.0.4 forwards `node_args` to
       * cluster workers as `cluster.settings.execArgv`, while a direct
       * `npm start` or `npm run dev` reads no descriptor at all and gets the
       * host-derived heap.
       *
       * A PAIRED OBLIGATION, exactly like `kill_timeout` above and the
       * `SHUTDOWN_TIMEOUT_MS` ceiling: move the two fields together, and keep
       * the OLD-SPACE FIGURE IN THIS FLAG -- the 192, not the 384 MiB
       * `heap_size_limit` V8 derives from it -- below the restart threshold
       * declared next. Neither number is the one PM2 compares: PM2 samples
       * RESIDENT memory, and what this flag does is bound the largest part of
       * it. Neither Node nor PM2 checks the relationship, so an inversion
       * goes undetected.
       */
      node_args: ['--max-old-space-size=192'],

      /*
       * A POLLED RESTART THRESHOLD FOR A LEAKING WORKER -- NOT A HARD CEILING,
       * AND THE OTHER HALF OF THE MEMORY BUDGET `node_args` ABOVE OPENS.
       * PM2 samples resident memory on its worker interval (30 s by default)
       * and restarts at the first sample above this figure, which turns a slow
       * leak into a RECORDED restart in `pm2 status`. It does not bound
       * memory: a worker allocating faster than the interval overshoots
       * between samples, and the kernel's OOM killer can arrive first. A limit
       * that cannot be overshot is a host concern -- cgroup, systemd
       * `MemoryMax=`, container limit -- and belongs to `README.md`.
       *
       * The division of labour between the two halves: the old-space figure
       * above keeps ordinary load away from this threshold, and this field
       * catches the growth that figure cannot bound. Change either and
       * re-check the other -- the flag's figure must stay the smaller of the
       * two.
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
       *
       * AND DELETING THE KEY AGAIN DOES NOT UNDO IT, which is why the mistake
       * is worth avoiding here rather than correcting later. Verified against
       * PM2 7.0.4: `pm2 reload ... --update-env` adds and changes keys in this
       * block, but a key REMOVED from it survives in the flattened process
       * environment the daemon keeps for the application and is still injected
       * into brand-new workers, so the shadowed `.env` value stays ignored
       * after the deploy that was meant to restore it. Retiring a key takes a
       * re-registration -- `pm2:delete` then `pm2:start`, then `pm2 save`;
       * the procedure and the `pm2 env <id>` check are in `README.md`
       * section 7.
       */
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
