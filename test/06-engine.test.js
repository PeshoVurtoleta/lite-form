// 06-engine.test.js -- the S2 additive engine surface: commit(), toPatch(),
// reinitialize(), and the WritableSignal-shaped value facade over the projection.
// The value core rides a @zakkster/lite-project projection over the detached
// baseline; the S1 unreachability + dirty contracts survive it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "@zakkster/lite-signal";
import { createForm } from "../Form.js";

const TE = { name: "TypeError" };

// --- commit -----------------------------------------------------------------

test("commit() folds every dirty value into the baseline; fields go pristine", () => {
    const f = createForm({ initialValues: { a: 1, b: 2, c: 3 } });
    f.field("a").set(10);
    f.field("b").set(20);
    assert.equal(f.isDirty(), true);
    f.commit();
    assert.equal(f.isDirty(), false);
    assert.equal(f.field("a").dirty(), false);
    assert.equal(f.field("b").dirty(), false);
    assert.deepEqual(f.values(), { a: 10, b: 20, c: 3 });
    // reset now targets the committed state, not the original
    f.field("a").set(99);
    f.reset();
    assert.equal(f.field("a").value(), 10);
    f.dispose();
});

test("commit(path) folds one field, leaving the others dirty", () => {
    const f = createForm({ initialValues: { a: 1, b: 2 } });
    f.field("a").set(10);
    f.field("b").set(20);
    f.commit("a");
    assert.equal(f.field("a").dirty(), false);
    assert.equal(f.field("b").dirty(), true);
    assert.deepEqual(f.toPatch().map((p) => p.path), ["b"]);
    f.dispose();
});

test("a field set back to its initial value is excluded from toPatch AND commit", () => {
    const f = createForm({ initialValues: { a: 1 } });
    f.field("a").set(2);
    assert.equal(f.field("a").dirty(), true);
    f.field("a").set(1); // back to initial -> overlay cleared
    assert.equal(f.field("a").dirty(), false);
    assert.deepEqual(f.toPatch(), []);
    f.commit(); // nothing to fold
    assert.deepEqual(f.values(), { a: 1 });
    f.dispose();
});

// --- toPatch ----------------------------------------------------------------

test("toPatch() returns {path, from, to} for exactly the dirty paths", () => {
    const f = createForm({ initialValues: { a: 1, b: 2, c: 3 } });
    f.field("a").set(10);
    f.field("c").set(30);
    const patch = f.toPatch().sort((x, y) => (x.path < y.path ? -1 : 1));
    assert.deepEqual(patch, [
        { path: "a", from: 1, to: 10 },
        { path: "c", from: 3, to: 30 },
    ]);
    f.dispose();
});

test("toPatch() is [] on a pristine form", () => {
    const f = createForm({ initialValues: { a: 1, b: 2 } });
    assert.deepEqual(f.toPatch(), []);
    f.dispose();
});

// --- reinitialize -----------------------------------------------------------

test("reinitialize(next) re-seeds values and leaves every field pristine", () => {
    const f = createForm({ initialValues: { a: 1, b: 2 } });
    f.field("a").set(99);
    f.reinitialize({ a: 5, b: 6 });
    assert.deepEqual(f.values(), { a: 5, b: 6 });
    assert.equal(f.isDirty(), false);
    // reset now returns to the reinitialized baseline
    f.field("a").set(50);
    f.reset();
    assert.equal(f.field("a").value(), 5);
    f.dispose();
});

test("reinitialize re-seeds a path absent from next as undefined", () => {
    const f = createForm({ initialValues: { a: 1, b: 2 } });
    f.reinitialize({ a: 7 });
    assert.equal(f.field("a").value(), 7);
    assert.equal(f.field("b").value(), undefined);
    assert.equal(f.field("b").dirty(), false);
    f.dispose();
});

test("reinitialize clears touched and submit state", async () => {
    const f = createForm({ initialValues: { a: 1 }, validators: { a: () => "err" } });
    f.field("a").blur();
    await f.submit();
    assert.equal(f.field("a").touched(), true);
    assert.equal(f.submitAttempted(), true);
    f.reinitialize({ a: 2 });
    assert.equal(f.field("a").touched(), false);
    assert.equal(f.submitAttempted(), false);
    f.dispose();
});

test("reinitialize throws TypeError on a non-object and mutates nothing", () => {
    const f = createForm({ initialValues: { a: 1 } });
    f.field("a").set(9);
    assert.throws(() => f.reinitialize(null), TE);
    assert.throws(() => f.reinitialize(42), TE);
    // state unchanged after the throw
    assert.equal(f.field("a").value(), 9);
    assert.equal(f.field("a").dirty(), true);
    f.dispose();
});

