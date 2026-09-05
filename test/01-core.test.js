// 01-core.test.js — original validation/lifecycle behaviors that ship Form.js.
// Mirrors the upload verbatim; subsequent files add edge-case + regression tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import { createForm } from "../Form.js";

const required = (v) => (v ? null : "required");
const email = (v) => (!v ? "required" : /@/.test(v) ? null : "invalid email");

test("field value is reactive; props() bridges to inputs", () => {
    const f = createForm({ initialValues: { name: "" } });
    let seen = null; const stop = effect(() => { seen = f.field("name").value(); });
    assert.equal(seen, "");
    f.field("name").set("Zahary"); assert.equal(seen, "Zahary");
    const p = f.field("name").props();
    p.onInput({ target: { value: "Z2" } }); assert.equal(f.field("name").value(), "Z2");
    stop(); f.dispose();
});

test("validation is a cutoff-gated computed — valid typing allocates/propagates nothing", () => {
    const f = createForm({ initialValues: { email: "" }, validators: { email }, validateOn: "change" });
    const fld = f.field("email");
    let renders = 0, err = "init"; const stop = effect(() => { err = fld.error(); renders++; });
    assert.equal(renders, 1);
    fld.set("a");        // still invalid ("invalid email"); shown now (dirty) — one change
    fld.set("ab");       // STILL "invalid email" — same string → cutoff → NO re-render
    fld.set("abc");      // still same
    assert.equal(renders, 2, "error stayed 'invalid email' across keystrokes → one render, not three");
    assert.equal(err, "invalid email");
    fld.set("a@b");      // becomes valid → error flips to null → one render
    assert.equal(renders, 3);
    assert.equal(err, null);
    fld.set("a@bc");     // stays valid (null) → cutoff → NO re-render
    fld.set("a@bcd");
    assert.equal(renders, 3, "valid typing is allocation-free: no further renders");
    stop(); f.dispose();
});

test("validity vs display: submit mode hides errors until submit; isValid is always true validity", () => {
    const f = createForm({ initialValues: { email: "" }, validators: { email }, validateOn: "submit" });
    const fld = f.field("email");
    assert.equal(fld.error(), null, "no error shown before submit (display gated)");
    assert.equal(f.isValid(), false, "...but isValid reflects true validity immediately");
    fld.set("bad");
    assert.equal(fld.error(), null, "still hidden in submit mode");
    f.submit();
    assert.equal(fld.error(), "invalid email", "revealed after submit attempt");
    f.dispose();
});

test("isValid reacts to field changes", () => {
    const f = createForm({ initialValues: { email: "", name: "" }, validators: { email, name: required } });
    let valid = null; const stop = effect(() => { valid = f.isValid(); });
    assert.equal(valid, false);
    f.field("email").set("a@b"); assert.equal(valid, false, "name still empty");
    f.field("name").set("Z");    assert.equal(valid, true);
    f.field("email").set("nope"); assert.equal(valid, false);
    stop(); f.dispose();
});

test("dirty / touched / isDirty", () => {
    const f = createForm({ initialValues: { a: "x" } });
    const fld = f.field("a");
    assert.equal(fld.dirty(), false);
    assert.equal(fld.touched(), false);
    assert.equal(f.isDirty(), false);
    fld.set("y"); assert.equal(fld.dirty(), true); assert.equal(f.isDirty(), true);
    fld.blur(); assert.equal(fld.touched(), true);
    fld.set("x"); assert.equal(fld.dirty(), false, "back to initial → not dirty");
    f.dispose();
});

test("submit: blocks when invalid, runs onSubmit with values when valid, tracks isSubmitting", async () => {
    let received = null, release;
    const gate = new Promise((r) => { release = r; });
    const f = createForm({
        initialValues: { email: "", n: 0 },
        validators: { email },
        onSubmit: async (vals) => { received = vals; await gate; },
    });
    const ok1 = await f.submit();
    assert.equal(ok1, false, "invalid → blocked");
    assert.equal(received, null);
    f.field("email").set("a@b");
    f.field("n").set(42);
    let submitting = null; const stop = effect(() => { submitting = f.isSubmitting(); });
    const p = f.submit();
    assert.equal(submitting, true, "isSubmitting true during async submit");
    release();
    const ok2 = await p;
    assert.equal(ok2, true);
    assert.deepEqual(received, { email: "a@b", n: 42 }, "onSubmit got the values snapshot");
    assert.equal(submitting, false, "isSubmitting false after");
    stop(); f.dispose();
});

test("cross-field validation via ctx.get re-validates dependents", () => {
    const f = createForm({
        initialValues: { pw: "", confirm: "" },
        validators: { confirm: (v, { get }) => (v === get("pw") ? null : "must match") },
        validateOn: "change",
    });
    const c = f.field("confirm");
    let err = "init"; const stop = effect(() => { err = c.error(); });
    f.field("confirm").set("abc"); assert.equal(err, "must match");
    f.field("pw").set("abc");      assert.equal(err, null, "changing pw re-validates confirm");
    stop(); f.dispose();
});

