/**
 * t7 -- soak, retention, conservation.
 *
 * Two independent witnesses that dispose(form) reclaims everything:
 *   1. reg.stats().activeNodes conservation across 4096 build/keystroke/reset/
 *      teardown cycles returns to its pre-loop baseline.
 *   2. a lite-leak createLeakTracker witness: after a form is disposed and every
 *      local reference dropped, each tracked field record is collectable, so
 *      tracker.size() returns to 0 and audit() is clean -- a SECOND, independent
 *      signal from the heap-side conservation number.
 *
 * Control: FORM_TORTURE_BREAK=leak retains ONE field record in a module-level
 * array, so it can never be collected -- tracker.size() never returns to 0 and
 * the leak witness fires.
 *
 * lite-leak held-value contract: neither the cleanup closure nor the tag may
 * close over the tracked target. We pass a null cleanup and a primitive tag.
 */

import { createLeakTracker } from "@zakkster/lite-leak";
import { BREAK, check, loadForm, withRegistry } from "./harness.mjs";

let createForm = null; // bound from loadForm() at run() entry

const CYCLES = 4096;
const CEIL = { maxNodes: 1 << 15, maxLinks: 1 << 17, onCapacityExceeded: "throw" };

/** Reinstated-leak sink for the "leak" control. Holds ONE field record. */
const heldLeak = [];

const settle = () => new Promise((r) => setTimeout(r, 50));

/**
 * Build one form, track every field record, churn it, dispose it, and drop all
 * references by returning nothing. Under the "leak" control, retain one record.
 */
function churn(tracker, holdLeak) {
  withRegistry(CEIL, (reg) => {
    const initialValues = {};
    for (let i = 0; i < 16; i++) initialValues["f" + i] = 0;
    const validators = { f0: (v) => (v > 900 ? "a" : null), f1: (v) => (v < 0 ? "b" : null) };
    const form = createForm({ initialValues, validators, registry: reg });
    // tag is a primitive, cleanup is null -- neither closes over the target.
    for (let i = 0; i < 16; i++) tracker.track(form.field("f" + i), null, i, { audit: true });
    for (let s = 0; s < 32; s++) form.field("f" + (s & 15)).set(s);
    if (holdLeak) heldLeak.push(form.field("f0")); // reinstated leak
    form.dispose();
  });
}

