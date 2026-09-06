/**
 * @zakkster/lite-form -- headless reactive forms for @zakkster/lite-signal
 * v1.3.0
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

export const VERSION = "1.3.0";

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

// --- FIELD ARRAYS (S4, opt-in via config.arrays) ----------------------------
// Every symbol below is dead for a form with no declared arrays (hasArrays === false):
// the eager block never calls seedArray, getField never enters routeArray, and the
// cold ops take their 1.3.0 branch. The keystroke path never touches any of it.
const ARRAY_CFG_KEYS = {key: 1, validators: 1, validatorsAsync: 1, asyncSources: 1, fieldOpts: 1};

// A row's leaf sub-paths. A plain-object row exposes each leaf by its dotted
// sub-path (arrays inside a row stay leaves, like the top-level tree); a
// primitive / array / Date row is ONE leaf addressed by "" (the array-key path).
function itemSubPaths(item) {
    if (isPlainObj(item)) {
        const out = leafPaths(item, "", []);
        return out.length > 0 ? out : [""];              // {} row -> one empty-object leaf
    }
    return [""];
}

// Read a row's seed leaf for a sub-path ("" = the whole row leaf).
function subLeafOf(item, sub) {
    if (sub === "") return item;
    return readBase(item, sub, sub.indexOf(".") < 0 ? null : sub.split("."));
}

// A row key must be a non-empty, dot-free, non-hostile string (P4). key() is
// called once per seed/add/reseed, never per keystroke.
function validateKey(k, arrPath) {
    if (typeof k !== "string" || k.length === 0) {
        throw new TypeError('[lite-form] arrays["' + arrPath + '"].key() must return a non-empty string');
    }
    if (k.indexOf(".") >= 0) {
        throw new TypeError('[lite-form] array "' + arrPath + '" key "' + k + '" must not contain "."');
    }
    if (hostileSeg(k)) throwHostile(k, arrPath);
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
    // A declared array block can add per-row async lanes; those lanes drive the SAME
    // form-level pendingCount / isValidating, so the async machinery is allocated
    // when EITHER top-level OR any array config declares async (a cheap cold scan).
    let arraysDeclareAsync = false;
    if (config.arrays != null && typeof config.arrays === "object") {
        for (const ap in config.arrays) {
            const b = config.arrays[ap];
            if (b != null && typeof b === "object" && (b.validatorsAsync || b.asyncSources)) { arraysDeclareAsync = true; break; }
        }
    }
    const anyAsync = hasAsync || arraysDeclareAsync;
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
    const pendingCount = anyAsync ? sig(0) : null;
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

    // FIELD ARRAYS. Declared via config.arrays; an UNDECLARED array path keeps
    // 1.3.0 leaf-copy behavior byte-for-byte (P1). arrayStates is the form-owned
    // keyed-row model: baseline snapshot + order + live/added/removed sets per
    // array; row fields ride keyed paths "<arrayPath>.<rowKey>.<sub>" in the one
    // fields Map. hasArrays gates every off-cost decision (the S3 hasAsync
    // precedent) so a form with no arrays adds nothing to the hot path.
    const arrayCfg = config.arrays;
    const arrayStates = [];
    const arrayByPath = new Map();                        // arrayPath -> arrayState
    if (arrayCfg !== undefined) {
        if (!isPlainObj(arrayCfg)) throw new TypeError("[lite-form] config.arrays must be a plain object");
        // Fail closed (P7), and FIRST: a live keyed source has no detached
        // baseline to key rows against, so declared arrays + source mode is an
        // undecidable combination -- refused before any per-path validation
        // (initialValues is not the source of truth in source mode, so the
        // resolve-to-an-Array check below would be the wrong error).
        if (config.source !== undefined) {
            throw new TypeError("[lite-form] declared field arrays are default-mode only; source mode has no keyed baseline");
        }
        for (const ap in arrayCfg) {
            const block = arrayCfg[ap];
            if (!isPlainObj(block)) throw new TypeError('[lite-form] arrays["' + ap + '"] must be a config object');
            for (const bk in block) {
                if (!ARRAY_CFG_KEYS[bk]) {
                    throw new TypeError('[lite-form] unknown key "' + bk + '" in arrays["' + ap + '"] (expected key/validators/validatorsAsync/asyncSources/fieldOpts)');
                }
            }
            if (typeof block.key !== "function") {
                throw new TypeError('[lite-form] arrays["' + ap + '"].key must be a function (item, i) => string');
            }
            const apSegs = ap.indexOf(".") < 0 ? null : ap.split(".");
            const items = readBase(baseline, ap, apSegs);
            if (!Array.isArray(items)) {
                throw new TypeError('[lite-form] arrays["' + ap + '"] must resolve to an Array in initialValues');
            }
            const arr = {
                path: ap,
                pathDot: ap + ".",
                segs: apSegs,
                keyFn: block.key,
                subConfig: {
                    validators: block.validators || EMPTY,
                    validatorsAsync: block.validatorsAsync || EMPTY,
                    asyncSources: block.asyncSources || EMPTY,
                    fieldOpts: block.fieldOpts || EMPTY,
                },
                baseKeys: [],                              // baseline order
                curKeys: [],                               // current order
                live: new Set(),                           // O(1) live-key membership
                added: new Set(),                          // keys added since baseline
                removed: [],                               // baseline keys removed
                baseSeed: new Map(),                       // key -> baseline item copy
                addSeed: new Map(),                        // key -> add-seed item copy
                rows: new Map(),                           // key -> RowState
                keysFrozen: Object.freeze([]),             // frozen curKeys snapshot (rebuilt on structure change)
                structRev: sig(0),                         // bumped once per structural mutation
                handleObj: null,                           // cached ArrayHandle
            };
            arrayStates.push(arr);
            arrayByPath.set(ap, arr);
        }
    }
    const hasArrays = arrayStates.length > 0;
    const declaredArraySet = new Set();
    for (let i = 0; i < arrayStates.length; i++) declaredArraySet.add(arrayStates[i].path);

    // ENGINE. lite-form's value core is a lite-project projection. In the default
    // mode the projection rides fromAccessors over the detached baseline; in
    // source mode (config.source) it rides fromProxy over a live keyed source.
    // Mode is resolved ONCE here so no keystroke body branches on it.
    const sourceMode = config.source !== undefined;
    // (source + declared arrays was already refused at the arrays parse above.)

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
        // A keyed row field has NO home in the flat baseline tree (baseline holds a
        // plain array under the array path); its baseline IS its per-field
        // initialRef, and the array's seed map mirrors it for reset/structure.
        if (f.arr !== null) {
            f.initialRef = copyLeaf(landed, path);
            const seedMap = f.arr.added.has(f.rowKey) ? f.arr.addSeed : f.arr.baseSeed;
            const item = seedMap.get(f.rowKey);
            if (item !== undefined && f.sub !== "") {
                setPathSegs(item, f.sub, f.sub.indexOf(".") < 0 ? null : f.sub.split("."), copyLeaf(landed, path));
            } else if (item !== undefined) {
                seedMap.set(f.rowKey, copyLeaf(landed, path));
            }
            return;
        }
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
    function readScratchFlat() {
        if (scratch === null) scratch = copyLeaf(baseline);
        for (let i = 0; i < fieldList.length; i++) {
            const f = fieldList[i];
            setPathSegs(scratch, f.path, f.segs, f.value());
        }
        return scratch;
    }
    // Array-aware scratch (chosen at construction only when hasArrays): non-array
    // fields write in place; each declared array is rebuilt IN ORDER as a plain
    // array (index i = curKeys[i]) so a schema sees the current row order.
    function readScratchArr() {
        if (scratch === null) scratch = copyLeaf(baseline);
        for (let i = 0; i < fieldList.length; i++) {
            const f = fieldList[i];
            if (f.arr !== null) continue;
            setPathSegs(scratch, f.path, f.segs, f.value());
        }
        for (let i = 0; i < arrayStates.length; i++) {
            const arr = arrayStates[i];
            arr.structRev();                              // track order: a move() must re-run the schema (index->key translation)
            const list = new Array(arr.curKeys.length);
            for (let j = 0; j < arr.curKeys.length; j++) list[j] = currentRowValue(arr, arr.curKeys[j], readTracked);
            setPathSegs(scratch, arr.path, arr.segs, list);
        }
        return scratch;
    }
    const readTracked = (f) => f.value();
    const readScratch = hasArrays ? readScratchArr : readScratchFlat;

    // Schema keys the schema returns for a declared array path are index-based
    // ("rows.0.name"); translate the index -> the key currently at that index
    // (D6). ONE pass over the raw keys; only keys under a declared array path move.
    function translateErrors(raw) {
        const out = {};
        for (const k in raw) {
            let tk = k;
            for (let i = 0; i < arrayStates.length; i++) {
                const arr = arrayStates[i];
                if (k === arr.path) break;
                if (k.startsWith(arr.pathDot)) {
                    const rest = k.slice(arr.pathDot.length);
                    const dot = rest.indexOf(".");
                    const idxStr = dot < 0 ? rest : rest.slice(0, dot);
                    if (/^\d+$/.test(idxStr)) {
                        const idx = +idxStr;
                        if (idx < arr.curKeys.length) {
                            tk = arr.pathDot + arr.curKeys[idx] + (dot < 0 ? "" : rest.slice(dot));
                        }
                    }
                    break;
                }
            }
            out[tk] = raw[k];
        }
        return out;
    }

    // Hoisted schema: runs validate() exactly ONCE per values change, not once per field.
    const formErrors = validate
        ? (hasArrays
            ? cmp(() => translateErrors(validate(readScratch()) || EMPTY))
            : cmp(() => validate(readScratch()) || EMPTY))
        : null;

    // makeField(path[, ri]). ri (rowInfo) is present ONLY for a keyed row field: it
    // carries the row seed leaf, the row ctx (get + local), the row-scoped sig/cmp
    // (so the field's nodes are torn down with the row, not the form), and the
    // per-row sub-config validator/async/opt. When ri is undefined the field is a
    // plain 1.3.0 field -- byte-for-byte the old body.
    function makeField(path, ri) {
        guardPath(path);                                  // sole fields.set site: no hostile path is ever cached
        const segs = path.indexOf(".") < 0 ? null : path.split(".");
        const seeded = ri === undefined
            ? copyLeaf(readBase(baseline, path, segs))
            : copyLeaf(ri.leaf);
        const validator = ri === undefined ? validators[path] : ri.validator;
        const asyncFn = ri === undefined ? validatorsAsync[path] : ri.asyncFn;
        const o = (ri === undefined ? fieldOpts[path] : ri.opt) || EMPTY;
        const mkSig = ri === undefined ? sig : ri.sig;
        const mkCmp = ri === undefined ? cmp : ri.cmp;
        const useCtx = ri === undefined ? ctx : ri.ctx;

        // initialRef migrates onto the record: dirty() then costs one property load.
        // asyncLane is null on EVERY record (uniform hidden class) -- populated only
        // for a path that has an async validator, so a sync-only field pays nothing.
        // arr/rowKey/sub are null on a plain field (uniform hidden class, the
        // asyncLane precedent) and identify a keyed row field for the cold ops.
        const f = {
            path,
            segs,                                         // cached path segments for the snapshot walk
            initialRef: seeded,
            asyncLane: null,
            arr: ri === undefined ? null : ri.arr,
            rowKey: ri === undefined ? null : ri.rowKey,
            sub: ri === undefined ? null : ri.sub,
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

        const touched = mkSig(false);
        // Per-field validity: depends ONLY on this field's value (lean keystroke path).
        const rawError = validator ? mkCmp(() => normErr(validator(value(), useCtx))) : NULL;
        // Default dirty is one closure read + one Object.is against the captured
        // initialRef -- the S1 compare. It must ALSO track baselineRev: initialRef
        // is a plain property, and commit()/forced-echo merge re-capture it while
        // value()'s output stays identical (folding is value-preserving), so the
        // value cutoff alone would strand a pre-commit cached dirty=true (LF-12).
        // Source dirty is overlay presence (dirtyCount() is the tracked engine
        // signal; isOverlaid the per-key read).
        const dirty = sourceMode
            ? mkCmp(() => { void handle.dirtyCount(); return handle.isOverlaid(path); })
            : mkCmp(() => { baselineRev(); return !eq(value(), f.initialRef); });
        // Async lane: allocated ONLY for a path with an async validator. Its seq +
        // pending + err signals exist here so f.isValidating can point at pending
        // and the error body can read err; the reader factory + settlement effect
        // are wired AFTER the record is fully assembled (see wireAsyncLane).
        const lane = asyncFn
            ? { seq: 0, pending: mkSig(false), err: mkSig(null), reader: null, ownReader: null, disp: null, ctx: useCtx, dead: false }
            : null;
        if (lane) f.asyncLane = lane;
        // Displayed error: reveal-gated; per-field error first, then schema fallback.
        // Reading formErrors() here is an O(1) lookup whose result is Object.is-cutoff,
        // so a field only re-renders when ITS message changes. TWO hoisted bodies:
        // the sync variant is byte-identical to the no-async build; the async variant
        // additionally surfaces the latest-seq lane verdict (lane.err).
        const error = lane
            ? mkCmp(() => {
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
            : mkCmp(() => {
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
        if (lane) wireAsyncLane(f, lane, asyncFn, ri);    // reader factory + effect AFTER the record is fully assembled
        return f;
    }

    // Wire an async field's lane: call the (optional) reader factory now that the
    // field record is fully assembled (value facade + isValidating present -- AM-5),
    // then create ONE form-owned effect that tracks the reader and (re)triggers the
    // async validator. A factory that throws propagates -> construction fails closed.
    // The default reader is the field's own value facade and is NEVER torn down.
    function wireAsyncLane(f, lane, asyncFn, ri) {
        const factory = ri === undefined ? asyncSources[f.path] : ri.asyncFactory;
        const reader = factory ? factory(f, lane.ctx) : f.value;
        lane.reader = reader;
        if (factory) lane.ownReader = reader;             // caller-owned handle (e.g. debounce): disposed on teardown
        // Detached (createRoot) so this effect is form-owned, not a child of any
        // consumer that happened to be tracking at construction. For a row field
        // the disposer is stored on the RowState too (remove() disposes it).
        lane.disp = CR(() => EF(() => {
            const v = lane.reader();                      // tracks the trigger source (value or debounced source)
            U(() => triggerAsync(lane, asyncFn, v));
        }));
        asyncLanes.push(lane);
        if (ri !== undefined) ri.lanes.push(lane);
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
        try { p = asyncFn(v, lane.ctx); }
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
        // lane.dead: a per-row lane torn down by remove()/reset() -- its settlement
        // is a no-op even while the form itself is live (D5 row-teardown discipline).
        if (disposed || lane.dead || lane.seq !== mySeq) return;
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
        // A keyed row field has no home in the flat baseline tree; its baseline is
        // the array's per-key seed (baseSeed). f.arr is null on every non-row field,
        // so a no-arrays form takes the flat branch with one cold property load.
        const fresh = f.arr !== null
            ? copyLeaf(subLeafOf(f.arr.baseSeed.get(f.rowKey), f.sub))
            : copyLeaf(readBase(baseline, f.path, f.segs));
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
        // A cached field (row or flat) returned above with ZERO array branches; the
        // P2 routing only fires on a MISS (cold), and only when the form has arrays.
        if (hasArrays) { const r = routeArray(path); if (r !== undefined) return r; }
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

    // --- FIELD ARRAY MACHINERY (dead for a no-arrays form) --------------------
    // Every function below is only ever CALLED when hasArrays; function decls are
    // hoisted so they may reference makeField / getField / handle freely.
    const peekRead = (f) => f.value.peek();               // untracked leaf read (snapshot / patch)

    // A row's current value, reconstructed from its live sub-fields (no per-call
    // split -- each sub carries its cached segs). `read` chooses tracked vs peek.
    function currentRowValue(arr, key, read) {
        const rs = arr.rows.get(key);
        const sl = rs.subList;
        if (rs.single) return read(sl[0].f);
        const out = {};
        for (let i = 0; i < sl.length; i++) setPathSegs(out, sl[i].sub, sl[i].segs, read(sl[i].f));
        return out;
    }

    // Per-row validator ctx: get(anyPath) tracked, PLUS local(sub) -> this row's
    // sub-field value (tracked). Created once per row (cold), never per keystroke.
    function makeRowCtx(arr, key) {
        return {
            get: (path) => getField(path).value(),
            local: (sub) => getField(sub === "" ? arr.pathDot + key : arr.pathDot + key + "." + sub).value(),
        };
    }

    // Create one row's fields inside a per-row createRoot (LF-04): its signals are
    // ownerless (createRoot detaches) and collected in rs.owned so remove()/reset()
    // /dispose() free them; the row's async-lane effects ride rs.lanes.
    function createRow(arr, key, seed) {
        const subs = itemSubPaths(seed);
        const rs = {
            key,
            single: subs.length === 1 && subs[0] === "",
            fields: new Map(),                            // sub -> Field
            subList: [],                                  // [{sub, segs, f}] for reconstruction
            owned: [],                                    // row-owned signal/computed handles
            lanes: [],                                    // row async lanes (disposed on teardown)
            fieldObj: null,                               // cached { key, field(sub) }
        };
        const rowCtx = makeRowCtx(arr, key);
        const mkSig = (v) => { const h = S(v); rs.owned.push(h); return h; };
        const mkCmp = (fn) => { const h = C(fn); rs.owned.push(h); return h; };
        CR(() => {
            for (let i = 0; i < subs.length; i++) buildRowField(arr, rs, key, subs[i], subLeafOf(seed, subs[i]), rowCtx, mkSig, mkCmp);
        });
        arr.rows.set(key, rs);
        return rs;
    }

    // Assemble the rowInfo and create ONE row sub-field. Shared by eager/add seeding
    // and by lazy field(sub) creation on a live row.
    function buildRowField(arr, rs, key, sub, leaf, rowCtx, mkSig, mkCmp) {
        const fullPath = sub === "" ? arr.pathDot + key : arr.pathDot + key + "." + sub;
        const ri = {
            leaf,
            validator: arr.subConfig.validators[sub],
            asyncFn: arr.subConfig.validatorsAsync[sub],
            asyncFactory: arr.subConfig.asyncSources[sub],
            opt: arr.subConfig.fieldOpts[sub],
            sig: mkSig,
            cmp: mkCmp,
            ctx: rowCtx,
            arr,
            rowKey: key,
            sub,
            lanes: rs.lanes,
        };
        const f = makeField(fullPath, ri);
        rs.fields.set(sub, f);
        rs.subList.push({sub, segs: sub === "" || sub.indexOf(".") < 0 ? null : sub.split("."), f});
        return f;
    }

    // A live row's field(sub) for a sub not yet materialized: created lazily INSIDE
    // the row's createRoot so remove() disposes it (leaf seeds undefined).
    function createRowSubField(arr, rs, key, sub) {
        if (merging) throwMerging();                      // creation is a mutation (the S3 lazy-create ruling)
        // Fail closed (review nit): a single-leaf row (primitive/array/Date item)
        // has exactly ONE field -- the row value itself, eagerly created with no
        // sub segment. A NAMED sub under it would be invisible to
        // values()/toPatch() (currentRowValue returns the single leaf) while
        // still counting toward validity -- silent inconsistency, so it throws.
        // The converse (an empty sub on an object row) is the same class.
        if (rs.single) {
            throw new TypeError('[lite-form] array "' + arr.path + '" row "' + key + '" is a single-leaf row; address it as "' + arr.path + '.' + key + '" -- it has no sub-field "' + sub + '"');
        }
        if (sub === "") {
            throw new TypeError('[lite-form] array "' + arr.path + '" row "' + key + '" is an object row; address one of its sub-fields, not the row itself');
        }
        const rowCtx = makeRowCtx(arr, key);
        const mkSig = (v) => { const h = S(v); rs.owned.push(h); return h; };
        const mkCmp = (fn) => { const h = C(fn); rs.owned.push(h); return h; };
        let f;
        CR(() => { f = buildRowField(arr, rs, key, sub, undefined, rowCtx, mkSig, mkCmp); });
        return f;
    }

    // Eager array seed: one row per baseline item, keys derived + validated + dup-
    // checked BEFORE any row is built (fail closed at createForm).
    function seedArray(arr) {
        const items = readBase(baseline, arr.path, arr.segs);
        for (let i = 0; i < items.length; i++) {
            const seed = copyLeaf(items[i], arr.path);
            const key = arr.keyFn(seed, i);
            validateKey(key, arr.path);
            if (arr.live.has(key)) throw new TypeError('[lite-form] array "' + arr.path + '" duplicate key "' + key + '"');
            arr.live.add(key);
            arr.baseKeys.push(key);
            arr.curKeys.push(key);
            arr.baseSeed.set(key, seed);
            createRow(arr, key, seed);
        }
        arr.keysFrozen = Object.freeze(arr.curKeys.slice());
    }

    // True when current order != baseline order OR there are pending adds/removes.
    function isStructureDirty(arr) {
        if (arr.added.size > 0 || arr.removed.length > 0) return true;
        if (arr.curKeys.length !== arr.baseKeys.length) return true;
        for (let i = 0; i < arr.curKeys.length; i++) if (arr.curKeys[i] !== arr.baseKeys[i]) return true;
        return false;
    }

    // Route a MISS under a declared array (P2). Returns the row sub-field for a LIVE
    // key, throws a path-naming TypeError for the array itself / an index / a non-
    // live key, or returns undefined if the path is under no declared array.
    function routeArray(path) {
        for (let i = 0; i < arrayStates.length; i++) {
            const arr = arrayStates[i];
            if (path === arr.path) {
                throw new TypeError('[lite-form] "' + arr.path + '" is a declared field array; use form.array("' + arr.path + '"), not field()');
            }
            if (path.startsWith(arr.pathDot)) {
                const rest = path.slice(arr.pathDot.length);
                const dot = rest.indexOf(".");
                const keySeg = dot < 0 ? rest : rest.slice(0, dot);
                const sub = dot < 0 ? "" : rest.slice(dot + 1);
                if (!arr.live.has(keySeg)) {
                    throw new TypeError('[lite-form] "' + path + '" addresses declared array "' + arr.path + '" by index or non-live key; use form.array("' + arr.path + '").row(key)');
                }
                const rs = arr.rows.get(keySeg);
                const existing = rs.fields.get(sub);
                return existing !== undefined ? existing : createRowSubField(arr, rs, keySeg, sub);
            }
        }
        return undefined;
    }

    // Cold write-door guard (commit(path)): a write addressing the array as a whole
    // or by index/non-live key throws; a live keyed path returns (allowed).
    function assertArrayWriteAllowed(path) {
        for (let i = 0; i < arrayStates.length; i++) {
            const arr = arrayStates[i];
            if (path === arr.path) {
                throw new TypeError('[lite-form] "' + arr.path + '" is a declared field array; use form.array("' + arr.path + '")');
            }
            if (path.startsWith(arr.pathDot)) {
                const rest = path.slice(arr.pathDot.length);
                const dot = rest.indexOf(".");
                const keySeg = dot < 0 ? rest : rest.slice(0, dot);
                if (!arr.live.has(keySeg)) {
                    throw new TypeError('[lite-form] "' + path + '" addresses declared array "' + arr.path + '" by index or non-live key; use form.array("' + arr.path + '").row(key)');
                }
                return;
            }
        }
    }

    // Tear down one row: dispose its async lanes (settlements become no-ops), clear
    // its overlays, delete its fields, dispose its owned nodes. NOT structure book-
    // keeping (the caller owns curKeys/live/added/removed). Prune is the caller's.
    function teardownRow(arr, key) {
        const rs = arr.rows.get(key);
        if (rs === undefined) return;
        for (let i = 0; i < rs.lanes.length; i++) {
            const lane = rs.lanes[i];
            lane.dead = true;
            // LF-13b: a lane torn down while PENDING must release its pendingCount
            // slot here -- its settlement returns on lane.dead BEFORE the normal
            // decrement, so without this the form-level counter sticks and
            // isValidating()/strict-false isValid() never recover.
            if (lane.pending.peek()) { lane.pending.set(false); pendingCount.set(pendingCount.peek() - 1); }
            if (lane.disp) { lane.disp(); lane.disp = null; }
            if (lane.ownReader && typeof lane.ownReader.dispose === "function") { lane.ownReader.dispose(); lane.ownReader = null; }
        }
        for (const f of rs.fields.values()) {
            handle.clear(f.path);
            fields.delete(f.path);
            const li = fieldList.indexOf(f);
            if (li >= 0) fieldList.splice(li, 1);
        }
        for (let i = 0; i < rs.owned.length; i++) D(rs.owned[i]);
        rs.owned.length = 0;
        arr.rows.delete(key);
    }

    // add/remove/move: STRUCTURE ops (O(rows) work allowed; one-bump discipline).
    function addRow(arr, item, atIndex) {
        if (merging) throwMerging();
        const n = arr.curKeys.length;
        const idx = atIndex === undefined ? n : atIndex;
        if (!Number.isInteger(idx) || idx < 0 || idx > n) {
            throw new TypeError('[lite-form] array "' + arr.path + '" add(atIndex) must be an integer 0..' + n);
        }
        const seed = copyLeaf(item, arr.path);
        const key = arr.keyFn(seed, idx);
        validateKey(key, arr.path);
        if (arr.live.has(key)) throw new TypeError('[lite-form] array "' + arr.path + '" duplicate key "' + key + '"');
        B(() => {
            arr.live.add(key);
            arr.added.add(key);
            arr.addSeed.set(key, seed);
            arr.curKeys.splice(idx, 0, key);
            createRow(arr, key, seed);
            arr.keysFrozen = Object.freeze(arr.curKeys.slice());
            arr.structRev.set(arr.structRev.peek() + 1);
            bumpRev();
        });
        return key;
    }

    function removeRow(arr, key) {
        if (merging) throwMerging();
        if (!arr.live.has(key)) throw new TypeError('[lite-form] array "' + arr.path + '" has no row "' + key + '"');
        B(() => {
            teardownRow(arr, key);                        // dispose row root FIRST (async no-ops)
            const ci = arr.curKeys.indexOf(key);
            if (ci >= 0) arr.curKeys.splice(ci, 1);
            arr.live.delete(key);
            if (arr.added.has(key)) { arr.added.delete(key); arr.addSeed.delete(key); }
            else arr.removed.push(key);                   // baseline key removed (baseSeed kept for reset)
            arr.keysFrozen = Object.freeze(arr.curKeys.slice());
            arr.structRev.set(arr.structRev.peek() + 1);
            bumpRev();
        });
        handle.prune();                                   // reclaim un-overlaid+unobserved slots (V2 seam)
    }

    function moveRow(arr, key, toIndex) {
        if (merging) throwMerging();
        if (!arr.live.has(key)) throw new TypeError('[lite-form] array "' + arr.path + '" has no row "' + key + '"');
        const n = arr.curKeys.length;
        if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= n) {
            throw new TypeError('[lite-form] array "' + arr.path + '" move(toIndex) must be an integer 0..' + (n - 1));
        }
        const from = arr.curKeys.indexOf(key);
        if (from === toIndex) return;                     // no-op: no signal write, no bump (P3 order-only)
        B(() => {
            arr.curKeys.splice(from, 1);
            arr.curKeys.splice(toIndex, 0, key);
            arr.keysFrozen = Object.freeze(arr.curKeys.slice());
            arr.structRev.set(arr.structRev.peek() + 1);
            bumpRev();
        });
    }

    // reset(): drop added rows, restore removed baseline rows pristine, restore the
    // baseline order. Runs inside reset()'s batch; field values reset by resetField.
    function resetArray(arr) {
        for (const key of Array.from(arr.added)) {
            teardownRow(arr, key);
            arr.live.delete(key);
            arr.addSeed.delete(key);
            const ci = arr.curKeys.indexOf(key);
            if (ci >= 0) arr.curKeys.splice(ci, 1);
        }
        arr.added.clear();
        for (let i = 0; i < arr.removed.length; i++) {
            const key = arr.removed[i];
            arr.live.add(key);
            createRow(arr, key, arr.baseSeed.get(key));
        }
        arr.removed.length = 0;
        arr.curKeys = arr.baseKeys.slice();
        arr.keysFrozen = Object.freeze(arr.curKeys.slice());
        arr.structRev.set(arr.structRev.peek() + 1);
    }

    // commit(): promote added rows into the baseline, drop removed rows permanently,
    // current order becomes baseline order. Field values already folded by handle.
    function foldArrayStructure(arr) {
        for (const key of arr.added) {
            const seed = arr.addSeed.get(key);
            if (seed !== undefined) arr.baseSeed.set(key, seed);
            arr.addSeed.delete(key);
        }
        arr.added.clear();
        for (let i = 0; i < arr.removed.length; i++) arr.baseSeed.delete(arr.removed[i]);
        arr.removed.length = 0;
        arr.baseKeys = arr.curKeys.slice();
        arr.structRev.set(arr.structRev.peek() + 1);
    }

    // 1-arg reinitialize(next) for a form with declared arrays: FULLY re-seed every
    // array (keys re-derived from next). Atomic: keys validated + dup-checked BEFORE
    // any mutation, so a hostile leaf or a bad key throws with nothing changed.
    function reinitArrays(nb) {
        const plans = [];
        for (let i = 0; i < arrayStates.length; i++) {
            const arr = arrayStates[i];
            const items = readBase(nb, arr.path, arr.segs);
            if (!Array.isArray(items)) {
                throw new TypeError('[lite-form] reinitialize: arrays["' + arr.path + '"] must resolve to an Array');
            }
            const keys = [];
            const seeds = [];
            const seen = new Set();
            for (let j = 0; j < items.length; j++) {
                const seed = copyLeaf(items[j], arr.path);
                const key = arr.keyFn(seed, j);
                validateKey(key, arr.path);
                if (seen.has(key)) throw new TypeError('[lite-form] array "' + arr.path + '" duplicate key "' + key + '"');
                seen.add(key);
                keys.push(key);
                seeds.push(seed);
            }
            plans.push({arr, keys, seeds});
        }
        B(() => {
            baseline = nb;
            handle.revert();
            for (let i = 0; i < arrayStates.length; i++) {
                const arr = arrayStates[i];
                for (const key of Array.from(arr.live)) teardownRow(arr, key);
                arr.live.clear();
                arr.added.clear();
                arr.removed.length = 0;
                arr.baseSeed.clear();
                arr.addSeed.clear();
                arr.baseKeys = [];
                arr.curKeys = [];
            }
            for (let i = 0; i < fieldList.length; i++) {
                const fresh = fieldList[i];
                if (fresh.arr !== null) continue;
                fresh.initialRef = copyLeaf(readBase(baseline, fresh.path, fresh.segs));
                fresh.touched.set(false);
            }
            for (let p = 0; p < plans.length; p++) {
                const {arr, keys, seeds} = plans[p];
                for (let j = 0; j < keys.length; j++) {
                    arr.live.add(keys[j]);
                    arr.baseKeys.push(keys[j]);
                    arr.curKeys.push(keys[j]);
                    arr.baseSeed.set(keys[j], seeds[j]);
                    createRow(arr, keys[j], seeds[j]);
                }
                arr.keysFrozen = Object.freeze(arr.curKeys.slice());
                arr.structRev.set(arr.structRev.peek() + 1);
            }
            submitAttempted.set(false);
            submitErr.set(null);
            bumpRev();
            scratch = null;
        });
        handle.prune();
    }

    // form.array(path) -> ArrayHandle (cached, one per array). Undeclared -> throw.
    function array(path) {
        const arr = arrayByPath.get(path);
        if (arr === undefined) throw new TypeError('[lite-form] array("' + path + '") is not a declared field array');
        if (arr.handleObj === null) {
            arr.handleObj = {
                keys: () => { arr.structRev(); return arr.keysFrozen; },
                length: () => { arr.structRev(); return arr.curKeys.length; },
                structureDirty: () => { arr.structRev(); return isStructureDirty(arr); },
                row: (key) => {
                    const rs = arr.rows.get(key);
                    if (rs === undefined) throw new TypeError('[lite-form] array "' + arr.path + '" has no row "' + key + '"');
                    if (rs.fieldObj === null) {
                        rs.fieldObj = {
                            key,
                            field: (sub) => {
                                const ex = rs.fields.get(sub);
                                return ex !== undefined ? ex : createRowSubField(arr, rs, key, sub);
                            },
                        };
                    }
                    return rs.fieldObj;
                },
                add: (item, atIndex) => addRow(arr, item, atIndex),
                remove: (key) => removeRow(arr, key),
                move: (key, toIndex) => moveRow(arr, key, toIndex),
            };
        }
        return arr.handleObj;
    }

    // Array-aware snapshot: non-array fields in place; each declared array rebuilt
    // IN ORDER as a plain array of deep-copied row values (never aliases internals).
    function valuesArr() {
        const out = copyLeaf(baseline);
        for (let i = 0; i < fieldList.length; i++) {
            const f = fieldList[i];
            if (f.arr !== null) continue;
            setPathSegs(out, f.path, f.segs, copyLeaf(f.value.peek(), f.path));
        }
        for (let i = 0; i < arrayStates.length; i++) {
            const arr = arrayStates[i];
            const list = new Array(arr.curKeys.length);
            for (let j = 0; j < arr.curKeys.length; j++) list[j] = copyLeaf(currentRowValue(arr, arr.curKeys[j], peekRead), arr.path);
            setPathSegs(out, arr.path, arr.segs, list);
        }
        return out;
    }

    // Array-aware toPatch (D2): field entries for EXISTING rows only (added-row
    // fields ride structure.added.value, never a field entry); one structure entry
    // per structurally-dirty array.
    function toPatchArr() {
        const out = [];
        handle.forEachPatch((k, from, to) => {
            const f = fields.get(k);
            if (f !== undefined && f.arr !== null && f.arr.added.has(f.rowKey)) return;
            out.push({path: k, from, to});
        });
        for (let i = 0; i < arrayStates.length; i++) {
            const arr = arrayStates[i];
            if (!isStructureDirty(arr)) continue;
            const added = [];
            for (let j = 0; j < arr.curKeys.length; j++) {
                const key = arr.curKeys[j];
                if (arr.added.has(key)) added.push({key, index: j, value: copyLeaf(currentRowValue(arr, key, peekRead), arr.path)});
            }
            out.push({path: arr.path, structure: {order: arr.curKeys.slice(), added, removed: arr.removed.slice()}});
        }
        return out;
    }

    // Eager allocation: every declared field, up front, outside any render effect.
    {
        const declared = new Set(Object.keys(validators));
        Object.keys(fieldOpts).forEach((p) => declared.add(p));
        Object.keys(validatorsAsync).forEach((p) => declared.add(p));
        Object.keys(asyncSources).forEach((p) => declared.add(p));
        leafPaths(baseline, "", []).forEach((p) => declared.add(p));
        if (hasArrays) {
            // A declared array path is a leaf in leafPaths(); it must NOT become a
            // plain field -- its rows are seeded keyed instead.
            for (let i = 0; i < arrayStates.length; i++) declared.delete(arrayStates[i].path);
            declared.forEach((p) => makeField(p));
            for (let i = 0; i < arrayStates.length; i++) seedArray(arrayStates[i]);
        } else {
            declared.forEach((p) => makeField(p));
        }
    }

    // isValid = no schema errors AND no per-field validator errors. Schema runs once
    // (formErrors cached); per-field rawErrors are cached, so typing one field doesn't
    // re-run the others. Cutoff stops isValid recomputing while validity is unchanged.
    // TWO hoisted bodies. No async paths -> the no-async build verbatim. With async
    // paths -> D6 strict-false while any lane is pending (isValidating() true implies
    // isValid() false -- the fail-closed submit gate needs no extra submit code),
    // then the same schema + per-field checks, then each lane's latest verdict.
    const baseIsValid = anyAsync
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
    // D6: row fields are normal fields -- isValid aggregates their per-field sync
    // rawErrors AND their latest async lane verdict, exactly like declared fields.
    // Row async PENDING is already the form-level pendingCount (shared triggerAsync),
    // so baseIsValid's strict-false covers it. Only referenced when hasArrays.
    function rowFieldsValid() {
        // LF-13a: the scan short-circuits, so this computed may hold exactly ONE
        // live dependency -- a row field's rawError. Removing that row disposes
        // the dependency and nothing would ever notify the memoized verdict
        // again (the LF-12 class, transposed to validity). structRev is the
        // add/remove/move notifier every structural mutation already bumps.
        for (let i = 0; i < arrayStates.length; i++) arrayStates[i].structRev();
        for (let i = 0; i < fieldList.length; i++) {
            const f = fieldList[i];
            if (f.arr === null) continue;
            if (f.rawError() != null) return false;
            if (f.asyncLane !== null && f.asyncLane.err() != null) return false;
        }
        return true;
    }
    const isValid = hasArrays ? cmp(() => baseIsValid() && rowFieldsValid()) : baseIsValid;
    // form.isValidating: shared FALSE when no async fields (off-cost), else true
    // exactly while some lane's latest seq is unsettled.
    const isValidating = anyAsync ? cmp(() => pendingCount() > 0) : FALSE;
    // Clear-on-initial (default) makes overlay presence coincide with dirty, so the
    // form-level flag is the tracked engine count. Source mode reads the same count
    // (overlay presence is the honest dirty signal without a captured baseline).
    // D6: form.isDirty = engine dirtyCount() > 0 OR any array structure-dirty. The
    // no-arrays variant is the 1.3.0 body verbatim (ZERO array work).
    const isDirty = hasArrays
        ? cmp(() => {
            if (handle.dirtyCount() > 0) return true;
            for (let i = 0; i < arrayStates.length; i++) {
                const arr = arrayStates[i];
                arr.structRev();                          // track the per-array structure rev
                if (isStructureDirty(arr)) return true;
            }
            return false;
        })
        : cmp(() => handle.dirtyCount() > 0);

    function valuesFlat() {                               // untracked snapshot (for submit / external reads)
        return materialize((f) => f.value.peek());
    }
    // Off-cost variant select (the S3 hasAsync precedent): a no-arrays form takes the
    // 1.3.0 materialize path byte-for-byte; valuesArr rebuilds keyed rows in order.
    const values = hasArrays ? valuesArr : valuesFlat;

    function setValues(patch) {
        B(() => {
            for (const path in patch) getField(path).set(patch[path]);
        });
    }

    function reset() {
        if (merging) throwMerging();
        if (sourceMode) { handle.revert(); return; }
        B(() => {
            // Structural restore FIRST (drop adds, revive removes, restore order),
            // then reset every field's value/touched over the restored field set.
            if (hasArrays) for (let i = 0; i < arrayStates.length; i++) resetArray(arrayStates[i]);
            for (let i = 0; i < fieldList.length; i++) resetField(fieldList[i]);
            submitAttempted.set(false);
            submitErr.set(null);
            bumpRev();
        });
        if (hasArrays) handle.prune();                    // reclaim slots of dropped added rows
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
                // P2 write-door: a whole-array / index / non-live keyed commit throws
                // and directs to the row API (a live keyed field commit is allowed).
                if (hasArrays) assertArrayWriteAllowed(path);
                // Fail closed: an unregistered path is an error, never a lazy
                // field creation -- getField here would permanently inject a
                // phantom field for a typo'd commit and then no-op.
                if (fields.get(path) === undefined) {
                    throw new TypeError('[lite-form] commit() for unregistered path "' + path + '"');
                }
                handle.commit(path);
            } else {
                handle.commit();
                // Promote added rows + fold structure (D3) after field overlays fold.
                if (hasArrays) for (let i = 0; i < arrayStates.length; i++) foldArrayStructure(arrayStates[i]);
            }
            bumpRev();
            scratch = null;
        });
    }

    // Exactly the dirty paths as [{path, from, to}] (from = baseline value, to =
    // current). Untracked + read-only: safe inside an effect. Our records, so the
    // key is renamed `path`.
    function toPatchFlat() {
        const out = [];
        handle.forEachPatch((k, from, to) => out.push({path: k, from, to}));
        return out;
    }
    // Off-cost variant select: a no-arrays form takes the 1.3.0 patch body byte-for-
    // byte; toPatchArr adds D2 structure entries + skips added-row field entries.
    const toPatch = hasArrays ? toPatchArr : toPatchFlat;

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
            // D4: 1-arg reinitialize fully re-seeds declared arrays (keys re-derived
            // from next); atomic key validation happens before any mutation.
            if (hasArrays) { reinitArrays(nb); return; }
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
        // D4: per-row keyed merge is a 1.5.0 candidate; a 2-arg merge on a form with
        // ANY declared array fails closed and points to the 1-arg full re-seed.
        if (hasArrays) throw new TypeError("[lite-form] merge-reinitialize (2-arg) is unsupported on a form with declared field arrays; use 1-arg reinitialize(next) to re-seed, or form.array(path) mutations");
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
        // The policy runs inside the engine's own overlay iteration, so it gets
        // the same purity window as a 2-arg reinitialize policy: any mutating
        // form call from inside it throws instead of corrupting the scan. This
        // is the ONE latch window reachable on a declared-arrays form (the
        // 2-arg merge refuses those up front), so the row-API guards fire here.
        merging = true;
        try {
            handle.reconcileAll(policy || eq);
        } finally {
            merging = false;
        }
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
        array,                                            // array(path) -> ArrayHandle (declared field arrays)
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
            // Row-owned signals/computeds live in per-row rs.owned (createRoot leaves
            // them ownerless); the projection slots were recycled by handle.dispose()
            // and the row async effects by the asyncLanes loop above.
            if (hasArrays) {
                for (let i = 0; i < arrayStates.length; i++) {
                    for (const rs of arrayStates[i].rows.values()) {
                        for (let k = 0; k < rs.owned.length; k++) D(rs.owned[k]);
                        rs.owned.length = 0;
                    }
                    arrayStates[i].rows.clear();
                }
            }
            fields.clear();
            fieldList.length = 0;
        },
    };
}