test("reset restores initial values and clears touched/submitAttempted", () => {
    const f = createForm({ initialValues: { a: "x" }, validators: { a: required }, validateOn: "submit" });
    f.field("a").set(""); f.field("a").blur(); f.submit();
    assert.equal(f.field("a").error(), "required");
    f.reset();
    assert.equal(f.field("a").value(), "x");
    assert.equal(f.field("a").touched(), false);
    assert.equal(f.field("a").error(), null, "submitAttempted cleared → errors hidden again");
    f.dispose();
});

test("schema validate() is HOISTED: one run per keystroke regardless of field count", () => {
    const N = 30;
    let schemaRuns = 0;
    const initialValues = {}; for (let i=0;i<N;i++) initialValues["f"+i] = "";
    const f = createForm({
        initialValues,
        validate: (vals) => {                                   // one schema over the whole form (Zod/Yup-shaped)
            schemaRuns++;
            const errs = {};
            for (const k in vals) if (!vals[k]) errs[k] = "required";
            return errs;
        },
        validateOn: "change",
    });
    const stops = [effect(()=>f.isValid())];
    for (let i=0;i<N;i++){ const fld=f.field("f"+i); stops.push(effect(()=>fld.error())); }
    schemaRuns = 0;                                             // reset after subscription pass
    const K = 50;
    for (let k=0;k<K;k++) f.field("f0").set("v"+k);             // type only in f0
    assert.equal(schemaRuns, K, `schema ran ${schemaRuns}× for ${K} keystrokes across ${N} fields — must be ${K}, not ${K*N}`);
    assert.equal(f.field("f0").error(), null, "f0 filled → no error");
    assert.equal(f.isValid(), false, "schema still sees the other 29 empty fields → invalid");
    stops.forEach(s=>s()); f.dispose();
});

test("schema errors flow to isValid and merge with per-field validators", () => {
    const f = createForm({
        initialValues: { email: "", code: "" },
        validators: { email: (v) => (/@/.test(v) ? null : "bad email") },   // per-field
        validate: (vals) => (vals.code === "OK" ? {} : { code: "wrong code" }), // schema
        validateOn: "change",
    });
    let valid=null; const stop=effect(()=>{ valid = f.isValid(); });
    assert.equal(valid, false);
    f.field("email").set("a@b");  assert.equal(valid, false, "schema (code) still failing");
    f.field("code").set("OK");    assert.equal(valid, true, "both per-field + schema satisfied");
    f.field("email").set("nope"); assert.equal(valid, false, "per-field re-breaks it");
    stop(); f.dispose();
});

test("fieldOpts parse/format apply at the props() boundary", () => {
    const f = createForm({
        initialValues: { age: 0 },
        fieldOpts: { age: { parse: Number, format: (v) => "#" + v } },
    });
    const p1 = f.field("age").props();
    p1.onInput({ target: { value: "42" } });                    // raw string → parsed to number
    assert.equal(f.field("age").value(), 42);
    assert.equal(typeof f.field("age").value(), "number");
    const p2 = f.field("age").props();
    assert.equal(p2.value, "#42", "format applied to displayed value");
    f.dispose();
});

test("onSubmit: structural bugs (ReferenceError) re-throw + log; operational errors → submitError", async () => {
    const orig = console.error; const logs = []; console.error = (...a) => logs.push(a);
    try {
        const fa = createForm({ initialValues:{ a:"" }, onSubmit: async () => { return undeclaredThing; } });
        let threw = false;
        try { await fa.submit(); } catch (e) { threw = e instanceof ReferenceError; }
        assert.ok(threw, "ReferenceError propagates, not swallowed");
        assert.ok(logs.length >= 1, "...and is logged to console.error");
        assert.equal(fa.isSubmitting(), false, "isSubmitting reset even on throw");
        assert.equal(fa.submitError(), null, "structural bug NOT stored as submitError");
        fa.dispose();
    } finally { console.error = orig; }

    // fetch network failure is a TypeError → must be captured, NOT treated as a bug
    const fb = createForm({ initialValues:{ a:"" }, onSubmit: async () => { throw new TypeError("Failed to fetch"); } });
    assert.equal(await fb.submit(), false);
    assert.ok(fb.submitError() instanceof TypeError, "fetch-style TypeError captured as submitError");
    fb.dispose();

    const fc = createForm({ initialValues:{ a:"" }, onSubmit: async () => { throw new Error("server 500"); } });
    await fc.submit();
    assert.equal(fc.submitError().message, "server 500", "operational Error → submitError");
    fc.dispose();
});

test("setPath preserves arrays on array-index paths (no corruption)", () => {
    const f = createForm({ initialValues:{ users:[{ name:"Ann" }] } });
    f.field("users.0.name").set("Bob");
    const v = f.values();
    assert.ok(Array.isArray(v.users), "users stays an Array, not overwritten with {}");
    assert.equal(v.users[0].name, "Bob");
    f.dispose();
});
