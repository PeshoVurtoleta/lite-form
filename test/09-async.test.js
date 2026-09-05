// 09-async.test.js -- the per-field async validation seam. One monotonic seq per
// field; only the LATEST settlement lands (stale ones dropped whole, no trace, no
// flash); isValidating flips exactly at the latest settle; a rejection can never
// leave a field valid; dispose() mid-flight makes a later settlement a no-op; and
// isValid is strict-false while a verdict is pending (fail-closed submit). The
// scheduler is a hand-controlled deferred queue -- NO wall clock, deterministic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "@zakkster/lite-signal";
import { createForm } from "../Form.js";

// A macrotask tick: flushes the microtask queue so attached .then callbacks (the
// settlement path) run before we assert.
const tick = () => new Promise((r) => setTimeout(r));

// A validator whose every call parks a deferred in `q` (push order). Resolve or
// reject q[i] by hand to control settlement order.
function deferredLane() {
    const q = [];
    const validator = (value) => new Promise((resolve, reject) => q.push({ value, resolve, reject }));
    return { validator, q };
}

test("last-write-wins: out-of-order settlements land only the latest; no stale flash", async () => {
    const { validator, q } = deferredLane();
    const f = createForm({ initialValues: { x: 0 }, validatorsAsync: { x: validator } });
    await tick();
    q[0].resolve(null); // clear the construction-time validation
    await tick();
    assert.equal(f.isValidating(), false);

    const errs = [];
    f.field("x").set(10); // q[1]
    f.field("x").set(20); // q[2]
    f.field("x").set(30); // q[3] LATEST
    const stop = f.field("x").error.subscribe((e) => errs.push(e)); // current: null
    q[2].resolve("stale-b"); await tick(); // stale -> dropped
    q[1].resolve("stale-a"); await tick(); // stale -> dropped
    q[3].resolve(null); await tick();      // latest -> lands (null, no change)
    assert.deepEqual(errs, [null], "a stale verdict must never flash into the displayed error");
    assert.equal(f.field("x").error.peek(), null);
    stop();
    f.dispose();
});

test("a real error from the latest settlement is surfaced", async () => {
    const { validator, q } = deferredLane();
    const f = createForm({ initialValues: { x: 0 }, validatorsAsync: { x: validator } });
    await tick(); q[0].resolve(null); await tick();
    f.field("x").set(5); // q[1] latest
    q[1].resolve("taken"); await tick();
    assert.equal(f.field("x").error.peek(), "taken");
    assert.equal(f.isValid(), false);
    f.dispose();
});

test("D6: isValid is strict-false while a verdict is pending", async () => {
    const { validator, q } = deferredLane();
    const f = createForm({ initialValues: { x: 0 }, validatorsAsync: { x: validator } });
    await tick(); q[0].resolve(null); await tick();
    assert.equal(f.isValid(), true);
    f.field("x").set(7); // q[1] pending
    assert.equal(f.isValidating(), true);
    assert.equal(f.isValid(), false, "pending async verdict must be strict-false");
    q[1].resolve(null); await tick();
    assert.equal(f.isValidating(), false);
    assert.equal(f.isValid(), true);
    f.dispose();
});

test("AM-3: two rapid triggers + one latest settle returns isValidating to false (no stuck counter)", async () => {
    const { validator, q } = deferredLane();
    const f = createForm({ initialValues: { x: 0 }, validatorsAsync: { x: validator } });
    await tick(); q[0].resolve(null); await tick();
    f.field("x").set(1); // q[1]: pending false->true (count 1)
    f.field("x").set(2); // q[2]: already pending -> seq bump only, NO double increment
    assert.equal(f.isValidating(), true);
    q[1].resolve(null); await tick(); // stale: no decrement
    assert.equal(f.isValidating(), true, "a stale settle must not decrement the counter");
    q[2].resolve(null); await tick(); // latest: single decrement
    assert.equal(f.isValidating(), false, "no stuck counter after rapid triggers");
    f.dispose();
});

test("AM-4: a latest rejection coerces to a non-empty error; a field can never stay valid on a throw", async () => {
    const { validator, q } = deferredLane();
    const f = createForm({ initialValues: { x: 0 }, validatorsAsync: { x: validator } });
    await tick(); q[0].resolve(null); await tick();
    f.field("x").set(9); // q[1] latest
    q[1].reject(new Error("db down")); await tick();
    assert.equal(f.field("x").error.peek(), "db down");
    assert.equal(f.isValid(), false, "a rejection cannot leave the field valid");
    f.dispose();
});

test("AM-4: a bare (message-less) rejection still yields a non-empty error string", async () => {
    const { validator, q } = deferredLane();
    const f = createForm({ initialValues: { x: 0 }, validatorsAsync: { x: validator } });
    await tick(); q[0].resolve(null); await tick();
    f.field("x").set(9);
    q[1].reject(undefined); await tick();
    const msg = f.field("x").error.peek();
    assert.equal(typeof msg, "string");
    assert.ok(msg.length > 0, "a rejection error must be non-empty");
    f.dispose();
});

