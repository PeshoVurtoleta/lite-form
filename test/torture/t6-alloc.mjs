/**
 * t6 -- the zero-alloc gate plus two recorded baselines.
 *
 * Three strictly-sequential measured windows (lite-gc-profiler is one-window-at-
 * a-time), each in its own fixed-ceiling registry:
 *
 *   (a) FLAT GATED  -- a single-field keystroke on a 100-field flat form. Two
 *       witnesses on the SAME hot body: the runOpsGate RULES window (maxPauseMs,
 *       maxArrayBuffersGrowth) plus the signal-pool witnesses (zero node acquires,
 *       zero pool growth), AND the primary transient witness -- new-space used
 *       bytes over 50000 GC-free ops (see harness allocTotal), budget 16384 B.
 *   (b) DOTTED GATED -- the same keystroke on 3-segment dotted paths. Since S1
 *       the dirty() path is an Object.is against a captured ref (no split, no
 *       baseline walk), so a dotted keystroke allocates nothing either: this is a
 *       hard transient-garbage gate with the flat window's discipline.
 *   (c) SCHEMA MEASURED -- keystroke + isValid() over a validate() schema; the
 *       schema snapshot legally allocates, so this is a recorded baseline too.
 *
 * Controls:
 *   FORM_TORTURE_BREAK=grow  -- window (a) runs on a pool sized BELOW the 100-
 *     field workload, so construction grows it and the poolGrowths witness fires.
 *   FORM_TORTURE_BREAK=alloc -- window (a)'s hot body writes a fresh object into a
 *     hoisted 16-slot array per iteration; that transient garbage is caught by the
 *     new-space witness (~32 B/op x 50000 ~= 1.6 MB, well over the 16384 B budget).
 */

import { BREAK, check, die, loadForm, runOpsGate, allocTotal, withRegistry } from "./harness.mjs";

const N = 100;
const CFG = { maxNodes: 1 << 14, maxLinks: 1 << 16, onCapacityExceeded: "throw" };

/** Hoisted 16-slot sink for the "alloc" control -- transient garbage, not retained. */
const garr = new Array(16).fill(null);

