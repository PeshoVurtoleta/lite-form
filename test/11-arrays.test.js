// 11-arrays.test.js -- S4 field arrays with preserved identity (v1.4.0). Keyed
// rows on the S2 engine: overlay keys "<arrayPath>.<rowKey>.<sub>", a form-owned
// keyed baseline, no new peer. Covers the config/P2 doors (fail closed), row
// identity that travels with the key across a move, the D2 patch shapes, D3
// commit/reset structure semantics, D4 reinitialize, ctx.local cross-field, the
// D6 schema index->key translation (incl. after a move), and the D5 row-teardown
// discipline (a remove() mid-async settlement is a no-op with no unhandledRejection).
// Registry-scoped where an activeNodes bound is cheap (the test/09 style).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "@zakkster/lite-signal";
import { createForm } from "../Form.js";

const TE = { name: "TypeError" };
const tick = () => new Promise((r) => setTimeout(r));
const byId = (item) => item.id;
const seedForm = (extra) => createForm(Object.assign({
    initialValues: { rows: [{ id: "a", name: "Ann" }, { id: "b", name: "Bob" }] },
    arrays: { rows: { key: byId } },
}, extra));

// A validator whose every call parks a deferred; resolve/reject q[i] by hand.
function deferredLane() {
    const q = [];
    const validator = (value) => new Promise((resolve, reject) => q.push({ value, resolve, reject }));
    return { validator, q };
}

// --- (a) config doors [4] ---------------------------------------------------

test("config door: a declared array whose initial value is not an array throws", () => {
    assert.throws(() => createForm({
        initialValues: { rows: { not: "an array" } },
        arrays: { rows: { key: byId } },
    }), (e) => e instanceof TypeError && /must resolve to an Array/.test(e.message));
});

test("config door: source mode + declared arrays throws at construction (P7 -- no keyed baseline)", () => {
    assert.throws(() => createForm({
        source: { rows: [{ id: "a" }] },
        arrays: { rows: { key: byId } },
    }), (e) => e instanceof TypeError && /default-mode only/.test(e.message));
});

test("config door: an unknown key in an array config block throws (fail closed)", () => {
    assert.throws(() => createForm({
        initialValues: { rows: [] },
        arrays: { rows: { key: byId, bogus: 1 } },
    }), (e) => e instanceof TypeError && /unknown key "bogus"/.test(e.message));
});

test("config door: key() returning empty / dotted / hostile is rejected", () => {
    assert.throws(() => createForm({
        initialValues: { rows: [{ id: "" }] },
        arrays: { rows: { key: byId } },
    }), (e) => e instanceof TypeError && /non-empty string/.test(e.message));
    assert.throws(() => createForm({
        initialValues: { rows: [{ id: "a.b" }] },
        arrays: { rows: { key: byId } },
    }), (e) => e instanceof TypeError && /must not contain "\."/.test(e.message));
    assert.throws(() => createForm({
        initialValues: { rows: [{ id: "__proto__" }] },
        arrays: { rows: { key: byId } },
    }), TE);
});

test("config door: two rows yielding the same key throw naming the duplicate", () => {
    assert.throws(() => createForm({
        initialValues: { rows: [{ id: "x" }, { id: "x" }] },
        arrays: { rows: { key: byId } },
    }), (e) => e instanceof TypeError && /duplicate key "x"/.test(e.message));
});

// --- (b) P2 addressing doors [4] --------------------------------------------

test("P2 door: an index path under a declared array throws to the row API", () => {
    const f = seedForm();
    assert.throws(() => f.field("rows.0.name"), (e) => e instanceof TypeError && /by index or non-live key/.test(e.message));
    f.dispose();
});

test("P2 door: field(\"rows\") addressing the array as a whole throws", () => {
    const f = seedForm();
    assert.throws(() => f.field("rows"), (e) => e instanceof TypeError && /declared field array/.test(e.message));
    f.dispose();
});

