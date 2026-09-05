// 08-merge.test.js -- merge-reinitialize(next, policy): fresh server data arrives
// WHILE the user edits. A pristine field ADOPTs the server value; a dirty field
// whose edit the policy ECHOes goes pristine at the server value; a dirty field
// whose edit CONFLICTs keeps the draft (masking the server value) but re-seeds the
// baseline underneath. The merge is atomic: a hostile leaf or a throwing policy
// leaves the form untouched. The four rows are proven across primitive, object,
// and absent leaves, plus the D1 touched/submit-state fate table and AM-1's
// source-mode contract (1-arg reverts, 2-arg throws).
import { test } from "node:test";
import assert from "node:assert/strict";
import { store, unwrap } from "@zakkster/lite-store";
import { createForm } from "../Form.js";

const TE = { name: "TypeError" };
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b); // structural policy for these leaves

// --- ADOPT (pristine) -------------------------------------------------------

test("ADOPT: a pristine field adopts the server value and stays pristine", () => {
    const f = createForm({ initialValues: { a: 1, b: 2 } });
    f.field("a").blur(); // pristine but touched
    f.reinitialize({ a: 9, b: 2 }, Object.is);
    assert.equal(f.field("a").value(), 9);
    assert.equal(f.field("a").dirty(), false);
    assert.equal(f.field("a").touched(), false, "ADOPT must clear touched");
    assert.deepEqual(f.toPatch(), []);
    f.dispose();
});

// --- ECHO (dirty, policy confirms) ------------------------------------------

test("ECHO primitive: a dirty edit the server echoed goes pristine at the value", () => {
    const f = createForm({ initialValues: { a: 1 } });
    f.field("a").set(5);
    f.field("a").blur();
    f.reinitialize({ a: 5 }, Object.is); // eq(5,5) -> forced ECHO
    assert.equal(f.field("a").value(), 5);
    assert.equal(f.field("a").dirty(), false, "ECHO field must be pristine");
    assert.equal(f.field("a").touched(), false, "ECHO must clear touched");
    assert.deepEqual(f.toPatch(), [], "ECHO field must be absent from toPatch");
    f.field("a").set(9); f.reset();
    assert.equal(f.field("a").value(), 5, "reset() must target the merged baseline");
    f.dispose();
});

// --- CONFLICT (dirty, policy rejects) ---------------------------------------

test("CONFLICT primitive: the draft masks the server value, baseline re-seeds under it", () => {
    const f = createForm({ initialValues: { a: 1 } });
    f.field("a").set(5);
    f.field("a").blur();
    f.reinitialize({ a: 9 }, Object.is); // eq(9,5) false, policy false -> CONFLICT
    assert.equal(f.field("a").value(), 5, "CONFLICT keeps the draft visible");
    assert.equal(f.field("a").dirty(), true);
    assert.equal(f.field("a").touched(), true, "CONFLICT must NOT clear touched");
    assert.deepEqual(f.toPatch(), [{ path: "a", from: 9, to: 5 }], "toPatch from = server value");
    f.reset();
    assert.equal(f.field("a").value(), 9, "reset() lands the server value");
    f.dispose();
});

// --- object leaf: CONFLICT under Object.is, ECHO under a structural policy ----

test("object leaf under Object.is is ALWAYS a CONFLICT (deep-copied payloads)", () => {
    const f = createForm({ initialValues: { o: { n: 1 } } });
    f.field("o").set({ n: 2 });
    f.reinitialize({ o: { n: 2 } }, Object.is); // structurally equal, but different refs
    assert.deepEqual(f.field("o").value(), { n: 2 });
    assert.equal(f.field("o").dirty(), true, "object echo cannot Object.is-confirm");
    f.dispose();
});

test("a structural policy confirms an object-leaf echo (ECHO)", () => {
    const f = createForm({ initialValues: { o: { n: 1 } } });
    f.field("o").set({ n: 2 });
    f.reinitialize({ o: { n: 2 } }, deepEq);
    assert.equal(f.field("o").dirty(), false, "structural policy must confirm the echo");
    assert.deepEqual(f.toPatch(), []);
    f.dispose();
});

// --- absent path (n = undefined) --------------------------------------------

test("absent path: a dirty field absent from next is a CONFLICT with from = undefined", () => {
    const f = createForm({ initialValues: { a: 1, b: 2 } });
    f.field("a").set(9); // pristine b, dirty a
    f.field("b").set(5);
    f.reinitialize({ a: 9 }, Object.is); // a: eq(9,9) ECHO; b absent: n=undefined vs 5 CONFLICT
    assert.equal(f.field("a").dirty(), false, "a echoed -> pristine at 9");
    assert.equal(f.field("b").value(), 5, "b draft masks the absent value");
    assert.deepEqual(f.toPatch(), [{ path: "b", from: undefined, to: 5 }]);
    f.reset();
    assert.equal(f.field("b").value(), undefined, "reset lands the absent (undefined) baseline");
    f.dispose();
});

