/**
 * @zakkster/lite-form -- type declarations
 *
 * Field values are addressed by string path, so v1 types them as `any` (a
 * schema-inferred, per-path-typed overload is a future enhancement). The signal
 * handle shapes below mirror lite-signal's runtime: a read is a callable with
 * `.peek()`; a writable read also has `.set/.update/.subscribe`.
 */

/** A read-only reactive value: call to read+track, `.peek()` to read untracked. */
export interface ReadSignal<T> {
    (): T;
    peek(): T;
}

/** A writable reactive value (lite-signal's signal handle). */
export interface WritableSignal<T> extends ReadSignal<T> {
    set(value: T): void;
    update(fn: (prev: T) => T): void;
    subscribe(fn: (value: T) => void): () => void;
}

/** Minimal structural view of a lite-signal registry (for the `registry` option). */
export interface Registry {
    signal: <T>(initial: T) => WritableSignal<T>;
    computed: <T>(fn: () => T) => ReadSignal<T>;
    batch: <T>(fn: () => T) => T;
    dispose: (handle: unknown) => void;
    /** Detached ownership scope for lazy field allocation and subscribe() effects (lite-signal 1.5.0+). */
    createRoot?: <T>(fn: () => T) => T;
    /** Untracked read scope. */
    untrack?: <T>(fn: () => T) => T;
    /** Effect factory (drives field.value.subscribe). */
    effect?: (fn: () => void) => () => void;
    /** True iff a read right now would record a dependency (lazy-field detachment). */
    isTracking?: () => boolean;
    /** Live-observer probe (optional; enables projection slot pruning). */
    hasObservers?: (handle: unknown) => boolean;
}

/** Context handed to every validator for cross-field reads (tracked). */
export interface FieldContext {
    /** Read another field's current value, recording a dependency on it. */
    get(path: string): any;
}

/** A validator returns a message string when invalid, or a falsy value when valid. */
export type Validator = (value: any, ctx: FieldContext) => string | null | false | undefined | void;

/**
 * An async validator: resolves to a message string when invalid, or a falsy value
 * when valid. Only the LATEST-seq settlement per field lands; stale ones are
 * dropped whole. A rejection can never leave the field valid (the rejection reason
 * is coerced to a non-empty error string).
 */
export type AsyncValidator = (value: any, ctx: FieldContext) => Promise<string | null | false | undefined | void>;

/**
 * Factory for a field's async TRIGGER SOURCE, invoked once at construction after
 * the field record is assembled. Returns a reader whose value the async lane
 * tracks -- e.g. `(field) => debounce(() => field.value(), 300)` to debounce the
 * async validation without lite-form owning a timer. A caller-owned reader that
 * exposes `.dispose()` (a lite-debounce api) is torn down with the form.
 */
export type AsyncSourceFactory = (field: Field, ctx: FieldContext) => (() => any);

/** Context handed to a ROW validator: `get(path)` plus `local(sub)`, which reads `<arrayPath>.<thisRowKey>.<sub>` with dependency tracking (cross-field within the same row without knowing the key). */
export interface RowFieldContext extends FieldContext {
    local(sub: string): any;
}

/** A per-row validator (declared inside an array config block, keyed by sub-path). */
export type RowValidator = (value: any, ctx: RowFieldContext) => string | null | false | undefined | void;

/** A per-row async validator: the S3 ordering law applies unchanged (latest settlement wins, stale ones dropped whole). */
export type RowAsyncValidator = (value: any, ctx: RowFieldContext) => Promise<string | null | false | undefined | void>;

/** A per-row async trigger-source factory (the row's Field is passed; the reader is torn down with the row). */
export type RowAsyncSourceFactory = (field: Field, ctx: RowFieldContext) => (() => any);

/**
 * Declares one keyed field array (v1.4.0). The config path must resolve to an
 * Array in `initialValues` (else TypeError at construction). Sub-config maps are
 * keyed by the SUB-PATH within a row (dotted sub-paths legal) -- there is no
 * wildcard path grammar. `key` derives each row's stable identity: called once
 * per row per seed/add/re-seed (never per keystroke), it must return a
 * non-empty string without "." (hostile segments rejected); duplicate keys
 * throw. On a declared array, index addressing (`rows.0.name`) and whole-array
 * writes throw -- the row API is the only door.
 */