test("P2 door: setValues at \"rows\" throws (whole-array write)", () => {
    const f = seedForm();
    assert.throws(() => f.setValues({ rows: [] }), (e) => e instanceof TypeError && /declared field array/.test(e.message));
    f.dispose();
});

test("P2 door: a non-live key sub-path throws", () => {
    const f = seedForm();
    assert.throws(() => f.field("rows.zzz.name"), (e) => e instanceof TypeError && /by index or non-live key/.test(e.message));
    f.dispose();
});

// --- (c) identity [2] -------------------------------------------------------

test("identity: an edited+touched row's state travels with the key across a move", () => {
    const f = seedForm();
    const rows = f.array("rows");
    f.field("rows.a.name").set("Ann-edited");
    f.field("rows.a.name").blur();
    assert.deepEqual(rows.keys(), ["a", "b"]);
    rows.move("a", 1);
    assert.deepEqual(rows.keys(), ["b", "a"], "move rewrites order only");
    // state rides the key, not the index: "a" is now at index 1 but unchanged.
    assert.equal(f.field("rows.a.name").value(), "Ann-edited");
    assert.equal(f.field("rows.a.name").touched(), true);
    assert.equal(f.field("rows.a.name").dirty(), true);
    // row(key).field(sub) is the SAME Field object as field("rows.<key>.name").
    assert.equal(rows.row("a").field("name"), f.field("rows.a.name"));
    f.dispose();
});

test("identity: keys() is the same frozen instance until a structural mutation", () => {
    const f = seedForm();
    const rows = f.array("rows");
    const k1 = rows.keys();
    assert.equal(Object.isFrozen(k1), true);
    f.field("rows.a.name").set("edited"); // field edit: NOT structural
    assert.equal(rows.keys(), k1, "a field edit must not flip the keys() snapshot");
    rows.move("b", 0); // structural
    const k2 = rows.keys();
    assert.notEqual(k2, k1, "a structural mutation flips the snapshot exactly once");
    assert.equal(rows.keys(), k2, "and stays stable until the next structural mutation");
    f.dispose();
});

// --- (d) D2 patch shapes [2] ------------------------------------------------

test("D2: a field-edit-only array emits a keyed field entry and NO structure entry", () => {
    const f = seedForm();
    f.field("rows.a.name").set("Zed");
    assert.deepEqual(f.toPatch(), [{ path: "rows.a.name", from: "Ann", to: "Zed" }]);
    f.dispose();
});

test("D2: added rows ride structure.added with full value and emit no field entries; removed + order tracked", () => {
    const f = seedForm();
    const rows = f.array("rows");
    const k = rows.add({ id: "c", name: "Cy" });
    f.field("rows.c.name").set("Cyrus"); // edit the added row's field
    rows.remove("a");                    // remove a baseline row
    const patch = f.toPatch();
    // no field entry for the added row (its value rides structure.added)
    assert.equal(patch.some((e) => e.path === "rows.c.name"), false, "added-row fields never emit field entries");
    const struct = patch.find((e) => e.path === "rows" && e.structure);
    assert.ok(struct, "a structurally-dirty array emits one structure entry");
    assert.deepEqual(struct.structure.order, ["b", "c"]);
    assert.deepEqual(struct.structure.removed, ["a"]);
    assert.equal(struct.structure.added.length, 1);
    assert.equal(struct.structure.added[0].key, "c");
    assert.deepEqual(struct.structure.added[0].value, { id: "c", name: "Cyrus" }, "full current value rides structure.added");
    assert.equal(k, "c");
    f.dispose();
});

// --- (e) D3 commit / reset structure [2] ------------------------------------

