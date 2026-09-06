/**
 * t5 -- differential fuzz. A form of 6 flat + 3 dotted fields PLUS one declared
 * keyed field array ("rows", key = item.id, a per-row "n" validator) is driven by
 * a seeded weighted op stream (4 seeds x 800 steps) against TWO independent plain-
 * object oracles: the flat overlay-as-value oracle (unchanged from 1.3.0) and an
 * independently-keyed row oracle (its own Map key -> current value + its own order
 * array + added/removed/baseline-seed bookkeeping). Both oracles are derived from
 * the SAME op stream and NEVER from form internals.
 *
 * After EVERY step the form's values() (arrays in order), isDirty(), isValid(),
 * per-flat-path AND per-row dirty()/touched() via keyed paths, the array handle's
 * keys()/length()/structureDirty(), and toPatch() -- field entries AND the D2
 * structure entry (order / added keys+index+full value / removed) -- must all
 * equal the oracles' own derivation. Any divergence dies with a replayable seed.
 *
 * D4: on a form that declares arrays, 2-arg reinitialize (merge) is a TypeError.
 * The merge-op arm therefore SKIPS the merge and asserts the throw (mutating
 * neither form nor oracle), then continues -- the flat merge oracle is unreachable
 * here by design and lives on for the no-array precedent in the git history.
 *
 * Control: FORM_TORTURE_BREAK=drop skips the flat oracle's per-field verdict
 * recompute after a set, so its cached validity goes stale and isValid diverges --
 * proving the invariant check can actually catch a wrong verdict.
 */

import { BREAK, SEED, check, deepEqual, die, loadForm, makePrng } from "./harness.mjs";

const SEEDS = 4;
const STEPS = 800;
const PATHS = ["a", "b", "c", "d", "e", "f", "p.x", "q.y", "r.z"];
// Existing 8 ops (indices 0..7, unchanged) + 5 keyed-row ops (indices 8..12).
const OP_NAMES = [
  "set", "blur", "reset", "setValues", "submit", "commit", "reinitialize", "reinitializeMerge",
  "rowAdd", "rowRemove", "rowMove", "rowSet", "rowReset",
];
// Seeded weights: structure churn is stressed hardest (rowAdd/rowSet/rowMove).
const WEIGHTS = [12, 6, 3, 8, 3, 3, 3, 2, 14, 8, 10, 16, 6];
const WTOTAL = (() => { let s = 0; for (let i = 0; i < WEIGHTS.length; i++) s += WEIGHTS[i]; return s; })();
function pickOp(r) {
  let x = r % WTOTAL;
  for (let i = 0; i < WEIGHTS.length; i++) { if (x < WEIGHTS[i]) return i; x -= WEIGHTS[i]; }
  return WEIGHTS.length - 1;
}

// Seeded policy pool for the (now-unreachable) merge op. Kept so the D4 throw is
// exercised across distinct policy identities.
const POLICIES = {
  "true": () => true,
  "false": () => false,
  "is": (n, d) => Object.is(n, d),
  "json": (n, d) => JSON.stringify(n) === JSON.stringify(d),
  "throw": () => { throw new Error("policy boom"); },
};
const POLICY_NAMES = Object.keys(POLICIES);

const normErr = (e) => (e ? e : null);

// value-dependent per-field validators (own value only)
const validators = {
  a: (v) => ((v >>> 0) % 3 === 0 ? null : "bad3"),
  c: (v) => ((v >>> 0) % 5 === 0 ? null : "bad5"),
  "q.y": (v) => ((v >>> 0) % 2 === 0 ? null : "odd"),
};
const VALIDATOR_PATHS = Object.keys(validators);

// one cross-field schema rule over the nested values object (ignores rows)
const schema = (vals) => {
  const errs = {};
  if ((vals.p.x >>> 0) > (vals.r.z >>> 0)) errs["r.z"] = "order";
  return errs;
};

// the row "n" field validator (rawError basis, no reveal)
const nOdd = (v) => ((v >>> 0) % 2 === 0 ? null : "odd");
const rowKeyFn = (item) => item.id;