export async function run() {
  const { createForm } = await loadForm();
  // --- window (a): FLAT GATED ------------------------------------------------
  const grow = BREAK === "grow";
  const cfgA = grow
    ? { maxNodes: 64, maxLinks: 256, onCapacityExceeded: "grow" } // sized BELOW the workload
    : CFG;

  withRegistry(cfgA, (reg) => {
    const base = reg.stats().activeNodes;
    // poolGrowths snapshot spans construction so the grow control (whose growth
    // happens at build time on the undersized pool) is caught by this witness.
    const g0 = reg.stats().poolGrowths;

    const initialValues = {};
    const validators = {};
    for (let i = 0; i < N; i++) { initialValues["f" + i] = 0; validators["f" + i] = (v) => (v > 900 ? "high" : null); }
    const form = createForm({ initialValues, validators, registry: reg });

    const built = reg.stats().activeNodes - base;
    check(built > 0, () => "t6: flat construction allocated no nodes (vacuous witness)");

    const f = form.field("f7");
    const fv = f.value;
    const fe = f.error;
    const a0 = reg.stats().totalAllocations; // window-only: after construction

    const hot = (i) => {
      fv.set(i & 1023);
      void fe();
      if (BREAK === "alloc") garr[i & 15] = { v: i };
    };

    const { report, summary } = runOpsGate("t6 flat keystroke", hot, { ops: 50000, warmup: 5000 });
    if (!report.ok) {
      const g = summary.gc;
      die("t6 alloc gate rejected -- verdict=" + report.verdict +
        " major=" + g.major + " minor=" + g.minor + " maxMs=" + g.maxMs.toFixed(3));
    }

    const da = reg.stats().totalAllocations - a0;
    check(da === 0, () => "t6: keystroke acquired " + da + " signal(s) during a pre-grown gate");
    const dg = reg.stats().poolGrowths - g0;
    check(dg === 0,
      () => "t6: the signal pool grew " + dg + " chunk(s) during a pre-grown gate" +
        (grow ? " (FORM_TORTURE_BREAK=grow control -- expected)" : ""));

    // Primary witness: transient garbage over a GC-free window on the same body.
    const total = allocTotal(hot, 50000, 5000);
    check(total <= 16384,
      () => "t6 alloc gate rejected -- flat keystroke allocated " + total +
        " B of transient garbage over 50000 ops (budget 16384 B total, ~0 B/op)");
    if (BREAK === "alloc") {
      die("t6: FORM_TORTURE_BREAK=alloc injected allocations but the gate passed");
    }

    form.dispose();
  });

  // --- window (b): DOTTED GATED ----------------------------------------------
  let dotted = 0;
  withRegistry(CFG, (reg) => {
    const initialValues = {};
    const validators = {};
    for (let i = 0; i < N; i++) { initialValues["d" + i] = { m: { v: 0 } }; validators["d" + i + ".m.v"] = (v) => (v > 900 ? "high" : null); }
    const form = createForm({ initialValues, validators, registry: reg });
    const f = form.field("d7.m.v");
    const fv = f.value;
    const fe = f.error;
    const dottedHot = (i) => { fv.set(i & 1023); void fe(); };
    const total = allocTotal(dottedHot, 50000, 5000);
    check(total <= 16384,
      () => "t6 alloc gate rejected -- dotted keystroke allocated " + total +
        " B of transient garbage over 50000 ops (budget 16384 B total, ~0 B/op)");
    dotted = total / 50000;
    form.dispose();
  });

  // --- window (c): SCHEMA MEASURED (recorded baseline) -----------------------
  let schema = 0;
  withRegistry(CFG, (reg) => {
    const initialValues = {};
    for (let i = 0; i < N; i++) initialValues["f" + i] = 0;
    const schemaFn = (vals) => { const e = {}; if ((vals.f0 >>> 0) > 900) e.f0 = "high"; return e; };
    const form = createForm({ initialValues, validate: schemaFn, registry: reg });
    const f = form.field("f7");
    const fv = f.value;
    const schemaHot = (i) => { fv.set(i & 1023); void form.isValid(); };
    // 50 ops, not thousands: since S2 the scratch tree is reused IN PLACE (no
    // per-keystroke clone), so the schema keystroke now allocates only what
    // validate() itself returns per run -- a recorded baseline, not zero. The
    // window must stay inside the initial semispace (~2 MB) so no scavenge lands
    // mid-window, which is what keeps this baseline byte-stable run to run.
    schema = allocTotal(schemaHot, 50, 200) / 50;
    form.dispose();
  });

  // --- window (d): ASYNC-VALIDATED KEYSTROKE (recorded, NOT gated) -----------
  // The Promise machinery an async lane rides is inherent, so this is a recorded
  // baseline, never a gate (the debounce recipe is the documented mitigation, not
  // a waiver on the sync path). The MEASURED window contains ONLY the trigger and
  // promise creation: fv.set(i) reruns the lane effect, which bumps the monotone
  // seq and calls the async validator (one parked, never-resolving Promise per op)
  // then attaches the settlement .then. NO settlement runs inside the window --
  // the validator's promise is deliberately never resolved, so the last-write-wins
  // settlement cost is OUTSIDE the measurement. Op count is small so the parked
  // promises stay inside the initial semispace (no scavenge voids the reading).
  let asyncKs = 0;
  withRegistry(CFG, (reg) => {
    const initialValues = { g0: 0 };
    const validatorsAsync = { g0: () => new Promise(() => {}) }; // parks forever: no settlement
    const form = createForm({ initialValues, validatorsAsync, registry: reg });
    const fv = form.field("g0").value;
    const asyncHot = (i) => { fv.set(i & 1023); };
    asyncKs = allocTotal(asyncHot, 512, 64) / 512;
    form.dispose();
  });

  // --- window (e): ROW KEYSTROKE GATED (S4) ----------------------------------
  // A warmed declared-array form: the target row field's slot is materialized once
  // (touch + warm read), then a keystroke alternates two overlaying values on ONE
  // row field. The keyed lookup is a Map.get on the interned keyed path; no string
  // is concatenated per keystroke, so this is a HARD transient-garbage gate exactly
  // like the flat/dotted windows. Pre-grown fixed-ceiling registry (throw), never
  // grow in a gate.
  let rowKs = 0;
  withRegistry(CFG, (reg) => {
    const rows = new Array(N);
    for (let i = 0; i < N; i++) rows[i] = { id: "k" + i, n: 0 };
    const form = createForm({
      initialValues: { rows },
      arrays: { rows: { key: (item) => item.id, validators: { n: (v) => (v > 900 ? "high" : null) } } },
      registry: reg,
    });
    const f = form.field("rows.k7.n"); // touch the target row field so its slot exists
    const fv = f.value;
    const fe = f.error;
    void fv();                         // warm read
    const rowHot = (i) => { fv.set(1 + (i & 1)); void fe(); }; // two overlaying values, never the seed
    const total = allocTotal(rowHot, 50000, 5000);
    check(total <= 16384,
      () => "t6 alloc gate rejected -- row keystroke allocated " + total +
        " B of transient garbage over 50000 ops (budget 16384 B total, ~0 B/op)");
    rowKs = total / 50000;
    form.dispose();
  });

  // --- window (f): STRUCTURE OPS RECORDED (S4) --------------------------------
  // add+remove PAIR per op, and move per op -- both legally allocate (Object.freeze
  // of a fresh key slice, per-row createRoot, slot acquire/prune), so these are
  // RECORDED baselines, not gates. Small op counts keep each window inside the
  // initial semispace so no scavenge voids the reading. Distinct data is not needed
  // here: the add reuses a freed key each op (remove frees it before the next add).
  let addRemove = 0;
  let move = 0;
  withRegistry(CFG, (reg) => {
    const rows = new Array(4);
    for (let i = 0; i < 4; i++) rows[i] = { id: "b" + i, n: 0 };
    const form = createForm({
      initialValues: { rows },
      arrays: { rows: { key: (item) => item.id } },
      registry: reg,
    });
    const arr = form.array("rows");
    const arHot = (i) => { arr.add({ id: "tmp", n: i & 1023 }); arr.remove("tmp"); };
    addRemove = allocTotal(arHot, 200, 32) / 200;
    const mvHot = (i) => { arr.move("b1", (i & 1) ? 3 : 0); }; // bounce between the ends
    move = allocTotal(mvHot, 512, 64) / 512;
    form.dispose();
  });

  process.stderr.write("t6 LF-06 baseline dotted=" + dotted.toFixed(3) + " B/op schema=" + schema.toFixed(3) + " B/op asyncKeystroke=" + asyncKs.toFixed(3) + " B/op\n");
  process.stderr.write("t6 S4 arrays rowKeystroke=" + rowKs.toFixed(3) + " addRemove=" + addRemove.toFixed(3) + " move=" + move.toFixed(3) + " B/op\n");

  // RECORDED baselines with headroom. rowKeystroke is GATED above (16384 B /
  // 50000 ops, measured ~0.1 B/op); addRemove/move are structural and legally
  // allocate (createRoot + Object.freeze slice). Ratchets are measured + headroom:
  // addRemove ~8.9 KB/op -> 32768 ceiling (the slotleak control runs this window
  // with prune blanked, which only accumulates retained pool slots, not transient
  // garbage, so the recorded window still survives to let t7 catch the leak);
  // move ~0.29 KB/op -> 4096 ceiling.
  check(!(addRemove > 32768), () => "t6: addRemove baseline " + addRemove + " B/op exceeds the 32768 ratchet ceiling");
  check(!(move > 4096), () => "t6: move baseline " + move + " B/op exceeds the 4096 ratchet ceiling");

  // Generous sanity ceilings -- these are RECORDED baselines, not budgets. The
  // real numbers land in the report; only an order-of-magnitude regression dies.
  check(!(dotted > 4096), () => "t6: dotted baseline " + dotted + " B/op exceeds the 4096 sanity ceiling");
  check(!(schema > 32768), () => "t6: schema baseline " + schema + " B/op exceeds the 32768 sanity ceiling");
}
