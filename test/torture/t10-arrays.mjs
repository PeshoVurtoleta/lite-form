/**
 * t10 -- field-array identity torture (S4). Four tiers, each proving a distinct
 * identity/purity law of the keyed-row engine:
 *
 *   (a) reorder purity -- move() is order-only: ZERO row-validator re-runs, ZERO
 *       row-field value writes, and the keys() snapshot identity flips EXACTLY
 *       once per structural op.
 *   (b) identity soak -- seeded add/remove/move/set/touch churn where every
 *       surviving row carries a distinguishing edit; after every op the per-key
 *       state (value/dirty/touched via "rows.<key>.<sub>") matches a tiny keyed
 *       model AND keys() equals the model's order array (the rowident control
 *       breaks key derivation and this "t10 identity" check dies).
 *   (c) remove mid-flight async -- a deferred row lane removed while pending:
 *       late settlements land nothing, isValidating() returns to false at the
 *       removal (LF-13b), and no stale settlement/rejection surfaces.
 *   (d) 1-arg reinitialize under churn -- keys re-derived, prior state gone, and
 *       a hostile leaf throws with NOTHING mutated (atomicity).
 *
 * This tier runs BETWEEN t8 and t9: t9's rowident control patches the seed-path
 * keyFn and runs the full tier list, so the identity check must die HERE (with
 * "t10 identity") before t9 would recursively spawn.
 */

import { SEED, check, die, loadForm, makePrng, deepEqual } from "./harness.mjs";

// Microtask drain: no wall clock, only awaited resolved promises (mirrors t8).
async function drain() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

