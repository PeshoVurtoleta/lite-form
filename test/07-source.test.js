// 07-source.test.js -- opt-in source mode: the projection overlays a LIVE keyed
// source (a @zakkster/lite-store proxy via fromProxy) instead of the detached
// baseline. Dirty is overlay presence: an authoritative source write under an
// un-overlaid field is not an edit; under an overlaid field it stays masked.
// commit() writes drafts through to the store. Source and form share the default
// lite-signal registry (the store owns its reactivity there).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "@zakkster/lite-signal";
import { store, unwrap } from "@zakkster/lite-store";
import { createForm } from "../Form.js";

test("a store-sourced form stages overlays without touching the store", () => {
    const s = store({ name: "Ann", age: 30 });
    const f = createForm({ initialValues: { name: "", age: 0 }, source: s });
    assert.equal(f.field("name").value(), "Ann"); // reads through to the source
    f.field("name").set("Draft");
    assert.equal(f.field("name").value(), "Draft");
    assert.equal(unwrap(s).name, "Ann", "the overlay leaked into the store");
    assert.equal(f.field("name").dirty(), true);
    f.dispose();
});

test("an authoritative write under an un-overlaid field does NOT flip dirty", () => {
    const s = store({ name: "Ann" });
    const f = createForm({ initialValues: { name: "" }, source: s });
    void f.field("name").value(); // warm the slot
    s.name = "Bob"; // authoritative source write
    assert.equal(f.field("name").value(), "Bob");
    assert.equal(f.field("name").dirty(), false, "an authoritative write was mistaken for an edit");
    assert.equal(f.isDirty(), false);
    f.dispose();
});

test("an authoritative write under an OVERLAID field stays masked", () => {
    const s = store({ name: "Ann" });
    const f = createForm({ initialValues: { name: "" }, source: s });
    f.field("name").set("Draft");
    s.name = "Bob"; // authoritative, but the overlay masks it
    assert.equal(f.field("name").value(), "Draft");
    assert.equal(f.field("name").dirty(), true);
    f.dispose();
});

test("commit() lands the draft in the store", () => {
    const s = store({ name: "Ann", age: 30 });
    const f = createForm({ initialValues: { name: "", age: 0 }, source: s });
    f.field("age").set(99);
    f.commit();
    assert.equal(unwrap(s).age, 99, "commit did not write through to the store");
    assert.equal(f.field("age").dirty(), false);
    f.dispose();
});

test("submit reads the committed values from the store", async () => {
    const s = store({ name: "Ann" });
    let submitted = null;
    const f = createForm({
        initialValues: { name: "" },
        source: s,
        onSubmit: (vals) => { submitted = vals; },
    });
    f.field("name").set("Committed");
    f.commit();
    const ok = await f.submit();
    assert.equal(ok, true);
    assert.deepEqual(submitted, { name: "Committed" });
    f.dispose();
});

test("registry-scoped (default mode) binds the projection to config.registry", () => {
    const reg = createRegistry({ maxNodes: 1 << 14, maxLinks: 1 << 16, onCapacityExceeded: "grow" });
    const base = reg.stats().activeNodes;
    const f = createForm({ initialValues: { a: 1 }, registry: reg });
    f.field("a").set(9);
    assert.deepEqual(f.toPatch(), [{ path: "a", from: 1, to: 9 }]);
    f.commit();
    assert.equal(f.isDirty(), false);
    f.dispose();
    assert.equal(reg.stats().activeNodes, base, "projection nodes leaked off config.registry");
});