test("D3: an added row edited back to its seed is pristine yet stays added; commit promotes it", () => {
    const f = seedForm();
    const rows = f.array("rows");
    rows.add({ id: "c", name: "Cy" });
    f.field("rows.c.name").set("X");
    f.field("rows.c.name").set("Cy"); // back to the add seed
    assert.equal(f.field("rows.c.name").dirty(), false, "edit-back-to-seed clears the overlay");
    assert.equal(rows.structureDirty(), true, "an added row's presence is still structure-dirty");
    assert.equal(f.isDirty(), true);
    f.commit();
    assert.equal(rows.structureDirty(), false, "commit promotes the added row into the baseline");
    assert.deepEqual(f.toPatch(), [], "commit leaves the patch empty");
    assert.equal(f.isDirty(), false);
    f.dispose();
});

test("D3: reset drops added rows, restores removed baseline rows, and restores the baseline order", () => {
    const f = seedForm();
    const rows = f.array("rows");
    rows.add({ id: "c", name: "Cy" });
    rows.remove("a");
    f.field("rows.b.name").set("Bobby");
    rows.move("b", 0);
    f.reset();
    assert.deepEqual(rows.keys(), ["a", "b"], "baseline order and membership restored");
    assert.equal(rows.structureDirty(), false);
    assert.equal(f.field("rows.a.name").value(), "Ann", "removed baseline row returns pristine");
    assert.equal(f.field("rows.b.name").value(), "Bob", "field edit reverted");
    assert.throws(() => f.field("rows.c.name"), TE, "the added row is gone");
    f.dispose();
});

// --- (f) D4 both arms [1] ---------------------------------------------------

test("D4: 2-arg reinitialize throws on a declared-array form; 1-arg fully re-seeds", () => {
    const f = seedForm();
    // arm 1: merge (2-arg) is unsupported with declared arrays -- fail closed.
    assert.throws(() => f.reinitialize({ rows: [{ id: "a", name: "A" }] }, Object.is),
        (e) => e instanceof TypeError && /declared field arrays/.test(e.message));
    // arm 2: 1-arg re-seeds atomically -- keys re-derived, old rows cleared.
    f.reinitialize({ rows: [{ id: "x", name: "Xavier" }] });
    assert.deepEqual(f.array("rows").keys(), ["x"]);
    assert.equal(f.field("rows.x.name").value(), "Xavier");
    assert.throws(() => f.field("rows.a.name"), TE, "the old key is gone after a full re-seed");
    f.dispose();
});

// --- (g) ctx.local cross-field within the row [1] ---------------------------

test("ctx.local: a row validator reads a sibling field within the same row (tracked)", () => {
    const f = createForm({
        initialValues: { rows: [{ id: "a", pw: "secret", pw2: "secret" }] },
        arrays: { rows: { key: byId, validators: { pw2: (v, ctx) => (v === ctx.local("pw") ? null : "mismatch") } } },
    });
    assert.equal(f.field("rows.a.pw2").rawError(), null);
    f.field("rows.a.pw2").set("other");
    assert.equal(f.field("rows.a.pw2").rawError(), "mismatch");
    f.field("rows.a.pw").set("other"); // local("pw") is tracked -> pw2 re-validates
    assert.equal(f.field("rows.a.pw2").rawError(), null, "changing the sibling re-runs the row validator");
    f.dispose();
});

// --- (h) schema index->key translation, incl. after a move [1] --------------

test("D6 schema: an index-keyed schema error translates to the row key, and follows a move", () => {
    const f = createForm({
        initialValues: { rows: [{ id: "a", name: "A" }, { id: "b", name: "B" }] },
        arrays: { rows: { key: byId } },
        validate: (vals) => {
            const e = {};
            vals.rows.forEach((r, i) => { if (!r.name) e["rows." + i + ".name"] = "required"; });
            return e;
        },
    });
    const rows = f.array("rows");
    f.field("rows.b.name").set(""); // row "b" (index 1) becomes invalid + dirty (revealed)
    assert.equal(f.field("rows.b.name").error(), "required", "index-1 schema error keyed to row b");
    assert.equal(f.field("rows.a.name").error(), null);
    rows.move("b", 0); // b now sits at index 0; the schema sees the new order
    assert.equal(f.field("rows.b.name").error(), "required", "after move the error still lands on row b (now index 0)");
    assert.equal(f.field("rows.a.name").error(), null, "row a (now index 1) stays valid");
    f.dispose();
});

