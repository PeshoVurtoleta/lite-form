// 04-hostile-paths.test.js -- v1.0.1 security hotfix regressions (LF-01).
// Prototype-chain path segments (__proto__, constructor, prototype) are
// rejected with a TypeError at every boundary a path can enter the form;
// Object.prototype must remain clean after any rejected call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createForm } from "../Form.js";

const HOSTILE = { name: "TypeError", message: /hostile path segment/ };

test("setValues with a __proto__ path throws; Object.prototype stays clean (the LF-01 repro)", () => {
    const f = createForm({ initialValues: { a: 1 } });
    assert.throws(() => f.setValues({ "__proto__.polluted": "PWNED" }), HOSTILE);
    f.values(); // the original pollution trigger -- must be inert now
    assert.equal(({}).polluted, undefined, "no own/inherited 'polluted' on a fresh object");
    assert.equal(Object.prototype.polluted, undefined);
    assert.deepEqual(f.values(), { a: 1 }, "rejected path was never cached as a field");
    f.dispose();
});

test("field() rejects every hostile segment, flat and dotted, at any position", () => {
    const f = createForm({ initialValues: { a: 1 } });
    for (const p of [
        "__proto__", "constructor", "prototype",
        "__proto__.x", "a.__proto__", "a.__proto__.b",
        "constructor.prototype.x", "a.prototype",
    ]) assert.throws(() => f.field(p), HOSTILE, p);
    f.dispose();
});

test("hostile validators/fieldOpts keys are rejected at createForm, not later", () => {
    assert.throws(() => createForm({ validators: { "__proto__.x": () => null } }), HOSTILE);
    assert.throws(() => createForm({ fieldOpts: { "constructor.prototype.x": {} } }), HOSTILE);
});

test("initialValues carrying an own __proto__ key (JSON.parse route) is rejected at createForm", () => {
    assert.throws(() => createForm({ initialValues: JSON.parse('{"__proto__":{"x":1}}') }), HOSTILE);
});

test("rejection leaves no partial state: later legit use of the same form works", () => {
    const f = createForm({ initialValues: { user: { name: "Z" } } });
    assert.throws(() => f.setValues({ "user.__proto__.x": 1 }), HOSTILE);
    f.setValues({ "user.name": "Z2" });
    assert.equal(f.field("user.name").value(), "Z2");
    assert.deepEqual(f.values(), { user: { name: "Z2" } });
    f.dispose();
});

test("near-miss names are NOT rejected: only exact segment matches are hostile", () => {
    const f = createForm({ initialValues: { proto: 1, "my": { prototype2: 2 } } });
    assert.equal(f.field("proto").value(), 1);
    assert.equal(f.field("my.prototype2").value(), 2);
    f.field("constructors.count").set(3); // lazy dotted path, legit segments
    assert.equal(f.field("constructors.count").value(), 3);
    f.dispose();
});

test("numeric segments and deep dotted round-trips still work after the guard", () => {
    const f = createForm({ initialValues: { list: [{ name: "a" }] } });
    f.field("list.0.name").set("b");
    assert.deepEqual(f.values().list, [{ name: "b" }]);
    f.field("list.1.name").set("c");
    assert.equal(f.values().list[1].name, "c");
    f.dispose();
});

test("schema mode readValues cannot be steered into the prototype chain", () => {
    // validate() forces the tracked readValues()/setPath walk every keystroke;
    // a hostile path can never reach it because makeField is the sole cache site.
    const f = createForm({
        initialValues: { a: "" },
        validate: (v) => (v.a ? {} : { a: "required" }),
    });
    assert.throws(() => f.field("a.__proto__.x"), HOSTILE);
    f.field("a").set("ok"); // runs the hoisted schema over all cached fields
    assert.equal(f.isValid(), true);
    assert.equal(Object.prototype.x, undefined);
    f.dispose();
});
