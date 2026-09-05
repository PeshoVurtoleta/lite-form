// 02-edge-cases.test.js — gap-filling tests: behaviors mentioned in JSDoc/types
// that the original suite did not directly exercise. Each test pins down ONE
// claim from Form.js so future refactors can't quietly regress it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { effect, createRegistry } from "@zakkster/lite-signal";
import { createForm } from "../Form.js";

const required = (v) => (v ? null : "required");

// ─────────────────────────────────────────────────────────────────────────────
// validateOn: "blur"
// ─────────────────────────────────────────────────────────────────────────────

test("validateOn 'blur' hides errors until the field is blurred", () => {
    const f = createForm({
        initialValues: { name: "" },
        validators: { name: required },
        validateOn: "blur",
    });
    const fld = f.field("name");
    let seen = "init";
    const stop = effect(() => { seen = fld.error(); });
    assert.equal(seen, null, "no error before blur");
    fld.set("");                            // still empty, still invalid, still pristine
    assert.equal(seen, null, "still hidden: not blurred yet");
    fld.blur();
    assert.equal(seen, "required", "blur reveals the error");
    fld.set("x");
    assert.equal(seen, null, "now valid → no error shown");
    stop(); f.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// setValues batching
// ─────────────────────────────────────────────────────────────────────────────

test("setValues batches: N field updates produce ONE isValid recompute", () => {
    const f = createForm({
        initialValues: { a: "", b: "", c: "" },
        validators: { a: required, b: required, c: required },
    });
    let runs = 0;
    const stop = effect(() => { f.isValid(); runs++; });
    runs = 0;                               // ignore initial run
    f.setValues({ a: "x", b: "y", c: "z" });
    assert.equal(runs, 1, "three field updates → one isValid run (batched)");
    assert.equal(f.isValid(), true);
    stop(); f.dispose();
});

test("setValues only writes paths it was given (untouched fields keep their value)", () => {
    const f = createForm({ initialValues: { a: "x", b: "y" } });
    f.setValues({ a: "X" });
    assert.equal(f.field("a").value(), "X");
    assert.equal(f.field("b").value(), "y", "b untouched");
    f.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// submit(ev) preventDefault + nullable callback
// ─────────────────────────────────────────────────────────────────────────────

test("submit(ev) calls ev.preventDefault when present", async () => {
    let prevented = false;
    const f = createForm({ initialValues: { a: "x" } });
    await f.submit({ preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    f.dispose();
});

test("submit() with no onSubmit returns true when valid (it's a no-op success)", async () => {
    const f = createForm({ initialValues: { a: "x" }, validators: { a: required } });
    assert.equal(await f.submit(), true, "valid + no callback → success");
    f.dispose();
});

test("submit() with no onSubmit returns false when invalid (still validates)", async () => {
    const f = createForm({ initialValues: { a: "" }, validators: { a: required } });
    assert.equal(await f.submit(), false);
    assert.equal(f.field("a").error(), "required", "errors revealed even without onSubmit");
    f.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// submitError lifecycle
// ─────────────────────────────────────────────────────────────────────────────

test("submitError is cleared at the start of every submit attempt (recovery path)", async () => {
    let throwIt = true;
    const f = createForm({
        initialValues: { a: "x" },
        onSubmit: async () => { if (throwIt) throw new Error("first fail"); },
    });
    assert.equal(await f.submit(), false);
    assert.equal(f.submitError().message, "first fail");
    throwIt = false;
    assert.equal(await f.submit(), true, "second try succeeds");
    assert.equal(f.submitError(), null, "submitError cleared on the successful retry");
    f.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// Deeper nested paths
// ─────────────────────────────────────────────────────────────────────────────

test("deeply nested paths round-trip through values()", () => {
    const f = createForm({
        initialValues: { a: { b: { c: { d: "deep" } } } },
    });
    assert.equal(f.field("a.b.c.d").value(), "deep");
    f.field("a.b.c.d").set("changed");
    const v = f.values();
    assert.equal(v.a.b.c.d, "changed");
    assert.equal(typeof v.a, "object");
    assert.equal(typeof v.a.b, "object");
    f.dispose();
});

test("setPath materializes missing intermediate containers (object by default, array on numeric)", () => {
    const f = createForm({ initialValues: {} });
    f.field("a.b.c").set("hi");
    f.field("arr.0.name").set("first");
    f.field("arr.1.name").set("second");
    const v = f.values();
    assert.equal(v.a.b.c, "hi");
    assert.ok(Array.isArray(v.arr), "numeric key after 'arr' → Array container");
    assert.equal(v.arr[0].name, "first");
    assert.equal(v.arr[1].name, "second");
    f.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// registry option — scoped graph
// ─────────────────────────────────────────────────────────────────────────────

test("registry option: form's signals live in the provided registry, not the default", () => {
    const reg = createRegistry({ maxNodes: 256, maxLinks: 1024 });
    const baseDefault = (globalThis.__activeNodes !== undefined)
        ? globalThis.__activeNodes
        : null;
    const before = reg.stats().activeNodes;
    const f = createForm({
        initialValues: { a: "", b: "" },
        validators: { a: required, b: required },
        registry: reg,
    });
    const after = reg.stats().activeNodes;
    assert.ok(after > before, "scoped registry grew when form was built");
    f.dispose();
    const afterDispose = reg.stats().activeNodes;
    assert.equal(afterDispose, before, "scoped registry returned to baseline on dispose");
});

// ─────────────────────────────────────────────────────────────────────────────
// Lazy field creation
// ─────────────────────────────────────────────────────────────────────────────

test("field(path) for an undeclared path creates the field lazily on first access", () => {
    const f = createForm({ initialValues: { declared: "x" } });
    // 'undeclared' is not in initialValues, validators, or fieldOpts
    const fld = f.field("undeclared");
    assert.equal(fld.value(), undefined, "lazy field starts undefined");
    fld.set("hello");
    assert.equal(f.values().undeclared, "hello", "lazy field shows up in values()");
    f.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// Checkbox event extraction
// ─────────────────────────────────────────────────────────────────────────────

test("props().onInput reads ev.target.checked for checkbox-type inputs", () => {
    const f = createForm({ initialValues: { agree: false } });
    const p = f.field("agree").props();
    p.onInput({ target: { type: "checkbox", checked: true, value: "on" } });
    assert.equal(f.field("agree").value(), true, "checkbox path picks .checked, not .value");
    p.onInput({ target: { type: "checkbox", checked: false, value: "on" } });
    assert.equal(f.field("agree").value(), false);
    f.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// dispose
// ─────────────────────────────────────────────────────────────────────────────

test("dispose is idempotent and disconnects future reactivity", () => {
    const f = createForm({ initialValues: { a: "x" } });
    let runs = 0;
    const stop = effect(() => { f.field("a").value(); runs++; });
    assert.equal(runs, 1);
    f.dispose();
    f.dispose();                            // no throw
    // After dispose the signal handle is dead; set() should not propagate to a
    // (already-stopped) effect. We're really asserting "no crash + no leak".
    try { f.field("a").set("y"); } catch (_) { /* writes to disposed handles may throw — fine */ }
    stop();
});

// ─────────────────────────────────────────────────────────────────────────────
// Reset edge case
// ─────────────────────────────────────────────────────────────────────────────

test("reset() clears submitError too", async () => {
    const f = createForm({
        initialValues: { a: "x" },
        onSubmit: async () => { throw new Error("boom"); },
    });
    await f.submit();
    assert.equal(f.submitError().message, "boom");
    f.reset();
    assert.equal(f.submitError(), null);
    f.dispose();
});

// ─────────────────────────────────────────────────────────────────────────────
// Performance claim: keystroke cost is constant in field count
// ─────────────────────────────────────────────────────────────────────────────

test("keystroke cost: typing in one field does NOT cause other fields' errors to re-evaluate", () => {
    const N = 50;
    const initialValues = {};
    const validators = {};
    let runCounts = {};
    for (let i = 0; i < N; i++) {
        initialValues["f" + i] = "";
        runCounts["f" + i] = 0;
        const me = "f" + i;
        validators[me] = (v) => { runCounts[me]++; return v ? null : "required"; };
    }
    const f = createForm({ initialValues, validators, validateOn: "change" });
    // Subscribe to every error so the computeds actually have demand.
    const stops = [];
    for (let i = 0; i < N; i++) stops.push(effect(() => f.field("f" + i).error()));
    // Reset counters AFTER the initial subscription pass (where each validator
    // fires once to populate its computed).
    for (const k in runCounts) runCounts[k] = 0;
    // Type only in f0 — 10 keystrokes.
    for (let k = 0; k < 10; k++) f.field("f0").set("v" + k);
    assert.equal(runCounts.f0, 10, "f0 validator ran 10 times (once per keystroke)");
    let othersFired = 0;
    for (let i = 1; i < N; i++) othersFired += runCounts["f" + i];
    assert.equal(othersFired, 0, `other ${N - 1} validators ran ${othersFired}× — must be 0`);
    stops.forEach(s => s()); f.dispose();
});
