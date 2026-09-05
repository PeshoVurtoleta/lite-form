// @zakkster/lite-form -- bench/bench.mjs
// Run: node --expose-gc bench/bench.mjs
//
// Honest, scoped measurements. Correctness claims (schema is hoisted, only the
// changed field re-validates) are proved by the test suite. The bench measures
// only what users care about timing-wise:
//
//   - Form lifecycle cost (create + dispose)
//   - Keystroke throughput on a non-trivial form
//   - Cross-field validation throughput
//   - A pure-JS baseline showing the work lite-form's caching avoids
//
// Each scenario reports transient bytes (peak before GC) and retained bytes
// (after a major GC), so the numbers tell you both alloc pressure AND leak risk.
import { createForm } from "../Form.js";
import { effect, stats, createRegistry } from "@zakkster/lite-signal";

const N_LIFECYCLE_SMALL = 20_000;
const N_LIFECYCLE_LARGE = 2_000;
const N_KEYSTROKES = 50_000;
const N_FIELDS_LARGE = 100;
const WARMUP_RATIO = 0.05;

const required = (v) => (v ? null : "required");
const email = (v) => (!v ? "required" : /@/.test(v) ? null : "invalid email");

// --- Memory helpers ---------------------------------------------------
function gc() { if (global.gc) global.gc(); }
function mem() { return process.memoryUsage().heapUsed; }

function fmtBytes(n) {
    if (!isFinite(n)) return "-";
    const a = Math.abs(n);
    if (a >= 1_000_000) return (n / 1_000_000).toFixed(2) + " MB";
    if (a >= 1_000) return (n / 1_000).toFixed(2) + " KB";
    return n.toFixed(0) + " B";
}
function fmtMs(n) { return n.toFixed(1).padStart(8) + " ms"; }
function fmtOps(n) { return n.toFixed(0).padStart(13); }
function pad(s, w) { return String(s).padEnd(w); }

// `setup()` returns either a `tick` function OR `{ tick, teardown }`.
function measure(label, N, setup) {
    const warm = Math.max(1, Math.floor(N * WARMUP_RATIO));
    const out = setup();
    const tick = typeof out === "function" ? out : out.tick;
    const teardown = typeof out === "function" ? null : out.teardown;
    for (let i = 0; i < warm; i++) tick(i);
    gc();
    const memStart = mem();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) tick(i);
    const t1 = process.hrtime.bigint();
    const transient = mem() - memStart;
    gc();
    const retained = mem() - memStart;
    const ms = Number(t1 - t0) / 1e6;
    const ops = (N * 1000) / ms;
    if (teardown) teardown();
    return { label, N, ms, ops, transient: transient / N, retained: retained / N };
}

function reportRow(r) {
    console.log(
        pad(r.label, 68),
        pad(r.N.toLocaleString(), 8),
        fmtMs(r.ms),
        fmtOps(r.ops),
        fmtBytes(r.transient).padStart(13),
        fmtBytes(r.retained).padStart(13),
    );
}

// --- Scenarios --------------------------------------------------------

// A) Create + dispose a small form. Measures lifecycle: eager field
//    allocation, signal/computed setup, dispose returns pool to baseline.
function scenarioA() {
    return measure(
        "A) create+dispose, small (3 fields, 1 validator)",
        N_LIFECYCLE_SMALL,
        () => () => {
            const f = createForm({
                initialValues: { name: "", email: "", age: 0 },
                validators: { email },
            });
            f.dispose();
        },
    );
}

// B) Larger form: 100 fields, each with a per-field validator. Cost should
//    scale linearly in field count. Each iteration is registry-scoped and
//    fully torn down.
function scenarioB() {
    const initialValues = {};
    const validators = {};
    for (let i = 0; i < N_FIELDS_LARGE; i++) {
        initialValues["f" + i] = "";
        validators["f" + i] = required;
    }
    return measure(
        `B) create+dispose, large (${N_FIELDS_LARGE} fields + per-field validators)`,
        N_LIFECYCLE_LARGE,
        () => () => {
            const reg = createRegistry({ maxNodes: 4096, maxLinks: 16384 });
            const f = createForm({ initialValues, validators, registry: reg });
            f.dispose();
        },
    );
}

// C) THE headline result. 100-field form, type only in f0, repeated N times.
//    Every field has a per-field validator AND an active error subscriber.
//    Demonstrates: typing in one field of a large form is O(1) -- only f0's
//    validator runs, the rest are untouched (their reveal-gated error()
//    short-circuits before reading rawError).
function scenarioC() {
    const initialValues = {};
    const validators = {};
    for (let i = 0; i < N_FIELDS_LARGE; i++) {
        initialValues["f" + i] = "";
        validators["f" + i] = required;
    }
    return measure(
        `C) keystroke on 1 of ${N_FIELDS_LARGE} fields (per-field validators)`,
        N_KEYSTROKES,
        () => {
            const reg = createRegistry({ maxNodes: 4096, maxLinks: 16384 });
            const f = createForm({ initialValues, validators, registry: reg });
            const stops = [];
            for (let i = 0; i < N_FIELDS_LARGE; i++) {
                stops.push(reg.effect(() => f.field("f" + i).error()));
            }
            const fld = f.field("f0");
            let k = 0;
            return {
                tick: () => {
                    k++;
                    // Toggle between two non-empty strings so the error stays
                    // null and we exercise the cutoff path. This is realistic
                    // typing -- validity doesn't flip on every keystroke.
                    fld.set("v" + (k & 1));
                },
                teardown: () => { stops.forEach(s => s()); f.dispose(); },
            };
        },
    );
}

