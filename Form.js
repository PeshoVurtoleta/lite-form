/**
 * @zakkster/lite-form -- headless reactive forms for @zakkster/lite-signal
 * v1.2.0
 * -----------------------------------------------------------------------------
 * Form STATE as fine-grained signals. No DOM, no virtual DOM, no compiler -- bind
 * the field signals with @zakkster/lite-signal-dom (or anything). The only hard
 * dependency is lite-signal core; the value engine rides a @zakkster/lite-project
 * projection.
 *
 * ASYNC VALIDATION SEAM (off-cost when unused). `validatorsAsync[path]` adds a
 * per-field async lane: one form-owned effect reads the field's TRIGGER SOURCE
 * (its value by default, or a caller-supplied `asyncSources[path]` reader, e.g.
 * a lite-debounce handle over the field's value), runs the async validator, and
 * writes its verdict via a monotonic seq guard -- only the LATEST settlement
 * lands, stale ones are dropped whole (no signal write, no trace). A field
 * exposes `isValidating`; the form exposes `isValidating` (any lane pending).
 * This file holds no timer or scheduling machinery of any kind; debounce belongs
 * to the caller via the lite-debounce recipe. lite-form only sequences caller
 * promises with plain .then callbacks. A form with no async validators allocates NO per-field
 * async machinery and reproduces the no-async keystroke cost byte-for-byte.
 *
 * TWO VALIDATION MODES, both cutoff-gated:
 *  - Per-field validators (`validators[path]`) -- each reads ONLY its own value, so
 *    typing in one field runs exactly one validator. Zero allocation on the
 *    keystroke path.
 *  - Form-level schema (`validate(values)` -> { path: message }), e.g. Zod/Yup --
 *    HOISTED into a single `formErrors` computed that runs the schema ONCE per
 *    keystroke (not once per field). Each field reads formErrors[path] as an O(1)
 *    lookup; lite-signal's Object.is cutoff means only fields whose error actually
 *    changed propagate to the DOM. O(1) schema runs, O(1) DOM updates.
 *
 * Validity vs. display are split: a field's validity is always live (drives
 * isValid); the SHOWN error is reveal-gated (validateOn + submit-attempted) so a
 * pristine form doesn't scream "required" everywhere.
 *
 * FIELD ALLOCATION -- eager by default, lazy is SAFE. Fields are created up front
 * from initialValues + validators + fieldOpts: forms have a known, bounded field
 * set, so eager is the right default (it is also why per-field options live in
 * config, not in field() calls -- the field already exists by the time UI binds
 * it). Lazy field() for an undeclared path is fully supported and safe as of
 * lite-signal 1.5.0: an undeclared field allocated under a live tracking context
 * is created inside the form's own registry.createRoot(), so its nodes are NOT
 * children of the re-running effect that touched it and cannot self-destruct on
 * that effect's next run.
 *
 * Lives in the DEFAULT registry so its signals share ONE graph with the caller's
 * effects and lite-signal-dom (tracking is per-registry). Pass `registry` to
 * scope it; then bind with that registry's effect. dispose() frees every node.
 *
 * INVARIANTS
 *  - Unreachable baseline. initialValues is deep-copied ONCE at construction into
 *    a private baseline; no field, values() snapshot, or reset() ever hands the
 *    caller's object graph back out, so mutating a value() array/object cannot
 *    reach in and change the baseline (and vice versa).
 *  - Object.is dirty contract. dirty() is Object.is(value(), initialRef): an
 *    IN-PLACE mutation of an object/array value never flips dirty -- setting a NEW
 *    reference (field.set(next)) is the API. Reset re-captures initialRef so an
 *    object leaf is clean again after reset().
 *  - Construction-time cloneability whitelist. initialValues may hold only
 *    primitives, plain objects, arrays, and Dates; any function, Map, Set,
 *    RegExp, TypedArray, class instance, or symbol throws a path-named TypeError
 *    at createForm(), never later.
 *  - Snapshot boundary. values() deep-copies each field value through the same
 *    whitelist; an uncopyable RUNTIME value throws a path-named TypeError at
 *    the snapshot boundary, not a late DataCloneError. (The schema reads the
 *    zero-copy scratch instead -- see readScratch.)
 *
 * MIT (c) Zahary Shinikchiev
 */
import {
    signal as dSignal, computed as dComputed, batch as dBatch, untrack as dUntrack, dispose as dDispose,
    isTracking as dIsTracking, createRoot as dCreateRoot, effect as dEffect, hasObservers as dHasObservers,
} from "@zakkster/lite-signal";
import { createProjector, fromAccessors, fromProxy } from "@zakkster/lite-project";

export const VERSION = "1.2.0";

const NULL = () => null;                                  // shared "no validator" error source
const EMPTY = {};                                         // shared empty errors / opts
const normErr = (e) => (e ? e : null);                    // falsy (undefined/false/"") -> null
const eq = Object.is;
// Shared frozen ReadSignal-shaped FALSE: field/form isValidating on a form (or a
// field) with no async machinery. One constant, never a per-field signal.
const FALSE = () => false;
FALSE.peek = () => false;
// Merge verdict codes (reinitialize(next, policy)). Small ints, no per-row alloc.
const ADOPT = 0, ECHO = 1, CONFLICT = 2;
const isPlainObj = (v) => v != null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);

