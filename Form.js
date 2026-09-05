/**
 * @zakkster/lite-form · headless reactive forms for @zakkster/lite-signal
 * v1.0.1
 * ─────────────────────────────────────────────────────────────────────────────
 * Form STATE as fine-grained signals. No DOM, no virtual DOM, no compiler — bind
 * the field signals with @zakkster/lite-signal-dom (or anything). The only hard
 * dependency is lite-signal core; async validation (lite-resource), field arrays,
 * and draft persistence (lite-persist) layer on top without bloating this core.
 *
 * TWO VALIDATION MODES, both cutoff-gated:
 *  • Per-field validators (`validators[path]`) — each reads ONLY its own value, so
 *    typing in one field runs exactly one validator. Zero allocation on the
 *    keystroke path.
 *  • Form-level schema (`validate(values)` → { path: message }), e.g. Zod/Yup —
 *    HOISTED into a single `formErrors` computed that runs the schema ONCE per
 *    keystroke (not once per field). Each field reads formErrors[path] as an O(1)
 *    lookup; lite-signal's Object.is cutoff means only fields whose error actually
 *    changed propagate to the DOM. O(1) schema runs, O(1) DOM updates.
 *
 * Validity vs. display are split: a field's validity is always live (drives
 * isValid); the SHOWN error is reveal-gated (validateOn + submit-attempted) so a
 * pristine form doesn't scream "required" everywhere.
 *
 * FIELD ALLOCATION — eager, by design. Fields are created once, up front, from
 * initialValues + validators + fieldOpts. lite-signal 1.2.0's owner tree makes any
 * node created inside a re-running effect a CHILD of that effect (disposed on its
 * next run), and 1.2.0 has no createRoot/runWithOwner to detach ownership — so lazy
 * per-field allocation inside a render effect would self-destruct. Forms have a
 * known, bounded field set, so eager allocation is right regardless. (This is also
 * why per-field options live in config, not in field() calls: the field already
 * exists by the time UI binds it.)
 *
 * Lives in the DEFAULT registry so its signals share ONE graph with the caller's
 * effects and lite-signal-dom (tracking is per-registry). Pass `registry` to
 * scope it; then bind with that registry's effect. dispose() frees every node.
 *
 * MIT © Zahary Shinikchiev
 */
import {
    signal as dSignal, computed as dComputed, batch as dBatch, untrack as dUntrack, dispose as dDispose,
} from "@zakkster/lite-signal";

export const VERSION = "1.0.1";

const NULL = () => null;                                  // shared "no validator" error source
const EMPTY = {};                                         // shared empty errors / opts
const normErr = (e) => (e ? e : null);                    // falsy (undefined/false/"") → null
const eq = Object.is;
const isPlainObj = (v) => v != null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);

// Prototype-chain segments are rejected wherever a path enters the form: a
// "__proto__" walk in setPath lands on Object.prototype (global pollution).
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

function getPath(obj, path) {
    if (obj == null) return undefined;
    if (path.indexOf(".") < 0) {
        if (hostileSeg(path)) throwHostile(path, path);
        return obj[path];
    }
    let o = obj;
    const keys = path.split(".");
    for (let i = 0; i < keys.length && o != null; i++) {
        if (hostileSeg(keys[i])) throwHostile(keys[i], path);
        o = o[keys[i]];
    }
    return o;
}

function setPath(obj, path, val) {
    if (path.indexOf(".") < 0) {
        if (hostileSeg(path)) throwHostile(path, path);
        obj[path] = val;
        return;
    }
    const keys = path.split(".");
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i];
        if (hostileSeg(k)) throwHostile(k, path);
        // Keep existing objects AND arrays while descending; only materialize a missing
        // container, choosing an array when the next key is a numeric index.
        if (!(isPlainObj(o[k]) || Array.isArray(o[k]))) {
            o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
        }
        o = o[k];
    }
    const last = keys[keys.length - 1];
    if (hostileSeg(last)) throwHostile(last, path);
    o[last] = val;
}

function leafPaths(obj, prefix, out) {                    // flatten initialValues to dotted leaf paths
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

    const fields = new Map();                             // path -> field record
    const submitAttempted = sig(false);
    const submitting = sig(false);
    const submitErr = sig(null);

    // Reactive cross-field accessor handed to every per-field validator: ctx.get('x')
    // reads another field's value AND tracks it (so a dependent re-validates when its
    // sibling changes) without building a snapshot object.
    const ctx = {get: (path) => getField(path).value()};

    // TRACKED values builder for the schema. Unlike values() (peek-based snapshot for
    // submit), this reads each field via value() so formErrors depends on every field.
    function readValues() {
        const out = isPlainObj(initialValues) ? structuredClone(initialValues) : {};
        for (const [path, f] of fields) setPath(out, path, f.value());
        return out;
    }

    // Hoisted schema: runs validate() exactly ONCE per values change, not once per field.
    const formErrors = validate ? cmp(() => validate(readValues()) || EMPTY) : null;

    function makeField(path) {
        guardPath(path);                                  // sole fields.set site: no hostile path is ever cached
        const initial = getPath(initialValues, path);
        const value = sig(initial);
        const touched = sig(false);
        const validator = validators[path];
        const o = fieldOpts[path] || EMPTY;

        // Per-field validity: depends ONLY on this field's value (lean keystroke path).
        const rawError = validator ? cmp(() => normErr(validator(value(), ctx))) : NULL;
        const dirty = cmp(() => !eq(value(), getPath(initialValues, path)));
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
            value,                                        // value() reads+tracks; value.peek() untracked
            error,                                        // error() = displayed error (reveal-gated)
            dirty,                                        // dirty() = value !== initial
            touched,                                      // touched() reads
            rawError,                                     // internal: per-field validity for isValid
            set: (v) => value.set(v),
            blur: () => touched.set(true),
            reset: () => {
                value.set(getPath(initialValues, path));
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
        return fields.get(path) || makeField(path);
    }

    // Eager allocation: every declared field, up front, outside any render effect.
    {
        const declared = new Set(Object.keys(validators));
        Object.keys(fieldOpts).forEach((p) => declared.add(p));
        leafPaths(initialValues, "", []).forEach((p) => declared.add(p));
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
        const out = isPlainObj(initialValues) ? structuredClone(initialValues) : {};
        for (const [path, f] of fields) setPath(out, path, f.value.peek());
        return out;
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
            // Structural code bugs aren't legitimate submission outcomes — surface them
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
        field: getField,                                  // field(path) → field record
        values,                                           // values() → snapshot (untracked)
        setValues,                                        // setValues({path: v, ...}) (batched)
        reset,                                            // reset() → back to initialValues
        submit,                                           // submit(ev?) → Promise<boolean> (validates, then onSubmit)
        isValid,                                          // isValid() → reactive boolean (true validity)
        isDirty,                                          // isDirty() → reactive boolean
        isSubmitting: submitting,                         // isSubmitting() → reactive boolean
        submitError: submitErr,                           // submitError() → last submit throw, or null
        submitAttempted,                                  // submitAttempted() → reactive boolean
        dispose: () => {
            for (const h of owned) D(h);
            owned.length = 0;
            fields.clear();
        },
    };
}
