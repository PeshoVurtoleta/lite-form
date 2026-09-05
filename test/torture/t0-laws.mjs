/**
 * t0 -- identities, idempotence, and the reveal truth table.
 *
 * Cold tier (no measured window). It proves the observable laws a keystroke gate
 * cannot: values() is a fresh faithful snapshot, reset() and dispose() are
 * idempotent, dispose() returns the registry to its pre-createForm baseline, and
 * the display-vs-validity split holds across all three validateOn modes.
 */

import { check, deepEqual, loadForm, withRegistry } from "./harness.mjs";

const CFG = { maxNodes: 1 << 16, maxLinks: 1 << 18, onCapacityExceeded: "grow" };

export async function run() {
  const { createForm } = await loadForm();
  withRegistry(CFG, (reg) => {
    // --- identities + idempotence -------------------------------------------
    const base = reg.stats().activeNodes;
    const initial = { name: "", age: 0, nested: { a: 1 } };
    const form = createForm({ initialValues: initial, registry: reg });

    const v1 = form.values();
    const v2 = form.values();
    check(v1 !== v2, () => "t0: values() returned the same object twice (not a fresh snapshot)");
    check(deepEqual(v1, v2), () => "t0: two values() snapshots differ on a pristine form");
    check(deepEqual(v1, initial), () => "t0: values() does not deep-equal initialValues on a pristine form");

    // reset() twice === reset() once
    form.field("name").set("z");
    form.field("name").blur();
    form.field("age").set(42);
    form.reset();
    const s1 = form.values();
    form.reset();
    const s2 = form.values();
    check(deepEqual(s1, s2), () => "t0: reset() twice differs from reset() once");
    check(deepEqual(s1, initial), () => "t0: reset() did not restore initialValues");

    // dispose() twice is a no-op and returns activeNodes to the pre-createForm baseline
    form.dispose();
    const afterDispose = reg.stats().activeNodes;
    check(afterDispose === base,
      () => "t0: dispose() left " + (afterDispose - base) + " node(s) above the pre-createForm baseline");
    form.dispose(); // second call must not throw or churn
    check(reg.stats().activeNodes === base,
      () => "t0: second dispose() was not a no-op");
  });

  // --- reveal truth table --------------------------------------------------
  // validator always errors, so rawError() is always live and isValid() is
  // always false; only error() (the DISPLAYED error) is reveal-gated.
  const MODES = ["change", "blur", "submit"];
  // expected error() per [mode][state]; states: pristine, dirty, touched, submitAttempted
  const EXPECT = {
    change: { pristine: null, dirty: "err", touched: null, submitAttempted: "err" },
    blur: { pristine: null, dirty: null, touched: "err", submitAttempted: "err" },
    submit: { pristine: null, dirty: null, touched: null, submitAttempted: "err" },
  };

  for (let m = 0; m < MODES.length; m++) {
    const mode = MODES[m];
    const states = ["pristine", "dirty", "touched", "submitAttempted"];
    for (let s = 0; s < states.length; s++) {
      const state = states[s];
      withRegistry(CFG, (reg) => {
        const form = createForm({
          initialValues: { name: "" },
          validators: { name: () => "err" },
          validateOn: mode,
          registry: reg,
        });
        const fld = form.field("name");
        if (state === "dirty") fld.set("x");
        else if (state === "touched") fld.blur();
        else if (state === "submitAttempted") form.submitAttempted.set(true);

        const want = EXPECT[mode][state];
        check(fld.error() === want,
          () => "t0: reveal table mode=" + mode + " state=" + state +
            " error()=" + JSON.stringify(fld.error()) + " expected " + JSON.stringify(want));
        // rawError() is always live regardless of reveal
        check(fld.rawError() === "err",
          () => "t0: rawError() not live for mode=" + mode + " state=" + state);
        // isValid() is unaffected by reveal -- always false while the validator errors
        check(form.isValid() === false,
          () => "t0: isValid() affected by reveal (mode=" + mode + " state=" + state + ")");
        form.dispose();
      });
    }
  }
}