// Prototype-chain segments are rejected wherever a path enters the form: a
// "__proto__" walk in setPathSegs lands on Object.prototype (global pollution).
// Throw, not sanitize -- a silently dropped segment is silent data loss.
const hostileSeg = (k) => k === "__proto__" || k === "constructor" || k === "prototype";
const throwHostile = (k, path) => {
    throw new TypeError('[lite-form] hostile path segment "' + k + '" in "' + path + '"');
};

function guardPath(path) {
    if (path.indexOf(".") < 0) {
        if (hostileSeg(path)) throwHostile(path, path);
        return path;
    }
    const keys = path.split(".");
    for (let i = 0; i < keys.length; i++) {
        if (hostileSeg(keys[i])) throwHostile(keys[i], path);
    }
    return path;
}

// Cloneability whitelist. Reports what to do with a value, or throws a path-named
// TypeError for anything outside the whitelist (function, Map, Set, RegExp,
// TypedArray, class instance, symbol). A class instance is typeof "object" and
// not an Array/Date, so isPlainObj alone cannot spot it -- the prototype probe
// does: only Object.prototype (or a null prototype) counts as a plain object.
function throwUncopyable(v, path) {
    const t = typeof v === "object"
        ? (v && v.constructor && v.constructor.name) || "object"
        : typeof v;
    throw new TypeError('[lite-form] cannot deep-copy value of type "' + t + '" at "' + (path || "<root>") + '"');
}

function leafKind(v, path) {
    if (v === null) return "prim";
    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean" || t === "undefined" || t === "bigint") return "prim";
    if (t === "function" || t === "symbol") throwUncopyable(v, path);
    if (Array.isArray(v)) return "array";
    if (v instanceof Date) return "date";
    const proto = Object.getPrototypeOf(v);
    if (proto === Object.prototype || proto === null) return "object";
    throwUncopyable(v, path);
}

// Own keys of a container plus an explicit own-"__proto__" probe: JSON.parse of
// '{"__proto__":{}}' plants an own (data) __proto__ key that must be rejected
// even when it forms no leaf path, so it is always surfaced to the hostile check.
function ownKeys(src) {
    const ks = Object.keys(src);
    if (Object.prototype.hasOwnProperty.call(src, "__proto__") && ks.indexOf("__proto__") < 0) ks.push("__proto__");
    return ks;
}

// Self-contained iterative deep copy (explicit stack, no recursion). Primitives
// as-is; Date -> new Date(+v); Array/plain object -> a fresh container whose own
// keys are copied (arrays keep their length, so sparse holes survive). On EVERY container: a hostile own key (__proto__/constructor/
// prototype) throws (rejecting it even inside array elements -- copying such a
// key data-safely is a pollution trap); a container revisited on the in-progress
// stack PATH is a cycle and throws (only the ancestor chain is tracked, so a
// shared non-cyclic subtree is legal and gets copied independently); any other
// type throws a path-named TypeError. Used by the construction walk, by makeField
// seeding, by reset, and by snapshot materialization.
function copyLeaf(root, rootPath) {
    const rp = rootPath === undefined ? "" : rootPath;
    const rk = leafKind(root, rp);
    if (rk === "prim") return root;
    if (rk === "date") return new Date(+root);
    const result = rk === "array" ? new Array(root.length) : {};
    const onPath = new Set();
    onPath.add(root);
    const stack = [{src: root, dst: result, keys: ownKeys(root), i: 0, path: rp}];
    while (stack.length > 0) {
        const fr = stack[stack.length - 1];
        if (fr.i >= fr.keys.length) {
            onPath.delete(fr.src);
            stack.pop();
            continue;
        }
        const k = fr.keys[fr.i++];
        const p = fr.path;
        if (hostileSeg(k)) throwHostile(k, p ? p + "." + k : k);
        const cp = p ? (p + "." + k) : k;
        const cv = fr.src[k];
        const ck = leafKind(cv, cp);
        if (ck === "prim") { fr.dst[k] = cv; continue; }
        if (ck === "date") { fr.dst[k] = new Date(+cv); continue; }
        if (onPath.has(cv)) throw new TypeError('[lite-form] cycle at "' + cp + '"');
        const cd = ck === "array" ? new Array(cv.length) : {};
        fr.dst[k] = cd;
        onPath.add(cv);
        stack.push({src: cv, dst: cd, keys: ownKeys(cv), i: 0, path: cp});
    }
    return result;
}

// The construction walk: deep-copy initialValues into the private baseline,
// rejecting hostile own keys, cycles, and any non-whitelisted type, with a
// path-tracked message. Thin over copyLeaf so construction and every later copy
// share one code path (and one reproto-control anchor).
function cloneConfig(src) {
    return copyLeaf(src);
}

// Read a leaf from the baseline by cached segments -- flat (segs null) is a
// direct property read; dotted walks the pre-split segs, no split per call.
// guardPath already validated the segments, so no hostile check here.
function readBase(base, path, segs) {
    if (base == null) return undefined;
    if (segs === null) return base[path];
    let o = base;
    for (let i = 0; i < segs.length && o != null; i++) o = o[segs[i]];
    return o;
}