// --- (i) remove() mid-async settlement is a no-op (D5) [1] -------------------

test("D5: remove() mid-async settlement lands nothing, raises no unhandledRejection, leaks no nodes", async () => {
    const seen = [];
    const onUnhandled = (r) => seen.push(r);
    process.on("unhandledRejection", onUnhandled);
    const reg = createRegistry({ maxNodes: 1 << 14, maxLinks: 1 << 16, onCapacityExceeded: "grow" });
    const { validator, q } = deferredLane();
    const f = createForm({
        initialValues: { rows: [{ id: "a", name: "Ann" }] },
        arrays: { rows: { key: byId, validatorsAsync: { name: validator } } },
        registry: reg,
    });
    await tick();
    q[0].resolve(null); // clear the construction-time validation for row a
    await tick();
    const before = reg.stats().activeNodes;
    const rows = f.array("rows");
    const k = rows.add({ id: "c", name: "Cy" }); // creates row c + its own async lane
    f.field("rows.c.name").set("Cyrus");         // triggers row c's async validator
    await tick();
    rows.remove("c");                            // dispose the row root FIRST
    // settle AFTER removal -- a no-op: no write, no throw, no unhandledRejection.
    for (let i = 1; i < q.length; i++) if (q[i]) q[i].resolve("late");
    await tick(); await tick();
    process.off("unhandledRejection", onUnhandled);
    assert.equal(k, "c");
    assert.equal(seen.length, 0, "a post-removal settlement must not surface as unhandledRejection");
    // prune() may reclaim MORE than the removed row: any slot that is both
    // un-overlaid and unobserved is fair game (lite-project contract; slots
    // re-create lazily on next read, values stay correct). The law is a BOUND,
    // not an exact refund: remove() must never grow the pool...
    const after = reg.stats().activeNodes;
    assert.ok(after <= before, "remove() + prune() must not grow the pool (before=" + before + " after=" + after + ")");
    // ...and distinct-key add/remove churn must stay activeNodes-flat (A2).
    const flat = reg.stats().activeNodes;
    const rows2 = f.array("rows");
    for (let i = 0; i < 32; i++) {
        const kk = rows2.add({ id: "x" + i, name: "N" });
        rows2.remove(kk);
    }
    assert.ok(reg.stats().activeNodes <= flat,
        "32 distinct-key add/remove cycles must not grow activeNodes (" + flat + " -> " + reg.stats().activeNodes + ")");
    f.dispose();
});

// --- (j) merge-purity latch (P11): the reconcile window + the D4 door ---------

test("D4 guards the 2-arg door: the merge policy never runs on a declared-arrays form", () => {
    // On a declared-arrays form the 2-arg reinitialize throws BEFORE any policy
    // window opens; the latch's reachable window on such a form is reconcile()
    // (tested below).
    const f = seedForm();
    let policyRan = false;
    assert.throws(
        () => f.reinitialize({ rows: [{ id: "a", name: "A" }] }, () => { policyRan = true; f.array("rows").add({ id: "z" }); return true; }),
        (e) => e instanceof TypeError && /declared field arrays/.test(e.message));
    assert.equal(policyRan, false, "the policy never ran: D4 refused the 2-arg merge before any latch window");
    f.dispose();
});