export interface ArrayConfig {
    key: (item: any, index: number) => string;
    validators?: Record<string, RowValidator>;
    validatorsAsync?: Record<string, RowAsyncValidator>;
    asyncSources?: Record<string, RowAsyncSourceFactory>;
    fieldOpts?: Record<string, FieldOpt>;
}

/** One row of a declared array: identity-stable per key; `field(sub)` returns the SAME Field as `form.field("<arrayPath>.<key>.<sub>")`. */
export interface Row {
    readonly key: string;
    field(sub: string): Field;
}

/** Reactive handle for one declared array (from `form.array(path)`; cached). */
export interface ArrayHandle {
    /** Tracked. A frozen key-order snapshot -- the SAME array instance until the structure changes (Object.is-friendly). */
    keys(): readonly string[];
    /** Tracked row count. */
    length(): number;
    /** Tracked. True when order differs from baseline or adds/removes are pending. Field edits inside rows do NOT flip this; `isDirty` covers both. */
    structureDirty(): boolean;
    /** Identity-stable row accessor. @throws {TypeError} for a key that is not live. */
    row(key: string): Row;
    /** Insert a row (deep-copied as its ADD SEED) and return its key. `atIndex` 0..length (integer) or omitted to append. */
    add(item: any, atIndex?: number): string;
    /** Remove a row: its signals and async lanes are disposed (in-flight settlements become no-ops) and its projection slots reclaimed. @throws {TypeError} for a non-live key. */
    remove(key: string): void;
    /** Reorder: move a row to `toIndex` (integer 0..length-1). Order-only -- no per-row signal writes, no validator re-runs. */
    move(key: string, toIndex: number): void;
}

/**
 * A merge policy for `reinitialize(next, policy)`: given the incoming server value
 * and the user's current draft, return `true` to CONFIRM the edit (drop the draft,
 * adopt the server value) or a falsy value to keep it a CONFLICT (draft masks the
 * server value). Only a strict `=== true` confirms (fail closed). Deep-copied
 * payloads mean an object-leaf draft is never `Object.is`-equal to the server
 * object, so under the `Object.is` policy an object-leaf edit is always a CONFLICT;
 * supply a structural policy to confirm it.
 */
export type MergePolicy = (nextValue: any, draftValue: any) => boolean;

/** A form-level schema (e.g. a Zod/Yup adapter): receives all values, returns a map of path -> message. Run ONCE per change. */
export type SchemaValidate = (values: Record<string, any>) => Record<string, string | null | false | undefined>;

/** Per-field input transforms, applied at the props() boundary. */
export interface FieldOpt {
    /** Map the raw input value before storing (e.g. Number for a numeric field). */
    parse?: (raw: any) => any;
    /** Map the stored value for display in props().value. */
    format?: (value: any) => any;
}

/** When a field's error becomes visible. `change` reveals once edited; `blur` on first blur; `submit` only after a submit attempt. A submit attempt always reveals everything. */
export type ValidateOn = "change" | "blur" | "submit";

/** Spread onto an `<input>` to bind it (framework-agnostic). */
export interface FieldProps {
    value: any;
    onInput(ev: any): void;
    onBlur(): void;
}

/** Reactive state + actions for a single field. */
export interface Field<T = any> {
    readonly path: string;
    /** The field's value handle: `value()` reads+tracks, `value.peek()` untracked. */
    readonly value: WritableSignal<T>;
    /** Displayed error (reveal-gated by `validateOn`), or null. */
    readonly error: ReadSignal<string | null>;
    /** True when the value differs from its initial reference: `!Object.is(value(), initialRef)` against the field's captured initial reference (re-captured on `reset()`). In-place mutation of an object/array leaf does NOT flip dirty; setting a new reference does. */
    readonly dirty: ReadSignal<boolean>;
    /** Whether the field has been blurred. */
    readonly touched: ReadSignal<boolean>;
    /** Always-live validity (ignores the reveal policy); drives `isValid`. */
    readonly rawError: ReadSignal<string | null>;
    /** True while this field's LATEST async validation is unsettled. A field with no async validator reads a shared frozen `false`. */
    readonly isValidating: ReadSignal<boolean>;
    set(value: T): void;
    blur(): void;
    reset(): void;
    props(): FieldProps;
}

