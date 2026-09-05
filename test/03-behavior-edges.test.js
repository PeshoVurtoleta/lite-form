// 03-behavior-edges.test.js — behaviors at the edges of lite-form's surface.
//
// These tests document CURRENT behavior so future refactors don't silently
// change it. A couple of them ((1) submit dedupe, (2) validator throws) are
// gaps worth filling in v1.1+; we lock down the status quo here. The rest
// document subtle properties that should hold long-term — particularly (3),
// which is lite-form's elegant alternative to a `setFieldError` API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { effect, signal } from "@zakkster/lite-signal";
import { createForm } from "../Form.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1) Concurrent submit calls fire onSubmit twice — they are NOT deduped
// ─────────────────────────────────────────────────────────────────────────────
// If submit() is called while a previous submit is still awaiting onSubmit,
// the second call goes through too. Both run concurrently against the same
// values snapshot. This is intentional simplicity: no internal queue, no
// "in-flight" lock. Users who care should disable their submit button via
// the reactive `isSubmitting` signal. If a future version adds dedupe, this
// test will fail and force the decision to be deliberate.
test("submit() while already submitting is NOT deduped — onSubmit fires twice", async () => {
    let calls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const f = createForm({
        initialValues: { x: "ok" },
        validators: { x: (v) => (v ? null : "required") },
        onSubmit: async () => { calls++; await gate; },
    });

    const p1 = f.submit();
    const p2 = f.submit();      // fires before p1 resolves
    assert.equal(calls, 2, "lite-form does not currently dedupe concurrent submits");

    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1, true);
    assert.equal(r2, true);
    f.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) A validator that THROWS propagates to error() and isValid() reads
// ─────────────────────────────────────────────────────────────────────────────
// Validators should return a message string or null/false/undefined for valid.
// If a validator throws an exception instead, the throw propagates up through
// rawError → error → any effect/read that consumes it. Pristine fields are
// safe (the reveal gate short-circuits before reading rawError), but the
// moment the field becomes dirty/touched the next reader gets the exception.
// Wrap your validator in try/catch if it does anything that can throw
// (e.g. JSON.parse on a path that might not be JSON).
test("a throwing validator propagates through error() once the field is revealed", () => {
    const f = createForm({
        initialValues: { x: "" },
        validators: { x: () => { throw new Error("validator bug"); } },
        validateOn: "change",
    });

    // Pristine — reveal=false in error() → rawError never read → no throw.
    assert.equal(f.field("x").error(), null, "pristine field doesn't invoke its validator");

    // Make it dirty; now error() must read rawError(), which calls the
    // throwing validator.
    f.field("x").set("anything");
    assert.throws(() => f.field("x").error(), /validator bug/);

    // isValid() reads rawError() unconditionally (not reveal-gated) — also
    // throws once the validator has been invalidated by the value change.
    assert.throws(() => f.isValid(), /validator bug/);

    f.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) Validators can close over external signals — re-validate transparently
// ─────────────────────────────────────────────────────────────────────────────
// lite-form has no `setFieldError(path, message)` API. It doesn't need one:
// a validator runs inside a `computed`, so any signal it reads is tracked.
// Surfacing a server-side error ("username already taken") is therefore a
// one-liner: hold the server error in a signal, read it from the validator.
// Updating the signal re-validates the field automatically. This test pins
// down that behavior so it can be documented as the canonical pattern.
test("validators can read external lite-signals; they re-validate when those signals change", () => {
    const serverErr = signal(null);   // "username taken" | null
    const f = createForm({
        initialValues: { name: "" },
        validators: {
            name: (v) => {
                if (!v) return "required";
                return serverErr() || null;       // tracked read
            },
        },
        validateOn: "change",
    });

    let seen = "init";
    const stop = effect(() => { seen = f.field("name").error(); });

    f.field("name").set("alice");
    assert.equal(seen, null, "locally valid, no server error yet");

    serverErr.set("already taken");
    assert.equal(seen, "already taken", "external signal flip caused field re-validation");

    serverErr.set(null);
    assert.equal(seen, null, "clearing the external signal clears the field error");

    stop(); f.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) dispose() during a pending submit returns synchronously
// ─────────────────────────────────────────────────────────────────────────────
// In SPA scenarios a form may be disposed (route change, modal close) while
// its onSubmit is still awaiting the network. Two contracts to lock in:
//   • dispose() must return synchronously, not block on the pending submit.
//   • When onSubmit eventually resolves, the continuation's writes to the
//     now-disposed isSubmitting / submitError signals must be silent no-ops
//     so the pending promise resolves cleanly instead of crashing the page.
test("dispose() during a pending submit returns synchronously; the pending promise resolves cleanly", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const f = createForm({
        initialValues: { x: "ok" },
        onSubmit: async () => { await gate; return "done"; },
    });

    const pending = f.submit();
    let resolved = false;
    let rejection = null;
    pending.then(() => { resolved = true; }, (e) => { resolved = true; rejection = e; });

    f.dispose();   // sync — must return before the gate is released
    assert.equal(resolved, false, "dispose() returned without awaiting the submit");

    release();
    // Microtask + tick so the awaited promise's continuation runs.
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(resolved, true, "pending submit resolves after release");
    assert.equal(rejection, null, "writes to disposed signals must be no-ops, not throws");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5) Form-level schema returning falsy values coerces to "no errors"
// ─────────────────────────────────────────────────────────────────────────────
// Schema adapter authors sometimes return `null` / `undefined` / `false` for
// the "everything's valid" case. Form.js does `validate(...) || EMPTY` to
// coerce these uniformly; this test pins that down so the contract for
// adapter authors stays stable.
test("validate() returning null / undefined / false coerces to no errors", () => {
    for (const sentinel of [null, undefined, false]) {
        const f = createForm({
            initialValues: { x: "" },
            validate: () => sentinel,
            validateOn: "change",
        });
        f.field("x").set("v");
        assert.equal(
            f.field("x").error(), null,
            `validate() returning ${sentinel} should yield no error`,
        );
        assert.equal(
            f.isValid(), true,
            `validate() returning ${sentinel} should leave isValid true`,
        );
        f.dispose();
    }
});
