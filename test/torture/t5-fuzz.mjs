/**
 * t5 -- differential fuzz. A form of 6 flat + 3 dotted fields, three per-field
 * validators with value-dependent verdicts, and one cross-field schema rule, is
 * driven by a seeded op stream (4 seeds x 800 steps) against an independent
 * plain-object oracle. After EVERY step the form's values(), isDirty(), isValid(),
 * per-path dirty()/touched(), and toPatch() from/to VALUES must equal the oracle's.
 * Any divergence dies with a replayable seed.
 *
 * The oracle carries its OWN baseline object, overlay-as-value model (clear-on-
 * initial: an overlay exists exactly while a value differs from its baseline), and
 * touched flags, so reinitialize(next, policy) is mirrored INDEPENDENTLY: the
 * merge table (ADOPT/ECHO/CONFLICT) is recomputed by hand, including the atomic
 * throwing-policy contract (a throw mutates nothing -- the mirror asserts the real
 * form ALSO threw and diverged nowhere), the D1 touched fate, and reseed-always.
 *
 * Control: FORM_TORTURE_BREAK=drop skips the oracle's per-field verdict recompute
 * after a set, so its cached validity goes stale and isValid diverges -- proving
 * the invariant check can actually catch a wrong verdict.
 */

import { BREAK, SEED, check, deepEqual, die, loadForm, makePrng } from "./harness.mjs";

const SEEDS = 4;
const STEPS = 800;
const PATHS = ["a", "b", "c", "d", "e", "f", "p.x", "q.y", "r.z"];
const OP_NAMES = ["set", "blur", "reset", "setValues", "submit", "commit", "reinitialize", "reinitializeMerge"];
const OP_COUNT = OP_NAMES.length;

// Seeded policy pool for the merge op. Values are integers, so json == is here;
// both are kept so the fuzz exercises distinct code paths (function identity).
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

// one cross-field schema rule over the nested values object
const schema = (vals) => {
  const errs = {};
  if ((vals.p.x >>> 0) > (vals.r.z >>> 0)) errs["r.z"] = "order";
  return errs;
};

function freshInitial() {
  return { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, p: { x: 0 }, q: { y: 0 }, r: { z: 0 } };
}

// leaf of a nested `next` object at a (possibly dotted) path; undefined when absent.
function nextLeaf(next, path) {
  const dot = path.indexOf(".");
  if (dot === -1) return next[path];
  const o = next[path.slice(0, dot)];
  return o == null ? undefined : o[path.slice(dot + 1)];
}