// segs-aware twin of the old string setPath: same array/{} materialization logic
// (choose an array when the next segment is a numeric index), but walking the
// pre-split segments so a snapshot leaf costs no split.
function setPathSegs(obj, path, segs, val) {
    if (segs === null) {
        if (hostileSeg(path)) throwHostile(path, path);
        obj[path] = val;
        return;
    }
    let o = obj;
    for (let i = 0; i < segs.length - 1; i++) {
        const k = segs[i];
        if (hostileSeg(k)) throwHostile(k, path);
        // Keep existing objects AND arrays while descending; only materialize a missing
        // container, choosing an array when the next key is a numeric index.
        if (!(isPlainObj(o[k]) || Array.isArray(o[k]))) {
            o[k] = /^\d+$/.test(segs[i + 1]) ? [] : {};
        }
        o = o[k];
    }
    const last = segs[segs.length - 1];
    if (hostileSeg(last)) throwHostile(last, path);
    o[last] = val;
}

function leafPaths(obj, prefix, out) {                    // flatten baseline to dotted leaf paths
    for (const k in obj) {
        const p = prefix ? prefix + "." + k : k;
        if (isPlainObj(obj[k])) leafPaths(obj[k], p, out);
        else out.push(p);
    }
    return out;
}

function evValue(ev) {                                    // extract a value from a DOM event (props())
    const t = ev && ev.target;
    if (!t) return ev;
    return t.type === "checkbox" ? t.checked : t.value;
}

/**
 * @param {{
 *   initialValues?: object,
 *   validators?: Record<string, (value:any, ctx:{get:(path:string)=>any}) => (string|null|false|undefined)>,
 *   validate?: (values:object) => Record<string, string|null|false|undefined>,
 *   fieldOpts?: Record<string, { parse?: (raw:any)=>any, format?: (value:any)=>any }>,
 *   validateOn?: "change" | "blur" | "submit",
 *   onSubmit?: (values:object) => void | Promise<void>,
 *   registry?: object,
 * }} [config]
 * @throws {TypeError} if initialValues carries a hostile own key, a cycle, or a
 *   value outside the cloneability whitelist.
 */