// --- D1 truth table: submit state is never written by the merge --------------

test("D1: the merge never writes submitAttempted/submitError", async () => {
    const f = createForm({ initialValues: { a: 1 }, validators: { a: () => "err" } });
    f.field("a").set(2);
    await f.submit(); // submitAttempted = true (invalid)
    assert.equal(f.submitAttempted(), true);
    f.reinitialize({ a: 9 }, Object.is); // CONFLICT
    assert.equal(f.submitAttempted(), true, "a background merge must NOT un-reveal errors");
    f.dispose();
});

// --- one reactive emission per merge -----------------------------------------

test("bumpRev fires exactly once per merge (one subscribe emission)", () => {
    const f = createForm({ initialValues: { a: 1, b: 2, c: 3 } });
    const seen = [];
    const stop = f.field("a").value.subscribe((v) => seen.push(v)); // fires now with 1
    seen.length = 0;
    f.reinitialize({ a: 9, b: 8, c: 7 }, Object.is); // all pristine -> ADOPT
    assert.equal(seen.length, 1, "a merge must emit exactly once per field, not per write");
    assert.equal(seen[0], 9);
    stop();
    f.dispose();
});

// --- schema sees the merged baseline (scratch invalidation) ------------------

test("a schema re-reads the merged baseline (scratch is rebuilt)", () => {
    const schema = (vals) => (vals.a > vals.cap ? { a: "over" } : {});
    const f = createForm({ initialValues: { a: 1, cap: 10 }, validate: schema });
    assert.equal(f.isValid(), true);
    // cap is a pristine, un-touched branch: the merge lowers it under the draft a.
    f.field("a").set(5);
    f.reinitialize({ a: 5, cap: 3 }, Object.is); // a echoes to 5, cap adopts 3 -> 5 > 3
    assert.equal(f.isValid(), false, "the schema must see the merged cap branch");
    f.dispose();
});

// --- atomicity: a throwing policy mutates nothing -----------------------------

test("a throwing policy leaves the form completely untouched (atomic)", () => {
    const f = createForm({ initialValues: { a: 1 } });
    f.field("a").set(5);
    const boom = () => { throw new Error("nope"); };
    assert.throws(() => f.reinitialize({ a: 9 }, boom), /nope/);
    assert.equal(f.field("a").value(), 5, "the draft survived the throw");
    assert.equal(f.field("a").dirty(), true);
    assert.deepEqual(f.toPatch(), [{ path: "a", from: 1, to: 5 }], "baseline unchanged after throw");
    f.dispose();
});

test("a hostile leaf in next is rejected before any state change", () => {
    const f = createForm({ initialValues: { a: 1 } });
    f.field("a").set(5);
    assert.throws(() => f.reinitialize(JSON.parse('{"__proto__":{}}'), Object.is), TE);
    assert.throws(() => f.reinitialize({ a: 9, bad: new Map() }, Object.is), TE);
    assert.equal(f.field("a").value(), 5);
    assert.equal(f.field("a").dirty(), true);
    f.dispose();
});

// --- aliasing probes ---------------------------------------------------------

test("mutating next after a merge cannot reach the form (unreachable baseline)", () => {
    const f = createForm({ initialValues: { o: { n: 1 } } });
    const next = { o: { n: 5 } };
    f.reinitialize(next, Object.is); // ADOPT
    next.o.n = 999; // mutate the object we handed in
    assert.deepEqual(f.field("o").value(), { n: 5 }, "the merge aliased next into the baseline");
    f.dispose();
});

test("mutating a merged toPatch().from cannot corrupt the restorable baseline", () => {
    const f = createForm({ initialValues: { o: { n: 1 } } });
    f.field("o").set({ n: 2 });
    f.reinitialize({ o: { n: 9 } }, Object.is); // CONFLICT: from = {n:9}
    const patch = f.toPatch();
    patch[0].from.n = 111;
    f.reset();
    assert.deepEqual(f.field("o").value(), { n: 9 }, "the baseline was reachable through toPatch().from");
    f.dispose();
});

// --- AM-1: source-mode contract ---------------------------------------------

test("AM-1: 1-arg reinitialize in source mode reverts drafts and clears state, source untouched", async () => {
    const s = store({ name: "Ann", age: 30 });
    const f = createForm({ initialValues: { name: "", age: 0 }, source: s });
    f.field("name").set("Draft");
    f.field("name").blur();
    await f.submit();
    f.reinitialize({ name: "", age: 0 }); // 1-arg: frozen behavior
    assert.equal(f.field("name").value(), "Ann", "the draft was reverted (source read-through)");
    assert.equal(f.field("name").dirty(), false);
    assert.equal(f.field("name").touched(), false, "touched cleared");
    assert.equal(f.submitAttempted(), false, "submit state cleared");
    assert.equal(unwrap(s).name, "Ann", "the source object was mutated by reinitialize");
    f.dispose();
});

