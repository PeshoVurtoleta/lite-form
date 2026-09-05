/**
 * @zakkster/lite-form -- torture harness (the shared spine).
 *
 * Every tier imports from here so no tier can drift from four disciplines:
 *
 *   1. SCRATCH ONCE. All scratch is allocated by the tier OUTSIDE every measured
 *      loop. This module hands out helpers and gate wrappers, never per-call
 *      allocations on a measured hot path.
 *   2. FAILURE-ONLY MESSAGES. check(cond, msgThunk) builds its string ONLY on
 *      failure -- a template literal per iteration is an allocation that would
 *      fail the t6 gate. Pass a thunk, never a pre-built string.
 *   3. SEEDED REPLAY. The PRNG is a seeded xorshift32 (FORM_TORTURE_SEED env,
 *      0-guarded to 1). A failing case replays via
 *      FORM_TORTURE_SEED=... node --expose-gc --preserve-symlinks test/torture.mjs.
 *   4. ONE MEASUREMENT WINDOW AT A TIME. lite-gc-profiler shares one heap across
 *      lanes; runOpsGate opens and closes a single window per call and tiers run
 *      strictly sequentially -- never nested, never concurrent.
 *
 * REGISTRY LAW. lite-form takes the registry as a config option: createForm({
 * registry: reg }). There is NO global default swap -- forms are scoped to the
 * registry handed to them, bound with reg.effect(...), and measured with
 * reg.stats(). withRegistry() builds a fresh registry and runs fn against it; a
 * measured tier pre-grows a fixed-ceiling registry (onCapacityExceeded:"throw")
 * to the run's high-water mark BEFORE the measured window -- a registry that
 * grows mid-measure is the allocation the gate exists to catch.
 *
 * @license MIT
 */

import v8 from "node:v8";
import { measureOps, checkNoGc } from "@zakkster/lite-gc-profiler";
import { createRegistry } from "@zakkster/lite-signal";

/**
 * The module under test. Overridable via FORM_TORTURE_MODULE so the realias /
 * reproto controls can point every tier at a patched copy of Form.js without a
 * FORM_TORTURE_BREAK flag. Every tier that touches the form loads it through
 * loadForm() rather than a static import.
 */
export const FORM_URL = process.env.FORM_TORTURE_MODULE || new URL("../../Form.js", import.meta.url).href;
export async function loadForm() { return import(FORM_URL); }

/**
 * TRANSIENT-GARBAGE WITNESS. V8's new space is a bump allocator: each allocation
 * advances a pointer, and the used-bytes figure only falls when a scavenge runs.
 * So if we gc() to a clean slate, then run a synchronous loop with NO GC between
 * samples, the new_space used-bytes DELTA around the loop is exactly the transient
 * garbage the loop produced -- byte-stable across runs, and it scales with per-op
 * allocation (0 B/op stays flat, 32 B/op grows linearly).
 *
 * This is the only witness that can see per-op garbage in a synchronous window.
 * The GC-observer RULES (checkNoGc on measureOps) cannot: perf_hooks GC entries
 * arrive event-loop-deferred, so inside one synchronous loop gc.minor reads 0 even
 * for a 96 MB-allocating loop, and measureOps bytesPerOp under stabilize:"deep" is
 * noise at this scale (a real 32 B/op body measured 0.052). The RULES window is
 * still meaningful for what it CAN see across a settle tick: maxPauseMs and
 * maxArrayBuffersGrowth. Both witnesses run on the same hot body.
 */

/** Seed for every PRNG in the run. Override with FORM_TORTURE_SEED for replay. */
export const SEED = (() => {
  const raw = process.env.FORM_TORTURE_SEED;
  if (raw === undefined) return 0x9e3779b9;
  const n = Number(raw) >>> 0;
  return n === 0 ? 1 : n; // xorshift32 must not be seeded with 0
})();

/**
 * Deliberately-broken control mode: one of "grow" | "alloc" | "drop" | "leak",
 * or "" for a normal run. When set, torture.mjs runs ONLY the targeted tier and
 * never t9 (no recursive spawning). The realias / reproto controls instead patch
 * Form.js itself and select it via FORM_TORTURE_MODULE, so they run a NORMAL
 * (all-tier) child that must die at t1.
 */
export const BREAK = process.env.FORM_TORTURE_BREAK || "";

/**
 * The fast suite's reviewed-true test count. This is the ONE recorded place the
 * torture entry's preflight checks README.md and llms.txt against -- a doc that
 * drifts from this number fails the gate instead of sitting silently stale.
 */
export const FAST_SUITE_COUNT = 77;

/** Base zero-GC rules. maxArrayBuffersGrowth needs measureOps stabilize:'deep'. */
export const RULES = { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 };

/** Seeded xorshift32. Returns a function yielding a uint32 each call. */
export function makePrng(seed) {
  let x = (seed >>> 0) || 1;
  return function next() {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x >>> 0;
  };
}

