// SPDX-License-Identifier: Apache-2.0
/**
 * The one pino root logger for this service.
 *
 * SINGLE RESPONSIBILITY. This module constructs exactly one pino logger for
 * the process and exports that instance. It owns three things and nothing
 * else: the shared identity fields stamped on every record (`base`), the
 * redaction policy applied before any record is written (`redact`), and the
 * environment-aware transport decision. It writes no records of its own --
 * the modules listed below do that -- and it holds no request state, no
 * counters and no files.
 *
 * WHO CONSUMES THIS INSTANCE, and what each of them needs from it:
 *
 *   * src/middleware/request-context.js -- hands this instance to pino-http,
 *     which derives the per-request child logger on `req.log` and emits the
 *     one access record per request. That child inherits `level`, `base` and
 *     `redact` from here, which is why the redaction policy belongs on the
 *     root rather than being re-stated per request.
 *   * src/middleware/error-handler.js -- writes the exception record for the
 *     500 class, where the real message is masked out of the response and
 *     would otherwise be lost entirely.
 *   * src/server.js -- the start-up, listener-error and shutdown records, and
 *     the flush step of the log -> flush -> disconnect -> exit sequence that
 *     every exit path in this service must follow.
 *
 * WHY PINO RATHER THAN WINSTON. pino emits newline-delimited JSON by default
 * -- `level`, `time`, `pid`, `hostname`, `msg` -- supports child loggers and
 * built-in redaction, and carries materially lower overhead, whereas
 * winston's JSON output requires explicit format configuration. Its
 * human-readable half, pino-pretty, is a development tool that must not run
 * in production, because it re-adds precisely the overhead pino exists to
 * avoid; the branch further down is where that is enforced.
 *
 * WHY THERE IS ONE INSTANCE AND NO FACTORY. A second root logger would mean
 * two identity blocks, two redaction policies and two transport decisions
 * that can drift apart, with nothing to report the divergence. Per-request
 * loggers are still created -- pino-http derives them as children of this one
 * -- so a caller wanting request-scoped fields uses `req.log`, never a second
 * root.
 *
 * WHY THE CONFIGURATION IMPORT IS NOT GUARDED HERE. src/config/index.js
 * validates during module evaluation and throws ONE aggregated error naming
 * every invalid variable at once. src/server.js performs the first internal
 * import of that module inside a try/catch and renders whatever it throws as
 * a single JSON object on stderr through its logger-free fatal() fallback --
 * which exists precisely because a configuration failure happens before any
 * logger does. Catching that error here would swallow the aggregated message
 * and leave an operator with less to act on, and there would be nothing to
 * report it with in any case: this file is the logger.
 *
 * @module lib/logger
 */

'use strict';

/*
 * The logging library itself, and one of only two imports in this file. pino
 * is a declared runtime dependency, so it is present on a production tree.
 * Its human-readable companion package is deliberately NOT imported here or
 * anywhere else in this file: it ships as a development dependency and is
 * absent from a production install, so a top-level import of it would crash
 * the process at start-up. The transport branch further down is where that
 * package is named, and only on the branch that never runs in production.
 */
const pino = require('pino');

/*
 * The frozen configuration object, and the only source of environment-derived
 * values in this file. Exactly four of its fields are read -- `logLevel`,
 * `isProduction`, `instance` and `serviceName` -- and the raw environment is
 * never inspected here: src/config/index.js is the single reader of it in the
 * whole codebase, which is what makes an invalid environment one loud
 * start-up failure rather than several quiet disagreements.
 *
 * `config.isProduction` is what the transport branch tests, rather than a
 * string comparison against the environment name. That predicate is derived
 * once in the configuration module specifically so that this file and
 * src/middleware/error-handler.js cannot answer the same question
 * differently.
 */
const config = require('../config');

