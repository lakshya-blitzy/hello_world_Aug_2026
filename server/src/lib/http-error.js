// SPDX-License-Identifier: Apache-2.0
//
// Single responsibility: the typed HTTP error for hello-world-service.
//
// This module owns one thing: an Error that carries its own HTTP status. That
// lets a route handler or a middleware signal intent ("this is a 404", "this is
// a 400") by delegating the error onward, without formatting a response itself.

'use strict';

// The failure-status range the constructor enforces.
const MIN_ERROR_STATUS = 400;
const MAX_ERROR_STATUS = 599;

/**
 * An `Error` subclass carrying the HTTP status its failure should produce, plus
 * optional details describing the cause. The status is constrained to the
 * failure range: an integer from 400 to 599 inclusive.
 *
 * Consumers, and the shape each one relies on:
 * - `src/middleware/error-handler.js` tests `err instanceof HttpError` and
 *   honours `err.status` as the response status.
 * - `src/middleware/not-found.js` constructs one with status 404 for a path the
 *   router did not match.
 * - `src/routes/api.routes.js` constructs one with status 400 when `POST /echo`
 *   rejects a request on media type or on body shape.
 *
 * Throwing it from an `async` handler is equally valid: Express 5 forwards a
 * rejected promise to the four-arity error middleware automatically.
 */
class HttpError extends Error {
  /**
   * Builds a typed HTTP error.
   *
   * @param {number} status The status this failure should produce: an integer
   *   from `MIN_ERROR_STATUS` to `MAX_ERROR_STATUS` inclusive. There is no
   *   default, because a status the caller did not choose would be a guess
   *   presented to the client as a decision.
   * @param {string} message Human-readable description of the failure, passed
   *   to `Error`. For a 5xx in production the error handler substitutes a
   *   generic message in the response and keeps this one in the log.
   * @param {*} [details] Optional context about the cause, of any type,
   *   attached to the error only when supplied.
   * @throws {TypeError} When `status` is not an integer in the failure range.
   */
  constructor(status, message, details) {
    // Refuses an unusable status rather than correcting it, so the defect is
    // reported here, at the raise site, where the offending call is in view.
    // Every caller in this repository passes a literal, so an invalid one is a
    // coding error rather than input. The terminal error handler repeats this
    // check defensively before sending -- `status` is a mutable public field
    // and can be reassigned after construction -- and answers an unusable value
    // with a masked 500, which is a correct response to a defect but names
    // nothing a reader could act on.
    if (
      !Number.isInteger(status) ||
      status < MIN_ERROR_STATUS ||
      status > MAX_ERROR_STATUS
    ) {
      throw new TypeError(
        `HttpError status must be an integer between ${MIN_ERROR_STATUS} and ` +
          `${MAX_ERROR_STATUS}; received ` +
          `${typeof status === 'number' ? status : typeof status}`
      );
    }

    super(message);

    // `name` is inherited as 'Error' otherwise. Setting it explicitly is what
    // makes the class legible once the error has been serialised into a log
    // record, where the prototype chain is no longer available to inspect.
    this.name = 'HttpError';

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

    // Passing the constructor as the second argument captures the stack with
    // this constructor's own frame omitted, so `err.stack`'s first frame is the
    // call site that raised the error rather than this module. That is what
    // makes an exception record point at the code that made the decision.
    Error.captureStackTrace(this, HttpError);
  }
}

// Exported as the class itself, not wrapped in an object. All three consumers
// address the module's export directly: `instanceof` in the error handler, and
// `new` in the not-found middleware and in the API route. Exporting
// `{ HttpError }` instead would break every one of them.
module.exports = HttpError;