export async function run() {
  const { createForm } = await loadForm();

  // --- (a) reorder purity ----------------------------------------------------
  {
    let runs = 0;
    const rows = [];
    for (let i = 0; i < 6; i++) rows.push({ id: "r" + i, n: i });
    const form = createForm({
      initialValues: { rows },
      arrays: { rows: { key: (item) => item.id, validators: { n: (v) => { runs++; return v > 900 ? "hi" : null; } } } },
    });
    const arr = form.array("rows");
    // Read the live keys the engine derived (identity itself is tier (b)'s law;
    // this tier stays key-agnostic so the rowident control's break is caught THERE
    // with the "t10 identity" marker, not here as a raw field-lookup throw).
    const liveKeys = arr.keys().slice();
    const writes = new Array(liveKeys.length).fill(0);
    const stops = [];
    for (let i = 0; i < liveKeys.length; i++) {
      const f = form.field("rows." + liveKeys[i] + ".n");
      const idx = i;
      stops.push(f.value.subscribe(() => { writes[idx]++; })); // fires once initially
      stops.push(f.error.subscribe(() => {}));                 // keep rawError live
      f.set(100 + i);                                          // dirty -> reveal -> validator runs
    }
    const runs0 = runs;
    const writes0 = writes.slice();
    const k0 = arr.keys();
    arr.move(liveKeys[0], 3);                                  // order-only structural op
    const k1 = arr.keys();
    check(runs === runs0, () => "t10 (a): move() re-ran a row validator (" + (runs - runs0) + " re-runs)");
    for (let i = 0; i < liveKeys.length; i++) {
      check(writes[i] === writes0[i],
        () => "t10 (a): move() wrote row field " + liveKeys[i] + " (" + (writes[i] - writes0[i]) + " write(s))");
    }
    check(k1 !== k0, () => "t10 (a): move() did not flip the keys() snapshot identity");
    check(arr.keys() === k1, () => "t10 (a): keys() identity flipped without a structural op");
    arr.move(liveKeys[0], 0);                                  // second structural op
    check(arr.keys() !== k1, () => "t10 (a): second move() did not flip keys() identity");
    for (let i = 0; i < stops.length; i++) stops[i]();
    form.dispose();
  }

  // --- (b) identity soak (rowident control target) ---------------------------
  {
    const prng = makePrng((SEED ^ 0x51ed270b) >>> 0);
    const rows = [];
    const order = [];
    const model = new Map(); // key -> { val, seed, touched }
    for (let i = 0; i < 3; i++) {
      const key = "m" + i;
      rows.push({ id: key, n: i });
      order.push(key);
      model.set(key, { val: i, seed: i, touched: false });
    }
    const form = createForm({
      initialValues: { rows },
      arrays: { rows: { key: (item) => item.id } },
    });
    const arr = form.array("rows");
    // Pre-loop identity: baseline keys MUST be the model ids -- the rowident
    // control derives keys as String(i) in the seed path, so this dies first.
    check(deepEqual(arr.keys().slice(), order),
      () => "t10 identity: baseline keys() " + JSON.stringify(arr.keys().slice()) +
        " != model order " + JSON.stringify(order));
    let ctr = 100; // distinct-key source, never reused
    const STEPS = 400;
    for (let s = 0; s < STEPS; s++) {
      const op = prng() % 5;
      if (op === 0) {                                          // add (distinct key)
        const key = "a" + (ctr++);
        const idx = prng() % (order.length + 1);
        const v = prng() & 1023;
        arr.add({ id: key, n: v }, idx);
        order.splice(idx, 0, key);
        model.set(key, { val: v, seed: v, touched: false });
      } else if (op === 1) {                                   // remove
        if (order.length > 0) {
          const key = order[prng() % order.length];
          arr.remove(key);
          order.splice(order.indexOf(key), 1);
          model.delete(key);
        }
      } else if (op === 2) {                                   // move
        if (order.length > 0) {
          const key = order[prng() % order.length];
          const to = prng() % order.length;
          arr.move(key, to);
          const from = order.indexOf(key);
          if (from !== to) { order.splice(from, 1); order.splice(to, 0, key); }
        }
      } else if (op === 3) {                                   // set (distinguishing edit)
        if (order.length > 0) {
          const key = order[prng() % order.length];
          const v = prng() & 1023;
          form.field("rows." + key + ".n").set(v);
          model.get(key).val = v;
        }
      } else {                                                 // touch
        if (order.length > 0) {
          const key = order[prng() % order.length];
          form.field("rows." + key + ".n").blur();
          model.get(key).touched = true;
        }
      }
      // Identity FIRST: dies under rowident before any field-by-key access can throw.
      check(deepEqual(arr.keys().slice(), order),
        () => "t10 identity: keys() " + JSON.stringify(arr.keys().slice()) +
          " != model order " + JSON.stringify(order) + " (step " + s + ")");
      for (let j = 0; j < order.length; j++) {
        const key = order[j];
        const m = model.get(key);
        const f = form.field("rows." + key + ".n");
        check(f.value() === m.val,
          () => "t10 (b): row " + key + " value " + f.value() + " != model " + m.val + " (step " + s + ")");
        check(f.dirty() === (m.val !== m.seed),
          () => "t10 (b): row " + key + " dirty " + f.dirty() + " != model " + (m.val !== m.seed) + " (step " + s + ")");
        check(f.touched() === m.touched,
          () => "t10 (b): row " + key + " touched " + f.touched() + " != model " + m.touched + " (step " + s + ")");
      }
    }
    form.dispose();
  }

  // --- (c) remove mid-flight async (LF-13b at tier level) --------------------
  {
    const seen = [];
    const onUnhandled = (reason) => seen.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      for (let r = 0; r < 16; r++) {
        const q = [];
        const va = (v) => new Promise((res, rej) => q.push({ res, rej }));
        const form = createForm({
          initialValues: { rows: [{ id: "x", n: 0 }] },
          arrays: { rows: { key: (item) => item.id, validatorsAsync: { n: va } } },
        });
        await drain();
        if (q[0]) q[0].res(null);                              // clear construction validation
        await drain();
        form.field("rows.x.n").set(r + 1);                     // q[1]: in flight
        check(form.isValidating() === true,
          () => "t10 (c): isValidating not true with a row validation in flight (round " + r + ")");
        form.array("rows").remove("x");                        // remove WHILE pending
        check(form.isValidating() === false,
          () => "t10 (c): isValidating stuck true after removing a row mid-flight (round " + r + ") -- LF-13b");
        for (let j = 0; j < q.length; j++) q[j].res("late");   // late settlements land nothing
        await drain();
        check(form.isValidating() === false,
          () => "t10 (c): a late settlement re-raised isValidating after row removal (round " + r + ")");
        form.dispose();
      }
      // A stale rejection after removal is swallowed whole (no unhandledRejection).
      for (let r = 0; r < 8; r++) {
        const q = [];
        const va = (v) => new Promise((res, rej) => q.push({ res, rej }));
        const form = createForm({
          initialValues: { rows: [{ id: "y", n: 0 }] },
          arrays: { rows: { key: (item) => item.id, validatorsAsync: { n: va } } },
        });
        await drain();
        if (q[0]) q[0].res(null);
        await drain();
        form.field("rows.y.n").set(r + 1);
        form.array("rows").remove("y");
        q[q.length - 1].rej(new Error("stale boom"));          // rejected after teardown
        await drain();
        form.dispose();
      }
      await drain();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    check(seen.length === 0,
      () => "t10 (c): a mid-flight row validation surfaced as unhandledRejection (" + seen.length + " seen)");
  }

  // --- (d) 1-arg reinitialize under churn ------------------------------------
  {
    const form = createForm({
      initialValues: { rows: [{ id: "o0", n: 0 }, { id: "o1", n: 1 }] },
      arrays: { rows: { key: (item) => item.id } },
    });
    const arr = form.array("rows");
    form.field("rows.o0.n").set(50);                           // edit
    arr.add({ id: "o2", n: 2 });                              // structure churn
    arr.move("o1", 0);
    check(form.isDirty() === true, () => "t10 (d): pre-reinit form not dirty");

    form.reinitialize({ rows: [{ id: "z0", n: 7 }, { id: "z1", n: 8 }, { id: "z2", n: 9 }] });
    check(deepEqual(arr.keys().slice(), ["z0", "z1", "z2"]),
      () => "t10 (d): reinitialize did not re-derive keys, got " + JSON.stringify(arr.keys().slice()));
    check(form.field("rows.z0.n").value() === 7,
      () => "t10 (d): reinitialized row z0 has wrong value " + form.field("rows.z0.n").value());
    check(form.isDirty() === false,
      () => "t10 (d): form still dirty after reinitialize (prior state not gone)");
    let threwOld = false;
    try { form.field("rows.o0.n"); } catch (e) { threwOld = e instanceof TypeError; }
    check(threwOld, () => "t10 (d): an old row key still resolved after reinitialize (prior state not gone)");

    // Hostile-leaf atomicity: a reinit whose second item carries a function leaf
    // (copyLeaf rejects it) throws with NOTHING mutated.
    const keysBefore = JSON.stringify(arr.keys().slice());
    const valBefore = form.field("rows.z0.n").value();
    let threwHostile = false;
    try {
      form.reinitialize({ rows: [{ id: "h0", n: 1 }, { id: "h1", n: () => {} }] });
    } catch (e) {
      threwHostile = e instanceof TypeError;
    }
    check(threwHostile, () => "t10 (d): a hostile leaf in reinitialize did not throw TypeError");
    check(JSON.stringify(arr.keys().slice()) === keysBefore,
      () => "t10 (d): hostile-leaf reinitialize mutated the key order (atomicity broken)");
    check(form.field("rows.z0.n").value() === valBefore,
      () => "t10 (d): hostile-leaf reinitialize mutated a row value (atomicity broken)");
    form.dispose();
  }
}
