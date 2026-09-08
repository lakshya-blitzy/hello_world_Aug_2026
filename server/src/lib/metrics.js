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
 *   2. The process identity every sample carries -- the service name and the
 *      PM2 cluster instance -- is NOT read here. It is passed IN, as the
 *      `identity` argument of `render()`, by that one reader. The identity
 *      originates in `../config`, the only module allowed to read the
 *      environment, and the reader consumes it exactly as
 *      `../routes/health.routes.js` consumes it for the `GET /health` payload.
 *      So the exposition does carry `service` and `instance` labels while this
 *      file keeps zero imports: the requirement that `GET /health`, the metrics
 *      output and every log line share ONE shape is satisfied at the transport
 *      boundary instead of by giving the counter store a dependency. Do not
 *      "simplify" this by importing `../config` here -- that would close the
 *      leaf property this module's single-writer guarantee rests on, and it
 *      would buy nothing the argument does not already provide.
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
 * THE TOTAL-VERSUS-BUCKET IDENTITY, STATED EXACTLY. The total is incremented
 * when a request is *accepted*; the per-class buckets are incremented when its
 * response *completes*. Both moves are synchronous and paired --
 * `recordRequestStart()` raises the total and the gauge together, and
 * `recordRequestEnd()` lowers the gauge and raises one bucket together -- so no
 * scrape can catch a half-applied update. The relationship is therefore an
 * EXACT identity at every externally observable point, not an approximation
 * and not something that only holds while the process is idle:
 *
 *     http_requests_total
 *       = sum(status_class buckets) + http_requests_in_flight + A
 *
 * where `A` counts the requests whose response never completed because the
 * client destroyed the connection first. Those are real accepted requests, so
 * they are in the total; they completed nothing, so they belong in no status
 * bucket -- see the abort contract on `recordRequestEnd()`. `A` is deliberately
 * not exposed as a seventh metric family, because the six families below are
 * the fixed exposition surface, so read the identity like this: on a worker
 * that has served no aborted connection the two sides are equal to the digit,
 * and a shortfall in `sum(buckets)` IS the number of aborted responses. What
 * the identity rules out is the other direction -- a surplus, or a shortfall on
 * a worker known to have had no aborts, is not arithmetic. It means a missed or
 * doubled `recordRequestEnd()` call, or a completed response whose status fell
 * outside 100-599, and either is a defect to find rather than a figure to
 * explain.
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
 * value that does not land in 100-599 -- a non-numeric value
 * (`Math.floor(NaN / 100)` renders as the key `"NaNxx"`) or a status outside
 * the HTTP range -- returns `null` instead of naming a sixth bucket.
 *
 * This is purely a guard against a caller defect, and it is worth being precise
 * about why: the ONE expected non-status path, an aborted response, is handled
 * by `recordRequestEnd()` before it ever calls this function, so a `null` from
 * here is never ordinary traffic. Node and Express only produce statuses in
 * 100-599, so reaching the `null` branch means a caller passed something that
 * is not a status code at all.
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
 * Record that a request has finished, whether or not its response completed.
 *
 * Lowers the in-flight gauge by one and -- only for a response that actually
 * completed -- increments the bucket for its status class.
 *
 * THE ABORT CONTRACT, AND WHY THE STATUS IS OPTIONAL. A request can leave the
 * service two ways: its response completes, or the client destroys the
 * connection first. Both must lower the gauge, but only the first has a status
 * that means anything. `res.statusCode` on an aborted response is whatever it
 * happened to be when the socket died -- and on an abort that arrives before
 * the handler responded, that is Node's UNTOUCHED DEFAULT OF 200. Passing it
 * would file an abandoned request in the `2xx` bucket of a family whose name
 * and HELP text both say "completed", turning dropped traffic into apparent
 * success: the one failure mode nobody reading a dashboard would ever question.
 *
 * So the caller passes a status ONLY for a completed response and `undefined`
 * otherwise, and the rule it decides that with is `res.writableFinished` --
 * true only once the response has been fully written. An abort therefore lands
 * in no bucket at all, which is why the module header's identity carries an
 * explicit `A` term for aborted responses rather than claiming the total and
 * the buckets always agree.
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
 * @param {number|undefined} statusCode Status code of the response, normally
 *   100-599 -- and `undefined` when the response did NOT complete, per the
 *   abort contract above. `undefined` lowers the in-flight gauge and tallies
 *   nothing. A number outside the five known status classes also lowers the
 *   gauge without tallying, but that path is a caller defect rather than an
 *   expected outcome; either way the fixed five-series label set is preserved.
 * @returns {void}
 */
