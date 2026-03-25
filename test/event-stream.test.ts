import test from "ava";
import HueEventStream from "../src/lib/hue-api/event-stream.js";
import { ErrorEvent, EventSource as EventSourceType, EventSourceInit } from "eventsource";

// Minimal mock compatible with the subset used by HueEventStream
class MockEventSource {
  onopen: () => void = () => {};
  onmessage: (event: { data: string }) => void = () => {};
  onerror: (err: ErrorEvent) => void = () => {};
  closeCalled = false;

  constructor(
    public url: string,
    public options: EventSourceInit = {}
  ) {}

  close() {
    this.closeCalled = true;
  }
}

// Helper to access internal (private) fields in a typed way for tests
// Note: This relies on implementation details only for verification purposes.
type HueEventStreamInternal = {
  connected: boolean;
  connecting: boolean;
  es: MockEventSource | null;
};

const getInternals = (s: HueEventStream) => s as unknown as HueEventStreamInternal;

// Provide the mock to the class via DI using the EventSource constructor type
const MockEventSourceCtor = MockEventSource as unknown as typeof EventSourceType;

test("connect() sets connecting flag and prevents simultaneous calls", (t) => {
  const stream = new HueEventStream(MockEventSourceCtor);
  const internals = getInternals(stream);

  // Initially not connected and not connecting
  t.is(internals.connected, false);
  t.is(internals.connecting, false);

  // Call connect
  stream.connect("http://localhost", "test-key");

  t.is(internals.connecting, true, "connecting flag should be true after connect()");

  const es1 = internals.es!;
  t.truthy(es1, "EventSource instance should be created");
  t.is(es1.url, "http://localhost/eventstream/clip/v2");

  // Call connect again while connecting
  stream.connect("http://localhost", "test-key");

  const es2 = internals.es!;
  t.is(es1, es2, "Should not create a new EventSource instance if already connecting");
  t.is(internals.connecting, true);

  // Simulate onopen
  internals.es!.onopen();
  t.is(internals.connected, true);
  t.is(internals.connecting, false);

  // Call connect again while connected
  stream.connect("http://localhost", "test-key");
  t.is(internals.es, es1, "Should not create a new EventSource instance if already connected");

  // Simulate disconnect
  stream.disconnect();
  t.is(internals.connected, false);
  t.is(internals.connecting, false);
  t.true(es1.closeCalled);
});

test("connect() resets connecting flag on error", (t) => {
  const stream = new HueEventStream(MockEventSourceCtor);
  const internals = getInternals(stream);

  stream.connect("http://localhost", "test-key");
  t.is(internals.connecting, true);

  // Simulate onerror
  internals.es!.onerror(new ErrorEvent("error", { code: 500, message: "Error" }));
  t.is(internals.connected, false);
  t.is(internals.connecting, false);
});
