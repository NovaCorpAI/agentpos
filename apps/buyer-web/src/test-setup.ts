/**
 * Test setup. `@x402/core` probes the facilitator's `/supported` endpoint in the background and
 * warns on the console when it cannot (no API key in tests, so it never can). That warning can
 * land after a test file has finished, while the worker is closing, and vitest then reports an
 * unhandled teardown error for a run where every test passed. The warning carries no signal
 * here, so it is dropped at the source; every other console call is untouched.
 */
const warn = console.warn.bind(console);
console.warn = (...args: unknown[]): void => {
  if (typeof args[0] === "string" && args[0].startsWith("Failed to fetch supported kinds from facilitator")) return;
  warn(...args);
};
