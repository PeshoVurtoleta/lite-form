// 05-fail-closed.test.js -- the v1.1.0 "fail closed" contract (LF-02..LF-04).
// initialValues is deep-copied into an unreachable baseline; dirty() is an
// Object.is identity check; non-cloneable values throw a path-named TypeError at
// construction (or at the snapshot boundary for runtime values); lazy fields are
// createRoot-owned and survive an effect re-run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "@zakkster/lite-signal";
import { createForm } from "../Form.js";

const TE = { name: "TypeError" };

// --- LF-02: unreachable baseline --------------------------------------------

test("mutating initialValues after createForm does not change form.values()", () => {
    const iv = { a: "x", nested: { b: 1 } };
    const f = createForm({ initialValues: iv });
    iv.a = "MUTATED";
    iv.nested.b = 999;
    assert.deepEqual(f.values(), { a: "x", nested: { b: 1 } });
    f.dispose();
});

test("mutating a value() array does not reach the caller's initialValues", () => {
    const iv = { tags: ["a"] };
    const f = createForm({ initialValues: iv });
    f.field("tags").value().push("b");
    assert.equal(iv.tags.length, 1, "the caller's array was mutated -- baseline is reachable");
    f.dispose();
});

test("reset() restores a pristine array after an in-place mutation", () => {
    const iv = { tags: ["a"] };
    const f = createForm({ initialValues: iv });
    f.field("tags").value().push("b");
    f.reset();
    assert.equal(f.field("tags").value().length, 1, "reset() did not restore a length-1 array");
    f.dispose();
});

test("an object-leaf field is NOT dirty at construction", () => {
    const f = createForm({ initialValues: { tags: ["a"], meta: { k: 1 } } });
    assert.equal(f.field("tags").dirty(), false);
    assert.equal(f.field("meta").dirty(), false);
    f.dispose();
});

test("in-place mutation does not flip dirty; set(newRef) does", () => {
    const f = createForm({ initialValues: { tags: ["a"] } });
    const arr = f.field("tags").value();
    arr.push("b"); // same reference: Object.is(value(), initialRef) still holds against... no, value !== initialRef only on set
    assert.equal(f.field("tags").dirty(), false, "in-place mutation flipped dirty");
    f.field("tags").set(["a", "b"]); // new reference
    assert.equal(f.field("tags").dirty(), true, "set(newRef) did not flip dirty");
    f.dispose();
});

// --- LF-03: construction-time cloneability whitelist ------------------------

test("a function value in initialValues throws a TypeError naming its path", () => {
    assert.throws(() => createForm({ initialValues: { cb: () => {} } }),
        (e) => e instanceof TypeError && /"cb"/.test(e.message));
});

test("Map/Set/RegExp/TypedArray/class instance/symbol each throw at construction with their path", () => {
    class Foo { constructor() { this.x = 1; } }
    const cases = {
        m: new Map(),
        s: new Set(),
        re: /x/,
        ta: new Uint8Array(4),
        inst: new Foo(),
        sym: Symbol("s"),
    };
    for (const key of Object.keys(cases)) {
        assert.throws(() => createForm({ initialValues: { [key]: cases[key] } }),
            (e) => e instanceof TypeError && e.message.indexOf('"' + key + '"') !== -1,
            "expected a path-named TypeError for " + key);
    }
});

test("Date and nested arrays are accepted and deep-copied (not aliased)", () => {
    const d = new Date(1700000000000);
    const arr = [{ n: 1 }, { n: 2 }];
    const f = createForm({ initialValues: { when: d, rows: arr } });
    const v = f.values();
    assert.deepEqual(v.when, d);
    assert.notEqual(v.when, d, "Date was aliased, not copied");
    assert.deepEqual(v.rows, arr);
    assert.notEqual(v.rows, arr, "array was aliased, not copied");
    assert.notEqual(v.rows[0], arr[0], "array element was aliased, not copied");
    f.dispose();
});

test("initialValues with an own __proto__ key (empty, JSON.parse route) throws", () => {
    assert.throws(() => createForm({ initialValues: JSON.parse('{"__proto__":{}}') }), TE);
});

test("object-branch and array-internal cycles throw TypeError; a shared subtree is accepted", () => {
    const branch = {};
    branch.self = branch;
    assert.throws(() => createForm({ initialValues: { branch } }),
        (e) => e instanceof TypeError && /cycle/.test(e.message));

    const arr = [];
    arr.push(arr);
    assert.throws(() => createForm({ initialValues: { arr } }),
        (e) => e instanceof TypeError && /cycle/.test(e.message));

    const shared = { k: 1 };
    const f = createForm({ initialValues: { left: shared, right: shared } });
    assert.deepEqual(f.values(), { left: { k: 1 }, right: { k: 1 } });
    assert.notEqual(f.values().left, f.values().right, "shared subtree was not copied independently");
    f.dispose();
});

// --- snapshot boundary ------------------------------------------------------

test("setting a non-cloneable runtime value then values() throws a TypeError naming the path", () => {
    const f = createForm({ initialValues: { x: "" } });
    f.field("x").set(() => {});
    assert.throws(() => f.values(),
        (e) => e instanceof TypeError && /"x"/.test(e.message));
    f.dispose();
});

// --- LF-04: createRoot-owned lazy fields ------------------------------------

test("a lazy field created inside a re-running effect survives re-trigger", () => {
    const reg = createRegistry({ maxNodes: 1 << 14, maxLinks: 1 << 16, onCapacityExceeded: "grow" });
    const form = createForm({ initialValues: { keep: 1 }, registry: reg });
    const trig = reg.signal(0);
    reg.effect(() => { void trig(); const rec = form.field("lz"); void rec.value(); });
    const before = reg.stats().activeNodes;
    trig.set(1);
    const after = reg.stats().activeNodes;
    assert.ok(after >= before, "activeNodes dropped after an effect re-run (" + after + " < " + before + ")");
    form.field("lz").set("v");
    assert.equal(form.field("lz").value(), "v", "lazy field did not read back its set value");
    form.dispose();
});
