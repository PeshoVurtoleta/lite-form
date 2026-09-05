/**
 * t1 -- degenerate shapes and the fail-closed ledger.
 *
 * LF-01 is a PASSING guard witness: prototype-pollution paths throw and cache
 * nothing. LF-02..LF-04 were the S0 registered-failing bugs; S1 fixed each, so
 * every check below now ENFORCES the fixed behaviour:
 *   LF-02 unreachable baseline -- object leaves are not dirty at construction, a
 *         value() array cannot reach the caller's initialValues, reset() restores.
 *   LF-03 construction-time whitelist -- a non-cloneable initialValues throws a
 *         TypeError at createForm(), never a late DataCloneError.
 *   LF-04 createRoot-owned lazy fields -- a field allocated inside a re-running
 *         effect survives that effect's next run.
 *
 * t9's realias / reproto controls patch Form.js to reintroduce LF-02 / LF-03 and
 * assert this tier dies again with the matching "t1 LF-0x" marker, so the marker
 * prefixes here are load-bearing.
 */

import { check, loadForm, withRegistry } from "./harness.mjs";

const CFG = { maxNodes: 1 << 16, maxLinks: 1 << 18, onCapacityExceeded: "grow" };

function threw(fn) {
  try { fn(); return null; } catch (err) { return err; }
}

export async function run() {
  const { createForm } = await loadForm();

  // --- LF-01: prototype-pollution guard (PASSING witness) ------------------
  withRegistry(CFG, (reg) => {
    const form = createForm({ initialValues: { name: "" }, registry: reg });

    const e1 = threw(() => form.setValues({ "__proto__.polluted": "PWNED" }));
    check(e1 instanceof TypeError,
      () => "t1 LF-01: setValues(__proto__.polluted) did not throw TypeError (got " + e1 + ")");
    check(({}).polluted === undefined,
      () => "t1 LF-01: Object.prototype was polluted");

    check(threw(() => form.field("__proto__")) instanceof TypeError,
      () => "t1 LF-01: field('__proto__') did not throw");
    check(threw(() => form.field("a.constructor.b")) instanceof TypeError,
      () => "t1 LF-01: field('a.constructor.b') did not throw");

    // hostile validators key rejected at createForm, not later
    check(threw(() => createForm({ validators: { "x.__proto__": () => null }, registry: reg })) instanceof TypeError,
      () => "t1 LF-01: hostile validators key not rejected at createForm");

    // nothing cached after a throw: the form is still usable
    check(form.field("name").value() === "",
      () => "t1 LF-01: form unusable after a rejected hostile path (cached partial state)");
    form.dispose();
  });

  // --- LF-02: unreachable baseline (ENFORCED) ------------------------------
  withRegistry(CFG, (reg) => {
    const iv = { tags: ["a"] };
    const form = createForm({ initialValues: iv, registry: reg });
    form.field("tags").value().push("b"); // must NOT reach the baseline or the caller's array
    check(form.field("tags").dirty() === false,
      () => "t1 LF-02: object-leaf field is dirty at construction");
    check(iv.tags.length === 1,
      () => "t1 LF-02: the caller's initialValues array was mutated through field.value() -- the baseline is reachable");
    form.reset();
    check(form.field("tags").value().length === 1,
      () => "t1 LF-02: reset() did not restore a pristine array");
    form.dispose();
  });

  // --- LF-03: non-cloneable initialValues throws at construction (ENFORCED) --
  withRegistry(CFG, (reg) => {
    const e = threw(() => createForm({ initialValues: { cb: () => {} }, registry: reg }));
    check(e instanceof TypeError,
      () => "t1 LF-03: non-cloneable initialValues did not throw TypeError at createForm (got " + (e && e.name) + ")");

    // an empty own __proto__ key (JSON.parse route) forms no leaf but must still throw
    const e2 = threw(() => createForm({ initialValues: JSON.parse('{"__proto__":{}}'), registry: reg }));
    check(e2 instanceof TypeError,
      () => "t1 LF-03: empty own __proto__ key was not rejected at createForm (got " + (e2 && e2.name) + ")");

    // the cloneability whitelist rejects a Map at construction, path-named
    const e3 = threw(() => createForm({ initialValues: { m: new Map() }, registry: reg }));
    check(e3 instanceof TypeError && e3.message.indexOf('"m"') !== -1,
      () => "t1 LF-03: a Map value was not rejected with a path-named TypeError at createForm (got " + (e3 && e3.message) + ")");
  });

  // --- LF-04: lazy field() inside an effect is createRoot-owned (ENFORCED) --
  withRegistry(CFG, (reg) => {
    const form = createForm({ initialValues: { keep: 1 }, registry: reg });
    const trig = reg.signal(0);
    let rec;
    reg.effect(() => { void trig(); rec = form.field("lazyx"); void rec.value(); });
    const before = reg.stats().activeNodes;
    trig.set(1);
    const after = reg.stats().activeNodes;
    check(after >= before,
      () => "t1 LF-04: activeNodes dropped after an effect re-run (" + after + " < " + before + ") -- the lazy field was owned by the effect");
    form.field("lazyx").set("kept");
    check(form.field("lazyx").value() === "kept",
      () => "t1 LF-04: lazy field lost its value after the effect re-ran -- it was a zombie owned by the effect");
    form.dispose();
  });
}