export function createForm(config = {}) {
    const {
        initialValues = {},
        validators = {},
        validate,
        fieldOpts = EMPTY,
        validateOn = "change",
        onSubmit,
        registry,
        validatorsAsync = EMPTY,
        asyncSources = EMPTY,
    } = config;

    // Async seam wiring. asyncPaths / hasAsync gate every off-cost decision: a
    // form with no async validators allocates none of the per-field lane machinery
    // and adds no signal reads to the keystroke path.
    const asyncPaths = Object.keys(validatorsAsync);
    const hasAsync = asyncPaths.length > 0;
    const asyncLanes = [];                                // per-async-field lanes, torn down on dispose
    let disposed = false;                                 // set FIRST in dispose(): a post-dispose settlement is a no-op

    const S = registry ? registry.signal : dSignal;
    const C = registry ? registry.computed : dComputed;
    const B = registry ? registry.batch : dBatch;
    const D = registry ? registry.dispose : dDispose;
    const U = registry ? registry.untrack : dUntrack;
    const CR = registry ? registry.createRoot : dCreateRoot;
    const EF = registry ? registry.effect : dEffect;
    const HO = registry ? registry.hasObservers : dHasObservers;
    const owned = [];
    const sig = (v) => {
        const h = S(v);
        owned.push(h);
        return h;
    };
    const cmp = (fn) => {
        const h = C(fn);
        owned.push(h);
        return h;
    };

    // Private baseline: initialValues deep-copied ONCE, whitelist-validated, so it
    // is never reachable from any value the caller can see or mutate. A `let` so
    // reinitialize(next) can atomically swap in a fresh validated tree.
    let baseline = isPlainObj(initialValues) ? cloneConfig(initialValues) : {};

    const fields = new Map();                             // path -> field record
    const fieldList = [];                                 // parallel plain array of records: walked index-wise (no per-entry array alloc on the schema path). Fields are never removed, so push-only.
    const subDisposers = [];                              // subscribe() effect disposers, drained on dispose()
    const submitAttempted = sig(false);
    const submitting = sig(false);
    const submitErr = sig(null);

    // Form-level count of async lanes whose LATEST seq is unsettled. Allocated
    // ONLY when the form has async fields (off-cost otherwise). Increments on a
    // lane.pending false->true edge, decrements only when a latest-seq settlement
    // flips it true->false -- a re-trigger while already pending bumps seq only.
    const pendingCount = hasAsync ? sig(0) : null;
    // Merge verdict scratch (reinitialize(next, policy)): form-owned, lazily
    // allocated on first merge, length-reused after. Never touched by a hot path.
    let verdicts = null;
    // Re-entrancy latch: a merge policy must be PURE. Verdicts are pre-scanned
    // against a snapshot of the drafts; a policy that mutated the form mid-scan
    // would have those verdicts applied over different state (and a nested merge
    // would splice the reused verdicts scratch). Every mutating entry point
    // throws while the latch is up -- pre-scan through the apply flush.
    let merging = false;
    const throwMerging = () => { throw new TypeError("[lite-form] cannot mutate the form from inside a merge policy"); };

    // ENGINE. lite-form's value core is a lite-project projection. In the default
    // mode the projection rides fromAccessors over the detached baseline; in
    // source mode (config.source) it rides fromProxy over a live keyed source.
    // Mode is resolved ONCE here so no keystroke body branches on it.
    const sourceMode = config.source !== undefined;

    // baselineRev: the ONLY new read-path signal. baselineGet tracks it; it is
    // BUMPED (never read) on reset/commit/reinitialize so a pristine (never-
    // overlaid) field's projected computed re-runs when the baseline changes
    // underneath it. A plain tree tracks nothing on its own.
    const baselineRev = sig(0);
    const bumpRev = () => baselineRev.set(baselineRev.peek() + 1);

    // Source accessors for the detached-baseline projection (default mode).
    // baselineGet: tracked read of the field's captured seed copy; an unregistered
    // path fails closed. baselineSet (engine-commit only, cold): deep-copies the
    // committed value into the baseline, then re-captures initialRef as a SECOND
    // copy so the handed-out ref never aliases the baseline tree.
    function baselineGet(path) {
        baselineRev();
        const f = fields.get(path);
        if (f === undefined) throw new TypeError('[lite-form] engine read for unregistered path "' + path + '"');
        return f.initialRef;
    }
    function baselineSet(path, v) {
        const f = fields.get(path);
        const landed = copyLeaf(v, path);
        setPathSegs(baseline, path, f.segs, landed);
        f.initialRef = copyLeaf(landed, path);
    }

    // The projection lives in the FORM's registry (never the default one unless the
    // form itself is default). The engine handles per-key createRoot detachment
    // internally, so lite-form never wraps slot creation in its own createRoot.
    const projReg = {signal: S, computed: C, createRoot: CR, dispose: D, untrack: U, batch: B, hasObservers: HO};
    const projector = createProjector(projReg);
    const handle = sourceMode
        ? projector.project(fromProxy(config.source))
        : projector.project(fromAccessors(baselineGet, baselineSet));

    // Schema materialization scratch (default mode): a per-form tree reused in
    // place across keystrokes; rebuilt only when the baseline shape changes
    // (reinitialize) or a commit lands. null means "rebuild on next read".
    let scratch = null;

    // Reactive cross-field accessor handed to every per-field validator: ctx.get('x')
    // reads another field's value AND tracks it (so a dependent re-validates when its
    // sibling changes) without building a snapshot object.
    const ctx = {get: (path) => getField(path).value()};

    // Deep-copy the baseline branches, then overwrite each field's leaf with a
    // deep copy of read(f). copyLeaf throws a path-named TypeError on an
    // uncopyable RUNTIME value (replacing the old late DataCloneError); undefined
    // lazy-field values still appear in the output.
    function materialize(read) {
        const out = copyLeaf(baseline);
        for (const [path, f] of fields) setPathSegs(out, path, f.segs, copyLeaf(read(f), path));
        return out;
    }

    // TRACKED, ZERO-COPY schema materialization. Unlike materialize() (a full
    // deep-copy snapshot), this reuses a per-form scratch tree: the baseline
    // branches are cloned ONCE (first read, or after invalidation), then every
    // field's current value() is written into its leaf IN PLACE via the segs walk
    // -- object leaves by reference. Reading value() tracks each field, so
    // formErrors depends on every field. The scratch is form-owned and transient:
    // retaining or mutating the object handed to validate() is undefined behaviour.
    // A lazy field on a NEW path materializes its containers in place on next read.
    function readScratch() {
        if (scratch === null) scratch = copyLeaf(baseline);
        for (let i = 0; i < fieldList.length; i++) {
            const f = fieldList[i];
            setPathSegs(scratch, f.path, f.segs, f.value());
        }
        return scratch;
    }

    // Hoisted schema: runs validate() exactly ONCE per values change, not once per field.
    const formErrors = validate ? cmp(() => validate(readScratch()) || EMPTY) : null;

    function makeField(path) {
        guardPath(path);                                  // sole fields.set site: no hostile path is ever cached
        const segs = path.indexOf(".") < 0 ? null : path.split(".");
        const seeded = copyLeaf(readBase(baseline, path, segs));
        const validator = validators[path];
        const asyncFn = validatorsAsync[path];
        const o = fieldOpts[path] || EMPTY;

        // initialRef migrates onto the record: dirty() then costs one property load.
        // asyncLane is null on EVERY record (uniform hidden class) -- populated only
        // for a path that has an async validator, so a sync-only field pays nothing.
        const f = {
            path,
            segs,                                         // cached path segments for the snapshot walk
            initialRef: seeded,
            asyncLane: null,
        };

        // value is a WritableSignal-shaped facade over the engine handle. value()
        // reads the projected computed (tracks); value.peek() is the untracked
        // effective read. value.set is the mode-chosen closure (built once): default
        // mode clears-on-initial so overlay presence coincides with dirty; source
        // mode always overlays. No mode branch executes on the keystroke.
        const value = () => handle.get(path);
        value.peek = () => handle.peek(path);
        value.set = sourceMode
            ? (v) => { if (merging) throwMerging(); handle.set(path, v); }
            : (v) => { if (merging) throwMerging(); if (eq(v, f.initialRef)) handle.clear(path); else handle.set(path, v); };
        value.update = (fn) => value.set(fn(handle.peek(path)));
        value.subscribe = (fn) => {
            // Detached (createRoot) so a subscribe called inside a consumer effect
            // is NOT cascade-disposed with that effect; the disposer is form-owned.
            // fn runs untracked (subscribe callbacks subscribe to nothing).
            const disp = CR(() => EF(() => { const v = handle.get(path); U(() => fn(v)); }));
            subDisposers.push(disp);
            return () => {
                // Only dispose while still form-owned: after form.dispose() has
                // drained subDisposers, a late user-held unsubscribe is a no-op
                // (never a second disp() into an already-recycled node).
                const idx = subDisposers.indexOf(disp);
                if (idx >= 0) { subDisposers.splice(idx, 1); disp(); }
            };
        };

        const touched = sig(false);
        // Per-field validity: depends ONLY on this field's value (lean keystroke path).
        const rawError = validator ? cmp(() => normErr(validator(value(), ctx))) : NULL;
        // Default dirty is one closure read + one Object.is against the captured
        // initialRef -- the S1 compare. It must ALSO track baselineRev: initialRef
        // is a plain property, and commit()/forced-echo merge re-capture it while
        // value()'s output stays identical (folding is value-preserving), so the
        // value cutoff alone would strand a pre-commit cached dirty=true (LF-12).
        // Source dirty is overlay presence (dirtyCount() is the tracked engine
        // signal; isOverlaid the per-key read).
        const dirty = sourceMode
            ? cmp(() => { void handle.dirtyCount(); return handle.isOverlaid(path); })
            : cmp(() => { baselineRev(); return !eq(value(), f.initialRef); });
        // Async lane: allocated ONLY for a path with an async validator. Its seq +
        // pending + err signals exist here so f.isValidating can point at pending
        // and the error body can read err; the reader factory + settlement effect
        // are wired AFTER the record is fully assembled (see wireAsyncLane).
        const lane = asyncFn
            ? { seq: 0, pending: sig(false), err: sig(null), reader: null, ownReader: null, disp: null }
            : null;
        if (lane) f.asyncLane = lane;
        // Displayed error: reveal-gated; per-field error first, then schema fallback.
        // Reading formErrors() here is an O(1) lookup whose result is Object.is-cutoff,
        // so a field only re-renders when ITS message changes. TWO hoisted bodies:
        // the sync variant is byte-identical to the no-async build; the async variant
        // additionally surfaces the latest-seq lane verdict (lane.err).
        const error = lane
            ? cmp(() => {
                const reveal = submitAttempted()
                    || (validateOn === "change" ? dirty()
                        : validateOn === "blur" ? touched()
                            : false);
                if (!reveal) return null;
                const own = rawError();
                if (own) return own;
                const ae = lane.err();
                if (ae) return ae;
                return formErrors ? normErr(formErrors()[path]) : null;
            })
            : cmp(() => {
                const reveal = submitAttempted()
                    || (validateOn === "change" ? dirty()
                        : validateOn === "blur" ? touched()
                            : false);
                if (!reveal) return null;
                const own = rawError();
                if (own) return own;
                return formErrors ? normErr(formErrors()[path]) : null;
            });

        f.value = value;                                  // value() reads+tracks; value.peek() untracked
        f.error = error;                                  // error() = displayed error (reveal-gated)
        f.dirty = dirty;                                  // dirty() = overlay presence / value !== initialRef
        f.touched = touched;                              // touched() reads
        f.rawError = rawError;                            // internal: per-field validity for isValid
        f.isValidating = lane ? lane.pending : FALSE;     // per-field pending; shared FALSE when sync-only
        f.set = value.set;
        f.blur = () => { if (merging) throwMerging(); touched.set(true); };
        f.reset = sourceMode
            ? () => { if (merging) throwMerging(); handle.clear(path); }
            : () => { if (merging) throwMerging(); B(() => { resetField(f); bumpRev(); }); };
        f.props = () => ({
            value: o.format ? o.format(value()) : value(),
            onInput: (ev) => value.set(o.parse ? o.parse(evValue(ev)) : evValue(ev)),
            onBlur: () => { if (merging) throwMerging(); touched.set(true); },
        });

        fields.set(path, f);
        fieldList.push(f);
        U(() => handle.get(path));                        // warm the slot AFTER fields.set (baselineGet needs the record)
        if (lane) wireAsyncLane(f, lane, asyncFn);        // reader factory + effect AFTER the record is fully assembled
        return f;
    }

    // Wire an async field's lane: call the (optional) reader factory now that the
    // field record is fully assembled (value facade + isValidating present -- AM-5),
    // then create ONE form-owned effect that tracks the reader and (re)triggers the
    // async validator. A factory that throws propagates -> construction fails closed.
    // The default reader is the field's own value facade and is NEVER torn down.
    function wireAsyncLane(f, lane, asyncFn) {
        const factory = asyncSources[f.path];
        const reader = factory ? factory(f, ctx) : f.value;
        lane.reader = reader;
        if (factory) lane.ownReader = reader;             // caller-owned handle (e.g. debounce): disposed on teardown
        // Detached (createRoot) so this effect is form-owned, not a child of any
        // consumer that happened to be tracking at construction.
        lane.disp = CR(() => EF(() => {
            const v = lane.reader();                      // tracks the trigger source (value or debounced source)
            U(() => triggerAsync(lane, asyncFn, v));
        }));
        asyncLanes.push(lane);
    }

    // (Re)trigger the async validator for a lane. Bumps the monotonic seq; a
    // pending false->true edge increments pendingCount ONCE (a re-trigger while
    // already pending bumps seq only). A synchronous throw is a rejection.
    function triggerAsync(lane, asyncFn, v) {
        const mySeq = ++lane.seq;
        if (!lane.pending.peek()) {
            B(() => { lane.pending.set(true); pendingCount.set(pendingCount.peek() + 1); });
        }
        let p;
        try { p = asyncFn(v, ctx); }
        catch (e) { settleAsync(lane, mySeq, e, true); return; }
        // Normalize (a non-promise return settles on a microtask). Both arms attach
        // so no settlement path can surface an unhandledRejection.
        Promise.resolve(p).then(
            (msg) => settleAsync(lane, mySeq, msg, false),
            (reason) => settleAsync(lane, mySeq, reason, true),
        );
    }

    // Land a settlement IFF it is the latest seq and the form is live. A stale or
    // post-dispose settlement is dropped WHOLE -- no signal write, no trace. A
    // rejection can never leave the field valid: it coerces to a non-empty string.
    function settleAsync(lane, mySeq, payload, rejected) {
        if (disposed || lane.seq !== mySeq) return;
        const msg = rejected
            ? (String(payload && payload.message || payload) || "async validator rejected")
            : normErr(payload);
        B(() => {
            lane.err.set(msg);
            if (lane.pending.peek()) { lane.pending.set(false); pendingCount.set(pendingCount.peek() - 1); }
        });
    }

    // Internal per-field reset body (default mode), no rev bump. Re-captures
    // initialRef from a FRESH copy so dirty() reads false again after reset even
    // for an object/array leaf, then drops any overlay.
    function resetField(f) {
        const fresh = copyLeaf(readBase(baseline, f.path, f.segs));
        f.initialRef = fresh;
        handle.clear(f.path);
        f.touched.set(false);
    }

    function getField(path) {
        const f = fields.get(path);
        if (f !== undefined) return f;                    // falsy-record fail-closed: only a real record hits
        // Creation is a mutation: a field born mid-merge would seed its initialRef
        // from the pre-merge baseline outside the verdict loop (which captured n).
        if (merging) throwMerging();
        return lazyField(path);
    }

    // Cold path for an undeclared field. Under a live tracking context the new
    // nodes would otherwise be children of the re-running effect that touched the
    // field; createRoot detaches ownership so they belong to the form, not the
    // effect. Registry-scoped forms use the form's OWN registry surface.
    function lazyField(path) {
        const tracking = registry ? registry.isTracking() : dIsTracking();
        if (!tracking) return makeField(path);
        return registry ? registry.createRoot(() => makeField(path)) : dCreateRoot(() => makeField(path));
    }

    // Eager allocation: every declared field, up front, outside any render effect.
    {
        const declared = new Set(Object.keys(validators));
        Object.keys(fieldOpts).forEach((p) => declared.add(p));
        Object.keys(validatorsAsync).forEach((p) => declared.add(p));
        Object.keys(asyncSources).forEach((p) => declared.add(p));
        leafPaths(baseline, "", []).forEach((p) => declared.add(p));
        declared.forEach(makeField);
    }

    // isValid = no schema errors AND no per-field validator errors. Schema runs once
    // (formErrors cached); per-field rawErrors are cached, so typing one field doesn't
    // re-run the others. Cutoff stops isValid recomputing while validity is unchanged.
    // TWO hoisted bodies. No async paths -> the no-async build verbatim. With async
    // paths -> D6 strict-false while any lane is pending (isValidating() true implies
    // isValid() false -- the fail-closed submit gate needs no extra submit code),
    // then the same schema + per-field checks, then each lane's latest verdict.
    const isValid = hasAsync
        ? cmp(() => {
            if (pendingCount() > 0) return false;
            if (formErrors) {
                const e = formErrors();
                for (const k in e) if (e[k]) return false;
            }
            for (const path in validators) {
                if (getField(path).rawError() != null) return false;
            }
            for (let i = 0; i < asyncPaths.length; i++) {
                if (getField(asyncPaths[i]).asyncLane.err() != null) return false;
            }
            return true;
        })
        : cmp(() => {
            if (formErrors) {
                const e = formErrors();
                for (const k in e) if (e[k]) return false;
            }
            for (const path in validators) {
                if (getField(path).rawError() != null) return false;
            }
            return true;
        });
    // form.isValidating: shared FALSE when no async fields (off-cost), else true
    // exactly while some lane's latest seq is unsettled.
    const isValidating = hasAsync ? cmp(() => pendingCount() > 0) : FALSE;
    // Clear-on-initial (default) makes overlay presence coincide with dirty, so the
    // form-level flag is the tracked engine count. Source mode reads the same count
    // (overlay presence is the honest dirty signal without a captured baseline).
    const isDirty = cmp(() => handle.dirtyCount() > 0);

    function values() {                                   // untracked snapshot (for submit / external reads)
        return materialize((f) => f.value.peek());
    }

    function setValues(patch) {
        B(() => {
            for (const path in patch) getField(path).set(patch[path]);
        });
    }

    function reset() {
        if (merging) throwMerging();
        if (sourceMode) { handle.revert(); return; }
        B(() => {
            for (let i = 0; i < fieldList.length; i++) resetField(fieldList[i]);
            submitAttempted.set(false);
            submitErr.set(null);
            bumpRev();
        });
    }

    // Fold dirty values into the baseline via the engine, then re-seed. commit()
    // writes ALL overlays; clear-on-initial means an overlaid key IS a dirty key,
    // so a set-back-to-initial field is never visited. commit(path) folds one key.
    // Committed values are deep-copied through the whitelist (baselineSet).
    function commit(path) {
        if (merging) throwMerging();
        B(() => {
            if (path !== undefined) {
                guardPath(path);
                // Fail closed: an unregistered path is an error, never a lazy
                // field creation -- getField here would permanently inject a
                // phantom field for a typo'd commit and then no-op.
                if (fields.get(path) === undefined) {
                    throw new TypeError('[lite-form] commit() for unregistered path "' + path + '"');
                }
                handle.commit(path);
            } else {
                handle.commit();
            }
            bumpRev();
            scratch = null;
        });
    }

    // Exactly the dirty paths as [{path, from, to}] (from = baseline value, to =
    // current). Untracked + read-only: safe inside an effect. Our records, so the
    // key is renamed `path`.
    function toPatch() {
        const out = [];
        handle.forEachPatch((k, from, to) => out.push({path: k, from, to}));
        return out;
    }

    // Re-seed the whole form like initialValues, in one of TWO shapes:
    //
    //  1-arg reinitialize(next) -- FROZEN 1.2.0 contract (both modes): atomic
    //    validate+copy, then drop EVERY edit. Every field re-captures its initialRef
    //    from the new baseline (absent path -> undefined); overlays reverted;
    //    touched + submit state cleared.
    //
    //  2-arg reinitialize(next, policy) -- MERGE (default mode only). Fresh server
    //    data lands WHILE the user edits: a pristine field adopts the new value, a
    //    dirty field whose edit the server ECHOed goes pristine at the new value, a
    //    dirty field whose edit CONFLICTs keeps the draft (masking the new value)
    //    but re-seeds the baseline underneath so reset()/toPatch() target it. The
    //    merge is atomic: validate+copy and the verdict pre-scan run with NO
    //    mutation, so a hostile leaf OR a throwing policy leaves the form untouched.
    function reinitialize(next, policy) {
        if (merging) throwMerging();
        if (policy === undefined) {
            if (!isPlainObj(next)) throw new TypeError("[lite-form] reinitialize(next) requires a plain object");
            const nb = cloneConfig(next);                 // throws BEFORE any mutation -> atomic
            B(() => {
                baseline = nb;
                handle.revert();
                for (let i = 0; i < fieldList.length; i++) {
                    const fresh = fieldList[i];
                    const reseed = copyLeaf(readBase(baseline, fresh.path, fresh.segs));
                    fresh.initialRef = reseed;
                    fresh.touched.set(false);
                }
                submitAttempted.set(false);
                submitErr.set(null);
                bumpRev();
                scratch = null;
            });
            return;
        }
        // --- 2-arg MERGE ------------------------------------------------------
        // PHASE 0 REFUSE (no mutation).
        if (sourceMode) throw new TypeError("[lite-form] merge-reinitialize is default-mode only; use reconcile(policy)");
        if (!isPlainObj(next)) throw new TypeError("[lite-form] reinitialize(next, policy) requires a plain object");
        if (typeof policy !== "function") throw new TypeError("[lite-form] reinitialize(next, policy) requires a function policy");
        // PHASE 1 VALIDATE+COPY (no mutation; hostile key/cycle/uncopyable throws).
        const nb = cloneConfig(next);
        // PHASE 2 PRE-SCAN VERDICTS (no mutation). A throw from the policy propagates
        // HERE, before any state change -- the merge is atomic on a throwing policy.
        const n = fieldList.length;
        if (verdicts === null || verdicts.length < n) verdicts = new Array(n);
        // The latch stays up through the apply FLUSH (effects run at batch close),
        // so caller code reached from either window cannot mutate mid-merge.
        merging = true;
        try {
            for (let i = 0; i < n; i++) {
                const fld = fieldList[i];
                const ni = readBase(nb, fld.path, fld.segs);  // next-baseline leaf (undefined when absent)
                if (!handle.isOverlaid(fld.path)) { verdicts[i] = ADOPT; continue; }
                const d = handle.peek(fld.path);              // current draft
                // FORCED ECHO: eq(ni,d) short-circuits the policy (protects clear-on-
                // initial). FAIL CLOSED: only === true is ECHO; any other return CONFLICTs.
                verdicts[i] = (eq(ni, d) || policy(ni, d) === true) ? ECHO : CONFLICT;
            }
            // PHASE 3 APPLY in ONE batch. Reseed initialRef ALWAYS (every row); ADOPT/ECHO
            // clear touched, CONFLICT leaves touched + overlay. submit state NOT written.
            B(() => {
                baseline = nb;
                for (let i = 0; i < n; i++) {
                    const fld = fieldList[i];
                    fld.initialRef = copyLeaf(readBase(baseline, fld.path, fld.segs));
                    const v = verdicts[i];
                    if (v === ADOPT) { fld.touched.set(false); }
                    else if (v === ECHO) { handle.clear(fld.path); fld.touched.set(false); }
                    // CONFLICT: overlay left in place, touched untouched.
                }
                bumpRev();                                    // LAST write, exactly once
                scratch = null;
            });
        } finally {
            merging = false;
        }
    }

    // Source-mode reconciliation: drop every overlay the policy confirms against the
    // CURRENT (untracked) source value; conflicts stay masked. Default policy is
    // confirmOnEcho (Object.is). In DEFAULT mode this is a near-no-op: clear-on-
    // initial means an overlay only exists when value differs from initialRef, so
    // Object.is(initialRef, overlay) is never true and nothing is dropped (AM-7).
    function reconcile(policy) {
        if (merging) throwMerging();
        if (policy !== undefined && typeof policy !== "function") {
            throw new TypeError("[lite-form] reconcile(policy) requires a function policy");
        }
        handle.reconcileAll(policy || eq);
    }

    async function submit(ev, opts) {
        if (merging) throwMerging();
        if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
        submitAttempted.set(true);                        // reveals all errors
        // untrack the validity read + the userland callback so submit() can be called
        // from inside a reactive context without onSubmit's own signal reads
        // (auth.token(), etc.) silently leaking in as dependencies. isValid() is
        // strict-false while any async lane is pending (D6), so a submit racing a
        // pending verdict fails closed here with no extra submit code.
        if (!U(() => isValid())) return false;
        if (!onSubmit) return true;
        submitting.set(true);
        submitErr.set(null);
        try {
            // opts.patch posts toPatch() (dirty-only) instead of the full values().
            await U(() => onSubmit(opts && opts.patch ? toPatch() : values()));
            return true;
        } catch (err) {
            // Structural code bugs aren't legitimate submission outcomes -- surface them
            // loudly instead of hiding them in submitError. TypeError is deliberately
            // NOT here: the browser fetch() API rejects with a TypeError on network
            // failure, and that IS valid submitError content.
            if (err instanceof ReferenceError || err instanceof SyntaxError) {
                console.error("[lite-form] bug thrown inside onSubmit:", err);
                throw err;
            }
            submitErr.set(err);
            return false;
        } finally {
            submitting.set(false);
        }
    }

    return {
        field: getField,                                  // field(path) -> field record
        values,                                           // values() -> snapshot (untracked)
        setValues,                                        // setValues({path: v, ...}) (batched)
        reset,                                            // reset() -> back to initialValues
        commit,                                           // commit(path?) -> fold dirty values into the baseline
        toPatch,                                          // toPatch() -> [{path, from, to}] for the dirty paths
        reinitialize,                                     // reinitialize(next[, policy]) -> re-seed / merge
        reconcile,                                        // reconcile(policy?) -> drop policy-confirmed overlays (source mode)
        submit,                                           // submit(ev?, opts?) -> Promise<boolean> (validates, then onSubmit)
        isValid,                                          // isValid() -> reactive boolean (true validity)
        isDirty,                                          // isDirty() -> reactive boolean
        isValidating,                                     // isValidating() -> reactive boolean (any async lane pending)
        isSubmitting: submitting,                         // isSubmitting() -> reactive boolean
        submitError: submitErr,                           // submitError() -> last submit throw, or null
        submitAttempted,                                  // submitAttempted() -> reactive boolean
        dispose: () => {
            if (merging) throwMerging();
            disposed = true;                              // FIRST: any post-dispose settlement is now a no-op
            for (let i = 0; i < asyncLanes.length; i++) {
                const lane = asyncLanes[i];
                if (lane.disp) lane.disp();               // stop the settlement effect
                // Tear down a caller-owned reader handle (e.g. a lite-debounce api,
                // whose disposal contract is api.dispose()); the default reader is
                // the field's own value facade and is NEVER disposed.
                if (lane.ownReader && typeof lane.ownReader.dispose === "function") lane.ownReader.dispose();
            }
            asyncLanes.length = 0;
            handle.dispose();                             // recycle every projection-owned node
            for (let i = 0; i < subDisposers.length; i++) subDisposers[i]();
            subDisposers.length = 0;
            for (const h of owned) D(h);
            owned.length = 0;
            fields.clear();
            fieldList.length = 0;
        },
    };
}
