// SPDX-License-Identifier: Apache-2.0
/**
 * Process-local request metrics for `hello-world-service`.
 *
 * Single responsibility: hold the in-process request counters and render them
 * in Prometheus text exposition format. This module is the *measurement* half
 * of the `/metrics` endpoint; `../routes/metrics.routes.js` is the *transport*
 * half and does nothing but serve the string `render()` returns.
 *
 * The module is a dependency-free leaf on purpose. It imports nothing at all
 * -- not even the application configuration -- and reads nothing from the
 * environment. Its only outside contact is the `process` global, for the
 * three process figures `render()` reports. Two consequences follow, and both
 * are deliberate rather than oversights:
 *
 *   1. It has exactly one writer (`../middleware/request-context.js`) and
 *      exactly one reader (`../routes/metrics.routes.js`), so measurement stays
 *      separate from transport and no third module can mutate a counter.
 *   2. The rendered samples carry no `service` or `instance` label, because a
 *      label would have to come from the configuration module this file is
 *      forbidden to import. A scraper that needs those labels attaches them at
 *      scrape time (Prometheus target labels) instead.
 *
 * WHY the counters are per-worker, and why that is not a defect: under PM2
 * cluster mode every worker is its own OS process with its own copy of this
 * module's state, and all workers share one listening socket. A scrape reaches
 * whichever worker the socket assigns it to, so a single scrape sees *one
 * worker's* numbers and consecutive scrapes may see different ones. That is
 * inherent to counting in-process behind a shared port, not a bug to fix here.
 * The only correct fix -- an aggregator in front of the workers -- is out of
 * scope for this service; `server/README.md` states the same caveat for
 * operators, and this comment states it for the next developer.
 *
 * WHY `http_requests_total` and the per-class buckets are not expected to
 * agree: the total is incremented when a request is *accepted* while the
 * per-class buckets are incremented when its response *completes*, so at any
 * instant `http_requests_total ~= sum(status_class buckets) +
 * http_requests_in_flight`. Equality only holds on an idle process.
 */
'use strict';

/*
 * ---------------------------------------------------------------------------
 * The counter store
 * ---------------------------------------------------------------------------
 * Module-scoped and deliberately private: none of the three values below is
 * exported, so the only way to change a counter is to call one of the two
 * recording functions. That is what keeps "exactly one writer" a property of
 * the design rather than a convention a caller could quietly break.
 *
 * Every counter declared here is both incremented by a recording function and
 * emitted by `render()`. A counter that is written but never rendered is
 * invisible; a family that is rendered but never written reads zero forever.
 */

/**
 * Total requests accepted by this worker since it started.
 * Incremented on accept, never decremented, never reset: a Prometheus counter
 * is monotonic for the lifetime of the process, and the process is replaced by
 * PM2's `autorestart` rather than zeroed in place.
 * @type {number}
 */
let requestsTotal = 0;

/**
 * Requests currently being handled by this worker.
 * Incremented on accept and decremented on completion, so unlike the two
 * counters it can fall as well as rise -- it is a gauge, not a counter.
 * @type {number}
 */
let inFlight = 0;

/**
 * Completed responses tallied by status class.
 *
 * WHY status *class* and not status *code*: keying on the full status code
 * would let the label set grow with every distinct status the service ever
 * returns, which is the unbounded-cardinality anti-pattern in Prometheus --
 * each new code silently adds a time series that a scraper then stores
 * forever. Five fixed buckets keep the series count constant no matter what
 * the service returns.
 *
 * WHY all five keys are pre-initialised to zero rather than created on first
 * use: a series that only appears once it has been hit is a series a dashboard
 * or an `increase()` query cannot reference before then. Pre-initialising
 * means every one of the five exists from process start, and `render()` can
 * iterate a fixed key list instead of whatever happens to have occurred.
 *
 * The object is treated as a fixed-shape record: `recordRequestEnd()` only
 * ever increments a key that is already present here and never adds one.
 *
 * @type {{ '1xx': number, '2xx': number, '3xx': number, '4xx': number, '5xx': number }}
 */
const requestsByStatusClass = {
  '1xx': 0,
  '2xx': 0,
  '3xx': 0,
  '4xx': 0,
  '5xx': 0,
};

/**
 * The status-class keys, in the order `render()` emits them.
 * Held as its own list so the rendered sample order is stable and independent
 * of how the store's keys were inserted or mutated.
 * @type {ReadonlyArray<string>}
 */
const STATUS_CLASS_KEYS = ['1xx', '2xx', '3xx', '4xx', '5xx'];

