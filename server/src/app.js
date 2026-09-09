// SPDX-License-Identifier: Apache-2.0
/**
 * The Express application factory for `hello-world-service`.
 *
 * SINGLE RESPONSIBILITY. This module assembles the application and nothing
 * else: the application settings, the ordered middleware pipeline, and the
 * mounted router tree. It is the one auditable place where the request
 * pipeline's shape is decided, which is the whole reason it is separate from
 * the process layer.
 *
 * WHAT DELIBERATELY LIVES ELSEWHERE. `src/server.js` owns the process: it
 * binds the listener, handles listener errors such as `EADDRINUSE`, sends
 * PM2's readiness handshake, installs the signal handlers and runs the
 * two-phase drain. None of that appears here, and no port or host value is
 * even read here. The application this file returns is COMPLETE BUT NOT
 * LISTENING.
 *
 * WHY THAT SPLIT EARNS ITS KEEP. An application that binds a port as a side
 * effect of being constructed can only be exercised by starting a server on a
 * real port, which makes every check of the pipeline a check of the process
 * lifecycle too. Because `createApp()` binds nothing, the pipeline can be
 * built, inspected and driven independently of any socket -- and `server.js`
 * remains free to decide when, where and whether to listen at all.
 *
 * WHERE ENVIRONMENT VALUES COME FROM. `src/config/index.js` is the only module
 * in this codebase permitted to read the raw environment, so the two
 * operator-settable values this file needs -- `trustProxy` and `bodyLimit` --
 * are read off the frozen configuration object that module exports. This file
 * performs no environment read of its own and holds no literal standing in for
 * a configurable value.
 *
 * WHY THAT BOUNDARY IS DESCRIBED IN WORDS AND NEVER NAMED. The single-reader
 * rule is verified by grepping this tree for the global environment object's
 * name and requiring exactly one file to match. A grep cannot tell code from a
 * comment, so even a passing mention in prose here would report a violation
 * that does not exist. Every other module in this tree observes the same
 * convention; keep the name out of this file entirely.
 *
 * @module app
 */

'use strict';

/*
 * ---------------------------------------------------------------------------
 * External dependencies
 *
 * All three are declared runtime dependencies of `server/package.json`
 * (express 5.2.1, helmet 8.3.0, compression 1.8.1). The SUPPORTED import
 * surface of this tree is the declared direct dependencies plus the Node
 * built-ins, and nothing beyond them. An install does put the whole transitive
 * closure on disk -- `npm ci` resolves 113 packages from seven declared
 * entries -- so requiring something like `qs` or `bytes` would resolve today;
 * it is still out of bounds, because it depends on npm's hoisting rather than
 * on anything the manifest guarantees and can move or vanish on any dependency
 * bump. No logger is built here -- `pino` belongs to `lib/logger.js` and
 * `pino-http` to `middleware/request-context.js`, which supplies the access
 * record this file merely positions.
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const helmet = require('helmet');
const compression = require('compression');

/*
 * ---------------------------------------------------------------------------
 * Internal dependencies
 *
 * Each export shape below is a fixed contract of the module named, and this
 * file consumes it exactly as it stands:
 *
 *   `./config`                     the frozen configuration OBJECT itself, so
 *                                  its fields are read (or destructured)
 *                                  directly off the import.
 *   `./middleware/request-context` a three-arity `(req, res, next)` middleware
 *   `./middleware/not-found`       function, exported by direct assignment --
 *                                  no wrapper object, no factory to call.
 *   `./middleware/error-handler`   the four-arity `(err, req, res, next)`
 *                                  handler, by direct assignment; its arity is
 *                                  what makes it an error handler (position 8).
 *   `./routes`                     one `express.Router()`, by direct
 *                                  assignment, already carrying every mount.
 *
 * Getting one of the four middleware imports wrong -- naming a property the
 * module does not export, or calling one as a factory -- fails LOUDLY, not
 * silently: `app.use()` rejects anything that is not a function while the
 * pipeline is being built, with `TypeError: app.use() requires a middleware
 * function`, so `createApp()` throws and no partly registered application is
 * ever handed to a caller or serves a request.
 * ---------------------------------------------------------------------------
 */