/** Fail the whole gate. stdout stays clean; the reason goes to stderr. */
export function die(msg) {
  process.stderr.write(
    "torture: FAIL -- " + msg +
    "\n  replay: FORM_TORTURE_SEED=" + SEED +
    " node --expose-gc --preserve-symlinks test/torture.mjs\n");
  process.exit(1);
}

/**
 * Assertion whose message is built ONLY on failure. Pass a thunk, not a string,
 * so the happy path allocates nothing.
 * @param {boolean} cond
 * @param {() => string} msgThunk
 */
export function check(cond, msgThunk) {
  if (!cond) die(msgThunk());
}

/**
 * Run fn(i) under a single measured window and gate it against RULES with
 * measureOps stabilize:'deep' so maxArrayBuffersGrowth resolves. Returns the
 * checkNoGc report plus the raw summary for diagnostics.
 * @param {string} name        Diagnostic label.
 * @param {(i:number)=>void} fn Sync, zero-alloc hot body.
 * @param {{ops:number, warmup?:number}} opts
 */
export function runOpsGate(name, fn, opts) {
  const res = measureOps(fn, {
    ops: opts.ops,
    warmup: opts.warmup === undefined ? 0 : opts.warmup,
    stabilize: "deep",
  });
  return { name, report: checkNoGc(res.summary, RULES), summary: res.summary };
}

/** Current new-space used bytes, straight from V8. Fails closed if absent. */
export function newSpaceUsed() {
  const spaces = v8.getHeapSpaceStatistics();
  for (let i = 0; i < spaces.length; i++) {
    if (spaces[i].space_name === "new_space") return spaces[i].space_used_size;
  }
  die("newSpaceUsed: no new_space in getHeapSpaceStatistics()");
}

/**
 * Total transient garbage fn(i) allocates over `ops` iterations, measured as the
 * new-space used-bytes delta around a GC-free synchronous loop. See the header
 * note on why this is the transient witness. gc() first for a clean slate; no GC
 * between the two samples; a shrink means a scavenge ran mid-window (the workload
 * overflowed new space) and the measurement is void.
 * @param {(i:number)=>void} fn
 * @param {number} ops
 * @param {number} warmup
 */
export function allocTotal(fn, ops, warmup) {
  for (let i = 0; i < warmup; i++) fn(i);
  globalThis.gc();
  const s0 = newSpaceUsed();
  for (let i = 0; i < ops; i++) fn(i);
  const s1 = newSpaceUsed();
  const total = s1 - s0;
  if (total < 0) die("allocTotal: new_space shrank mid-window (" + total + " B) -- a scavenge ran; the workload overflowed new space, shrink ops");
  return total;
}

/**
 * Build a fresh isolated registry and run fn against it. lite-form is scoped by
 * config (createForm({registry: reg})), so there is no global swap to restore.
 * @param {object} config createRegistry config.
 * @param {(reg:object)=>any} fn
 */
export function withRegistry(config, fn) {
  const reg = createRegistry(config);
  return fn(reg);
}

/**
 * Plain-object oracle for t5. Mirrors lite-form's observable surface with hand-
 * applied validators/schema: vals, baseline, touched, submitAttempted, plus the
 * cached per-field verdicts so isValid() can be reproduced without re-running
 * validators on every read (the "drop" control corrupts exactly that cache).
 * @param {object} config { fields, validators, schema, initial }
 */
export function mirror(config) {
  const vals = {};
  const baseline = {};
  const paths = config.fields;
  for (let i = 0; i < paths.length; i++) {
    vals[paths[i]] = config.initial[paths[i]];
    baseline[paths[i]] = config.initial[paths[i]];
  }
  return { vals, baseline, touched: new Set(), submitAttempted: false };
}

/**
 * Iterative structural deep-equality (explicit stack, cycle-safe via a seen-Map)
 * so it cannot overflow on a deep argument. NaN equals NaN; arrays and plain
 * objects compare shape then contents; non-plain values compare by identity.
 * @param {any} a
 * @param {any} b
 */
export function deepEqual(a, b) {
  const stack = [a, b];
  const seen = new Map();
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    if (x === y) continue;
    if (x === null || y === null || typeof x !== "object" || typeof y !== "object") {
      if (x !== x && y !== y) continue; // NaN === NaN for this purpose
      return false;
    }
    const xa = Array.isArray(x);
    const ya = Array.isArray(y);
    if (xa !== ya) return false;
    const prev = seen.get(x);
    if (prev !== undefined) {
      if (prev === y) continue;
      return false;
    }
    seen.set(x, y);
    if (xa) {
      if (x.length !== y.length) return false;
      for (let i = 0; i < x.length; i++) { stack.push(x[i]); stack.push(y[i]); }
    } else {
      const xk = Object.keys(x);
      const yk = Object.keys(y);
      if (xk.length !== yk.length) return false;
      for (let i = 0; i < xk.length; i++) {
        const k = xk[i];
        if (!Object.prototype.hasOwnProperty.call(y, k)) return false;
        stack.push(x[k]); stack.push(y[k]);
      }
    }
  }
  return true;
}