test("AM-1: 2-arg reinitialize in source mode throws (use reconcile)", () => {
    const s = store({ name: "Ann" });
    const f = createForm({ initialValues: { name: "" }, source: s });
    assert.throws(() => f.reinitialize({ name: "Bob" }, Object.is), (e) => {
        return e instanceof TypeError && /reconcile/.test(e.message);
    });
    f.dispose();
});

test("reconcile() with no argument is legal and defaults to the Object.is echo policy", () => {
    const s = store({ name: "Ann" });
    const f = createForm({ initialValues: { name: "" }, source: s });
    f.field("name").set("Bob");                 // overlay
    assert.equal(f.field("name").dirty(), true);
    s.name = "Bob";                             // authoritative write matches the overlay
    f.reconcile();                              // no-arg -> Object.is confirms, overlay dropped
    assert.equal(f.field("name").dirty(), false, "no-arg reconcile dropped the Object.is-confirmed overlay");
    assert.equal(f.field("name").value(), "Bob");
    f.dispose();
});

// LF-12 regression (latent 1.2.0 defect, exposed by the t5 per-path oracle):
// dirty() read -- and therefore cached -- BEFORE a value-preserving re-capture
// must recompute after it. commit() folds the staged value into the baseline,
// so value()'s output never changes across the fold; without dirty's own
// baselineRev read the cutoff strands the cached true forever.
test("LF-12: a cached dirty() goes false across commit() (one-path and full)", () => {
    const f = createForm({ initialValues: { a: 1, b: 1 } });
    f.field("a").set(2);
    f.field("b").set(3);
    assert.equal(f.field("a").dirty(), true);   // cache the computed pre-commit
    assert.equal(f.field("b").dirty(), true);
    f.commit("a");
    assert.equal(f.field("a").dirty(), false, "one-path commit re-captured initialRef; cached dirty must recompute");
    f.commit();
    assert.equal(f.field("b").dirty(), false, "full commit; cached dirty must recompute");
    f.dispose();
});

test("LF-12: a cached dirty() goes false across a forced-echo merge row", () => {
    const f = createForm({ initialValues: { a: 1 } });
    f.field("a").set(2);
    assert.equal(f.field("a").dirty(), true);   // cache pre-merge
    // next echoes the draft exactly: the forced Object.is echo short-circuits the
    // always-false policy, the overlay clears, and value()'s output is unchanged.
    f.reinitialize({ a: 2 }, () => false);
    assert.equal(f.field("a").dirty(), false, "forced echo cleared the overlay; cached dirty must recompute");
    assert.equal(f.field("a").value(), 2);
    f.dispose();
});

// Re-entrancy latch (reviewer blocker): a merge policy must be PURE. Verdicts
// are pre-scanned against a snapshot of the drafts; a policy mutating the form
// mid-scan would have them applied over different state, and a nested merge
// would splice the reused verdicts scratch. Every mutating entry throws while
// the latch is up, and the throw rides the atomic pre-scan path (nothing moves).
test("a merge policy that mutates the form throws, and the merge is atomic", () => {
    const f = createForm({ initialValues: { a: 1, b: 1 } });
    f.field("a").set(2);
    f.field("b").set(9);
    assert.throws(
        () => f.reinitialize({ a: 5, b: 9 }, () => { f.field("b").set(77); return true; }),
        (e) => e instanceof TypeError && /inside a merge policy/.test(e.message));
    assert.equal(f.field("a").value(), 2, "draft a untouched");
    assert.equal(f.field("b").value(), 9, "draft b untouched -- the hostile set never landed");
    assert.equal(f.field("a").dirty(), true);
    f.reset();
    assert.deepEqual(f.values(), { a: 1, b: 1 }, "baseline never re-seeded (atomic)");
    f.dispose();
});

test("a merge policy that re-enters reinitialize throws (no verdict splicing)", () => {
    const f = createForm({ initialValues: { a: 1 } });
    f.field("a").set(2);
    assert.throws(
        () => f.reinitialize({ a: 3 }, () => { f.reinitialize({ a: 4 }); return true; }),
        (e) => e instanceof TypeError && /inside a merge policy/.test(e.message));
    assert.equal(f.field("a").value(), 2);
    assert.equal(f.field("a").dirty(), true);
    f.field("a").reset();
    assert.equal(f.field("a").value(), 1, "baseline untouched by either merge");
    f.dispose();
});

test("a merge policy that lazily creates a field throws (creation is a mutation)", () => {
    const f = createForm({ initialValues: { a: 1 } });
    f.field("a").set(2);
    assert.throws(
        () => f.reinitialize({ a: 3 }, () => { f.field("zzz"); return true; }),
        (e) => e instanceof TypeError && /inside a merge policy/.test(e.message));
    assert.equal(f.field("a").value(), 2, "atomic: draft intact");
    assert.throws(() => f.commit("zzz"), TypeError, "no phantom field was born mid-merge");
    f.dispose();
});