export async function run() {
  createForm = (await loadForm()).createForm;

  // --- witness 1: activeNodes conservation over 4096 cycles -----------------
  withRegistry(CEIL, (reg) => {
    const base = reg.stats().activeNodes;
    for (let c = 0; c < CYCLES; c++) {
      const initialValues = {};
      for (let i = 0; i < 8; i++) initialValues["f" + i] = 0;
      const validators = { f0: (v) => (v > 900 ? "a" : null), f1: (v) => (v < 0 ? "b" : null) };
      const form = createForm({ initialValues, validators, registry: reg });
      for (let s = 0; s < 32; s++) form.field("f" + (s & 7)).set(s);
      form.reset();
      form.dispose();
    }
    const delta = reg.stats().activeNodes - base;
    check(delta === 0, () => "t7: activeNodes leaked " + delta + " node(s) over " + CYCLES + " cycles");
  });

  // --- witness 1b: commit/revert churn reuses pooled nodes ------------------
  // Warmed keys, then a create->touch->overlay->commit->overlay->revert cycle
  // repeated hard. The engine reuses pooled overlay/projected nodes, so on a
  // pre-grown fixed-ceiling registry the pool must not grow and no node leaks.
  withRegistry(CEIL, (reg) => {
    const initialValues = {};
    for (let i = 0; i < 16; i++) initialValues["f" + i] = 0;
    const form = createForm({ initialValues, registry: reg });
    for (let i = 0; i < 16; i++) void form.field("f" + i).value(); // warm every key
    const g0 = reg.stats().poolGrowths;
    const a0 = reg.stats().activeNodes;
    for (let c = 0; c < 2000; c++) {
      for (let i = 0; i < 16; i++) form.field("f" + i).set(c + i + 1);
      form.commit();
      for (let i = 0; i < 16; i++) form.field("f" + i).set(-c - i - 1);
      form.reset();
    }
    const dg = reg.stats().poolGrowths - g0;
    check(dg === 0, () => "t7: commit/revert churn grew the pool " + dg + " chunk(s) on warmed keys");
    const da = reg.stats().activeNodes - a0;
    check(da === 0, () => "t7: commit/revert churn leaked " + da + " node(s) on warmed keys");
    form.dispose();
  });

  // --- witness 2: lite-leak retention witness -------------------------------
  const leaks = [];
  const warns = [];
  const tracker = createLeakTracker({
    name: "t7-soak",
    onLeak: (r) => leaks.push(r.kind),
    onWarning: (w) => warns.push(w.kind),
  });

  churn(tracker, BREAK === "leak");

  // Drive collection: FR callbacks fire only after a collection AND a macrotask.
  globalThis.gc();
  for (let k = 0; k < 12 && tracker.size() > 0; k++) {
    globalThis.gc();
    await settle();
  }

  const live = tracker.size();
  check(live === 0,
    () => "t7: leak witness sees " + live + " retained field record(s) after dispose" +
      (BREAK === "leak" ? " (FORM_TORTURE_BREAK=leak control -- expected)" : ""));
  check(tracker.audit().length === 0,
    () => "t7: leak audit reported " + tracker.audit().length + " finding(s)");
  check(warns.length === 0,
    () => "t7: leak witness raised " + warns.length + " warning(s)");

  // --- witness 3: lazy-field churn under a re-running effect -----------------
  // Undeclared fields created INSIDE a re-running effect are createRoot-owned by
  // the form, not children of the effect, so they survive its re-runs and are
  // reclaimed by dispose(). Two signals: activeNodes conservation across
  // build/churn/dispose, and a lite-leak tracker returning to 0.
  const leaks3 = [];
  const warns3 = [];
  const tracker3 = createLeakTracker({
    name: "t7-lazy",
    onLeak: (r) => leaks3.push(r.kind),
    onWarning: (w) => warns3.push(w.kind),
  });
  withRegistry(CEIL, (reg) => {
    const base = reg.stats().activeNodes;
    const form = createForm({ initialValues: { keep: 0 }, registry: reg });
    const built = reg.stats().activeNodes;
    const trig = reg.signal(0);
    let round = 0;
    const stop = reg.effect(() => {
      void trig();
      for (let i = 0; i < 8; i++) {
        const fld = form.field("lz" + round + "_" + i); // undeclared: lazyField -> createRoot
        void fld.value();
        tracker3.track(fld, null, round * 8 + i, { audit: true }); // primitive tag, null cleanup
      }
      round++;
    });
    for (let t = 1; t <= 16; t++) trig.set(t); // re-run the effect 16 times
    check(reg.stats().activeNodes > built,
      () => "t7: lazy-field churn allocated no nodes (vacuous witness)");
    // fields from the FIRST round still read/write after every re-run
    for (let i = 0; i < 8; i++) form.field("lz0_" + i).set(i);
    for (let i = 0; i < 8; i++) {
      check(form.field("lz0_" + i).value() === i,
        () => "t7: lazy field lz0_" + i + " lost its value across effect re-runs");
    }
    stop();                       // dispose the effect
    reg.dispose(trig);            // dispose the trigger signal
    form.dispose();               // frees every field, declared and lazy
    const after = reg.stats().activeNodes;
    check(after === base,
      () => "t7: lazy-field churn left " + (after - base) + " node(s) after dispose");
  });

  globalThis.gc();
  for (let k = 0; k < 12 && tracker3.size() > 0; k++) {
    globalThis.gc();
    await settle();
  }
  const live3 = tracker3.size();
  check(live3 === 0,
    () => "t7: lazy-field leak witness sees " + live3 + " retained field record(s) after dispose");
  check(tracker3.audit().length === 0,
    () => "t7: lazy-field leak audit reported " + tracker3.audit().length + " finding(s)");
  check(warns3.length === 0,
    () => "t7: lazy-field leak witness raised " + warns3.length + " warning(s)");
}
