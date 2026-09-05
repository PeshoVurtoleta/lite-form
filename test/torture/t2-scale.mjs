/**
 * t2 -- scale. A form with 1000 flat fields plus 200 eight-segment dotted paths
 * builds under a fixed-ceiling registry without tripping capacity, re-querying a
 * declared field is a pure map hit (zero new signals), and a single keystroke
 * runs EXACTLY one per-field validator -- the cutoff promise at scale. dispose()
 * returns the registry to its pre-createForm baseline.
 */

import { check, loadForm, withRegistry } from "./harness.mjs";

const FLAT = 1000;
const DOTTED = 200;
const CFG = { maxNodes: 1 << 15, maxLinks: 1 << 17, onCapacityExceeded: "throw" };

// Module-scope validator counters -- incremented INSIDE each per-field validator.
let counters = null;

export async function run() {
  const { createForm } = await loadForm();
  withRegistry(CFG, (reg) => {
    const base = reg.stats().activeNodes;

    counters = new Uint32Array(FLAT);
    const initialValues = {};
    const validators = {};
    for (let i = 0; i < FLAT; i++) {
      initialValues["f" + i] = 0;
      const idx = i;
      validators["f" + i] = (v) => { counters[idx]++; return v > 900 ? "high" : null; };
    }
    const flatPaths = [];
    for (let i = 0; i < FLAT; i++) flatPaths.push("f" + i);
    // 200 fields on 8-segment dotted paths: "g<i>.a.b.c.d.e.f.h"
    for (let i = 0; i < DOTTED; i++) {
      initialValues["g" + i] = { a: { b: { c: { d: { e: { f: { h: 0 } } } } } } };
    }

    const form = createForm({ initialValues, validators, registry: reg });

    const built = reg.stats().activeNodes - base;
    check(built > 0, () => "t2: construction allocated no nodes (vacuous witness)");

    // Observe isValid so per-field rawErrors are cached (the cutoff depends on
    // observation). This first evaluation runs every validator exactly once.
    const stop = reg.effect(() => { void form.isValid(); });

    // Re-querying a declared field is a map hit: zero new signals.
    const ta0 = reg.stats().totalAllocations;
    for (let i = 0; i < FLAT; i++) form.field(flatPaths[i]);
    const taDelta = reg.stats().totalAllocations - ta0;
    check(taDelta === 0,
      () => "t2: re-querying 1000 declared fields allocated " + taDelta + " signal(s) (must be map hits)");

    // Snapshot counters, then one keystroke -> exactly one validator runs.
    let sumBefore = 0;
    for (let i = 0; i < FLAT; i++) sumBefore += counters[i];
    const c7 = counters[7];

    form.field("f7").set(1);
    void form.isValid(); // pull the cached graph forward deterministically

    let sumAfter = 0;
    for (let i = 0; i < FLAT; i++) sumAfter += counters[i];
    check(counters[7] - c7 === 1,
      () => "t2: field f7's validator ran " + (counters[7] - c7) + " time(s) on one keystroke (expected 1)");
    check(sumAfter - sumBefore === 1,
      () => "t2: one keystroke ran " + (sumAfter - sumBefore) + " validators total (expected exactly 1)");

    // isDirty flips on the one write and back on reset.
    check(form.isDirty() === true, () => "t2: isDirty() did not flip true after a write");
    form.reset();
    check(form.isDirty() === false, () => "t2: isDirty() did not return false after reset()");

    stop();
    form.dispose();
    const leaked = reg.stats().activeNodes - base;
    check(leaked === 0, () => "t2: dispose() left " + leaked + " node(s) above baseline");
  });
}
