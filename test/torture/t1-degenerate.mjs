/**
 * t1 -- degenerate shapes and the registered-failing ledger.
 *
 * LF-01 is a PASSING guard witness: prototype-pollution paths throw and cache
 * nothing. LF-02..LF-04 are REGISTERED-FAILING -- each asserts the CURRENT
 * (broken) behaviour so the bug is pinned in the gate; S1 flips each check when
 * the fix lands. A registered-failing test that starts passing silently is how a
 * fix goes unmarked, so these are explicit.
 */

import { createForm } from "../../Form.js";
import { check, withRegistry } from "./harness.mjs";

const CFG = { maxNodes: 1 << 16, maxLinks: 1 << 18, onCapacityExceeded: "grow" };

function threw(fn) {
  try { fn(); return null; } catch (err) { return err; }
}

export async function run() {
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

  // --- LF-02: shared-array initialValues alias (REGISTERED-FAILING) ---------
  withRegistry(CFG, (reg) => {
    const iv = { tags: ["a"] };
    const form = createForm({ initialValues: iv, registry: reg });
    form.field("tags").value().push("b"); // mutates the aliased initial array
    // LF-02 REGISTERED-FAILING -- S1 flips this check.
    check(form.field("tags").dirty() === false,
      () => "t1 LF-02: dirty() became true -- the shared-array alias may be fixed; flip this check");
    check(iv.tags.length === 2,
      () => "t1 LF-02: caller's initialValues array was NOT mutated -- alias may be fixed; flip this check");
    form.reset();
    check(form.field("tags").value().length === 2,
      () => "t1 LF-02: reset() restored a pristine array -- alias may be fixed; flip this check");
    form.dispose();
  });

  // --- LF-03: non-cloneable initialValues (REGISTERED-FAILING) --------------
  withRegistry(CFG, (reg) => {
    const form = createForm({ initialValues: { cb: () => {} }, registry: reg });
    const e = threw(() => form.values());
    // LF-03 REGISTERED-FAILING -- S1 flips this check.
    check(e !== null && e.name === "DataCloneError",
      () => "t1 LF-03: values() no longer throws DataCloneError on a function value (got " + (e && e.name) + ") -- flip this check");
    form.dispose();
  });

  // --- LF-04: lazy field() inside an effect self-destructs (REGISTERED-FAILING)
  withRegistry(CFG, (reg) => {
    const form = createForm({ initialValues: { keep: 1 }, registry: reg });
    const trig = reg.signal(0);
    let rec;
    reg.effect(() => { void trig(); rec = form.field("lazyx"); void rec.value(); });
    const before = reg.stats().activeNodes;
    trig.set(1);
    const after = reg.stats().activeNodes;
    // LF-04 REGISTERED-FAILING -- S1 flips this check.
    check(after < before,
      () => "t1 LF-04: activeNodes did not drop after re-running the effect (" + after + " >= " + before + ") -- lazy alloc may be detached now; flip this check");
    check(form.field("lazyx").value() === undefined,
      () => "t1 LF-04: field('lazyx') is no longer a zombie (value() !== undefined) -- may be fixed; flip this check");
    form.dispose();
  });
}