/**
 * The options handed to pino, assembled in one place so the whole shape of a
 * log record is readable without tracing calls.
 *
 * Everything pino already defaults to sensibly is deliberately absent: the
 * destination (all levels go to stdout, as documented on the exported
 * instance), the `time` field, the `msg` message key, the serializers and the
 * level's numeric representation. Each absence below is a decision rather
 * than an oversight, and the ones a reader would otherwise undo carry their
 * reasons inline.
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
   * pino's default censor -- the string `[Redacted]` -- is left in place: the
   * requirement is that these values never appear, not that the substitute
   * read a particular way, and a custom censor would be one more thing to keep
   * in step across two files.
   */
  redact: ['req.headers.authorization', 'req.headers.cookie']
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

/*
 * THE TRANSPORT IS CONSTRUCTED ONLY ON THE NON-PRODUCTION BRANCH, AND THIS
 * CONDITIONAL MUST NOT BE FLATTENED.
 *
 * pino-pretty is a devDependency, and a production host installs with
 * `npm ci --omit=dev`, so the package is simply not on disk there. pino
 * resolves a transport target when the logger is CONSTRUCTED, not when the
 * first record is written, so merely presenting this option in production is
 * fatal: the process crashes during start-up, before the listener binds,
 * naming a module nobody expected it to need. An unconditional reference is
 * fatal even where its value would never be used -- which is why the option is
 * assigned inside this branch instead of being given a conditional value on
 * the literal above, and why pino-pretty is not imported at the top of this
 * file, or anywhere in it.
 *
 * This is the mistake the service's production-tree validation stage exists to
 * catch: it installs with `--omit=dev`, confirms pino-pretty is absent from the
 * tree, and then starts the service under PM2 with the environment set to
 * production. If the service reaches `online` and serves a request, this
 * branch is correct.
 *
 * The transport options are kept minimal on purpose. `colorize` and
 * `translateTime` change presentation only; nothing here uses `ignore`,
 * because the three `base` identity fields are exactly what a reader needs to
 * see, and hiding them would make development output describe a different
 * record from the one production writes.
 */
if (!config.isProduction) {
  options.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard'
    }
  };
}

/**
 * The process-wide root logger.
 *
 * Every record it writes carries the three identity fields from `base` --
 * `pid`, `instance` and `service` -- alongside pino's own `level`, `time` and
 * `msg`. `req.headers.authorization` and `req.headers.cookie` are redacted
 * before anything is written, at the root, so every child inherits the policy.
 * In production the instance writes raw newline-delimited JSON, one complete
 * JSON object per line; outside production the same records are rendered as
 * human-readable text by pino-pretty.
 *
 * ALL LEVELS GO TO STDOUT, on pino's default destination. No second stream is
 * configured and error-level records are deliberately NOT routed to stderr:
 * the PM2 descriptor sends stdout to `logs/out.log` and stderr to
 * `logs/error.log`, and `error.log` is expected to be empty in a clean run
 * precisely because pino writes every level to stdout. A service record
 * appearing there would mean this stream configuration had changed.
 *
 * @type {import('pino').Logger}
 */
const logger = pino(options);

/*
 * THE RAW INSTANCE IS EXPORTED -- NOT A FACADE, AND NOT `{ logger }`.
 *
 * Wrapping it in an object exposing only `info`, `warn` and `error` would drop
 * two members this service depends on, and both failures are silent ones.
 *
 * `logger.flush()` is the middle step of the log -> flush ->
 * `process.disconnect?.()` -> `process.exit()` sequence src/server.js runs on
 * every exit path, orderly drain and fatal alike. Exiting immediately after a
 * log call truncates pino's pending write through PM2's stdout pipe, so the
 * final line -- the one recording how the process ended -- simply disappears,
 * while the code that wrote it still looks correct.
 *
 * `logger.child()` is what pino-http calls to derive the per-request logger on
 * `req.log`, so a facade would take the access record with it.
 *
 * Nothing else is exported, and nothing else should be added: no `flush`
 * helper wrapping the method that already exists, no named per-module loggers,
 * and no factory. There is exactly one root logger per process, and this is
 * it.
 */
module.exports = logger;
