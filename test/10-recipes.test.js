// 10-recipes.test.js -- the two composed stories S3 promotes from README prose to
// tested recipes: (1) debounced async validation via `asyncSources` + a caller-
// owned @zakkster/lite-debounce handle, driven by flush() -- NEVER the wall clock;
// (2) the server-error (409) flow -- a caller signal merged into `validate`, zero
// new lite-form API. Plus the dirty-only patch-submit shape (D2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "@zakkster/lite-signal";
import { debounce } from "@zakkster/lite-debounce";
import { createForm } from "../Form.js";

const tick = () => new Promise((r) => setTimeout(r));

function deferredLane() {
    const q = [];
    const validator = (value) => new Promise((resolve, reject) => q.push({ value, resolve, reject }));
    return { validator, q };
}

// --- recipe 1: debounced async validation -----------------------------------

test("lite-debounce recipe: a keystroke burst collapses to ONE validation via flush()", async () => {
    let deb;
    const { validator, q } = deferredLane();
    const f = createForm({
        initialValues: { name: "" },
        validatorsAsync: { name: validator },
        asyncSources: { name: (fld) => (deb = debounce(() => fld.value(), 300)) },
    });
    await tick();
    q[0].resolve(null); await tick(); // clear the construction-time validation of ""
    const before = q.length;
    f.field("name").set("a");
    f.field("name").set("ab");
    f.field("name").set("abc");
    await tick();
    assert.equal(q.length, before, "the burst must not validate before the debounce emits");
    deb.flush(); // emit the latest value synchronously -- no wall clock
    await tick();
    assert.equal(q.length, before + 1, "flush collapses the burst into ONE validation");
    assert.equal(q[before].value, "abc", "the validated value is the latest in the burst");
    q[before].resolve("taken"); await tick();
    assert.equal(f.field("name").error.peek(), "taken");
    f.dispose();
});

test("lite-debounce recipe: dispose() tears down the caller's debounce handle", async () => {
    let disposeCalls = 0;
    const { validator, q } = deferredLane();
    const f = createForm({
        initialValues: { name: "" },
        validatorsAsync: { name: validator },
        asyncSources: {
            name: (fld) => {
                const deb = debounce(() => fld.value(), 300);
                const orig = deb.dispose.bind(deb);
                deb.dispose = () => { disposeCalls++; orig(); }; // spy the AM-6 teardown
                return deb;
            },
        },
    });
    await tick();
    q[0].resolve(null); await tick();
    f.dispose();
    assert.equal(disposeCalls, 1, "form.dispose() must call the caller reader handle's dispose()");
});

// --- recipe 2: server-error (409) flow --------------------------------------

test("server-error recipe: a 409 from onSubmit surfaces on the field via a caller signal", async () => {
    const reg = createRegistry({ maxNodes: 1 << 14, maxLinks: 1 << 16, onCapacityExceeded: "grow" });
    const serverErrors = reg.signal({}); // caller-owned { path: message }
    const f = createForm({
        initialValues: { email: "taken@x.com" },
        validate: () => serverErrors(),   // merge the server signal into the schema
        onSubmit: () => {
            serverErrors.set({ email: "already registered" }); // simulate the 409 body
            throw new Error("409");
        },
        registry: reg,
    });
    assert.equal(f.isValid(), true, "clean before submit");
    const ok = await f.submit();
    assert.equal(ok, false, "onSubmit threw -> submit resolved false");
    assert.equal(String(f.submitError()), "Error: 409");
    assert.equal(f.field("email").error(), "already registered", "the 409 shows on the field");
    assert.equal(f.isValid(), false, "the server error invalidates the form");
    f.dispose();
});

test("server-error recipe: editing the field clears the server error (caller-cleared)", async () => {
    const reg = createRegistry({ maxNodes: 1 << 14, maxLinks: 1 << 16, onCapacityExceeded: "grow" });
    const serverErrors = reg.signal({ email: "already registered" });
    const f = createForm({
        initialValues: { email: "taken@x.com" },
        validate: () => serverErrors(),
        registry: reg,
    });
    await f.submit(); // reveal
    assert.equal(f.field("email").error(), "already registered");
    // The caller clears the stale server error when the user edits.
    const un = f.field("email").value.subscribe(() => serverErrors.set({}));
    f.field("email").set("fresh@x.com");
    assert.equal(f.field("email").error(), null, "the server error cleared on edit");
    assert.equal(f.isValid(), true);
    un();
    f.dispose();
});

// --- D2: dirty-only patch submit --------------------------------------------

test("patch submit: submit(ev, {patch:true}) posts toPatch(), not values()", async () => {
    let got;
    const f = createForm({ initialValues: { a: 1, b: 2 }, onSubmit: (p) => { got = p; } });
    f.field("a").set(9);
    const ok = await f.submit(undefined, { patch: true });
    assert.equal(ok, true);
    assert.deepEqual(got, [{ path: "a", from: 1, to: 9 }]);
    f.dispose();
});

test("patch submit: an empty patch still runs onSubmit([])", async () => {
    let got = "unset";
    const f = createForm({ initialValues: { a: 1 }, onSubmit: (p) => { got = p; } });
    const ok = await f.submit(undefined, { patch: true });
    assert.equal(ok, true);
    assert.deepEqual(got, [], "empty patch still invokes onSubmit");
    f.dispose();
});