/**
 * The frozen configuration object, of which this file reads EXACTLY TWO
 * fields: `trustProxy` (a real boolean) and `bodyLimit` (a string such as
 * `'100kb'`, which Express's parsers resolve themselves). Both types matter:
 * every non-empty string is truthy, so a `'false'` reaching `trust proxy`
 * would enable exactly the header trust the default exists to withhold.
 */
const config = require('./config');

const requestContext = require('./middleware/request-context');
const notFound = require('./middleware/not-found');
const errorHandler = require('./middleware/error-handler');
const routes = require('./routes');

/**
 * Validates the `extraRouters` seam before anything is mounted.
 *
 * WHY VALIDATE AT ALL, GIVEN EXPRESS ALREADY DOES. Express rejects a
 * non-function passed to `app.use()`, and it does so as the pipeline is built,
 * so earliness is not what this check buys. It buys the DIAGNOSIS. Express
 * reports only `TypeError: app.use() requires a middleware function`, naming
 * neither the option nor the array index that produced the value, because by
 * then the value has lost its provenance -- and a caller injecting several
 * routers cannot tell which entry was bad without bisecting its own harness.
 * This check names `options.extraRouters` and the offending index. A non-array
 * is rejected separately because `for...of` over a single router -- the most
 * likely mistake, since a Router *is* a function -- would otherwise throw an
 * opaque "is not iterable" from inside the factory.
 *
 * @param {unknown} extraRouters The caller-supplied value to check.
 * @returns {void} Returns nothing; the value is unchanged on success.
 * @throws {TypeError} When `extraRouters` is not an array, or when any slot
 *                     from `0` through `length - 1` does not hold a mountable
 *                     function. A MISSING slot -- a sparse-array hole, as in
 *                     `new Array(3)` or `[, router]` -- is rejected exactly
 *                     like an explicit `undefined`, and is named by its index.
 */
function assertMountableRouters(extraRouters) {
  if (!Array.isArray(extraRouters)) {
    throw new TypeError(
      'createApp: options.extraRouters must be an array of express.Router() ' +
        'or middleware functions, received ' +
        (extraRouters === null ? 'null' : typeof extraRouters)
    );
  }

  // An index-bearing message: with several injected routers, "entry 2" is the
  // difference between a one-line fix and bisecting the harness.
  //
  // WHY A COUNTING LOOP AND NOT `forEach`. `forEach` skips the holes in a
  // sparse array, so it would pass an array such as `new Array(3)` or
  // `[, router]` as valid -- and the registration loop below, which iterates,
  // yields `undefined` for those same holes and fails inside `app.use()` after
  // the pipeline is already assembled, with neither the index nor the option
  // name in the message. Visiting every slot from `0` to `length - 1` reads a
  // hole as the `undefined` it will register as, which is what makes the
  // named-index contract above true. Do not "modernise" this back to `forEach`.
  for (let index = 0; index < extraRouters.length; index += 1) {
    const router = extraRouters[index];

    if (typeof router !== 'function') {
      throw new TypeError(
        `createApp: options.extraRouters[${index}] must be an ` +
          'express.Router() or a mountable middleware function, received ' +
          (router === null ? 'null' : typeof router)
      );
    }
  }
}

/**
 * Builds the configured Express application: settings, the eight-position
 * middleware pipeline, and the mounted router tree.
 *
 * Called with no arguments in production -- `src/server.js` passes nothing --
 * so both the options object and the `extraRouters` array carry defaults. A
 * missing default on either would make the production call path throw at
 * start-up.
 *
 * @param {object}   [options]                  Construction options.
 * @param {Array<import('express').Router|import('express').RequestHandler>}
 *                   [options.extraRouters=[]]  Additional routers or mountable
 *                   middleware to register AFTER the service's own router tree
 *                   and BEFORE the terminal 404 producer. Each entry must be an
 *                   `express.Router()` or a middleware function -- anything
 *                   `app.use()` accepts as a single argument. Defaults to an
 *                   empty array, so production behaviour is unchanged.
 * @returns {import('express').Express} The configured application: settings
 *          applied, all eight positions registered, router tree mounted. It is
 *          NOT LISTENING -- no port is bound and no socket exists. Binding is
 *          `src/server.js`'s responsibility.
 * @throws {TypeError} When `options.extraRouters` is not an array of mountable
 *                     functions.
 *
 * @example
 * // Production: no arguments, nothing injected.
 * const { createApp } = require('./app');
 * const app = createApp();
 *
 * @example
 * // A harness injecting a route the service does not ship. Mounting it on the
 * // returned app instead would 404 -- see the seam's comment below.
 * const probe = express.Router();
 * probe.get('/_slow', async (req, res) => { res.json({ ok: true }); });
 * const app = createApp({ extraRouters: [probe] });
 */
