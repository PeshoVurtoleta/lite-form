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

import { createForm } from "../../Form.js";
import { createLeakTracker } from "@zakkster/lite-leak";
import { BREAK, check, withRegistry } from "./harness.mjs";

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
}