// D) Schema-validated form, all fields revealed (submit-attempted). Schema
//    is hoisted to a single computed that runs once per keystroke regardless
//    of N. Each field reads schema[path] as a cached lookup.
function scenarioD() {
    const initialValues = {};
    for (let i = 0; i < N_FIELDS_LARGE; i++) initialValues["f" + i] = "";
    return measure(
        `D) keystroke on 1 of ${N_FIELDS_LARGE} fields (form-level schema, hoisted)`,
        N_KEYSTROKES,
        () => {
            const reg = createRegistry({ maxNodes: 4096, maxLinks: 16384 });
            const f = createForm({
                initialValues,
                validate: (vals) => {
                    const errs = {};
                    for (const k in vals) if (!vals[k]) errs[k] = "required";
                    return errs;
                },
                registry: reg,
            });
            const stops = [];
            for (let i = 0; i < N_FIELDS_LARGE; i++) {
                stops.push(reg.effect(() => f.field("f" + i).error()));
            }
            // Reveal all errors so the schema actually exercises its full path.
            f.submitAttempted.set(true);
            const fld = f.field("f0");
            let k = 0;
            return {
                tick: () => { k++; fld.set("v" + (k & 1)); },
                teardown: () => { stops.forEach(s => s()); f.dispose(); },
            };
        },
    );
}

// E) Cross-field dependency: confirm depends on pw via ctx.get("pw").
//    Every pw keystroke must re-run confirm's validator.
function scenarioE() {
    return measure(
        "E) cross-field validation (pw + confirm, ctx.get)",
        N_KEYSTROKES,
        () => {
            const f = createForm({
                initialValues: { pw: "", confirm: "" },
                validators: {
                    confirm: (v, { get }) => (v === get("pw") ? null : "must match"),
                },
                validateOn: "change",
            });
            const stop = effect(() => f.field("confirm").error());
            const fld = f.field("pw");
            let k = 0;
            return {
                tick: () => { k++; fld.set("v" + (k & 1)); },
                teardown: () => { stop(); f.dispose(); },
            };
        },
    );
}

// F) Pure-JS baseline -- what a hand-written form does without reactivity:
//    on every input, store the value AND re-run every validator AND notify
//    every "rendered" field component. This is what you'd write yourself in
//    plain JS / what a form library does if it doesn't cache. lite-form's job
//    is to do less work than this without you having to think about it.
function scenarioF() {
    return measure(
        `F) PURE-JS baseline: handwritten setValue runs all ${N_FIELDS_LARGE} validators`,
        N_KEYSTROKES,
        () => {
            const values = {};
            const errors = {};
            const subscribers = {};       // path -> [fn, ...]
            const validators = {};
            for (let i = 0; i < N_FIELDS_LARGE; i++) {
                values["f" + i] = "";
                errors["f" + i] = "required";
                validators["f" + i] = (v) => v ? null : "required";
                subscribers["f" + i] = [];
            }
            // Active "subscribers" simulating bound field components.
            let sink = 0;
            for (let i = 0; i < N_FIELDS_LARGE; i++) {
                subscribers["f" + i].push((err) => { sink += err ? 1 : 0; });
            }
            function setValue(path, val) {
                values[path] = val;
                // Re-run every validator (handwritten form has no caching)
                for (const k in validators) {
                    const newErr = validators[k](values[k]);
                    if (newErr !== errors[k]) {
                        errors[k] = newErr;
                        const subs = subscribers[k];
                        for (let i = 0; i < subs.length; i++) subs[i](newErr);
                    }
                }
            }
            let k = 0;
            return {
                tick: () => { k++; setValue("f0", "v" + (k & 1)); },
                teardown: () => { /* nothing reactive to dispose */ },
            };
        },
    );
}

// --- Main -------------------------------------------------------------
console.log("");
console.log("@zakkster/lite-form -- benchmark");
console.log(`Node: ${process.version} - ${new Date().toISOString()}`);
console.log("");
console.log(`Pre-bench activeNodes: ${stats().activeNodes}`);
console.log("");
console.log(
    pad("scenario", 68),
    pad("N", 8),
    "      ms total",
    "        ops/sec",
    "  transient/op",
    "    retained/op",
);
console.log("-".repeat(135));

const rows = [scenarioA(), scenarioB(), scenarioC(), scenarioD(), scenarioE(), scenarioF()];
for (const r of rows) reportRow(r);

console.log("");

gc();
const finalNodes = stats().activeNodes;
const poolClean = finalNodes === 0;
console.log(`Post-bench activeNodes: ${finalNodes} - ${poolClean ? "[ok] pool clean" : "[!] residual nodes"}`);

const C = rows[2], F = rows[5];
console.log("");
console.log(`Keystroke throughput on a ${N_FIELDS_LARGE}-field form: ${Math.round(C.ops).toLocaleString()} ops/sec`);
console.log(`vs pure-JS handwritten "run all validators":  ${Math.round(F.ops).toLocaleString()} ops/sec`);
console.log(`Speedup over the handwritten pattern:         ${(C.ops / F.ops).toFixed(1)}x (lite-form runs 1 validator instead of ${N_FIELDS_LARGE})`);
console.log("");