test("reinitialize validates next BEFORE any state change (hostile key / cycle atomic)", () => {
    const f = createForm({ initialValues: { a: 1 } });
    f.field("a").set(9);
    assert.throws(() => f.reinitialize(JSON.parse('{"__proto__":{}}')), TE);
    const cyc = {}; cyc.self = cyc;
    assert.throws(() => f.reinitialize({ a: cyc }), TE);
    assert.throws(() => f.reinitialize({ a: new Map() }), TE);
    // every throw left the pre-call state intact
    assert.equal(f.field("a").value(), 9);
    assert.equal(f.field("a").dirty(), true);
    assert.deepEqual(f.toPatch(), [{ path: "a", from: 1, to: 9 }]);
    f.dispose();
});

// --- value facade conformance -----------------------------------------------

test("field.value satisfies the WritableSignal shape: (), peek, set, update, subscribe", () => {
    const f = createForm({ initialValues: { a: 1 } });
    const v = f.field("a").value;
    assert.equal(typeof v, "function");
    assert.equal(v(), 1);
    assert.equal(v.peek(), 1);
    v.set(2);
    assert.equal(v(), 2);
    v.update((prev) => prev + 40); // update APPLIES the fn
    assert.equal(v(), 42);
    assert.equal(typeof v.subscribe, "function");
    f.dispose();
});

test("field.value.subscribe fires on change and its disposer stops it", () => {
    const f = createForm({ initialValues: { a: 1 } });
    const seen = [];
    const stop = f.field("a").value.subscribe((val) => seen.push(val));
    assert.deepEqual(seen, [1]); // fires immediately with the current value
    f.field("a").set(2);
    assert.deepEqual(seen, [1, 2]);
    stop();
    f.field("a").set(3);
    assert.deepEqual(seen, [1, 2], "disposer did not stop the subscription");
    f.dispose();
});

// --- dispose + unreachability probes ----------------------------------------

test("dispose() after a commit returns the registry to its pre-createForm baseline", () => {
    const reg = createRegistry({ maxNodes: 1 << 14, maxLinks: 1 << 16, onCapacityExceeded: "grow" });
    const base = reg.stats().activeNodes;
    const f = createForm({ initialValues: { a: 1, b: 2 }, registry: reg });
    f.field("a").set(9);
    f.commit();
    f.dispose();
    assert.equal(reg.stats().activeNodes, base, "dispose() leaked nodes after commit");
});

test("mutating a values() result cannot reach the baseline (reset proves it)", () => {
    const f = createForm({ initialValues: { rows: [{ n: 1 }] } });
    const snap = f.values();
    snap.rows.push({ n: 2 });
    snap.rows[0].n = 999;
    f.reset();
    assert.deepEqual(f.field("rows").value(), [{ n: 1 }]);
    f.dispose();
});

test("mutating a toPatch() entry's from cannot corrupt the restorable baseline", () => {
    const f = createForm({ initialValues: { obj: { n: 1 } } });
    f.field("obj").set({ n: 2 });
    const patch = f.toPatch();
    patch[0].from.n = 111; // from is the captured initial ref view -- must not alias the baseline tree
    f.reset();             // re-seeds from the baseline tree, unaffected by the mutation above
    assert.deepEqual(f.field("obj").value(), { n: 1 }, "the baseline tree was reachable through toPatch().from");
    f.dispose();
});

test("mutating an object after commit cannot reach the committed baseline", () => {
    const f = createForm({ initialValues: { obj: { n: 1 } } });
    const live = { n: 2 };
    f.field("obj").set(live);
    f.commit();
    live.n = 999; // mutate the object we handed in
    f.field("obj").set({ n: 3 });
    f.reset();
    assert.deepEqual(f.field("obj").value(), { n: 2 }, "commit aliased the caller's object into the baseline");
    f.dispose();
});

test("commit(path) for an unregistered path throws and creates no phantom field", () => {
    const f = createForm({ initialValues: { a: 1 } });
    f.field("a").set(2);
    const before = f.values();
    assert.throws(() => f.commit("emial"), TE);           // typo'd path: loud, not a lazy no-op
    assert.throws(() => f.commit("emial"), /emial/);      // the error names the path
    assert.deepEqual(f.values(), before, "the throw mutated form state");
    f.commit();
    assert.ok(!("emial" in f.values()), "commit(path) injected a phantom field");
    f.dispose();
});

test("a subscriber's unsubscribe after form.dispose() is a no-op", () => {
    const f = createForm({ initialValues: { a: 1 } });
    let calls = 0;
    const un = f.field("a").value.subscribe(() => { calls++; });
    f.field("a").set(2);
    f.dispose();
    un();                                                  // late, user-held: must not double-dispose
    un();                                                  // and stays idempotent
    assert.ok(calls >= 0);
});