/*
 * ---------------------------------------------------------------------------
 * The write side
 * ---------------------------------------------------------------------------
 * WHY two functions rather than one: a request is accepted at one moment and
 * its response completes at another, and `inFlight` has to move in opposite
 * directions at those two moments. A single "record this request" call would
 * have to pick one of them, and either choice makes the gauge wrong -- count
 * on accept and it never comes down, count on completion and it never goes up.
 * Splitting the write side is the honest shape for that lifecycle.
 *
 * Both functions are called from the same single writer,
 * `../middleware/request-context.js`, which sits at position 1 of the
 * middleware pipeline. Position 1 is what makes the counts complete: a request
 * that 404s, or whose body fails to parse, has already been counted before it
 * reaches the router, and its response still completes through the same hook.
 */

/**
 * Map an HTTP status code onto its status-class key.
 *
 * Called only by `recordRequestEnd()` in this module; it is not exported,
 * because the class keys are an internal representation and a caller with the
 * key in hand would be one step from writing the store directly.
 *
 * The `hasOwnProperty` check is the guard that keeps the label set fixed: any
 * value that does not land in 100-599 -- including `undefined`, a non-numeric
 * value (`Math.floor(NaN / 100)` renders as the key `"NaNxx"`), or a status
 * outside the HTTP range -- returns `null` instead of naming a sixth bucket.
 * Node and Express only produce statuses in 100-599 in practice, so this is a
 * guard against a caller defect rather than an expected code path.
 *
 * @param {number} statusCode HTTP response status code, normally 100-599.
 * @returns {string|null} One of `'1xx'`..`'5xx'`, or `null` when the code does
 *   not belong to any of the five pre-initialised classes.
 */
function statusClassKey(statusCode) {
  const key = `${Math.floor(statusCode / 100)}xx`;

  return Object.prototype.hasOwnProperty.call(requestsByStatusClass, key)
    ? key
    : null;
}

/**
 * Record that a request has been accepted for handling.
 *
 * Increments the lifetime request total and raises the in-flight gauge by one.
 * Takes no arguments: nothing about the request is measured at this point, and
 * accepting one would invite per-request labels this module deliberately does
 * not carry.
 *
 * Sole permitted caller: `../middleware/request-context.js`, on the way in.
 * Every call must be paired with exactly one later `recordRequestEnd()` call
 * -- see the contract on that function.
 *
 * @returns {void}
 */
function recordRequestStart() {
  requestsTotal += 1;
  inFlight += 1;
}

/**
 * Record that a response has completed.
 *
 * Lowers the in-flight gauge by one and increments the bucket for the
 * response's status class.
 *
 * PAIRING CONTRACT -- read this before wiring the caller. This function must
 * be called **exactly once for every `recordRequestStart()` call, including
 * for requests the client aborts**. The caller therefore needs a completion
 * hook that fires on abort and on error as well as on a normal finish, and it
 * must not fire twice for one request. Call it too seldom and `inFlight`
 * drifts upward permanently, so it never returns to zero on an idle process
 * and the gauge becomes worthless; call it twice and the gauge goes negative
 * while a status bucket over-counts.
 *
 * The decrement is deliberately a plain `-= 1` with no `Math.max(0, ...)`
 * floor. WHY: a negative `http_requests_in_flight` can only mean the caller
 * broke the pairing contract above, and that is precisely the defect an
 * operator needs to see in the exposition output. Clamping at zero would hide
 * it behind a plausible-looking gauge.
 *
 * Sole permitted caller: `../middleware/request-context.js`, on completion.
 *
 * @param {number} statusCode Status code of the completed response, normally
 *   100-599. A value outside the five known status classes still lowers the
 *   in-flight gauge -- the request did complete -- but is not tallied in any
 *   bucket, so the fixed five-series label set is preserved.
 * @returns {void}
 */
function recordRequestEnd(statusCode) {
  inFlight -= 1;

  const key = statusClassKey(statusCode);

  // A `null` key is the guard path described on `statusClassKey()`: skip the
  // per-class increment rather than create a sixth series for a status the
  // service should never have produced.
  if (key !== null) {
    requestsByStatusClass[key] += 1;
  }
}

/*
 * ---------------------------------------------------------------------------
 * The read side
 * ---------------------------------------------------------------------------
 * One function, producing the whole exposition document as a string. It is
 * pure with respect to the store -- rendering never mutates a counter -- so a
 * scrape cannot perturb what it measures.
 */

