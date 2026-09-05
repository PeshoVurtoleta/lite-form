/**
 * @zakkster/lite-form · type declarations
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
}

/** Context handed to every validator for cross-field reads (tracked). */
export interface FieldContext {
    /** Read another field's current value, recording a dependency on it. */
    get(path: string): any;
}

/** A validator returns a message string when invalid, or a falsy value when valid. */
export type Validator = (value: any, ctx: FieldContext) => string | null | false | undefined | void;

/** A form-level schema (e.g. a Zod/Yup adapter): receives all values, returns a map of path → message. Run ONCE per change. */
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
    /** True when the value differs from its initial value. */
    readonly dirty: ReadSignal<boolean>;
    /** Whether the field has been blurred. */
    readonly touched: ReadSignal<boolean>;
    /** Always-live validity (ignores the reveal policy); drives `isValid`. */
    readonly rawError: ReadSignal<string | null>;
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
    /** Per-field parse/format, keyed by path. Config-level because fields are allocated eagerly. */
    fieldOpts?: Record<string, FieldOpt>;
    validateOn?: ValidateOn;
    onSubmit?: (values: Record<string, any>) => void | Promise<void>;
    /** Use a specific lite-signal registry instead of the default one. Bind with that registry's `effect`. */
    registry?: Registry;
}

export interface Form {
    /** Get a field's reactive state by path (dotted paths supported for nesting). */
    field(path: string): Field;
    /** Snapshot of all current values (untracked). */
    values(): Record<string, any>;
    /** Batch-set values by path: `setValues({ email: "x", "user.name": "y" })`. */
    setValues(patch: Record<string, any>): void;
    /** Restore all fields to their initial values and clear touched/submit state. */
    reset(): void;
    /** Reveal errors, validate, and run `onSubmit(values())` if valid. Resolves to whether submission ran. */
    submit(ev?: { preventDefault?: () => void }): Promise<boolean>;
    /** True validity (independent of whether errors are shown). */
    readonly isValid: ReadSignal<boolean>;
    /** True if any field differs from its initial value. */
    readonly isDirty: ReadSignal<boolean>;
    /** True while an async `onSubmit` is in flight. */
    readonly isSubmitting: ReadSignal<boolean>;
    /** The last error thrown by `onSubmit`, or null. */
    readonly submitError: ReadSignal<unknown>;
    /** Whether a submit has been attempted (reveals all errors once true). */
    readonly submitAttempted: ReadSignal<boolean>;
    /** Free every signal/computed this form created. */
    dispose(): void;
}

export function createForm(config?: FormConfig): Form;

/** Package version, kept in sync with package.json. */
export const VERSION: string;
