// SPDX-License-Identifier: Apache-2.0
//
// Root route for hello-world-service.
//
// Single responsibility: serve the service's root response -- `GET /` -- and
// nothing else. This module registers exactly one route on exactly one
// express.Router(), and src/routes/index.js mounts that router at `/`, so the
// effective path is `GET /`.
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

'use strict';

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
 * The root response body.
 *
 * A single-quoted literal with an explicit `\n` escape -- not a multi-line
 * template literal, which would embed this file's own indentation into the
 * payload. Exactly one trailing newline byte is part of the contract.
 *
 * @type {string}
 */
const ROOT_BODY = 'Hello, World!\n';

/**
 * `ROOT_BODY`'s length in bytes, measured once at module load.
 *
 * Derived from the body rather than written as a number so the payload and the
 * `Content-Length` header the handler sends cannot drift apart if the body
 * ever changes.
 *
 * @type {number}
 */
const ROOT_BODY_BYTE_LENGTH = Buffer.byteLength(ROOT_BODY);

/**
 * `GET /` -- the service's root response.
 *
 * Writes the fixed root response and returns: status `200`, `Content-Type:
 * text/plain; charset=utf-8`, and the 14-byte body `Hello, World!\n`
 * (a trailing newline included, so the payload reads cleanly in a terminal).
 *
 * THIS HANDLER ALSO ANSWERS `HEAD /`, and deliberately declares nothing for
 * it. The router package resolves `HEAD` against this `GET` route because no
 * explicit `HEAD` handler exists, so the status and both headers below are the
 * ones a `HEAD` caller receives; Node suppresses the body itself, because it
 * marks a response to a `HEAD` request as carrying none. `Content-Length: 14`
 * is retained on that empty answer, which is what RFC 9110 asks for -- the
 * header describes the representation the matching `GET` would return, not the
 * bytes on this particular wire. Declaring a `HEAD` handler here, or trimming
 * the header for it, would break that parity rather than complete it. The
 * method reaches this route because `./index.js` sanctions it at the gate.
 *
 * The handler is deliberately synchronous and has no failure path. It reads no
 * input, performs no I/O and consults no state, so there is no condition it
 * could reject and nothing that could throw -- which is why it takes no
 * `next` parameter, adds no validation and wraps nothing in try/catch. It also
 * does not call `next()` on success: the response is complete when `res.end()`
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
  // WHY THIS WRITES THE RESPONSE ITSELF RATHER THAN CALLING `res.send()`.
  // `res.send()` evaluates conditional-request freshness before it writes: on
  // a GET it rewrites a 2xx to `304 Not Modified` and strips the body, and
  // `If-None-Match: *` counts as fresh whether or not the response carries an
  // ETag -- so disabling ETag generation in ../app.js does not close that path
  // on its own. A single request header would otherwise decide what this route
  // returns, which is not a choice the fixed contract above leaves open.
  // `res.end()` performs no freshness test, so the status and the body below
  // are what every caller gets.
  res.status(200);

  // Written verbatim through the raw setter rather than inferred via
  // `res.type('text/plain')`: the contract names the full header value, and a
  // string body with no Content-Type would otherwise be served as `text/html`.
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');

  // `res.send()` derives this header itself; `res.end()` does not, and
  // without it Node frames the response with chunked transfer encoding
  // instead of a length -- so it is set here, from the body's own measured
  // size, to keep the wire form a fixed-length payload implies.
  // Safe against `compression()` at pipeline position 3: that middleware
  // removes this header whenever it compresses, and this body is far below its
  // size threshold, so it is never compressed in the first place.
  res.setHeader('Content-Length', ROOT_BODY_BYTE_LENGTH);
  res.end(ROOT_BODY);
});

module.exports = router;