/**
 * Render the current metrics in Prometheus text exposition format.
 *
 * Emits six metric families, each preceded by its `# HELP` and `# TYPE`
 * lines: the lifetime request total, the five per-status-class buckets, the
 * in-flight gauge, and three process figures. The `process_*` family names
 * deliberately match the conventional Prometheus process-collector names, so a
 * scraper or dashboard that already expects them works without remapping.
 *
 * Sole permitted caller: `../routes/metrics.routes.js`, which serves the
 * returned string under `Content-Type: text/plain; version=0.0.4`. This
 * function sets no header and knows nothing about HTTP -- that separation is
 * why the measurement half of `/metrics` can be exercised without a server.
 *
 * @returns {string} The exposition document, terminated by a single newline.
 *   The trailing newline is required by the text format: the final sample line
 *   must be LF-terminated or a strict parser rejects the document.
 */
function render() {
  // WHY the three process figures are read here, inside `render()`, rather
  // than sampled on a timer or cached: a scrape must reflect the instant it
  // was taken, and a background sampler would put an interval timer into a
  // module whose whole point is to stay dependency-free and passive. Reading
  // them on the scrape path also means an idle process does no work at all.
  const uptimeSeconds = process.uptime();
  const residentMemoryBytes = process.memoryUsage().rss;
  const cpu = process.cpuUsage();

  // WHY the division by 1e6: `process.cpuUsage()` reports `user` and `system`
  // in **microseconds**, while this metric is named `_seconds_total` and
  // Prometheus convention requires base units. Emitting the raw sum would
  // overstate CPU time by a factor of a million, and nothing downstream would
  // flag it -- the value would simply look like a busy process. This is the
  // single easiest unit error to make in this file.
  const cpuSeconds = (cpu.user + cpu.system) / 1e6;

  const lines = [
    '# HELP http_requests_total Total HTTP requests accepted by this worker since start.',
    '# TYPE http_requests_total counter',
    `http_requests_total ${requestsTotal}`,
    '# HELP http_requests_by_status_class_total Completed HTTP requests by response status class.',
    '# TYPE http_requests_by_status_class_total counter',
  ];

  // Iterating the fixed key list (rather than the store's own keys) is what
  // guarantees all five series appear on every scrape, in the same order,
  // whatever traffic the worker has seen.
  for (const statusClass of STATUS_CLASS_KEYS) {
    const count = requestsByStatusClass[statusClass];

    lines.push(
      `http_requests_by_status_class_total{status_class="${statusClass}"} ${count}`,
    );
  }

  // Counts are plain integers and are interpolated as such; only the two
  // fractional figures are formatted, with `toFixed()` rather than default
  // number-to-string conversion so that a very small value renders as
  // `0.000123` and never in exponential notation, which the text format's
  // sample grammar does not accept from this renderer.
  lines.push(
    '# HELP http_requests_in_flight HTTP requests currently being handled by this worker.',
    '# TYPE http_requests_in_flight gauge',
    `http_requests_in_flight ${inFlight}`,
    '# HELP process_uptime_seconds Seconds elapsed since this worker process started.',
    '# TYPE process_uptime_seconds gauge',
    `process_uptime_seconds ${uptimeSeconds.toFixed(3)}`,
    '# HELP process_resident_memory_bytes Resident set size of this worker process, in bytes.',
    '# TYPE process_resident_memory_bytes gauge',
    `process_resident_memory_bytes ${residentMemoryBytes}`,
    '# HELP process_cpu_seconds_total Total user plus system CPU time consumed by this worker, in seconds.',
    '# TYPE process_cpu_seconds_total counter',
    `process_cpu_seconds_total ${cpuSeconds.toFixed(6)}`,
  );

  return `${lines.join('\n')}\n`;
}

/*
 * ---------------------------------------------------------------------------
 * Exports
 * ---------------------------------------------------------------------------
 * Exactly two writers and one reader, and nothing else. The counter store
 * itself stays module-private: exporting it would let any module increment a
 * counter -- or overwrite one -- without going through the two functions that
 * define what a "request" means here, and the single-writer property the
 * module is built around would become unenforceable.
 *
 * Nothing further is exported on purpose. There is no `reset()`, because a
 * Prometheus counter is monotonic for the lifetime of the process and a worker
 * is replaced by PM2's `autorestart` rather than zeroed in place. There is no
 * latency histogram or summary, because response time is already carried on
 * the pino-http access record. There is no JSON renderer beside the text one,
 * because the single reader serves Prometheus text. And there are no
 * per-counter getters, because the exposition document is the read interface.
 */
module.exports = { recordRequestStart, recordRequestEnd, render };
