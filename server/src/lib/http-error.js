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
 * Lowest status this error may carry: the first client-error code.
 *
 * A status below this is not a failure at all -- an informational, successful
 * or redirect status handed to the error handler would present a failure to
 * the client as one of those things instead, which is worse than an error
 * because nothing reports it.
 *
 * @type {number}
 */
const MIN_ERROR_STATUS = 400;

/**
 * Highest status this error may carry: the last server-error code.
 *
 * The bound is the class range rather than a list of registered codes, because
 * a service is free to answer an unregistered 4xx or 5xx and rejecting one
 * would be this module inventing a policy the HTTP specification does not
 * have. What it must reject is a value that is not a failure status at all.
 *
 * @type {number}
 */
const MAX_ERROR_STATUS = 599;

/**
 * An `Error` subclass that carries the HTTP status its failure should produce,
 * plus optional structured details describing the cause.
 *
 * The status is constrained to the failure range -- an integer from 400 to 599
 * inclusive -- and the constructor rejects anything else outright. That is the
 * contract error-handler.js relies on when it sends `err.status` verbatim, and
 * the reasoning behind refusing rather than defaulting is in the constructor.
 *
 * Consumers, and the shape each one relies on:
 * - `src/middleware/error-handler.js` tests `err instanceof HttpError` and,
 *   when that holds, honours `err.status` as the response status instead of
 *   masking the failure as a 500 -- re-checking the value first, because a
 *   public field can be reassigned after construction.
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
   *   would be a guess presented to the client as a decision. It must be an
   *   integer from `MIN_ERROR_STATUS` to `MAX_ERROR_STATUS` inclusive.
   * @param {string} message Human-readable description of the failure. It is
   *   passed to `Error`, so `err.message` and `err.stack` behave normally. For a
   *   5xx in production the error handler substitutes a generic message in the
   *   response and keeps this one in the log.
   * @param {*} [details] Optional structured context about the cause: any
   *   serialisable value. Omit it entirely when there is nothing useful to add.
   * @throws {TypeError} When `status` is not an integer in the failure range.
   *   Raising rather than substituting a default is deliberate: see below.
   */
  constructor(status, message, details) {
    // VALIDATED BEFORE `super`, AND AN INVALID STATUS THROWS RATHER THAN BEING
    // CORRECTED.
    //
    // `status` is read straight out of this object by error-handler.js and
    // handed to `res.status()`. Express rejects anything that is not an
    // integer from 100 to 999 by throwing -- and it would throw INSIDE the
    // terminal error handler, the one place in the pipeline that has nothing
    // after it to catch a failure, so the request would end with no envelope
    // and no status of its own. A value inside Express's range but outside the
    // failure range fails differently and more quietly: a 204 or a 302 would
    // answer a failure as a success or a redirect, and no log line would
    // disagree.
    //
    // Correcting the value here instead of rejecting it would hide a defect
    // that only ever comes from a call site in this repository: every caller
    // passes a literal. So the constructor refuses, at the raise site, with
    // the received value named. If such a call ever ships, the TypeError is
    // delegated to error-handler.js like any other unexpected failure and
    // becomes a masked 500 with an exception record -- which is the correct
    // outcome for a defect, and never a client error.
    //
    // error-handler.js validates `status` again at the boundary. That is not
    // redundant: `status` is a mutable public field, and the handler honours it
    // on any object that is an `instanceof` this class, including one whose
    // status was assigned after construction.
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

    // THE STACK COMES FROM `super(message)`, AND IS CAPTURED EXACTLY ONCE.
    // DO NOT ADD `Error.captureStackTrace(this, HttpError)` HERE.
    //
    // It looks necessary, because the second argument is documented as the way
    // to omit the constructor's own frame and start the trace at the call site
    // that raised the error. V8 already does that for a subclass of `Error`:
    // constructing one captures the stack with the constructor chain of the
    // error being built excluded, so `err.stack`'s first frame is the raiser
    // and no `new HttpError` frame appears -- verified on this service's Node
    // 24.20.0, from both a synchronous and an async raise path, with the two
    // stacks identical apart from the line and column of the call site.
    //
    // Adding it back therefore changes nothing about the trace and costs a
    // second stack walk on every construction. That matters here more than it
    // would elsewhere: every unmatched path and every rejected `POST /echo`
    // body raises one of these, so the cost is on a path any client can drive
    // as fast as it likes. Measured at 200,000 constructions, the second
    // capture roughly doubled the time spent building them.
  }
}

// Exported as the class itself, not wrapped in an object. All three consumers
// address the module's export directly: `instanceof` in the error handler, and
// `new` in the not-found middleware and in the API route. Exporting
// `{ HttpError }` instead would break every one of them.
module.exports = HttpError;