export interface FormConfig {
    initialValues?: Record<string, any>;
    validators?: Record<string, Validator>;
    /** Form-level schema, hoisted to a single computed; merges with per-field validators. */
    validate?: SchemaValidate;
    /** Per-field async validators, keyed by path. Each adds an off-cost async lane with last-write-wins ordering and `isValidating`. Debounce via `asyncSources`. */
    validatorsAsync?: Record<string, AsyncValidator>;
    /** Per-field async trigger-source factories, keyed by path. Wrap a field's value in a debounce so async validation is debounced without lite-form owning a timer. */
    asyncSources?: Record<string, AsyncSourceFactory>;
    /** Keyed field arrays (v1.4.0), keyed by the dotted path of an Array in `initialValues`. Opt-in per path: an UNDECLARED array stays a plain leaf value exactly as before. */
    arrays?: Record<string, ArrayConfig>;
    /** Per-field parse/format, keyed by path. Config-level because fields are allocated eagerly. */
    fieldOpts?: Record<string, FieldOpt>;
    validateOn?: ValidateOn;
    /** Runs on a valid submit: receives the full `values()` snapshot, or the dirty-only `toPatch()` array when `submit(ev, { patch: true })` is used. */
    onSubmit?:
        | ((values: Record<string, any>) => void | Promise<void>)
        | ((patch: FormPatchEntry[]) => void | Promise<void>);
    /** Use a specific lite-signal registry instead of the default one. Bind with that registry's `effect`. */
    registry?: Registry;
    /**
     * Engine mode: overlay drafts over a LIVE keyed source (e.g. a lite-store
     * proxy) instead of the detached baseline. In source mode `field.dirty` is
     * overlay presence -- an authoritative write to an un-overlaid field changes
     * the value but is NOT an edit; a write under an overlaid field stays masked.
     * `commit()` writes drafts through to the source. Must share the source's
     * lite-signal registry (typically the default one).
     */
    source?: Record<PropertyKey, any>;
}

/** One dirty path as a patch entry: `from` = baseline value, `to` = current value. */
export interface FormPatch {
    path: string;
    from: any;
    to: any;
}

/** The structure half of an array patch entry (v1.4.0). */
export interface ArrayStructure {
    /** Full current key order. */
    order: readonly string[];
    /** Added rows, each with its FULL current value -- added-row fields never emit separate field entries (no overlapping patches). */
    added: ReadonlyArray<{ key: string; index: number; value: any }>;
    /** Baseline keys no longer present. */
    removed: readonly string[];
}

/** One structurally-dirty declared array as a patch entry (emitted only when structure-dirty). */
export interface FormStructurePatch {
    path: string;
    structure: ArrayStructure;
}

/** What `toPatch()` returns: per-field entries (existing rows and plain fields) plus at most one structure entry per declared array. */
export type FormPatchEntry = FormPatch | FormStructurePatch;

