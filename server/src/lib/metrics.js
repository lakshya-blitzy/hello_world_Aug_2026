// SPDX-License-Identifier: Apache-2.0
/**
 * Process-local request metrics for `hello-world-service`.
 *
 * Single responsibility: hold the in-process request counters and render them
 * in Prometheus text exposition format. This module is the *measurement* half
 * of the `/metrics` endpoint; `../routes/metrics.routes.js` is the *transport*
 * half and does nothing but serve the string `render()` returns.
 *
 * The module is a dependency-free leaf on purpose. It issues no `require` at
 * all, and its only outside contact is the `process` global, for the three
 * process figures `render()` reports. Two consequences follow, and both are
 * deliberate rather than oversights:
 *
 *   1. It has exactly one writer (`../middleware/request-context.js`) and
 *      exactly one reader (`../routes/metrics.routes.js`), so measurement stays
 *      separate from transport and no third module can move a counter.
 *   2. The exposition carries no identity. No sample names the service or the
 *      PM2 cluster ordinal, and the only label in the whole document is the
 *      fixed `status_class` on the per-class family. Those identity values
 *      could only come from `../config`, which this module must not import --
 *      and leaving them out is also what keeps an unauthenticated scrape from
 *      disclosing service identity or worker topology. `GET /health` and every
 *      log line carry the identity instead; this document carries request
 *      counts and process figures, and nothing else.
 *
 * WHY the counters are per-worker, and why that is not a defect: under PM2
 * cluster mode every worker is its own OS process with its own copy of this
 * module's state, and all workers share one listening socket. A scrape reaches
 * whichever worker the socket assigns it to, so a single scrape sees *one
 * worker's* numbers and consecutive scrapes may see different ones -- and,
 * there being no worker label in the document, a scrape cannot be attributed
 * to a particular worker at all. That is inherent to counting in-process
 * behind a shared port, not a bug to fix here. The only correct fix -- an
 * aggregator in front of the workers -- is out of scope for this service;
 * `server/README.md` states the same caveat for operators.
 *
 * HOW THE THREE REQUEST FAMILIES RELATE. The total is incremented when a
 * request is *accepted* and the per-class buckets when its response
 * *completes*, with the gauge covering the span between -- so a request still
 * being handled is counted by `http_requests_in_flight` and creates no gap.
 * `sum(status_class buckets) + http_requests_in_flight` therefore accounts for
 * `http_requests_total` exactly, save for requests that ended with no
 * countable status: a response the client destroyed before it finished leaves
 * the total with nothing to tally, and the shortfall is that count. A
 * *surplus* is the reading that is not arithmetic -- it means a doubled
 * `recordRequestEnd()` call, or a bucket moved outside these two functions,
 * and either is a defect to find rather than a figure to explain.
 */
'use strict';

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
 * WHY THE WRITE SIDE IS TWO FUNCTIONS RATHER THAN ONE: a request is accepted
 * at one moment and its response completes at another, and `inFlight` has to
 * move in opposite directions at those two moments. A single "record this
 * request" call would have to pick one of them, and either choice makes the
 * gauge wrong -- count on accept and it never comes down, count on completion
 * and it never goes up.
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
 * value that does not land in 100-599 -- a non-numeric value
 * (`Math.floor(NaN / 100)` renders as the key `"NaNxx"`) or a status outside
 * the HTTP range -- returns `null` instead of naming a sixth bucket. Node and
 * Express only ever produce statuses in 100-599, so that branch guards the
 * store's fixed five-series shape rather than describing a path ordinary
 * traffic takes.
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
 * Record that a request has finished.
 *
 * Lowers the in-flight gauge by one and increments the bucket for the status
 * class of the response that completed.
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
 * @param {number} statusCode Status code of the response, normally 100-599.
 *   Required: it is the value that decides which of the five buckets moves,
 *   and `http_requests_by_status_class_total` counts responses by the status
 *   they completed with. A value that maps to none of the five classes lowers
 *   the gauge and tallies nothing, which is what keeps the label set fixed at
 *   five series.
 * @returns {void}
 */
function recordRequestEnd(statusCode) {
  // Unconditional, and first: every request that started has now finished, so
  // the gauge comes down whatever status the response carried. Keeping this
  // independent of the status is what makes the pairing contract above
  // satisfiable for a request that ended without a countable status.
  inFlight -= 1;

  const key = statusClassKey(statusCode);

  // A `null` key is the guard path described on `statusClassKey()`: skip the
  // per-class increment rather than create a sixth series for a value that is
  // not one of the five status classes.
  if (key !== null) {
    requestsByStatusClass[key] += 1;
  }
}

/**
 * Render the current metrics in Prometheus text exposition format.
 *
 * Takes no arguments, and reads nothing outside this module but `process`:
 * every number in the document comes from the counter store above or from one
 * of the three process figures sampled below. Rendering never mutates a
 * counter, so a scrape cannot perturb what it measures.
 *
 * Emits six metric families, each preceded by its `# HELP` and `# TYPE` lines
 * -- the lifetime request total, the five per-status-class buckets, the
 * in-flight gauge, and three process figures -- for ten sample lines in all.
 * The `process_*` family names deliberately match the conventional Prometheus
 * process-collector names, so a scraper or dashboard that already expects them
 * works without remapping.
 *
 * THE ONLY LABEL IN THE DOCUMENT is the fixed `status_class` on
 * `http_requests_by_status_class_total`. No sample carries a service name, a
 * cluster ordinal or any other configuration-derived value: this module
 * imports nothing and so cannot look one up, and the minimal surface is the
 * point rather than a limitation -- `/metrics` is unauthenticated, and a
 * document that named the process and its cluster position would tell a caller
 * more about the deployment than a scrape needs. The identity is available
 * from `GET /health` and from every log line, both of which take it from
 * `../config`.
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

  // `toFixed()` keeps the two fractional figures at a fixed width, so a
  // near-idle worker's CPU time reads as `0.000012` rather than `1.2e-5`.
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

// The counter store stays module-private: these three functions are the only
// way to move or read a counter, which is what makes "exactly one writer" a
// property of the design rather than a convention.
module.exports = { recordRequestStart, recordRequestEnd, render };
