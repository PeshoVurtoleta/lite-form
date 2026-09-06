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
import { BREAK, SEED, check, loadForm, makePrng, withRegistry } from "./harness.mjs";

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

  // --- witness 4: async-lane churn (R5-i) -----------------------------------
  // 4096 cycles of: create a form with 2 async fields, fire several triggers per
  // field, settle the parked deferreds OUT OF ORDER, dispose, then settle any
  // leftovers post-dispose (must be no-ops -- no throw, no write). Two signals:
  // activeNodes conservation (pool-flat) and a lite-leak tracker returning to 0.
  const leaks4 = [];
  const warns4 = [];
  const tracker4 = createLeakTracker({
    name: "t7-async",
    onLeak: (r) => leaks4.push(r.kind),
    onWarning: (w) => warns4.push(w.kind),
  });
  const prng = makePrng(SEED);
  await withRegistry(CEIL, async (reg) => {
    const base = reg.stats().activeNodes;
    for (let c = 0; c < CYCLES; c++) {
      const qa = [];
      const qb = [];
      const va = (v) => new Promise((res, rej) => qa.push({ res, rej }));
      const vb = (v) => new Promise((res, rej) => qb.push({ res, rej }));
      const form = createForm({ initialValues: { a: 0, b: 0 }, validatorsAsync: { a: va, b: vb }, registry: reg });
      // tag primitive, cleanup null -- neither closes over the tracked target.
      tracker4.track(form.field("a"), null, c * 2, { audit: true });
      tracker4.track(form.field("b"), null, c * 2 + 1, { audit: true });
      form.field("a").set(1); form.field("a").set(2); // qa[1], qa[2]
      form.field("b").set(1); form.field("b").set(2); // qb[1], qb[2]
      // settle a subset OUT OF ORDER before dispose; leave leftovers.
      const pre = [qa[1], qb[2], qa[0]];
      shufflePrng(pre, prng);
      for (let j = 0; j < pre.length; j++) if (pre[j]) pre[j].res(null);
      form.dispose();
      // post-dispose leftovers: a settlement is now a complete no-op.
      for (let j = 0; j < qa.length; j++) qa[j].res("late");
      for (let j = 0; j < qb.length; j++) qb[j].res("late");
      if ((c & 255) === 0) { await Promise.resolve(); await Promise.resolve(); }
    }
    await Promise.resolve(); await Promise.resolve();
    const delta = reg.stats().activeNodes - base;
    check(delta === 0, () => "t7: async-lane churn leaked " + delta + " node(s) over " + CYCLES + " cycles");
  });
  globalThis.gc();
  for (let k = 0; k < 12 && tracker4.size() > 0; k++) { globalThis.gc(); await settle(); }
  const live4 = tracker4.size();
  check(live4 === 0, () => "t7: async-lane leak witness sees " + live4 + " retained field record(s) after dispose");
  check(tracker4.audit().length === 0, () => "t7: async-lane leak audit reported " + tracker4.audit().length + " finding(s)");
  check(warns4.length === 0, () => "t7: async-lane leak witness raised " + warns4.length + " warning(s)");

  // --- witness 5: merge churn (R5-ii) ---------------------------------------
  // 4096 cycles of set()s + reinitialize(next, policy) with mixed ADOPT/ECHO/
  // CONFLICT verdicts each cycle. Leak-flat + pool-flat: the merge runs in one
  // batch and reseeds in place, so no node leaks across cycles.
  const leaks5 = [];
  const warns5 = [];
  const tracker5 = createLeakTracker({
    name: "t7-merge",
    onLeak: (r) => leaks5.push(r.kind),
    onWarning: (w) => warns5.push(w.kind),
  });
  withRegistry(CEIL, (reg) => {
    const base = reg.stats().activeNodes;
    for (let c = 0; c < CYCLES; c++) {
      const form = createForm({ initialValues: { a: 0, b: 0, d: 0 }, registry: reg });
      tracker5.track(form.field("a"), null, c * 3, { audit: true });
      tracker5.track(form.field("b"), null, c * 3 + 1, { audit: true });
      tracker5.track(form.field("d"), null, c * 3 + 2, { audit: true });
      form.field("b").set(10); // dirty, server will echo -> ECHO
      form.field("d").set(20); // dirty, server conflicts -> CONFLICT
      // a: pristine -> ADOPT; b: next 10 === draft 10 -> ECHO; d: next 99 != 20 -> CONFLICT.
      form.reinitialize({ a: c + 1, b: 10, d: 99 }, () => false);
      form.dispose();
    }
    const delta = reg.stats().activeNodes - base;
    check(delta === 0, () => "t7: merge churn leaked " + delta + " node(s) over " + CYCLES + " cycles");
  });
  globalThis.gc();
  for (let k = 0; k < 12 && tracker5.size() > 0; k++) { globalThis.gc(); await settle(); }
  const live5 = tracker5.size();
  check(live5 === 0, () => "t7: merge-churn leak witness sees " + live5 + " retained field record(s) after dispose");
  check(tracker5.audit().length === 0, () => "t7: merge-churn leak audit reported " + tracker5.audit().length + " finding(s)");
  check(warns5.length === 0, () => "t7: merge-churn leak witness raised " + warns5.length + " warning(s)");

  // --- witness 6: declared-array churn (S4) ---------------------------------
  // Thousands of add/remove cycles with DISTINCT keys (never reused: "k"+i) plus
  // periodic move, each added row's field handle tracked. Three signals:
  //   (a) activeNodes FLAT across the churn -- the prune bound. remove() disposes
  //       the row root and calls handle.prune() ONCE, which reclaims the removed
  //       row's un-overlaid+unobserved slots (and, per D5, may reclaim wider), so
  //       distinct-key add/remove churn never GROWS the pool. Exact refund is NOT
  //       the law: the sample is taken AFTER a warmup that lets prune settle, and
  //       the end delta must be <= 0. The slotleak control blanks that prune, so
  //       removed-row slots accumulate and this "t7 arrays churn" law dies.
  //   (b) the lite-leak tracker returns to 0 (row-field records collectable).
  //   (c) dispose() returns activeNodes to the pre-form baseline.
  const leaks6 = [];
  const warns6 = [];
  const tracker6 = createLeakTracker({
    name: "t7-arrays",
    onLeak: (r) => leaks6.push(r.kind),
    onWarning: (w) => warns6.push(w.kind),
  });
  const ARR_CYCLES = 4096;
  withRegistry(CEIL, (reg) => {
    const base = reg.stats().activeNodes;
    const rows = new Array(4);
    for (let i = 0; i < 4; i++) rows[i] = { id: "base" + i, n: 0 };
    const form = createForm({
      initialValues: { rows },
      arrays: { rows: { key: (item) => item.id, validators: { n: (v) => (v > 900 ? "hi" : null) } } },
      registry: reg,
    });
    const arr = form.array("rows");
    // Warmup: distinct-key add/touch/remove cycles so prune has settled before the
    // flat sample (its wider-reclaim first-touch cost is paid here, not measured).
    for (let w = 0; w < 64; w++) {
      const k = "w" + w;
      arr.add({ id: k, n: w });
      void form.field("rows." + k + ".n").value();
      arr.remove(k);
    }
    const aWarm = reg.stats().activeNodes;
    for (let i = 0; i < ARR_CYCLES; i++) {
      const k = "k" + i;                              // DISTINCT key, never reused
      arr.add({ id: k, n: i & 1023 });
      const fld = form.field("rows." + k + ".n");     // materialize + touch the slot
      fld.set((i & 1) ? 500 : 0);
      tracker6.track(fld, null, i, { audit: true });  // primitive tag, null cleanup
      if ((i & 15) === 0) arr.move("base1", (i & 31) ? 0 : 3); // periodic move
      arr.remove(k);
    }
    const churnDelta = reg.stats().activeNodes - aWarm;
    check(churnDelta <= 0,
      () => "t7 arrays churn leaked " + churnDelta + " node(s) over " + ARR_CYCLES +
        " distinct-key add/remove cycles -- removed-row slots were not reclaimed (prune bound violated)");
    form.dispose();
    const after = reg.stats().activeNodes;
    check(after === base,
      () => "t7 arrays churn left " + (after - base) + " node(s) after dispose (pre-form baseline)");
  });
  globalThis.gc();
  for (let k = 0; k < 12 && tracker6.size() > 0; k++) { globalThis.gc(); await settle(); }
  const live6 = tracker6.size();
  check(live6 === 0, () => "t7 arrays churn leak witness sees " + live6 + " retained row-field record(s) after dispose");
  check(tracker6.audit().length === 0, () => "t7 arrays churn leak audit reported " + tracker6.audit().length + " finding(s)");
  check(warns6.length === 0, () => "t7 arrays churn leak witness raised " + warns6.length + " warning(s)");
}

// Seeded Fisher-Yates shuffle used by witness 4's out-of-order settlement.
function shufflePrng(arr, prng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = prng() % (i + 1);
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}