export interface Form {
    /** Get a field's reactive state by path (dotted paths supported for nesting). A path not declared in `initialValues` is created lazily on first access; a lazy field allocated while a tracking context is live is created inside the form's own `registry.createRoot()`, so it survives effect re-runs (safe as of lite-signal 1.5.0). */
    field(path: string): Field;
    /** Reactive handle for a declared array (v1.4.0). @throws {TypeError} for a path not declared in `config.arrays`. */
    array(path: string): ArrayHandle;
    /** Snapshot of all current values (untracked). Materialized by an own-key walk: baseline branches plus a per-field deep copy of each leaf, so the returned tree never aliases the form's internal state. An uncopyable runtime value (a leaf that was `set()` to a function/Map/Set/RegExp/TypedArray/class instance/symbol, or a cycle) throws a `TypeError` naming its path. */
    values(): Record<string, any>;
    /** Batch-set values by path: `setValues({ email: "x", "user.name": "y" })`. */
    setValues(patch: Record<string, any>): void;
    /** Restore all fields to their initial values and clear touched/submit state. */
    reset(): void;
    /** Fold dirty values into the baseline (committed values are deep-copied through the whitelist), leaving every field pristine and `reset()` targeting the committed state. With `path`, commits just that field. A set-back-to-initial field is not written. @throws {TypeError} for a `path` no field was ever created for -- a typo'd commit is loud, never a lazy field creation. */
    commit(path?: string): void;
    /** List exactly the dirty paths as `[{ path, from, to }]` (`from` = baseline value, `to` = current), plus at most one `{ path, structure }` entry per structurally-dirty declared array. Entries never overlap: an added row rides `structure.added` with its full value and emits no field entries. Untracked and read-only -- safe to call inside an effect. */
    toPatch(): FormPatchEntry[];
    /**
     * Re-seed the form. 1-arg `reinitialize(next)` re-seeds like `initialValues`
     * and DROPS every edit: `next` is validated and deep-copied atomically BEFORE
     * any state change (a hostile key, cycle, or uncopyable leaf throws a
     * `TypeError` with nothing mutated), then every field re-captures its initial
     * reference (a path absent from `next` re-seeds `undefined`), overlays are
     * reverted, and touched/submit state clears.
     *
     * 2-arg `reinitialize(next, policy)` MERGES fresh server data while the user
     * edits (default mode only; throws in source mode -- use `reconcile`): a
     * pristine field adopts the new value; a dirty field whose edit the `policy`
     * confirms goes pristine at the new value; a dirty field whose edit conflicts
     * keeps the draft (masking the new value) but re-seeds the baseline underneath
     * so `reset()`/`toPatch()` target it. Atomic: validate+copy and the verdict
     * pre-scan run with NO mutation, so a hostile leaf or a throwing `policy`
     * leaves the form untouched. Submit state is never written by the merge.
     *
     * With declared arrays (v1.4.0): 1-arg re-seeds each declared array fully
     * (keys re-derived from `next`, all row state cleared, order adopted);
     * the 2-arg MERGE throws a `TypeError` on a form with declared field
     * arrays -- keyed row merge is a recorded future design.
     */
    reinitialize(next: Record<string, any>, policy?: MergePolicy): void;
    /** Source mode: drop every overlay the `policy` confirms against the current source value (default `Object.is`); conflicts stay masked. A near-no-op in default mode. */
    reconcile(policy?: MergePolicy): void;
    /** Reveal errors, validate, and run `onSubmit` if valid -- `onSubmit(values())`, or `onSubmit(toPatch())` when `opts.patch` is true. Resolves to whether submission ran. */
    submit(ev?: { preventDefault?: () => void }, opts?: { patch?: boolean }): Promise<boolean>;
    /** True validity (independent of whether errors are shown). While any async lane is pending, this is strictly `false` (fail closed). */
    readonly isValid: ReadSignal<boolean>;
    /** True if any field differs from its initial value. */
    readonly isDirty: ReadSignal<boolean>;
    /** True while any async field's latest validation is unsettled. A form with no async validators reads a shared frozen `false`. */
    readonly isValidating: ReadSignal<boolean>;
    /** True while an async `onSubmit` is in flight. */
    readonly isSubmitting: ReadSignal<boolean>;
    /** The last error thrown by `onSubmit`, or null. */
    readonly submitError: ReadSignal<unknown>;
    /** Whether a submit has been attempted (reveals all errors once true). */
    readonly submitAttempted: ReadSignal<boolean>;
    /** Free every signal/computed this form created. */
    dispose(): void;
}

/**
 * Create a form. `initialValues` is deep-copied once at construction (the caller's
 * object is never aliased or read again); object leaves are copied again at each
 * seed / `reset()` / snapshot materialization.
 * @throws {TypeError} at construction for a hostile own key (`__proto__`,
 *   `constructor`, `prototype`) anywhere in `initialValues` / `validators` /
 *   `fieldOpts`, a cycle in `initialValues`, or a leaf that is not a
 *   primitive / Array / Date / plain object (function, Map, Set, RegExp,
 *   TypedArray, class instance, symbol). The path is named in the message.
 */
export function createForm(config?: FormConfig): Form;

/** Package version, kept in sync with package.json. */
export const VERSION: string;
