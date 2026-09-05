/**
 * @zakkster/lite-form -- headless reactive forms for @zakkster/lite-signal
 * v1.0.2
 * -----------------------------------------------------------------------------
 * Form STATE as fine-grained signals. No DOM, no virtual DOM, no compiler -- bind
 * the field signals with @zakkster/lite-signal-dom (or anything). The only hard
 * dependency is lite-signal core; async validation (lite-resource), field arrays,
 * and draft persistence (lite-persist) layer on top without bloating this core.
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
 *  - Snapshot boundary. values()/readValues() deep-copy each field value through
 *    the same whitelist; an uncopyable RUNTIME value throws a path-named
 *    TypeError at the snapshot boundary, not a late DataCloneError.
 *
 * MIT (c) Zahary Shinikchiev
 */
import {
    signal as dSignal, computed as dComputed, batch as dBatch, untrack as dUntrack, dispose as dDispose,
    isTracking as dIsTracking, createRoot as dCreateRoot,
} from "@zakkster/lite-signal";

export const VERSION = "1.0.2";

const NULL = () => null;                                  // shared "no validator" error source
const EMPTY = {};                                         // shared empty errors / opts
const normErr = (e) => (e ? e : null);                    // falsy (undefined/false/"") -> null
const eq = Object.is;
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
    } = config;

    const S = registry ? registry.signal : dSignal;
    const C = registry ? registry.computed : dComputed;
    const B = registry ? registry.batch : dBatch;
    const D = registry ? registry.dispose : dDispose;
    const U = registry ? registry.untrack : dUntrack;
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
    // is never reachable from any value the caller can see or mutate.
    const baseline = isPlainObj(initialValues) ? cloneConfig(initialValues) : {};

    const fields = new Map();                             // path -> field record
    const submitAttempted = sig(false);
    const submitting = sig(false);
    const submitErr = sig(null);

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

    // TRACKED values builder for the schema. Unlike values() (peek-based snapshot for
    // submit), this reads each field via value() so formErrors depends on every field.
    function readValues() {
        return materialize((f) => f.value());
    }

    // Hoisted schema: runs validate() exactly ONCE per values change, not once per field.
    const formErrors = validate ? cmp(() => validate(readValues()) || EMPTY) : null;

    function makeField(path) {
        guardPath(path);                                  // sole fields.set site: no hostile path is ever cached
        const segs = path.indexOf(".") < 0 ? null : path.split(".");
        const seeded = copyLeaf(readBase(baseline, path, segs));
        let initialRef = seeded;
        const value = sig(seeded);
        const touched = sig(false);
        const validator = validators[path];
        const o = fieldOpts[path] || EMPTY;

        // Per-field validity: depends ONLY on this field's value (lean keystroke path).
        const rawError = validator ? cmp(() => normErr(validator(value(), ctx))) : NULL;
        // dirty is one closure read + one Object.is against the captured initialRef
        // -- no path split, no baseline walk on the keystroke path.
        const dirty = cmp(() => !eq(value(), initialRef));
        // Displayed error: reveal-gated; per-field error first, then schema fallback.
        // Reading formErrors() here is an O(1) lookup whose result is Object.is-cutoff,
        // so a field only re-renders when ITS message changes.
        const error = cmp(() => {
            const reveal = submitAttempted()
                || (validateOn === "change" ? dirty()
                    : validateOn === "blur" ? touched()
                        : false);
            if (!reveal) return null;
            const own = rawError();
            if (own) return own;
            return formErrors ? normErr(formErrors()[path]) : null;
        });

        const f = {
            path,
            segs,                                         // cached path segments for the snapshot walk
            value,                                        // value() reads+tracks; value.peek() untracked
            error,                                        // error() = displayed error (reveal-gated)
            dirty,                                        // dirty() = value !== initialRef
            touched,                                      // touched() reads
            rawError,                                     // internal: per-field validity for isValid
            set: (v) => value.set(v),
            blur: () => touched.set(true),
            reset: () => {
                // Re-capture initialRef from a FRESH copy so dirty() reads false again
                // after reset even for an object/array leaf.
                const fresh = copyLeaf(readBase(baseline, path, segs));
                initialRef = fresh;
                value.set(fresh);
                touched.set(false);
            },
            props: () => ({
                value: o.format ? o.format(value()) : value(),
                onInput: (ev) => value.set(o.parse ? o.parse(evValue(ev)) : evValue(ev)),
                onBlur: () => touched.set(true),
            }),
        };
        fields.set(path, f);
        return f;
    }

    function getField(path) {
        const f = fields.get(path);
        if (f !== undefined) return f;                    // falsy-record fail-closed: only a real record hits
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
        leafPaths(baseline, "", []).forEach((p) => declared.add(p));
        declared.forEach(makeField);
    }

    // isValid = no schema errors AND no per-field validator errors. Schema runs once
    // (formErrors cached); per-field rawErrors are cached, so typing one field doesn't
    // re-run the others. Cutoff stops isValid recomputing while validity is unchanged.
    const isValid = cmp(() => {
        if (formErrors) {
            const e = formErrors();
            for (const k in e) if (e[k]) return false;
        }
        for (const path in validators) {
            if (getField(path).rawError() != null) return false;
        }
        return true;
    });
    const isDirty = cmp(() => {
        for (const f of fields.values()) if (f.dirty()) return true;
        return false;
    });

    function values() {                                   // untracked snapshot (for submit / external reads)
        return materialize((f) => f.value.peek());
    }

    function setValues(patch) {
        B(() => {
            for (const path in patch) getField(path).set(patch[path]);
        });
    }

    function reset() {
        B(() => {
            for (const f of fields.values()) f.reset();
            submitAttempted.set(false);
            submitErr.set(null);
        });
    }

    async function submit(ev) {
        if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
        submitAttempted.set(true);                        // reveals all errors
        // untrack the validity read + the userland callback so submit() can be called
        // from inside a reactive context without onSubmit's own signal reads
        // (auth.token(), etc.) silently leaking in as dependencies.
        if (!U(() => isValid())) return false;
        if (!onSubmit) return true;
        submitting.set(true);
        submitErr.set(null);
        try {
            await U(() => onSubmit(values()));
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
        submit,                                           // submit(ev?) -> Promise<boolean> (validates, then onSubmit)
        isValid,                                          // isValid() -> reactive boolean (true validity)
        isDirty,                                          // isDirty() -> reactive boolean
        isSubmitting: submitting,                         // isSubmitting() -> reactive boolean
        submitError: submitErr,                           // submitError() -> last submit throw, or null
        submitAttempted,                                  // submitAttempted() -> reactive boolean
        dispose: () => {
            for (const h of owned) D(h);
            owned.length = 0;
            fields.clear();
        },
    };
}