export async function run() {
  const { createForm } = await loadForm();
  const drop = BREAK === "drop";

  for (let k = 0; k < SEEDS; k++) {
    const seed = (SEED + k) >>> 0;
    const prng = makePrng(seed);

    // distinct-key counter -- no key is ever reused, so no add/reseed dup throws.
    let keyCtr = 0;
    const nk = () => "r" + (keyCtr++);

    const { createRegistry } = await import("@zakkster/lite-signal");
    const reg = createRegistry({ maxNodes: 1 << 15, maxLinks: 1 << 17, onCapacityExceeded: "grow" });

    const rk0 = nk();
    const rk1 = nk();
    const form = createForm({
      initialValues: {
        a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, p: { x: 0 }, q: { y: 0 }, r: { z: 0 },
        rows: [{ id: rk0, n: 0 }, { id: rk1, n: 0 }],
      },
      validators,
      validate: schema,
      arrays: { rows: { key: rowKeyFn, validators: { n: nOdd } } },
      registry: reg,
    });
    const arr = form.array("rows");

    // --- oracle A: flat overlay-as-value + touched (1.3.0 shape, unchanged) ----
    const vals = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, "p.x": 0, "q.y": 0, "r.z": 0 };
    const baseline = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, "p.x": 0, "q.y": 0, "r.z": 0 };
    const touched = new Set();
    const verdicts = { a: null, c: null, "q.y": null };

    // --- oracle B: independently-keyed row model (own maps + own order array) ---
    const rowN = new Map([[rk0, 0], [rk1, 0]]);       // key -> current n
    const baseSeedN = new Map([[rk0, 0], [rk1, 0]]);  // key -> baseline seed n (kept for removed rows)
    const addSeedN = new Map();                       // key -> add seed n (uncommitted adds)
    const rowTouched = new Set();                     // keys whose "n" field is touched
    const added = new Set();                          // uncommitted added keys
    let removed = [];                                 // baseline keys removed, in removal order
    let curOrder = [rk0, rk1];                        // current key order
    let baseOrder = [rk0, rk1];                       // baseline key order

    const rowSeedOf = (key) => (added.has(key) ? addSeedN.get(key) : baseSeedN.get(key));
    const rowDirty = (key) => rowN.get(key) !== rowSeedOf(key);
    const anyRowDirty = () => { for (let i = 0; i < curOrder.length; i++) if (rowDirty(curOrder[i])) return true; return false; };
    const structureDirty = () => {
      if (added.size > 0 || removed.length > 0) return true;
      if (curOrder.length !== baseOrder.length) return true;
      for (let i = 0; i < curOrder.length; i++) if (curOrder[i] !== baseOrder[i]) return true;
      return false;
    };
    const rowsValid = () => { for (let i = 0; i < curOrder.length; i++) if (nOdd(rowN.get(curOrder[i])) != null) return false; return true; };
    const mirrorRows = () => curOrder.map((key) => ({ id: key, n: rowN.get(key) }));

    const recompute = (path) => { const v = validators[path]; if (v) verdicts[path] = normErr(v(vals[path])); };
    const recomputeAll = () => { for (let j = 0; j < VALIDATOR_PATHS.length; j++) recompute(VALIDATOR_PATHS[j]); };

    const mirrorValues = () => ({
      a: vals.a, b: vals.b, c: vals.c, d: vals.d, e: vals.e, f: vals.f,
      p: { x: vals["p.x"] }, q: { y: vals["q.y"] }, r: { z: vals["r.z"] },
      rows: mirrorRows(),
    });
    const mirrorDirty = () => {
      for (let j = 0; j < PATHS.length; j++) if (vals[PATHS[j]] !== baseline[PATHS[j]]) return true;
      return anyRowDirty() || structureDirty();
    };
    const mirrorValid = () => {
      const se = schema(mirrorValues());
      for (const kk in se) if (se[kk]) return false;
      for (let j = 0; j < VALIDATOR_PATHS.length; j++) if (verdicts[VALIDATOR_PATHS[j]] != null) return false;
      return rowsValid();
    };
    // toPatch(): flat field entries + keyed row-field entries (baseline rows only)
    // + the D2 structure entry (added-row values ride structure.added). Sorted by
    // path for a stable compare (every path is unique, incl. the "rows" structure).
    const mirrorPatch = () => {
      const out = [];
      for (let j = 0; j < PATHS.length; j++) {
        const p = PATHS[j];
        if (vals[p] !== baseline[p]) out.push({ path: p, from: baseline[p], to: vals[p] });
      }
      for (let i = 0; i < curOrder.length; i++) {
        const key = curOrder[i];
        if (added.has(key)) continue;                 // added-row fields never emit field entries
        if (rowN.get(key) !== baseSeedN.get(key)) {
          out.push({ path: "rows." + key + ".n", from: baseSeedN.get(key), to: rowN.get(key) });
        }
      }
      if (structureDirty()) {
        const addedArr = [];
        for (let i = 0; i < curOrder.length; i++) {
          const key = curOrder[i];
          if (added.has(key)) addedArr.push({ key, index: i, value: { id: key, n: rowN.get(key) } });
        }
        out.push({ path: "rows", structure: { order: curOrder.slice(), added: addedArr, removed: removed.slice() } });
      }
      out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
      return out;
    };

    // reset() / commit() / reinitialize() array-side mirrors ---------------------
    const mirrorResetRows = () => {
      // drop added, restore removed baseline rows pristine, restore baseline order.
      for (const key of added) { rowN.delete(key); addSeedN.delete(key); }
      added.clear();
      for (let i = 0; i < removed.length; i++) rowN.set(removed[i], baseSeedN.get(removed[i]));
      removed = [];
      for (let i = 0; i < baseOrder.length; i++) rowN.set(baseOrder[i], baseSeedN.get(baseOrder[i]));
      curOrder = baseOrder.slice();
      rowTouched.clear();
    };
    const mirrorCommitRows = () => {
      for (const key of added) { baseSeedN.set(key, rowN.get(key)); addSeedN.delete(key); }
      added.clear();
      for (let i = 0; i < curOrder.length; i++) baseSeedN.set(curOrder[i], rowN.get(curOrder[i]));
      // drop baseline seeds for rows no longer present (removed baseline keys folded away)
      for (let i = 0; i < removed.length; i++) baseSeedN.delete(removed[i]);
      removed = [];
      baseOrder = curOrder.slice();
    };
    const mirrorReinitRows = (items) => {
      rowN.clear(); baseSeedN.clear(); addSeedN.clear(); rowTouched.clear();
      added.clear(); removed = [];
      curOrder = [];
      for (let i = 0; i < items.length; i++) {
        rowN.set(items[i].id, items[i].n);
        baseSeedN.set(items[i].id, items[i].n);
        curOrder.push(items[i].id);
      }
      baseOrder = curOrder.slice();
    };

    for (let i = 0; i < STEPS; i++) {
      const op = pickOp(prng());
      if (op === 0) { // set
        const path = PATHS[prng() % PATHS.length];
        const value = prng();
        form.field(path).set(value);
        vals[path] = value;
        if (!drop) recompute(path); // "drop" leaves the cached verdict stale
      } else if (op === 1) { // blur (flat; no value change; marks touched)
        const path = PATHS[prng() % PATHS.length];
        form.field(path).blur();
        touched.add(path);
      } else if (op === 2) { // reset (revert overlays + re-seed + clear touched, flat AND rows)
        form.reset();
        for (let j = 0; j < PATHS.length; j++) vals[PATHS[j]] = baseline[PATHS[j]];
        touched.clear();
        recomputeAll();
        mirrorResetRows();
      } else if (op === 3) { // setValues of 2 random FLAT fields
        const p1 = PATHS[prng() % PATHS.length];
        const v1 = prng();
        const p2 = PATHS[prng() % PATHS.length];
        const v2 = prng();
        const patch = {};
        patch[p1] = v1;
        patch[p2] = v2;
        form.setValues(patch);
        vals[p1] = v1; recompute(p1);
        vals[p2] = v2; recompute(p2);
      } else if (op === 4) { // submit (no onSubmit): validates, changes no values
        await form.submit();
      } else if (op === 5) { // commit: fold overlays into the baseline (flat AND rows)
        form.commit();
        for (let j = 0; j < PATHS.length; j++) baseline[PATHS[j]] = vals[PATHS[j]];
        mirrorCommitRows();
      } else if (op === 6) { // reinitialize (1-arg): replace baseline + re-seed rows fully
        const rv = prng();
        const nk0 = nk(); const nk1 = nk();
        const items = [
          { id: nk0, n: (rv & 1) ? rv : rv + 1 },
          { id: nk1, n: ((rv >> 1) & 1) ? rv + 2 : rv + 3 },
        ];
        const next = { a: rv, b: rv, c: rv, d: rv, e: rv, f: rv, p: { x: rv }, q: { y: rv }, r: { z: rv }, rows: items };
        form.reinitialize(next);
        for (let j = 0; j < PATHS.length; j++) { vals[PATHS[j]] = rv; baseline[PATHS[j]] = rv; }
        touched.clear();
        recomputeAll();
        mirrorReinitRows(items);
      } else if (op === 7) { // reinitializeMerge (2-arg): D4 -- MUST throw on a declared-array form
        const nk0 = nk();
        const next = { a: prng(), rows: [{ id: nk0, n: prng() }] };
        const policyName = POLICY_NAMES[prng() % POLICY_NAMES.length];
        const policyFn = POLICIES[policyName];
        let threwForm = false;
        try { form.reinitialize(next, policyFn); } catch (e) { threwForm = e instanceof TypeError; }
        check(threwForm,
          () => "t5: D4 -- 2-arg reinitialize on a declared-array form did NOT throw TypeError -- seed " +
            seed + " step " + i + " policy=" + policyName);
        // neither form nor oracle mutated: the following full-state compare confirms it.
      } else if (op === 8) { // rowAdd (distinct key, at a random index)
        const idx = prng() % (curOrder.length + 1);
        const key = nk();
        const n = prng();
        form.array("rows").add({ id: key, n }, idx);
        added.add(key); addSeedN.set(key, n); rowN.set(key, n);
        curOrder.splice(idx, 0, key);
      } else if (op === 9) { // rowRemove
        if (curOrder.length > 0) {
          const key = curOrder[prng() % curOrder.length];
          form.array("rows").remove(key);
          const ci = curOrder.indexOf(key);
          curOrder.splice(ci, 1);
          if (added.has(key)) { added.delete(key); addSeedN.delete(key); }
          else removed.push(key);
          rowN.delete(key);
          rowTouched.delete(key);
        }
      } else if (op === 10) { // rowMove (order-only; from===to is an engine no-op)
        if (curOrder.length > 0) {
          const key = curOrder[prng() % curOrder.length];
          const to = prng() % curOrder.length;
          form.array("rows").move(key, to);
          const from = curOrder.indexOf(key);
          if (from !== to) { curOrder.splice(from, 1); curOrder.splice(to, 0, key); }
        }
      } else if (op === 11) { // rowSet (edit a row field's n, then blur -> touched)
        if (curOrder.length > 0) {
          const key = curOrder[prng() % curOrder.length];
          const v = prng();
          form.field("rows." + key + ".n").set(v);
          form.field("rows." + key + ".n").blur();
          rowN.set(key, v);
          rowTouched.add(key);
        }
      } else { // op === 12: rowReset (set a row field back to its seed -> overlay clears)
        if (curOrder.length > 0) {
          const key = curOrder[prng() % curOrder.length];
          const s = rowSeedOf(key);
          form.field("rows." + key + ".n").set(s);
          rowN.set(key, s);
        }
      }

      const opName = OP_NAMES[op];
      if (!deepEqual(form.values(), mirrorValues())) {
        die("t5: oracle diverged -- seed " + seed + " step " + i + " op " + opName + " (values)");
      }
      check(form.isDirty() === mirrorDirty(),
        () => "t5: oracle diverged -- seed " + seed + " step " + i + " op " + opName + " (isDirty)");
      check(form.isValid() === mirrorValid(),
        () => "t5: oracle diverged -- seed " + seed + " step " + i + " op " + opName +
          " (isValid) form=" + form.isValid() + " mirror=" + mirrorValid() +
          " rowsValid=" + rowsValid() + " structureDirty=" + structureDirty() +
          " curOrder=" + JSON.stringify(curOrder));
      // array handle: keys()/length()/structureDirty()
      if (!deepEqual(arr.keys().slice(), curOrder)) {
        die("t5: oracle diverged -- seed " + seed + " step " + i + " op " + opName + " (array keys)");
      }
      check(arr.length() === curOrder.length,
        () => "t5: oracle diverged -- seed " + seed + " step " + i + " op " + opName + " (array length)");
      check(arr.structureDirty() === structureDirty(),
        () => "t5: oracle diverged -- seed " + seed + " step " + i + " op " + opName + " (structureDirty)");
      // per-flat-path dirty() and touched()
      for (let j = 0; j < PATHS.length; j++) {
        const p = PATHS[j];
        check(form.field(p).dirty() === (vals[p] !== baseline[p]),
          () => "t5: oracle diverged -- seed " + seed + " step " + i + " op " + opName + " (dirty path " + p + ") formVal=" + form.field(p).value() + " formDirty=" + form.field(p).dirty() + " mVal=" + vals[p] + " mBase=" + baseline[p]);
        check(form.field(p).touched() === touched.has(p),
          () => "t5: oracle diverged -- seed " + seed + " step " + i + " op " + opName + " (touched path " + p + ")");
      }
      // per-row dirty() and touched() via keyed paths
      for (let j = 0; j < curOrder.length; j++) {
        const key = curOrder[j];
        const rf = form.field("rows." + key + ".n");
        check(rf.dirty() === rowDirty(key),
          () => "t5: oracle diverged -- seed " + seed + " step " + i + " op " + opName + " (row dirty key " + key + ") formDirty=" + rf.dirty() + " mDirty=" + rowDirty(key) + " n=" + rowN.get(key) + " seed=" + rowSeedOf(key));
        check(rf.touched() === rowTouched.has(key),
          () => "t5: oracle diverged -- seed " + seed + " step " + i + " op " + opName + " (row touched key " + key + ")");
      }
      // toPatch(): field entries AND the structure entry
      const fp = form.toPatch().slice().sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
      if (!deepEqual(fp, mirrorPatch())) {
        die("t5: oracle diverged -- seed " + seed + " step " + i + " op " + opName + " (toPatch structure/field)");
      }
    }

    form.dispose();
  }
}