test("single-leaf rows: a named sub-field throws instead of silently dropping from snapshots", () => {
    const f = createForm({
        initialValues: { tags: ["x", "y"] },
        arrays: { tags: { key: (t) => String(t) } },
    });
    assert.equal(f.field("tags.x").value(), "x", "the single leaf is addressable with no sub segment");
    assert.throws(() => f.array("tags").row("x").field("name"),
        (e) => e instanceof TypeError && /single-leaf row/.test(e.message));
    assert.throws(() => f.field("tags.x.name"),
        (e) => e instanceof TypeError && /single-leaf row/.test(e.message), "the keyed-path route hits the same door");
    f.dispose();
});

test("object rows: addressing the row itself as a field throws (sub-fields are the door)", () => {
    const f = seedForm();
    assert.throws(() => f.array("rows").row("a").field(""),
        (e) => e instanceof TypeError && /object row/.test(e.message));
    f.dispose();
});

test("P11 via reconcile: a policy calling rows.remove() throws the latch TypeError, nothing mutates", () => {
    const f = seedForm();
    f.field("rows.a.name").set("Ann2");                   // exactly one overlay, so the policy runs once
    const rows = f.array("rows");
    assert.throws(
        () => f.reconcile(() => { rows.remove("b"); return false; }),
        (e) => e instanceof TypeError && /inside a merge policy/.test(e.message));
    assert.deepEqual([...rows.keys()], ["a", "b"], "the hostile scan mutated no structure");
    assert.equal(f.field("rows.a.name").value(), "Ann2", "the draft survives the aborted scan");
    f.dispose();
});

test("P11 via reconcile: lazy row sub-field creation inside the policy throws (creation is mutation)", () => {
    const f = seedForm();
    f.field("rows.a.name").set("Ann2");
    const row = f.array("rows").row("a");
    assert.throws(
        () => f.reconcile(() => { row.field("nickname"); return false; }),
        (e) => e instanceof TypeError && /inside a merge policy/.test(e.message));
    f.dispose();
});

// --- LF-13: teardown without a notifier (the LF-12 class, on the validity lane) --

test("LF-13a: isValid recovers after removing the row that carried the only error", () => {
    const nOdd = (v) => (((v >>> 0) % 2) === 0 ? null : "odd");
    const f = createForm({
        initialValues: { rows: [{ id: "r0", n: 0 }, { id: "r1", n: 0 }] },
        arrays: { rows: { key: byId, validators: { n: nOdd } } },
    });
    f.field("rows.r0.n").set(3);
    assert.equal(f.isValid(), false, "r0 is odd -> invalid (isValid cached with ONE row dep)");
    f.array("rows").remove("r0");
    assert.equal(f.isValid(), true, "removing the only-invalid row must notify isValid (structRev), not orphan it");
    f.field("rows.r1.n").set(5);
    assert.equal(f.isValid(), false, "the survivor still validates");
    f.dispose();
});

test("LF-13b: removing a row mid-async-validation releases pendingCount (isValidating recovers)", async () => {
    const { validator, q } = deferredLane();
    const f = createForm({
        initialValues: { rows: [{ id: "a", name: "Ann" }] },
        arrays: { rows: { key: byId, validatorsAsync: { name: validator } } },
    });
    await tick();
    q[0].resolve(null); await tick();                     // settle the construction-time run
    assert.equal(f.isValidating(), false);
    const rows = f.array("rows");
    const k = rows.add({ id: "z", name: "Zed" });
    f.field("rows.z.name").set("Zz"); await tick();       // row z's lane goes pending
    assert.equal(f.isValidating(), true, "row lane pending drives the form-level counter");
    assert.equal(f.isValid(), false, "strict-false while pending");
    rows.remove(k);                                       // teardown while PENDING
    assert.equal(f.isValidating(), false, "teardown of a pending lane must release its pendingCount slot");
    assert.equal(f.isValid(), true, "validity recovers once the pending row is gone");
    for (let i = 1; i < q.length; i++) if (q[i]) q[i].resolve("late");
    await tick(); await tick();                           // late settlements stay no-ops
    assert.equal(f.isValidating(), false);
    assert.equal(f.isValid(), true);
    f.dispose();
});