test("AM-4: a stale rejection is swallowed whole and raises no unhandledRejection", async () => {
    const seen = [];
    const onUnhandled = (r) => seen.push(r);
    process.on("unhandledRejection", onUnhandled);
    const { validator, q } = deferredLane();
    const f = createForm({ initialValues: { x: 0 }, validatorsAsync: { x: validator } });
    await tick(); q[0].resolve(null); await tick();
    f.field("x").set(1); // q[1]
    f.field("x").set(2); // q[2] latest
    q[1].reject(new Error("stale boom")); await tick(); // stale rejection -> dropped
    q[2].resolve(null); await tick();                   // latest ok
    await tick(); await tick();
    process.off("unhandledRejection", onUnhandled);
    assert.equal(seen.length, 0, "a stale rejection must not surface as unhandledRejection");
    assert.equal(f.field("x").error.peek(), null, "the stale rejection left no trace");
    assert.equal(f.isValidating(), false);
    f.dispose();
});

test("a synchronous throw inside the async validator is treated as a rejection", async () => {
    const validator = () => { throw new Error("sync boom"); };
    const f = createForm({ initialValues: { x: 0 }, validatorsAsync: { x: validator } });
    await tick();
    f.field("x").set(3);
    await tick();
    assert.equal(f.field("x").error.peek(), "sync boom");
    assert.equal(f.isValidating(), false, "a synchronous throw still settles the lane");
    f.dispose();
});

test("dispose() mid-flight: a later settlement is a no-op and leaks no nodes", async () => {
    const reg = createRegistry({ maxNodes: 1 << 14, maxLinks: 1 << 16, onCapacityExceeded: "grow" });
    const base = reg.stats().activeNodes;
    const { validator, q } = deferredLane();
    const f = createForm({ initialValues: { x: 0 }, validatorsAsync: { x: validator }, registry: reg });
    await tick();
    f.field("x").set(5); // in flight
    f.dispose();
    // settle AFTER dispose -- must not throw, must write nothing
    for (let i = 0; i < q.length; i++) q[i].resolve("late");
    await tick(); await tick();
    assert.equal(reg.stats().activeNodes, base, "dispose() left async-lane nodes behind");
});

test("A6: submit fails closed while a verdict is pending, then succeeds once valid", async () => {
    const { validator, q } = deferredLane();
    let ran = 0;
    const f = createForm({
        initialValues: { x: 0 },
        validatorsAsync: { x: validator },
        onSubmit: () => { ran++; },
    });
    await tick(); q[0].resolve(null); await tick();
    f.field("x").set(1); // q[1] pending
    // Defense 1: a submit racing a pending verdict must not run onSubmit.
    assert.equal(await f.submit(), false, "submit ran on unsettled validity");
    assert.equal(ran, 0);
    q[1].resolve(null); await tick();
    // Defense 2: once settled valid, submit runs exactly once.
    assert.equal(await f.submit(), true);
    assert.equal(ran, 1);
    f.dispose();
});

test("A6: a submit racing an async rejection stays closed (invalid)", async () => {
    const { validator, q } = deferredLane();
    let ran = 0;
    const f = createForm({
        initialValues: { x: 0 },
        validatorsAsync: { x: validator },
        onSubmit: () => { ran++; },
    });
    await tick(); q[0].resolve(null); await tick();
    f.field("x").set(2); // q[1]
    q[1].reject(new Error("nope")); await tick();
    // Defense 3: an async error keeps the form invalid, so submit stays closed.
    assert.equal(await f.submit(), false);
    assert.equal(ran, 0);
    f.dispose();
});

test("per-field isolation: triggering one async field does not mark the other validating", async () => {
    const a = deferredLane();
    const b = deferredLane();
    const f = createForm({
        initialValues: { x: 0, y: 0 },
        validatorsAsync: { x: a.validator, y: b.validator },
    });
    await tick();
    a.q[0].resolve(null); b.q[0].resolve(null); await tick();
    assert.equal(f.isValidating(), false);
    f.field("x").set(1); // only x
    assert.equal(f.field("x").isValidating(), true);
    assert.equal(f.field("y").isValidating(), false, "y must not validate when only x changed");
    assert.equal(f.isValidating(), true);
    a.q[1].resolve(null); await tick();
    assert.equal(f.isValidating(), false);
    f.dispose();
});

test("a sync-only field's isValidating is the shared frozen FALSE constant", () => {
    const { validator } = deferredLane();
    const f = createForm({
        initialValues: { s1: 0, s2: 0, ax: 0 },
        validatorsAsync: { ax: validator }, // ax async, s1/s2 sync
    });
    const s1 = f.field("s1").isValidating;
    const s2 = f.field("s2").isValidating;
    assert.equal(s1, s2, "sync fields must share ONE frozen isValidating constant");
    assert.equal(s1(), false);
    assert.equal(s1.peek(), false);
    assert.notEqual(f.field("ax").isValidating, s1, "an async field owns its own pending signal");
    f.dispose();
});

test("field.isValidating tracks in an effect and settles cleanly", async () => {
    const reg = createRegistry({ maxNodes: 1 << 14, maxLinks: 1 << 16, onCapacityExceeded: "grow" });
    const { validator, q } = deferredLane();
    const f = createForm({ initialValues: { x: 0 }, validatorsAsync: { x: validator }, registry: reg });
    await tick(); q[0].resolve(null); await tick();
    const seen = [];
    const stop = reg.effect(() => seen.push(f.field("x").isValidating()));
    seen.length = 0;
    f.field("x").set(1); await tick();
    q[1].resolve(null); await tick();
    assert.deepEqual(seen, [true, false], "isValidating must flip true then false across one validation");
    stop();
    f.dispose();
});