export async function run() {
  const { createForm } = await loadForm();
  const drop = BREAK === "drop";

  for (let k = 0; k < SEEDS; k++) {
    const seed = (SEED + k) >>> 0;
    const prng = makePrng(seed);

    const { createRegistry } = await import("@zakkster/lite-signal");
    const reg = createRegistry({ maxNodes: 1 << 14, maxLinks: 1 << 16, onCapacityExceeded: "grow" });
    const form = createForm({ initialValues: freshInitial(), validators, validate: schema, registry: reg });

    // --- the oracle (own baseline + overlay-as-value + touched flags) ---------
    const vals = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, "p.x": 0, "q.y": 0, "r.z": 0 };
    const baseline = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, "p.x": 0, "q.y": 0, "r.z": 0 };
    const touched = new Set();
    const verdicts = { a: null, c: null, "q.y": null };

    const recompute = (path) => {
      const v = validators[path];
      if (v) verdicts[path] = normErr(v(vals[path]));
    };
    const recomputeAll = () => { for (let j = 0; j < VALIDATOR_PATHS.length; j++) recompute(VALIDATOR_PATHS[j]); };
    const mirrorValues = () => ({
      a: vals.a, b: vals.b, c: vals.c, d: vals.d, e: vals.e, f: vals.f,
      p: { x: vals["p.x"] }, q: { y: vals["q.y"] }, r: { z: vals["r.z"] },
    });
    const mirrorDirty = () => {
      for (let j = 0; j < PATHS.length; j++) if (vals[PATHS[j]] !== baseline[PATHS[j]]) return true;
      return false;
    };
    const mirrorValid = () => {
      const se = schema(mirrorValues());
      for (const kk in se) if (se[kk]) return false;
      for (let j = 0; j < VALIDATOR_PATHS.length; j++) if (verdicts[VALIDATOR_PATHS[j]] != null) return false;
      return true;
    };
    // toPatch() from/to VALUES: exactly the paths whose value differs from the
    // baseline, from = baseline value, to = current draft.
    const mirrorPatch = () => {
      const out = [];
      for (let j = 0; j < PATHS.length; j++) {
        const p = PATHS[j];
        if (vals[p] !== baseline[p]) out.push({ path: p, from: baseline[p], to: vals[p] });
      }
      out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
      return out;
    };

    // Independent mirror of reinitialize(next, policy). PHASE 2 pre-scan may throw
    // (throwing policy); it mutates NOTHING before that, so a throw leaves the
    // oracle untouched. Returns nothing; propagates a policy throw to the caller.
    const mirrorMerge = (next, policyFn) => {
      const verdictArr = new Array(PATHS.length);
      for (let j = 0; j < PATHS.length; j++) {
        const p = PATHS[j];
        const ni = nextLeaf(next, p);
        if (vals[p] === baseline[p]) { verdictArr[j] = 0; continue; } // not overlaid -> ADOPT
        const d = vals[p];
        // FORCED ECHO short-circuits the policy (Object.is); only === true is ECHO.
        verdictArr[j] = (Object.is(ni, d) || policyFn(ni, d) === true) ? 1 : 2; // ECHO : CONFLICT
      }
      for (let j = 0; j < PATHS.length; j++) {
        const p = PATHS[j];
        const ni = nextLeaf(next, p);
        baseline[p] = ni;                          // reseed baseline ALWAYS (every row)
        const v = verdictArr[j];
        if (v === 0 || v === 1) { vals[p] = ni; touched.delete(p); } // ADOPT/ECHO adopt + clear touched
        // CONFLICT (2): vals kept (masks ni), touched unchanged.
      }
      recomputeAll();
    };

    for (let i = 0; i < STEPS; i++) {
      const op = prng() % OP_COUNT;
      if (op === 0) { // set
        const path = PATHS[prng() % PATHS.length];
        const value = prng();
        form.field(path).set(value);
        vals[path] = value;
        if (!drop) recompute(path); // "drop" leaves the cached verdict stale
      } else if (op === 1) { // blur (no value change; marks touched)
        const path = PATHS[prng() % PATHS.length];
        form.field(path).blur();
        touched.add(path);
      } else if (op === 2) { // reset (revert overlays + re-seed + clear touched)
        form.reset();
        for (let j = 0; j < PATHS.length; j++) vals[PATHS[j]] = baseline[PATHS[j]];
        touched.clear();
        recomputeAll();
      } else if (op === 3) { // setValues of 2 random fields
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
      } else if (op === 5) { // commit: fold overlays into the baseline, clear them
        form.commit();
        for (let j = 0; j < PATHS.length; j++) baseline[PATHS[j]] = vals[PATHS[j]];
      } else if (op === 6) { // reinitialize (1-arg): replace baseline, drop overlays, clear touched
        const r = prng();
        const next = { a: r, b: r, c: r, d: r, e: r, f: r, p: { x: r }, q: { y: r }, r: { z: r } };
        form.reinitialize(next);
        for (let j = 0; j < PATHS.length; j++) { vals[PATHS[j]] = r; baseline[PATHS[j]] = r; }
        touched.clear();
        recomputeAll();
      } else { // reinitializeMerge (2-arg): merge with a seeded policy
        const r = prng();
        // Some leaves echo the current draft so ECHO fires under is/false too.
        const next = {
          a: (prng() & 1) ? vals.a : r + 1,
          b: (prng() & 1) ? vals.b : r + 2,
          c: (prng() & 1) ? vals.c : r + 3,
          d: (prng() & 1) ? vals.d : r + 4,
          e: (prng() & 1) ? vals.e : r + 5,
          f: (prng() & 1) ? vals.f : r + 6,
          p: { x: (prng() & 1) ? vals["p.x"] : r + 7 },
          q: { y: (prng() & 1) ? vals["q.y"] : r + 8 },
          r: { z: (prng() & 1) ? vals["r.z"] : r + 9 },
        };
        const policyName = POLICY_NAMES[prng() % POLICY_NAMES.length];
        const policyFn = POLICIES[policyName];
        // Mirror first: PHASE 2 may throw; the oracle mutates nothing before that.
        let threwMirror = false;
        try { mirrorMerge(next, policyFn); }
        catch (e) { threwMirror = true; }
        let threwForm = false;
        try { form.reinitialize(next, policyFn); }
        catch (e) { threwForm = true; }
        check(threwForm === threwMirror,
          () => "t5: oracle diverged -- seed " + seed + " step " + i + " op reinitializeMerge policy=" +
            policyName + " (throw mismatch form=" + threwForm + " mirror=" + threwMirror + ")");
      }

      const opName = OP_NAMES[op];
      if (!deepEqual(form.values(), mirrorValues())) {
        die("t5: oracle diverged -- seed " + seed + " step " + i + " op " + opName + " (values)");
      }
      check(form.isDirty() === mirrorDirty(),
        () => "t5: oracle diverged -- seed " + seed + " step " + i + " op " + opName + " (isDirty)");
      check(form.isValid() === mirrorValid(),
        () => "t5: oracle diverged -- seed " + seed + " step " + i + " op " + opName + " (isValid)");
      // per-path dirty() and touched()
      for (let j = 0; j < PATHS.length; j++) {
        const p = PATHS[j];
        check(form.field(p).dirty() === (vals[p] !== baseline[p]),
          () => "t5: oracle diverged -- seed " + seed + " step " + i + " op " + opName + " (dirty path " + p + ") formVal=" + form.field(p).value() + " formDirty=" + form.field(p).dirty() + " mVal=" + vals[p] + " mBase=" + baseline[p]);
        check(form.field(p).touched() === touched.has(p),
          () => "t5: oracle diverged -- seed " + seed + " step " + i + " op " + opName + " (touched path " + p + ")");
      }
      // toPatch() from/to VALUES
      const fp = form.toPatch().slice().sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
      if (!deepEqual(fp, mirrorPatch())) {
        die("t5: oracle diverged -- seed " + seed + " step " + i + " op " + opName + " (toPatch from/to)");
      }
    }

    form.dispose();
  }
}
