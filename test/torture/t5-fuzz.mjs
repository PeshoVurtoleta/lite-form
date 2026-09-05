/**
 * t5 -- differential fuzz. A form of 6 flat + 3 dotted fields, three per-field
 * validators with value-dependent verdicts, and one cross-field schema rule, is
 * driven by a seeded op stream (4 seeds x 800 steps) against an independent
 * plain-object oracle. After EVERY step the form's values(), isDirty(), and
 * isValid() must equal the oracle's. Any divergence dies with a replayable seed.
 *
 * Control: FORM_TORTURE_BREAK=drop skips the oracle's per-field verdict
 * recompute after a set, so its cached validity goes stale and isValid diverges
 * -- proving the invariant check can actually catch a wrong verdict.
 */

import { BREAK, SEED, check, deepEqual, die, loadForm, makePrng } from "./harness.mjs";

const SEEDS = 4;
const STEPS = 800;
const PATHS = ["a", "b", "c", "d", "e", "f", "p.x", "q.y", "r.z"];
const OP_NAMES = ["set", "blur", "reset", "setValues", "submit"];

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

export async function run() {
  const { createForm } = await loadForm();
  const drop = BREAK === "drop";

  for (let k = 0; k < SEEDS; k++) {
    const seed = (SEED + k) >>> 0;
    const prng = makePrng(seed);

    const { createRegistry } = await import("@zakkster/lite-signal");
    const reg = createRegistry({ maxNodes: 1 << 14, maxLinks: 1 << 16, onCapacityExceeded: "grow" });
    const form = createForm({ initialValues: freshInitial(), validators, validate: schema, registry: reg });

    // --- the oracle -----------------------------------------------------------
    const vals = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, "p.x": 0, "q.y": 0, "r.z": 0 };
    const baseline = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, "p.x": 0, "q.y": 0, "r.z": 0 };
    const verdicts = { a: null, c: null, "q.y": null };

    const recompute = (path) => {
      const v = validators[path];
      if (v) verdicts[path] = normErr(v(vals[path]));
    };
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

    for (let i = 0; i < STEPS; i++) {
      const op = prng() % 5;
      if (op === 0) { // set
        const path = PATHS[prng() % PATHS.length];
        const value = prng();
        form.field(path).set(value);
        vals[path] = value;
        if (!drop) recompute(path); // "drop" leaves the cached verdict stale
      } else if (op === 1) { // blur (no value change)
        form.field(PATHS[prng() % PATHS.length]).blur();
      } else if (op === 2) { // reset
        form.reset();
        for (let j = 0; j < PATHS.length; j++) vals[PATHS[j]] = baseline[PATHS[j]];
        for (let j = 0; j < VALIDATOR_PATHS.length; j++) recompute(VALIDATOR_PATHS[j]);
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
      } else { // submit (no onSubmit): validates, changes no values
        await form.submit();
      }

      const opName = OP_NAMES[op];
      if (!deepEqual(form.values(), mirrorValues())) {
        die("t5: oracle diverged -- seed " + seed + " step " + i + " op " + opName + " (values)");
      }
      check(form.isDirty() === mirrorDirty(),
        () => "t5: oracle diverged -- seed " + seed + " step " + i + " op " + opName + " (isDirty)");
      check(form.isValid() === mirrorValid(),
        () => "t5: oracle diverged -- seed " + seed + " step " + i + " op " + opName + " (isValid)");
    }

    form.dispose();
  }
}
