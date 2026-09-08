/**
 * The reconnecting Box SSE: it must reconnect after a TRANSIENT drop with CAPPED backoff,
 * and it must NOT reconnect after a 401. These are the load-bearing properties of the whole
 * session model — a stream that reconnected into a dead session would hammer a 401ing
 * endpoint forever, and one that gave up on a network blip would silently stop updating.
 *
 * Pure: a fake EventSource and a fake scheduler are injected, so no browser is needed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ReconnectingBoxStream } from "../src/lib/boxStream.ts";

/** A controllable fake EventSource. */
class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.onerror = null;
    this.onopen = null;
    this.closed = false;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, fn) {
    this.listeners.set(type, fn);
  }
  emit(type, data) {
    const fn = this.listeners.get(type);
    if (fn) fn({ data });
  }
  fireOpen() {
    if (this.onopen) this.onopen({});
  }
  fireError() {
    if (this.onerror) this.onerror({});
  }
  close() {
    this.closed = true;
  }
}
FakeEventSource.instances = [];

/** A manual scheduler: records scheduled callbacks and runs them on demand. */
function makeScheduler() {
  const scheduled = [];
  let nextHandle = 1;
  return {
    setTimeoutFn(fn, ms) {
      const handle = nextHandle++;
      scheduled.push({ handle, fn, ms });
      return handle;
    },
    clearTimeoutFn(handle) {
      const i = scheduled.findIndex((s) => s.handle === handle);
      if (i >= 0) scheduled.splice(i, 1);
    },
    runNext() {
      const job = scheduled.shift();
      if (job) job.fn();
      return job;
    },
    get pending() {
      return scheduled.slice();
    },
  };
}

function setup({ probeResult }) {
  FakeEventSource.instances = [];
  const sched = makeScheduler();
  const events = { open: 0, disconnect: 0, unauthorized: 0, snapshots: [] };
  const stream = new ReconnectingBoxStream({
    url: "http://localhost/api/box/stream",
    events: ["snapshot"],
    onOpen: () => events.open++,
    onDisconnect: () => events.disconnect++,
    onUnauthorized: () => events.unauthorized++,
    probeUnauthorized: async () => probeResult,
    onEvent: (type, data) => {
      if (type === "snapshot") events.snapshots.push(data);
    },
    create: (url) => new FakeEventSource(url),
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    setTimeoutFn: sched.setTimeoutFn,
    clearTimeoutFn: sched.clearTimeoutFn,
  });
  return { stream, sched, events };
}

/** Let the microtask queue (the probe promise) drain. */
const flush = () => new Promise((r) => setImmediate(r));

test("opens with the injected EventSource and forwards named events", () => {
  const { stream, events } = setup({ probeResult: false });
  stream.start();
  assert.equal(FakeEventSource.instances.length, 1);
  FakeEventSource.instances[0].emit("snapshot", "{\"x\":1}");
  assert.deepEqual(events.snapshots, ["{\"x\":1}"]);
  stream.stop();
});

test("reconnects after a TRANSIENT drop (probe says not unauthorized)", async () => {
  const { stream, sched, events } = setup({ probeResult: false });
  stream.start();
  const first = FakeEventSource.instances[0];

  first.fireError();
  assert.equal(events.disconnect, 1);
  assert.equal(first.closed, true, "the failed source is closed before reconnecting");

  await flush(); // the probe resolves "not unauthorized" → a reconnect is scheduled
  assert.equal(sched.pending.length, 1, "a reconnect is scheduled");
  sched.runNext(); // fire the reconnect timer

  assert.equal(FakeEventSource.instances.length, 2, "a second EventSource was opened");
  assert.equal(events.unauthorized, 0, "a transient drop is NOT treated as a 401");
  stream.stop();
});

test("does NOT reconnect after a 401 (probe says unauthorized)", async () => {
  const { stream, sched, events } = setup({ probeResult: true });
  stream.start();
  const first = FakeEventSource.instances[0];

  first.fireError();
  await flush(); // the probe resolves "unauthorized"

  assert.equal(events.unauthorized, 1, "onUnauthorized fired exactly once");
  assert.equal(sched.pending.length, 0, "NO reconnect is scheduled after a 401");
  assert.equal(FakeEventSource.instances.length, 1, "no new EventSource is created");

  // A further tick must not resurrect the stream.
  sched.runNext();
  assert.equal(FakeEventSource.instances.length, 1);
  stream.stop();
});

test("backoff grows exponentially but is CAPPED at maxDelayMs", () => {
  const { stream } = setup({ probeResult: false });
  // base 1000, cap 30000: 1000, 2000, 4000, 8000, 16000, 32000→capped 30000, …
  assert.equal(stream.backoffFor(0), 1000);
  assert.equal(stream.backoffFor(1), 2000);
  assert.equal(stream.backoffFor(2), 4000);
  assert.equal(stream.backoffFor(4), 16000);
  assert.equal(stream.backoffFor(5), 30000, "32000 is capped to 30000");
  assert.equal(stream.backoffFor(10), 30000, "stays capped, never unbounded");
  assert.equal(stream.backoffFor(50), 30000);
});

test("a successful reopen resets the backoff to base", async () => {
  const { stream, sched } = setup({ probeResult: false });
  stream.start();

  // Drop, reconnect once (attempt advances to 1).
  FakeEventSource.instances[0].fireError();
  await flush();
  sched.runNext();
  // The reopened source signals open → backoff resets.
  FakeEventSource.instances[1].fireOpen();

  // Next drop should schedule at BASE again, not at the grown delay.
  FakeEventSource.instances[1].fireError();
  await flush();
  const job = sched.pending[0];
  assert.equal(job.ms, 1000, "backoff restarted from base after a clean reconnect");
  stream.stop();
});

test("stop() cancels a pending reconnect and closes the source", async () => {
  const { stream, sched } = setup({ probeResult: false });
  stream.start();
  FakeEventSource.instances[0].fireError();
  await flush();
  assert.equal(sched.pending.length, 1);
  stream.stop();
  assert.equal(sched.pending.length, 0, "the pending reconnect timer was cleared");
});
