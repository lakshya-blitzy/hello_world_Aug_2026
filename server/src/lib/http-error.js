// SPDX-License-Identifier: Apache-2.0
//
// Single responsibility: the typed HTTP error for hello-world-service.
//
// This module owns one thing: an Error that carries its own HTTP status. That
// lets a route handler or a middleware signal intent ("this is a 404", "this is
// a 400") by delegating the error onward, without formatting a response itself.
// Presentation belongs exclusively to src/middleware/error-handler.js, which is
// the single exit for every failure in the pipeline and the only place the
// { error: { status, message, requestId } } envelope is built.
//
// This module is a leaf in the dependency graph: it imports nothing at all,
// neither the frozen configuration object nor the logger nor express. That is
// deliberate rather than incidental. It is consumed from the middleware, route
// and application layers alike, and having no outgoing edge of its own is what
// guarantees it can never participate in a dependency cycle.

'use strict';

/**
 * An `Error` subclass that carries the HTTP status its failure should produce,
 * plus optional structured details describing the cause.
 *
 * Consumers, and the shape each one relies on:
 * - `src/middleware/error-handler.js` tests `err instanceof HttpError` and, when
 *   that holds, honours `err.status` as the response status instead of masking
 *   the failure as a 500.
 * - `src/middleware/not-found.js` constructs one with status 404 for any path
 *   the router did not match, so the 404 path and the error path share a single
 *   response format.
 * - `src/routes/api.routes.js` constructs one with status 400 when `POST /echo`
 *   rejects a request on media type or on body shape.
 *
 * Throwing it from an `async` handler is equally valid: Express 5 forwards a
 * rejected promise to the four-arity error middleware automatically, so no
 * try/catch wrapper is needed at the call site.
 *
 * @example
 * // Signal intent and let the error handler format the response.
 * next(new HttpError(404, `Cannot ${req.method} ${req.originalUrl}`));
 *
 * @example
 * // Attach structured detail about why the request was rejected.
 * throw new HttpError(400, 'Request body must be a JSON object or array', {
 *   received: typeof req.body,
 * });
 */
class HttpError extends Error {
  /**
   * Builds a typed HTTP error.
   *
   * @param {number} status The HTTP status code this failure should produce,
   *   read directly by `error-handler.js`. Always supplied explicitly by the
   *   caller; there is no default, because a status the caller did not choose
   *   would be a guess presented to the client as a decision.
   * @param {string} message Human-readable description of the failure. It is
   *   passed to `Error`, so `err.message` and `err.stack` behave normally. For a
   *   5xx in production the error handler substitutes a generic message in the
   *   response and keeps this one in the log.
   * @param {*} [details] Optional structured context about the cause: any
   *   serialisable value. Omit it entirely when there is nothing useful to add.
   */
  constructor(status, message, details) {
    // Delegate to Error so `message` and `stack` are populated the standard way.
    super(message);

    // `name` is inherited as 'Error' otherwise. Setting it explicitly is what
    // makes the class legible once the error has been serialised into a log
    // record, where the prototype chain is no longer available to inspect.
    this.name = 'HttpError';

    // The status the error handler will honour for this failure.
    this.status = status;

    // Assigned conditionally rather than unconditionally, and the difference is
    // observable: a plain `this.details = details` leaves an own property whose
    // value is `undefined` on every error raised without details, which is the
    // majority of them, and that then surfaces as a permanently empty field in
    // serialised output. Guarding the assignment keeps `'details' in err` a
    // truthful test of whether the raiser actually supplied any.
    if (details !== undefined) {
      this.details = details;
    }

    // Re-capture the stack passing the constructor as the second argument, which
    // omits this constructor's own frame. The first line of `err.stack` is then
    // the call site that actually raised the error rather than a frame inside
    // this module, which never varies and so tells an operator correlating a
    // failure to its origin nothing at all.
    Error.captureStackTrace(this, HttpError);
  }
}

// Exported as the class itself, not wrapped in an object. All three consumers
// address the module's export directly: `instanceof` in the error handler, and
// `new` in the not-found middleware and in the API route. Exporting
// `{ HttpError }` instead would break every one of them.
module.exports = HttpError;