function recordRequestEnd(statusCode) {
  // Unconditional, and first: every request that started has now finished, so
  // the gauge comes down whatever the outcome was. Making this independent of
  // the status is what keeps the pairing contract above satisfiable for an
  // aborted request.
  inFlight -= 1;

  // The abort path, checked explicitly rather than left to fall through
  // `statusClassKey()`'s defect guard. Both would skip the increment, but only
  // an explicit test says that an absent status is EXPECTED here -- a reader
  // who saw an abort reach a branch documented as "a status the service should
  // never have produced" would reasonably conclude the guard was load-bearing
  // for ordinary traffic and try to "fix" it into a bucket.
  if (statusCode === undefined) {
    return;
  }

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
 * One exported function producing the whole exposition document as a string,
 * plus one private helper it uses to make a label value safe to embed. Both
 * are pure with respect to the store -- rendering never mutates a counter --
 * so a scrape cannot perturb what it measures.
 */

/**
 * Escape a value for use inside a Prometheus label, per the text exposition
 * format's label rules.
 *
 * The format allows any UTF-8 sequence in a label value provided three
 * characters are escaped: the backslash as `\\`, the double quote as `\"` and
 * the line feed as `\n`. The replacements happen in that order because the
 * first one introduces backslashes the later two must not re-escape.
 *
 * WHY THIS EXISTS AT ALL, given that both label values this module renders --
 * a service name and a small integer -- are tame today. `render()` is a
 * document GENERATOR, and its identity labels arrive from a caller rather than
 * from state this file owns. An unescaped quote in a label value does not
 * produce a wrong number; it produces a line a strict parser rejects, which
 * fails the whole scrape and takes the other nine samples down with it. This
 * is four lines of arithmetic-free string work on a path that runs once per
 * scrape, so paying it unconditionally is cheaper than reasoning about whether
 * today's caller still holds tomorrow.
 *
 * Not exported: it is an implementation detail of the exposition format, and a
 * caller with it in hand would be one step from assembling sample lines
 * outside `render()`.
 *
 * @param {string|number} value The raw label value.
 * @returns {string} The value with backslash, double quote and line feed
 *   escaped, ready to sit between the quotes of `name="..."`.
 */
function escapeLabelValue(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

/**
 * Render the current metrics in Prometheus text exposition format.
 *
 * Emits six metric families, each preceded by its `# HELP` and `# TYPE`
 * lines: the lifetime request total, the five per-status-class buckets, the
 * in-flight gauge, and three process figures. The `process_*` family names
 * deliberately match the conventional Prometheus process-collector names, so a
 * scraper or dashboard that already expects them works without remapping.
 *
 * THE IDENTITY LABELS, AND WHY THEY ARE AN ARGUMENT. Every sample carries
 * `service="<name>",instance="<n>"`, so a reader of the raw exposition can tell
 * which worker's numbers these are -- and so that `GET /health`, the metrics
 * output and every log line describe the process the same way, with `instance`
 * present and `0` even when PM2 did not launch it. The values cannot be read
 * here: only `../config` may touch the environment, and this module imports
 * nothing (see the header). So the reader passes them in. Cardinality is
 * unaffected -- one process has one identity, so this adds no series, and the
 * exposition stays at ten sample lines.
 *
 * ONE CONSEQUENCE TO KNOW BEFORE DEBUGGING A DASHBOARD: `instance` is also a
 * label Prometheus attaches itself, from the scrape target. With the default
 * `honor_labels: false` the server keeps its own and renames the one in this
 * document to `exported_instance`; with `honor_labels: true` the value below
 * wins. Neither is a defect here -- the name is chosen to match the `instance`
 * field in `/health` and in the logs, because that shared shape is the point --
 * but a query written against a Prometheus server may need
 * `exported_instance`.
 *
 * Sole permitted caller: `../routes/metrics.routes.js`, which serves the
 * returned string under `Content-Type: text/plain; version=0.0.4`. This
 * function sets no header and knows nothing about HTTP -- that separation is
 * why the measurement half of `/metrics` can be exercised without a server.
 *
 * @param {{ service: string, instance: number }} identity The rendering
 *   process's identity, sourced from the frozen configuration object by the
 *   caller: `service` is the service's canonical name and `instance` is the
 *   PM2 cluster ordinal (`0` when the process was launched directly).
 * @returns {string} The exposition document, terminated by a single newline.
 *   The trailing newline is required by the text format: the final sample line
 *   must be LF-terminated or a strict parser rejects the document.
 * @throws {TypeError} When `identity` is absent or either field is the wrong
 *   shape. This is a precondition check on a caller defect, and failing loudly
 *   is deliberate: the alternative is an exposition that quietly advertises
 *   `service=""`, attributing a worker's counters to a nameless series that
 *   silently merges with every other misconfigured worker. Both values come
 *   from configuration validated at start-up, so a defect here shows up on the
 *   very first scrape rather than intermittently.
 */
function render(identity) {
  // Validated before anything is read or built, so a bad call cannot produce a
  // half-formed document. Each branch names the field and what it received --
  // the caller is a route handler, so this message is what reaches the log.
  if (identity === null || typeof identity !== 'object') {
    throw new TypeError(
      'render(identity) requires an identity object of the shape ' +
        `{ service, instance } (received ${typeof identity})`,
    );
  }

  const { service, instance } = identity;

  if (typeof service !== 'string' || service.length === 0) {
    throw new TypeError(
      'render(identity) requires a non-empty string identity.service ' +
        `(received ${typeof service})`,
    );
  }

  // `Number.isInteger` rather than a `typeof`/`>= 0` pair: it rejects `NaN`,
  // the infinities and a fractional value in one test, and a cluster ordinal is
  // a whole number by definition.
  if (!Number.isInteger(instance) || instance < 0) {
    throw new TypeError(
      'render(identity) requires a non-negative integer identity.instance ' +
        `(received ${String(instance)})`,
    );
  }

  // Built once and shared by all ten sample lines, so the identity cannot
  // differ between two samples of the same scrape.
  const identityLabels =
    `service="${escapeLabelValue(service)}",` +
    `instance="${escapeLabelValue(instance)}"`;

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
    `http_requests_total{${identityLabels}} ${requestsTotal}`,
    '# HELP http_requests_by_status_class_total Completed HTTP requests by response status class.',
    '# TYPE http_requests_by_status_class_total counter',
  ];

  // Iterating the fixed key list (rather than the store's own keys) is what
  // guarantees all five series appear on every scrape, in the same order,
  // whatever traffic the worker has seen.
  for (const statusClass of STATUS_CLASS_KEYS) {
    const count = requestsByStatusClass[statusClass];

    lines.push(
      `http_requests_by_status_class_total{${identityLabels},status_class="${statusClass}"} ${count}`,
    );
  }

  // Counts are plain integers and are interpolated as such; only the two
  // fractional figures are formatted, and `toFixed()` is a READABILITY choice
  // rather than a compliance one. Being exact about that, because the opposite
  // is easy to assume: the text format takes a sample value as a float "as
  // required by the Go strconv package", so exponential notation is perfectly
  // legal -- the format's own reference exposition contains `1.458255915e9`.
  // Default number-to-string conversion would therefore also parse. What it
  // would not do is stay legible: it renders a nearly-idle worker's CPU time as
  // `1.2e-5`, so two consecutive scrapes read by hand or diffed by a script
  // change width and notation as the value crosses 1e-6. Fixed decimals give
  // every scrape the same shape -- millisecond resolution on uptime, microsecond
  // on CPU seconds -- which is what makes the document skimmable, and the range
  // these two figures occupy is nowhere near the magnitude at which `toFixed()`
  // would itself fall back to exponential form.
  lines.push(
    '# HELP http_requests_in_flight HTTP requests currently being handled by this worker.',
    '# TYPE http_requests_in_flight gauge',
    `http_requests_in_flight{${identityLabels}} ${inFlight}`,
    '# HELP process_uptime_seconds Seconds elapsed since this worker process started.',
    '# TYPE process_uptime_seconds gauge',
    `process_uptime_seconds{${identityLabels}} ${uptimeSeconds.toFixed(3)}`,
    '# HELP process_resident_memory_bytes Resident set size of this worker process, in bytes.',
    '# TYPE process_resident_memory_bytes gauge',
    `process_resident_memory_bytes{${identityLabels}} ${residentMemoryBytes}`,
    '# HELP process_cpu_seconds_total Total user plus system CPU time consumed by this worker, in seconds.',
    '# TYPE process_cpu_seconds_total counter',
    `process_cpu_seconds_total{${identityLabels}} ${cpuSeconds.toFixed(6)}`,
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
