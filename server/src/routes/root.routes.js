// SPDX-License-Identifier: Apache-2.0
//
// Root route for hello-world-service.
//
// Single responsibility: serve the service's root response -- `GET /` -- and
// nothing else. This module registers exactly one route on exactly one
// express.Router(), and src/routes/index.js mounts that router at `/`, so the
// effective path is `GET /`.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO. It registers no middleware, sets
// no application-level settings, writes no log line of its own, and touches no
// response header other than the Content-Type its own contract fixes. Every
// cross-cutting concern is already applied by the ordered pipeline in
// src/app.js before this router is ever reached: request identity and access
// logging (position 1), security headers (2), response compression (3) and
// body parsing (4-5). The aggregated router tree is registered at position 6,
// the terminal 404 producer at 7, and the four-arity error handler at 8.
// This module must therefore stay a plain, mountable Router: it neither
// terminates the pipeline itself nor handles errors, because the two positions
// that do already sit behind it.
//
// WHY THE RESPONSE BODY IS WHAT IT IS -- read this before changing it.
// `Hello, World!\n` is a PLAN DECISION. It is not a user-supplied requirement,
// and it is not a baseline recovered from a previous implementation: this
// repository contained no HTTP server of any kind, so there was nothing from
// which a root response could be recovered and nothing to preserve
// compatibility with. The body is a design default, chosen so that the root
// mount answers something meaningful rather than 404, and it carries no
// authority beyond that. If a real root contract is ever specified, replacing
// this body is an ordinary change and breaks no promise to anyone.
//
// WHY THAT MAKES THIS ITS OWN MODULE. This single route is isolated in a
// single-route file precisely because the response above is the one
// undetermined decision in the whole HTTP surface: keeping it here makes
// changing it a one-file change with no other module to touch and no unrelated
// route to re-read. Folding this handler into src/routes/index.js, or into any
// other route module, would destroy exactly that isolation -- which is this
// module's entire reason for existing. Do not consolidate it away.
//
// CONSISTENCY OBLIGATION. The endpoint-reference table in server/README.md is
// the canonical, single-location documentation of this contract. The status
// code, the content type and the body below are reproduced there; changing any
// of the three here without updating that table makes the runbook untrue.

'use strict';

// Express is deliberately the only import here, and the list of things this
// module does NOT import is the point: not src/config, not src/lib/logger, not
// src/lib/http-error. The response below is unconditional, so configuration
// owns nothing in it; logging is already done for every request by position 1
// of the pipeline; and a route with no failure path raises no error to type.
// Each of those requires would be dead weight in a module whose whole job is
// one fixed response.
const express = require('express');

/**
 * The router this module exports.
 *
 * A bare `express.Router()` carrying the one route registered below. It is
 * exported by direct assignment (`module.exports = router`) because
 * src/routes/index.js mounts it with
 * `router.use('/', require('./root.routes'))`, which needs a mountable Router
 * value -- not a wrapper object, not `{ router }`, and not a factory that has
 * to be invoked first. Any other export shape breaks that mount.
 *
 * @type {import('express').Router}
 */
const router = express.Router();

/**
 * `GET /` -- the service's root response.
 *
 * Writes the fixed root response and returns: status `200`, `Content-Type:
 * text/plain; charset=utf-8`, and the 14-byte body `Hello, World!\n`
 * (a trailing newline included, so the payload reads cleanly in a terminal).
 *
 * The handler is deliberately synchronous and has no failure path. It reads no
 * input, performs no I/O and consults no state, so there is no condition it
 * could reject and nothing that could throw -- which is why it takes no
 * `next` parameter, adds no validation and wraps nothing in try/catch. It also
 * does not call `next()` on success: the response is complete when `send()`
 * returns, and delegating onward from here would fall through to the terminal
 * 404 producer registered after this router.
 *
 * @param {import('express').Request} req The incoming request. Intentionally
 *   unread: the response is unconditional, identical for every caller, and
 *   derives nothing from the request. The parameter exists because Express
 *   supplies handler arguments positionally, so `res` cannot be reached
 *   without it.
 * @param {import('express').Response} res The response to write. Receives the
 *   status, the content type and the body, in that order.
 * @returns {void} Nothing is returned to the caller; the result of this
 *   handler is the response written to `res`.
 */
router.get('/', (req, res) => {
  // Setting the type BEFORE sending is required rather than stylistic. Given a
  // string body and no Content-Type already set, Express infers `text/html`,
  // which would silently violate the contract this route documents. Calling
  // `res.type('text/plain')` first appends the charset for text types, so the
  // header emitted is exactly `text/plain; charset=utf-8`.
  //
  // The body is a single-quoted literal with an explicit `\n` escape -- not a
  // multi-line template literal, which would embed this file's own indentation
  // into the payload, and not a second newline from any other source. Exactly
  // one trailing newline byte is part of the contract.
  res.status(200).type('text/plain').send('Hello, World!\n');
});

// The public surface is the Router itself and nothing else: no named helpers,
// no configuration hook and no test-only export. src/routes/index.js consumes
// this value directly, so the assignment must stay a bare Router.
module.exports = router;