function createApp({ extraRouters = [] } = {}) {
  // Caller input is checked before any registration work begins, so a bad
  // `extraRouters` is reported against the option and the index that produced
  // it rather than from somewhere inside the assembled pipeline.
  assertMountableRouters(extraRouters);

  const app = express();

  /*
   * APPLICATION SETTINGS -- all three declared before any middleware, so the
   * application's posture is established at construction and is the first
   * thing a reader of this file meets.
   */

  // Express advertises itself with `X-Powered-By: Express` by default. The
  // header tells an attacker which framework and, by implication, which CVE
  // list to consult, and buys a client nothing in return. Disabling it at the
  // application level is the authoritative switch rather than a header strip
  // further down the pipeline.
  app.disable('x-powered-by');

  // Governs whether Express derives `req.ip` and `req.protocol` from the
  // `X-Forwarded-*` headers. It is an operator decision resolved through the
  // frozen configuration object -- never a literal here -- because it is only
  // safe when a proxy is genuinely in front of the service and overwrites
  // those headers. With no known topology, trusting them lets any direct
  // client forge its own address and scheme, and position 1's request
  // serializer writes exactly those two Express values as the access record's
  // `req.ip` and `req.protocol`, so a forged header would be logged as the
  // client's real identity. The default is therefore `false`.
  app.set('trust proxy', config.trustProxy);

  // Express generates a weak ETag for every body written through `res.send()`
  // or `res.json()` and then honours conditional requests against it: a GET
  // whose `If-None-Match` matches is rewritten to `304 Not Modified` with the
  // body, content type and length stripped. Every status in this service's
  // contract is fixed and unconditional, and no response here is one a client
  // would revalidate -- the root body is a fixed constant, and the probes and
  // the metrics scrape are point-in-time process state that a fresh request
  // answers more cheaply than a conditional one. The validator therefore buys
  // a client nothing and costs those responses their guarantee, so it is not
  // generated at all. Removing it here rather than per route covers every
  // response the application produces, including any route added later.
  //
  // WHAT THIS DOES NOT DO: it does not make a response non-cacheable. Removing
  // the validator only stops a stored copy from being REVALIDATED against
  // this application; forbidding the STORAGE is a separate property and takes
  // a `Cache-Control` directive on the response that wants it. The probes send
  // `no-store` from `routes/health.routes.js` for exactly that reason, and it
  // stays there because it belongs to their contract rather than to every
  // response this pipeline carries.
  //
  // THIS SETTING IS ONLY HALF THE FIX, AND THE OTHER HALF IS NOT A SETTING.
  // `If-None-Match: *` is treated as fresh whether or not a response carries
  // an ETag, so with no validator to match, that one header would still turn
  // a fixed 200 into an empty 304. The freshness test lives inside
  // `res.send()`, and a response that never calls it cannot be rewritten:
  // routes/root.routes.js and routes/health.routes.js therefore serialize
  // their own fixed payloads and terminate with `res.end()`. Neither half is
  // redundant -- this one closes the matching-validator path for the whole
  // application, that one closes the wildcard path for the fixed responses.
  app.set('etag', false);

  /*
   * THE REQUEST PIPELINE -- EIGHT POSITIONS, IN THIS ORDER.
   *
   * The order is correctness, not style. Express runs middleware in
   * registration order, so each position below depends on standing where it
   * does. Do not reorder, merge or "tidy" them.
   */

  // POSITION 1 -- request identity, access logging and metric counters.
  //
  // WHY IT IS FIRST. Everything downstream may fail, and the requests that
  // fail are precisely the ones worth seeing. Registering this first means a
  // request that 404s, or whose body the parser rejects, STILL receives a
  // request id, an access record and a counter increment. At any later
  // position those requests would fall outside the pipeline's observability
  // altogether -- silently, with a correlation id absent from exactly the
  // failures someone is trying to correlate.
  app.use(requestContext);

  // POSITION 2 -- security response headers on every response.
  //
  // Above the router so the headers are attached irrespective of which handler
  // answers, including the 404 and error paths, which are responses to real
  // clients like any other.
  app.use(helmet());

  // POSITION 3 -- response compression for clients that advertise support.
  //
  // Before the body parsers and the router because it must wrap `res.write`
  // and `res.end` before any handler calls them; it acts on the way out, not
  // on the way in. Only responses above its size threshold are compressed, so
  // the small probe payloads pass through untouched.
  app.use(compression());

  // POSITION 4 -- JSON body parsing, bounded.
  //
  // `config.bodyLimit` is the operator-settable ceiling, already validated by
  // the configuration module against `^\d+(kb|mb)?$` with a hard 1 MB cap, and
  // passed through as the string it is. An over-limit body becomes an
  // `entity.too.large` error that position 8 renders as 413; a malformed one
  // becomes `entity.parse.failed`, rendered 400.
  app.use(express.json({ limit: config.bodyLimit }));

  // POSITION 5 -- form body parsing, bounded by the same limit.
  //
  // `extended: false` disables nested form input. It does not swap the parser:
  // the bundled body-parser 2.3.0 calls `qs.parse()` in both modes, and the
  // flag sets the parse depth to `0` and clamps the array limit to the number
  // of parameters actually submitted. With depth `0`, bracket syntax is never
  // interpreted -- `a[b]=1` arrives as the literal key `a[b]`, not as
  // `{ a: { b: '1' } }` -- so a body reaches a handler as a flat map of
  // strings (repeated keys still collect into an array of strings). No endpoint
  // here wants nested form input, and the object graph an attacker can
  // construct from a form body is bounded to one level as a result.
  app.use(express.urlencoded({ extended: false, limit: config.bodyLimit }));

  // POSITION 6 -- the service's own router tree, mounted as one value:
  // `/` and `/health` and `/metrics` and `/api/v1`, aggregated by
  // `src/routes/index.js` so that versioning is a mount path rather than a
  // branch inside a handler.
  app.use(routes);

  // THE INJECTION SEAM -- registered after position 6 and before position 7.
  // DO NOT REMOVE, RENAME, OR MOVE IT AFTER `notFound`.
  //
  // WHY IT EXISTS. By the time `createApp()` returns, `notFound` and
  // `errorHandler` are already registered, so a caller CANNOT mount an
  // additional route on the returned application: the request would match
  // `notFound` first and 404 before ever reaching it. Anything needing a route
  // the service does not ship must therefore be injected here, which is the
  // only position both after the real routes and ahead of the terminal 404.
  // The acceptance sequence depends on it for two routes the service must
  // never ship -- `GET /_boom`, which throws after an `await` to prove the 500
  // path, and `GET /_slow`, which resolves after `?ms=` milliseconds to prove
  // an in-flight request survives a reload.
  //
  // It defaults to an empty array, so with nothing injected this loop is a
  // no-op and production behaviour is exactly as if the seam were absent.
  for (const router of extraRouters) {
    app.use(router);
  }

  // POSITION 7 -- the terminal 404 producer.
  //
  // Reached only when neither the router tree nor an injected router matched.
  // It does not answer the request itself; it constructs a typed 404 and
  // delegates with `next(err)`, so a missing path and a failed request share
  // one response envelope produced in one place.
  app.use(notFound);

  // POSITION 8 -- the single error handler, registered LAST.
  //
  // WHY LAST, AND WHY ITS FOUR-ARITY SIGNATURE MATTERS. Express identifies
  // error middleware solely by its four-parameter signature `(err, req, res,
  // next)`, and dispatches to it only for errors raised at a position ahead of
  // where it is registered. Registered earlier, or wrapped in a three-argument
  // function that discards its arity, it stops receiving errors entirely --
  // and neither mistake produces a start-up error to tell you. It is mounted
  // by direct reference for that reason: `errorHandler.length === 4` is what
  // makes it an error handler.
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
