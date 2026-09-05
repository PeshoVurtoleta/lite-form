# @zakkster/lite-form

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-form.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-form)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
[![zero-gc](https://img.shields.io/badge/zero--GC-steady--state-5fe39f.svg)](#why-this-exists)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-form?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-form)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-form?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-form)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-form?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-form)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational?style=flat-square)
[![lite-signal peer](https://img.shields.io/npm/dependency-version/@zakkster/lite-form/peer/@zakkster/lite-signal?style=for-the-badge&color=blue)](https://github.com/PeshoVurtoleta/lite-signal)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE.txt)

> Headless reactive forms for `@zakkster/lite-signal`.
> No DOM, no virtual DOM, no compiler. **Typing in one field of a 100-field form
> runs exactly one validator** -- every other field is a cached read.

```bash
npm i @zakkster/lite-form @zakkster/lite-signal @zakkster/lite-project
```

```js
import { createForm } from "@zakkster/lite-form";

const form = createForm({
    initialValues: { email: "", password: "" },
    validators: {
        email:    (v) => /@/.test(v) ? null : "invalid email",
        password: (v) => v.length >= 8 ? null : "min 8 chars",
    },
    onSubmit: async (vals) => fetch("/api/login", { method: "POST", body: JSON.stringify(vals) }),
});

// Bind to anything -- vanilla DOM, lite-element, your own renderer:
const e = form.field("email");
emailInput.value = e.value();
emailInput.addEventListener("input", (ev) => e.set(ev.target.value));
// e.error() is a live reactive read -- null until shown
```

**Headline (measured on Node 22, see [Benchmarks](#benchmarks)):**
**~1.5 million keystrokes/sec** on a 100-field form -- typing in one field runs
exactly one validator. **8× faster than a hand-written "run all validators on
every change" form.** Lifecycle: ~210K create+dispose/sec, ~1 byte retained per
form. Pool returns to baseline (`stats().activeNodes === 0`).

---

## Table of contents

- [Why this exists](#why-this-exists)
- [What you get](#what-you-get)
- [Quickstart](#quickstart)
- [Validation modes](#validation-modes)
- [The two validation pipelines](#the-two-validation-pipelines)
- [Cross-field validation](#cross-field-validation)
- [Schema (Zod / Yup)](#schema-zod--yup)
- [Async validation](#async-validation)
- [Surfacing server errors (the `setFieldError` story)](#surfacing-server-errors-the-setfielderror-story)
- [Submit lifecycle](#submit-lifecycle)
- [API reference](#api-reference)
- [Benchmarks](#benchmarks)
- [The engine](#the-engine)
- [Edge cases pinned down](#edge-cases-pinned-down)
- [What this is **not**](#what-this-is-not)
- [Browser / runtime support](#browser--runtime-support)
- [Peer dependency](#peer-dependency)
- [FAQ](#faq)
- [License](#license)

---

## Why this exists

A small set of design constraints picked deliberately:

- **One validator per keystroke.** When you type in `email`, lite-form runs
  `email`'s validator and nothing else. The other 99 fields keep their cached
  error values. There is no `<form>` re-render, no validation pass over the
  whole shape, no diff. Cutoff-gated computeds + reveal-gated display do this
  for free.
- **One schema run per keystroke, not one per field.** If you use a form-level
  schema (Zod, Yup, custom), it's hoisted into a single computed that runs
  exactly once per change. Every field reads `schema[path]` as a cached lookup;
  lite-signal's `Object.is` cutoff means only fields whose error actually
  flipped propagate to the DOM.
- **Validity vs. display are split.** `isValid()` always reflects true validity
  -- drives a submit button correctly from the first render. A field's
  `error()` is reveal-gated (`change` / `blur` / `submit`), so a pristine form
  doesn't scream "required" at the user before they've touched anything.
- **No DOM. No renderer.** lite-form ships ~621 lines of pure state. Bind it
  with `@zakkster/lite-signal-dom`, `@zakkster/lite-element`, hand-written
  `addEventListener`, or whatever you want. Forms are state, not components.
- **Pool-clean teardown.** `form.dispose()` frees every signal and computed.
  `stats().activeNodes` returns to baseline. We test it on a 100-field form;
  the bench audits the global pool at the end of every run.

If you want a `<Form>` component, a renderer, a CSS framework, a server adapter,
or a 12-step wizard runtime -- this is the wrong library. One factory function,
two peer deps (lite-signal always; lite-project only when you opt into engine
mode), ~6.4 KB minified.

---

## What you get

```js
const form = createForm({
    initialValues:  { /* shape your form here */ },
    validators:     { /* path -> (value, ctx) => message | null */ },
    validate:       /* optional: (values) => { path: message } -- Zod adapter goes here */,
    fieldOpts:      { /* path -> { parse, format } */ },
    validateOn:     "change" | "blur" | "submit",
    onSubmit:       async (values) => { /* ... */ },
    registry:       /* optional: a createRegistry() handle for isolation */,
});

// Per-field reactive state:
form.field("email").value()      // reactive read (call to subscribe)
form.field("email").error()      // reveal-gated displayed error
form.field("email").dirty()      // reactive boolean
form.field("email").touched()    // reactive boolean
form.field("email").set(value)   // write
form.field("email").blur()       // mark touched
form.field("email").reset()      // back to initial
form.field("email").props()      // { value, onInput, onBlur } -- spread onto an <input>

// Form-level reactive state:
form.isValid()        // always live (not reveal-gated)
form.isDirty()        // any field differs from initial
form.isSubmitting()   // async onSubmit in flight
form.submitError()    // last operational error (or null)
form.submitAttempted()// reveals all errors once true

// Imperative actions:
form.values()                                // untracked snapshot
form.setValues({ email: "x", password: "y" })// batched multi-set
form.reset()                                 // back to initialValues; clears submit state
form.submit(ev?)                             // Promise<boolean> -- runs validation + onSubmit
form.dispose()                               // free every signal/computed
```

---

## Quickstart

A complete sign-in form, framework-agnostic. Wire it to any reactive primitive
(`effect` from lite-signal, lite-element's `bind`, lite-signal-dom, manual):

```js
import { createForm } from "@zakkster/lite-form";
import { effect } from "@zakkster/lite-signal";

const form = createForm({
    initialValues: { email: "", password: "" },
    validators: {
        email:    (v) => v ? (/@/.test(v) ? null : "invalid email") : "required",
        password: (v) => v.length >= 8 ? null : "min 8 chars",
    },
    onSubmit: async ({ email, password }) => {
        const r = await fetch("/api/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email, password }),
        });
        if (!r.ok) throw new Error("login failed");
    },
});

// Wire to plain DOM. Each input mirrors its field; each <span> shows the error.
const $ = (id) => document.getElementById(id);
for (const name of ["email", "password"]) {
    const f = form.field(name);
    const inp = $(name), err = $(name + "-error");
    inp.addEventListener("input", (ev) => f.set(ev.target.value));
    inp.addEventListener("blur", () => f.blur());
    effect(() => { inp.value = f.value(); });
    effect(() => { err.textContent = f.error() || ""; });
}

// Submit button only enabled while valid; reflects in-flight state.
const btn = $("submit");
effect(() => {
    btn.disabled = !form.isValid() || form.isSubmitting();
    btn.textContent = form.isSubmitting() ? "Signing in..." : "Sign in";
});
$("form").addEventListener("submit", (ev) => form.submit(ev));
```

---

## Validation modes

`validateOn` controls when errors become **visible**. It does NOT affect
`isValid()` -- that's always live.

| mode       | error shown when...                                     |
|------------|-------------------------------------------------------|
| `"change"` | the field becomes dirty (default -- keystroke reveal)  |
| `"blur"`   | the field is blurred for the first time               |
| `"submit"` | the form has had at least one submit attempt          |

A submit attempt always reveals everything, regardless of the mode. `reset()`
clears the submit-attempted flag, so a fresh form is pristine again.

---

## The two validation pipelines

Both feed into the same `field.error()` read; you can use either, both, or
neither. They merge cleanly: per-field validators run first, schema fills in
what they don't cover.

### Per-field validators

```js
validators: {
    email:    (v, ctx) => /@/.test(v) ? null : "invalid email",
    password: (v, ctx) => v.length >= 8 ? null : "min 8 chars",
}
```

A per-field validator is a function `(value, ctx) => string | null`. It depends
only on its own field's value (plus anything it reads via `ctx.get(path)`, see
[Cross-field validation](#cross-field-validation)). The keystroke path is lean:
typing in `email` runs `email`'s validator and no other.

### Form-level schema

```js
import { z } from "zod";
const schema = z.object({ email: z.string().email(), age: z.number().min(18) });

const form = createForm({
    initialValues: { email: "", age: 0 },
    validate: (values) => {
        const r = schema.safeParse(values);
        if (r.success) return {};
        return Object.fromEntries(
            r.error.issues.map(i => [i.path.join("."), i.message])
        );
    },
});
```

The `validate` function runs in **one** hoisted computed, exactly once per
keystroke. Every field reads its slot from the result as an O(1) lookup.
Object.is cutoff means a field that stays "required" across keystrokes
doesn't re-render the DOM.

This means: **plug in your Zod parse, your Yup schema, your hand-rolled
validator -- the cost per keystroke is the cost of ONE schema run, not N.**

---

## Cross-field validation

A validator's `ctx.get(path)` is a tracked read: depending on another field
makes this field re-validate whenever the dependency changes.

```js
createForm({
    initialValues: { password: "", confirm: "" },
    validators: {
        confirm: (v, { get }) => v === get("password") ? null : "must match",
    },
});
```

Typing in `password` re-validates `confirm` automatically. There's no
dependency declaration, no `dependsOn: ["password"]`, no manual subscription
-- the act of reading `get("password")` records the dependency. The same
mechanism lite-signal uses for `computed`.

---

## Schema (Zod / Yup)

Adapters are 4-line functions. Plug them into `validate`:

```js
// Zod
const zodAdapter = (schema) => (values) => {
    const r = schema.safeParse(values);
    return r.success ? {} :
        Object.fromEntries(r.error.issues.map(i => [i.path.join("."), i.message]));
};

// Yup
const yupAdapter = (schema) => async (values) => {
    try { await schema.validate(values, { abortEarly: false }); return {}; }
    catch (e) { return Object.fromEntries(e.inner.map(i => [i.path, i.message])); }
};
```

> The form-level `validate` schema is sync (one hoisted run per keystroke).
> Per-field ASYNC business validation is first-class since v1.3.0 -- see
> [Async validation](#async-validation).

Schema errors merge with per-field validators: per-field message wins if
present, otherwise the schema message shows. Useful for "the schema validates
shape; the per-field validator checks availability".

---

## Async validation

`validatorsAsync` gives a field an async lane beside its sync validator -- your
promise, sequenced by lite-form. There is no timer, no debounce, no transport
machinery inside lite-form: the validator returns a promise; lite-form
guarantees ordering.

```js
const form = createForm({
    initialValues: { username: "" },
    validators:      { username: (v) => v ? null : "required" },   // sync lane, instant
    validatorsAsync: {
        username: async (v) => {
            const r = await fetch("/api/taken?u=" + encodeURIComponent(v));
            return (await r.json()).taken ? "already taken" : null;
        },
    },
});

form.field("username").isValidating();  // true while the LATEST check is unsettled
form.isValidating();                    // true while ANY field's check is unsettled
```

The ordering contract:

- **Last write wins.** Every trigger bumps a per-field sequence; a settlement
  (resolve OR reject) carrying a stale sequence is dropped whole -- no signal
  write, no error flash, no trace.
- **Pending is not-yet-valid.** While any async verdict is pending, `isValid()`
  is `false` (strict fail-closed). `submit()` therefore refuses while
  validation is in flight -- a pending verdict can never race a submit into a
  false positive.
- **A rejection is a verdict.** The latest rejection surfaces as the field's
  error message (a rejection can never leave the field valid); stale
  rejections are swallowed with no unhandled-rejection.
- **`dispose()` mid-flight is safe.** A settlement arriving after `dispose()`
  is a complete no-op.
- **Off-cost when unused.** A form with no `validatorsAsync` allocates no
  async machinery and keeps the 1.2.0 keystroke numbers byte-for-byte; on a
  mixed form, sync-only fields pay nothing either (their `isValidating` is a
  shared frozen constant).

**Debouncing (the lite-debounce recipe).** Firing a server check per keystroke
is the caller's decision -- lite-form owns no timers. Hand the async lane a
debounced reader via `asyncSources`; the check then re-fires when the debounced
read changes instead of on every keystroke:

```js
import { debounce } from "@zakkster/lite-debounce";

const form = createForm({
    initialValues: { username: "" },
    validatorsAsync: { username: checkAvailability },
    asyncSources: {
        // called once at construction, inside the form's own root:
        username: (fld) => debounce(() => fld.value(), 300),
    },
});
```

An async-validated keystroke allocates -- promise machinery is inherent
(measured 629.703 B/op, recorded in the torture tier, settlements outside the
window). That cost is exactly why the debounce recipe exists; the sync path
stays gated at zero.

---

## Surfacing server errors (the `setFieldError` story)

lite-form has no `setFieldError(path, message)` API. It doesn't need one.

Per-field validators run inside a `computed`, so any signal they read is
tracked. The canonical pattern is: hold the server error in a signal; flip
it from your fetch handler. The field re-validates automatically.

```js
import { signal, effect } from "@zakkster/lite-signal";

const usernameServerErr = signal(null);   // null | "already taken" | ...

const form = createForm({
    initialValues: { username: "", email: "" },
    validators: {
        username: (v) => {
            if (!v) return "required";
            if (v.length < 3) return "too short";
            return usernameServerErr() || null;     // tracked read
        },
    },
    async onSubmit(values) {
        const res = await fetch("/api/signup", { method: "POST", body: JSON.stringify(values) });
        if (res.status === 409) {
            const body = await res.json();
            if (body.field === "username") usernameServerErr.set(body.message);
            throw new Error("signup failed");        // surfaces in submitError too
        }
    },
});

// Clear the server error when the user starts editing -- the user has acknowledged it:
effect(() => { form.field("username").value(); usernameServerErr.set(null); });
```

Why this is strictly nicer than a `setFieldError` method:

- **No imperative call** -- the field error is a function of `value × server-state`,
  always. It can't get out of sync with the value (the classic "clear server
  error when user types" footgun is one effect, not a forgotten listener).
- **No race** between programmatic write and reactive validate. The signal
  flip and the validator re-run are in the same reactive transaction.
- **Disposal is free** -- `serverErr` is a plain lite-signal handle. Pass a
  `registry` to `createForm` and they're cleaned up together.
- **Composable** -- multiple validators can read the same server-error signal
  (e.g. a generic `formErr` plus per-field overrides). Try doing that with
  imperative `setFieldError` calls without re-applying them on every change.

For form-wide errors (the whole submission failed, not one field),
`submitError()` is already wired -- your `onSubmit` just throws.

---

## Submit lifecycle

```js
const ok = await form.submit(ev?);
```

1. `ev.preventDefault()` if `ev` is provided.
2. `submitAttempted` flips to `true` -> reveals all errors.
3. If `isValid()` is false -> returns `false` synchronously. No call to `onSubmit`.
4. `isSubmitting` flips to `true`.
5. `onSubmit(values())` is invoked with an **untracked** snapshot.
6. On success: returns `true`, `isSubmitting` flips back, `submitError` is cleared.
7. On throw:
   - `ReferenceError` / `SyntaxError` -> re-thrown after `console.error`. These
     are structural bugs in your code, not legitimate submission outcomes;
     hiding them in `submitError` would be a debugging nightmare.
   - Any other error (including `TypeError` from `fetch()` network failure)
     -> stored in `submitError()`, returns `false`. `isSubmitting` resets.

`submit()` and `onSubmit` are both called inside `untrack` -- they don't
accidentally subscribe the calling effect to internal form state, and your
`onSubmit` can read `auth.token()` without that becoming a dependency.

### Double-submit defense (concurrent `submit()` IS a footgun)

`submit()` is **not** internally deduped. If `submit()` is called twice while
one call is still awaiting `onSubmit`, both calls go through. Both `onSubmit`
invocations run concurrently against the same values snapshot. Both return
`true` if the request succeeds. This is intentional simplicity -- lite-form
holds no in-flight lock and no internal queue -- but it does mean a hotkey
that fires `submit()` from two places, or a parent component re-rendering and
re-attaching a handler, can double-fire your network request.

Three documented defenses, in order of how often you'll want each:

**1. Disable the submit button** (covers ~90% of cases -- UI forms with a
single submit element):

```js
effect(() => { btn.disabled = form.isSubmitting() || !form.isValid(); });
```

**2. Throttle the handler** with [@zakkster/lite-throttle](https://www.npmjs.com/package/@zakkster/lite-throttle) (covers Enter-key + button, hotkey + button, two places that
both fire `submit()`):

```js
import { throttle } from "@zakkster/lite-throttle";
const guardedSubmit = throttle(() => form.submit(), {
    leading: true,        // fire the first call
    trailing: false,      // drop subsequent calls in the window
    wait: 500,
});
formEl.addEventListener("submit", (e) => { e.preventDefault(); guardedSubmit(); });
```

**3. Guard inside your own handler** with `isSubmitting.peek()` (one-liner,
no extra dependency):

```js
function onFormSubmit(e) {
    e.preventDefault();
    if (form.isSubmitting.peek()) return;
    form.submit();
}
```

Don't disable both -- pick the one that matches your UI surface. Disabling
the button alone won't help if `submit()` is also bound to Enter on the
document; that's where throttle wins.

---

## API reference

### `createForm(config?) -> Form`

| option          | type                                                | default          |
|-----------------|-----------------------------------------------------|------------------|
| `initialValues` | `Record<string, any>`                               | `{}`             |
| `validators`    | `Record<string, (value, ctx) => string \| null>`    | `{}`             |
| `validate`      | `(values) => Record<string, string \| null>`        | --                |
| `validatorsAsync` | `Record<string, (value, ctx) => Promise<string \| null>>` | `{}`      |
| `asyncSources`  | `Record<string, (field, ctx) => (() => any)>`       | the field's value |
| `fieldOpts`     | `Record<string, { parse?, format? }>`               | `{}`             |
| `validateOn`    | `"change" \| "blur" \| "submit"`                    | `"change"`       |
| `onSubmit`      | `(values) => void \| Promise<void>`                 | --                |
| `registry`      | `createRegistry()` handle                           | default registry |
| `source`        | live keyed source (e.g. a lite-store proxy)         | --                |

Passing `source` selects **engine mode**: the value core projects the live
source instead of the detached baseline. Edits stage as overlays (the source is
never written by an edit); `commit()` writes through. In this mode `dirty` is
overlay presence -- an authoritative source write under an un-overlaid field is
not an edit and never flips dirty; a conflicting write under an overlaid field
stays masked. Without `source`, the form projects the detached baseline through
the same engine -- lite-project is imported statically and required in BOTH modes.

### `form.field(path) -> Field`

Returns the reactive state for a field. Paths are dotted (`"user.address.zip"`,
`"items.0.qty"`). Fields declared in `initialValues`/`validators`/`fieldOpts`
are eagerly allocated; calling `field()` on an undeclared path creates one
lazily on first access.

### Field

| member        | type                       | notes                                                  |
|---------------|----------------------------|--------------------------------------------------------|
| `path`        | `string`                   |                                                        |
| `value`       | `WritableSignal<T>`        | `value()` reads+tracks, `value.peek()` untracked       |
| `error`       | `ReadSignal<string\|null>` | reveal-gated; merges per-field + schema                |
| `rawError`    | `ReadSignal<string\|null>` | always-live validity (ignores reveal); drives isValid  |
| `dirty`       | `ReadSignal<boolean>`      | `!Object.is(value(), initialRef)`; in-place mutation does not flip it, `set(newRef)` does |
| `touched`     | `ReadSignal<boolean>`      | blurred at least once                                  |
| `isValidating`| `ReadSignal<boolean>`      | latest async check unsettled; async-validated fields only (a shared frozen `false` otherwise) |
| `set(v)`      | function                   |                                                        |
| `blur()`      | function                   | marks touched                                          |
| `reset()`     | function                   | back to initial value, clears touched                  |
| `props()`     | `() => FieldProps`         | `{ value, onInput, onBlur }` -- spread onto `<input>`   |

### Form

| member             | type                                | notes                                          |
|--------------------|-------------------------------------|------------------------------------------------|
| `field(path)`      | `(string) => Field`                 |                                                |
| `values()`         | `() => object`                      | untracked snapshot                             |
| `setValues(patch)` | `(object) => void`                  | batched multi-set                              |
| `reset()`          | `() => void`                        | restore initial, clear touched + submit state  |
| `commit(path?)`    | `(path?) => void`                   | fold dirty values into the baseline (all, or one path); committed fields go pristine, `reset()` now targets the committed state; values deep-copied through the whitelist; an unregistered `path` throws a `TypeError` (loud, never a lazy field creation) |
| `toPatch()`        | `() => Array<{path, from, to}>`     | exactly the dirty paths (`from` = baseline, `to` = current); a field set back to its initial ref is excluded; untracked + read-only, safe in an effect |
| `reinitialize(next, policy?)`| `(next, policy?) => void`  | 1-arg: re-seed like `initialValues` (deep-copied + whitelist-validated BEFORE any state change -- atomic `TypeError` on bad input); drops every edit, absent paths re-seed `undefined`, clears touched + submit state. With a `policy`: MERGES instead -- dirty fields survive unless echoed (see [The engine](#the-engine)); default-mode only (source mode throws -- use `reconcile`) |
| `reconcile(policy?)`| `(policy?) => void`                | source-mode merge: drop exactly the overlays the source now agrees with (default `Object.is`); legal in default mode too (a no-op under the default policy, by design) |
| `submit(ev?, opts?)`| `(ev?, {patch?}) => Promise<boolean>` | true if `onSubmit` ran without throwing; `opts.patch: true` posts `toPatch()` to `onSubmit` instead of `values()` (an empty patch still submits `[]` -- the caller checks `.length`) |
| `isValidating`     | `ReadSignal<boolean>`               | true while ANY field's async check is unsettled |
| `isValid`          | `ReadSignal<boolean>`               | always live                                    |
| `isDirty`          | `ReadSignal<boolean>`               |                                                |
| `isSubmitting`     | `ReadSignal<boolean>`               |                                                |
| `submitError`      | `ReadSignal<Error \| null>`         | last operational throw                         |
| `submitAttempted`  | `WritableSignal<boolean>`           | set true to force-reveal                       |
| `dispose()`        | `() => void`                        | free every node                                |

---

## Benchmarks

Measured on Node 22.22 with `--expose-gc`. Run yourself: `npm run bench`.

| Scenario                                                          | N       | ops/sec     | transient/op | retained/op |
|-------------------------------------------------------------------|--------:|------------:|-------------:|------------:|
| **A) create+dispose, small** (3 fields, 1 validator)              | 20K     | **~210K**   | ~260 B       | ~2 B        |
| **B) create+dispose, large** (100 fields + per-field validators)  | 2K      | ~1.3K       | ~9 KB        | ~1 B        |
| **C) keystroke on 1 of 100 fields** (per-field validators)        | 50K     | **~1.5M**   | ~28 B        | ~1 B        |
| **D) keystroke on 1 of 100 fields** (form-level schema, hoisted)  | 50K     | ~30K        | ~164 B       | ~1 B        |
| **E) cross-field validation** (pw + confirm, ctx.get)             | 50K     | **~5M**     | ~25 B        | 0 B         |
| **F) pure-JS baseline** (handwritten, runs all 100 validators)    | 50K     | ~180K       | ~8 B         | 0 B         |

**Headline:**

- **A keystroke on a 100-field form lite-form ~ 8× faster** than the
  handwritten pattern that re-runs every validator on every change (F vs C).
  The reason: lite-form only invokes `f0`'s validator. The other 99 fields'
  validators are cached and never called -- their `error()` short-circuits
  on the reveal gate before reading `rawError()`.
- **Schema-validated forms cost ~33 µs per keystroke** at N=100 (D). The cost
  is dominated by snapshot construction (an own-key walk that deep-copies each
  leaf + setPath × N) -- your Zod parse runs **once** per change, not N times.
- **Cross-field validation is cheap.** `ctx.get` records a dependency on
  read; subsequent changes re-validate only the dependent. ~5M ops/sec.
- **Pool clean.** All scenarios end with `stats().activeNodes === 0` --
  no leaked signals or computeds across 100K+ lifecycle cycles.

> *Numbers vary ~15% run-to-run with GC timing. The bench file is
> `bench/bench.mjs`; copy it, modify, re-run.*

---

## The engine

As of v1.2.0 the value core rides a `@zakkster/lite-project` projection over the
S1 detached baseline. The default mode is a `fromAccessors` projection over
per-field seed copies plus a `baselineRev` signal; the engine owns a per-key
overlay signal and a projected computed, with the slot warmed at field creation.
Validation, reveal gating, and submit stay lite-form's own code -- the swap is
confined to how a field's value is stored and read.

**The unification trick.** `field.set(v)` compares `Object.is(v, seed)`; on
equality it *clears* the overlay instead of staging it. So "overlaid" coincides
exactly with "dirty", and `form.isDirty` rides the engine's tracked
`dirtyCount()` rather than a separate walk.

**The scratch-tree contract.** Schema mode no longer clones the value tree per
keystroke. The internal materialization handed to `validate()` reuses a per-form
scratch tree -- leaves written in place, object leaves shared by reference --
rebuilt only on `reinitialize`/`commit`. The object passed to schema
`validate()` is therefore **form-owned and transient: retaining or mutating it
is undefined behaviour.** Public `values()` is unaffected -- it still returns a
fresh deep copy every call.

Every S1 contract survives verbatim: the baseline stays unreachable
(`source.get` returns the field's seed copy, never a baseline reference; commit
deep-copies in), `dirty = !Object.is(value(), initialRef)`, the construction
whitelist / cycle / hostile-segment `TypeError`s, and the copying snapshot with
its path-naming `TypeError`.

**commit + toPatch round-trip.** The new methods give you an explicit
edit/baseline boundary -- diff the pending edits, ship them, then fold them in:

```js
const form = createForm({ initialValues: { name: "Ann", role: "dev" } });

form.field("name").set("Bob");
form.isDirty();        // true
form.toPatch();        // [{ path: "name", from: "Ann", to: "Bob" }]

await save(form.toPatch());   // ship exactly the dirty paths
form.commit();                // fold edits into the baseline

form.isDirty();        // false -- every field pristine again
form.field("name").reset();   // stays "Bob" -- reset() targets the committed state
```

**Server data while the user edits: `reinitialize(next, policy)`.** The 1-arg
form is unchanged (atomic re-seed, drops every edit). Passing a `policy` merges
instead: dirty fields survive unless the server echoed them. Per registered
field, with `n` = the deep-copied `next` leaf and `d` = the user's draft:

| field state | verdict | result |
|---|---|---|
| pristine | ADOPT | takes `n`; stays pristine; touched cleared |
| dirty, `Object.is(n, d)` or `policy(n, d) === true` | ECHO | overlay cleared; pristine at `n`; touched cleared |
| dirty, anything else | CONFLICT | draft kept (masks `n`); baseline re-seeds underneath -- `reset()` now lands `n` and `toPatch().from === n`; touched kept |
| path absent from `next` | the same table with `n = undefined` | |

The default policy is `Object.is` (confirm-on-echo). Deep-copied payloads mean
an OBJECT leaf can never `Object.is`-echo -- object edits are always conflicts
under the default; pass a structural policy when your leaves are objects. Only
`=== true` confirms (fail closed), a throwing policy is atomic (nothing
mutated), and a merge never touches `submitAttempted`/`submitError` -- a
background refresh must not un-reveal errors mid-flow. The policy must be
PURE: any mutating form call from inside the merge window (`set`, `commit`,
`reset`, a nested `reinitialize`, ...) throws a `TypeError` -- verdicts are
pre-scanned against a snapshot, and applying them over mutated state would be
silent corruption.

In source mode there is no detached baseline to re-seed, so the merge story is
`form.reconcile(policy?)` -- drop exactly the overlays the live source now
agrees with. `reinitialize(next, policy)` in source mode throws (loud, never a
silent fallback).

Allocation, measured on Node 26 (`node --expose-gc --preserve-symlinks
test/torture.mjs`):

| keystroke path         | B/op       | gate                                 |
|------------------------|-----------:|--------------------------------------|
| flat, per-field        | ~0 (noise) | gated                                |
| dotted, 3-segment      | 0.112      | GATED (<= 16384 B / 50K ops)         |
| schema mode            | 113.440    | recorded baseline (was 20,990 in 1.1.0; ceiling 32768 B/op) |
| async-validated        | 629.703    | recorded (trigger + promise creation; settlements outside the window; see [Async validation](#async-validation)) |

The schema-mode figure is a 185x fall from 1.1.0's 20,990 B/op -- the scratch
tree replaced a full per-keystroke clone.

> `@zakkster/lite-project` 1.4.0 was falsified by lite-form's t6: a ~40 B/op
> hot-path context allocation inside the engine's `get`/`peek`/`set`, invisible
> to lite-project's own pool-census gate. It was fixed upstream as 1.4.1 with the
> transient witness ported. See [`decisions/0002-engine.md`](./decisions/0002-engine.md)
> for the full record. Hence the peer floor `@zakkster/lite-project ^1.4.1`.

---

## Testing

lite-form ships **118 deterministic tests** (`node:test`, zero runtime deps):

```sh
npm test          # the fast suite
npm run torture   # plus the torture gate: npm run torture
npm run verify    # test + torture, the full gate
```

The torture gate (`test/torture.mjs`) proves the zero-GC and zero-leak claims
with `@zakkster/lite-gc-profiler` (a keystroke allocates nothing, provokes no
major GC) and `@zakkster/lite-leak` (every disposed form's field records are
collectable). It runs under `--expose-gc --preserve-symlinks`.

**Development wiring.** The witness peers and the signal core are linked as local
symlinks so the gate measures the real, single lite-signal instance:

```sh
ln -s ../../../LiteSignal      node_modules/@zakkster/lite-signal
ln -s ../../../LiteProject     node_modules/@zakkster/lite-project
ln -s ../../../LiteStore       node_modules/@zakkster/lite-store
ln -s ../../../LiteLeak        node_modules/@zakkster/lite-leak
ln -s ../../../LiteGCProfiler  node_modules/@zakkster/lite-gc-profiler
```

Run the gate with `--preserve-symlinks` so Form.js and the harness resolve the
same lite-signal (a duplicate instance would make the witnesses vacuous):

```sh
node --expose-gc --preserve-symlinks test/torture.mjs
```

---

## Edge cases pinned down

- **`dispose()` is idempotent.** Calling it twice is safe; the second call is
  a no-op.
- **`reset()` clears `submitError` too.** A pristine form is fully pristine --
  errors, touched flags, submit attempts, and the last submit throw all reset
  in one batched write.
- **Structural bugs re-throw, operational errors flow to `submitError`.**
  `ReferenceError` / `SyntaxError` thrown inside `onSubmit` are logged via
  `console.error` and re-thrown. `TypeError` (which is what `fetch()` rejects
  with on network failure) is captured as a valid `submitError`. Same for any
  other Error subclass.
- **`setPath` preserves arrays.** Writing `users.0.name = "Bob"` on a form
  initialized with `{ users: [{ name: "Ann" }] }` keeps `users` an Array. We
  test that we don't accidentally overwrite it with `{}` because the path's
  numeric key is detected.
- **Lazy field creation works.** Calling `form.field("undeclaredPath")` on a
  field that wasn't in `initialValues`/`validators`/`fieldOpts` creates it on
  the spot with `undefined` as its initial value. Use this for forms with a
  variable shape -- though for known fixed shapes, declaring them in
  `initialValues` is faster.
- **`setValues` batches.** A `setValues({ a: 1, b: 2, c: 3 })` call triggers
  exactly one re-evaluation of `isValid`, not three.
- **Checkbox bridge works out of the box.** `props().onInput` detects
  `ev.target.type === "checkbox"` and reads `.checked` instead of `.value`.
- **A `registry` option scopes everything.** If you pass a `createRegistry()`
  handle, every signal/computed lives in that registry. The default global
  registry stays untouched. Bind with that registry's `effect` to wire to
  your renderer.

---

## What this is **not**

- **Not a renderer.** lite-form gives you state; you decide how to render. Pair
  with `@zakkster/lite-signal-dom`, `@zakkster/lite-element`, vanilla
  `addEventListener`, or your framework of choice.
- **Not a fetch/debounce layer.** `validatorsAsync` sequences YOUR promises
  (last-write-wins, strict-false while pending) -- lite-form owns no timers and
  no transport. Debounce belongs to the caller via `@zakkster/lite-debounce`
  (see [Async validation](#async-validation)).
- **Not a field-array helper.** Dotted paths work for nested objects and
  arrays, but if you need `<FieldArray>`-style adds/removes/reorders with
  preserved field identity, that's a future `@zakkster/lite-form-fields`
  package.
- **Not a schema library.** Bring your own (Zod / Yup / Valibot / hand-rolled).
  lite-form just calls your `validate` function once per change.
- **Not a wizard / multi-step form runtime.** A wizard is multiple forms
  composed together. Build it with two `createForm()` calls and your own
  navigation state.

---

## Browser / runtime support

| target           | works | notes                                      |
|------------------|:-----:|--------------------------------------------|
| Node >= 14       | yes    | ES2015 baseline; lite-form calls no `structuredClone` |
| Chrome / Edge    | yes    | All evergreen versions                     |
| Firefox          | yes    | All evergreen versions                     |
| Safari >= 10     | yes    | ES2015 baseline; own-walk snapshot, no `structuredClone` |
| Deno / Bun       | yes    | ESM + standard JS only                     |

ESM only. No CJS build. If you need CJS, bundle through esbuild/rollup.

---

## Peer dependency

```json
"peerDependencies": {
    "@zakkster/lite-signal": "^1.5.0",
    "@zakkster/lite-project": "^1.4.1"
}
```

Both are always required. `@zakkster/lite-project` (~7 KB minified, 958 lines)
is the projection engine the value core rides in BOTH modes -- the import is
static, so it must be installed even if you never pass `source` (default mode
projects the detached baseline through it; engine mode projects your live
source). lite-form is ~621 lines on top of the two.

---

## FAQ

**Q: Is `field()` eager or lazy?**
Eager by default: fields are allocated from `initialValues` + `validators` +
`fieldOpts` during `createForm()`, which is right for the known, bounded field
set most forms have. Lazy `field()` for an undeclared path is also fully
supported and safe: a lazy field allocated while a tracking context is live is
created inside the form's own `registry.createRoot()`, so its nodes belong to
the form, not the calling effect, and survive that effect's re-runs. This needs
lite-signal >= 1.5.0 (its `createRoot` detaches ownership); on older cores a
lazy field created inside a render effect would be torn down on the effect's
next run.

**Q: Can I use `field()` for paths not in `initialValues`?**
Yes. `field("undeclared")` creates the field lazily on first access. It just
won't have a per-field validator unless you also declared one. Useful for
forms with variable shape -- but if the shape is fixed, declaring up front is
slightly faster (no Map lookup miss).

**Q: How do I integrate Zod / Yup / Valibot?**
Adapter is 4 lines. See [Schema (Zod / Yup)](#schema-zod--yup). Your library's
parse function runs once per change inside lite-form's hoisted computed.

**Q: What's the difference between `error()` and `rawError()`?**
`error()` is reveal-gated by `validateOn` -- null if the field isn't yet
revealed. `rawError()` is always live. Use `error()` to drive your DOM display,
`rawError()` for anything that needs true validity (the form-level `isValid`
already wraps this for you).

**Q: Why does `validate` return a flat path map instead of nested errors?**
Flat keys make the field-side `formErrors[path]` lookup O(1) and structurally
cutoff-friendly. Wrap your schema's error shape in your adapter; Zod's
`issues[i].path.join(".")` is what most folks land on.

**Q: I want to track `value` changes outside of effects (e.g. autosave debounce).**
Use `value.subscribe(fn)` -- it's a real lite-signal subscribe; returns an
unsubscribe function. Or wrap it in an effect with your debounce. lite-form
doesn't ship a debounce helper because [@zakkster/lite-debounce](https://www.npmjs.com/package/@zakkster/lite-debounce)
already does (published; or `setTimeout` + `clearTimeout` if you'd rather not add a dep).

**Q: How do I dispose a form?**
Call `form.dispose()`. Every signal and computed is freed; the pool returns to
baseline. It's idempotent -- safe to call twice. If you're scoping a form to a
component lifecycle, register `form.dispose` as the cleanup.

**Q: Why is `submitAttempted` writable?**
So you can force-reveal errors without actually calling `submit()`. Useful if
you have an "are you sure?" preview step that needs to highlight invalid
fields before the actual submit.

**Q: I called `submit()` twice and my server got two requests. Bug?**
Working as designed -- `submit()` is not internally deduped. lite-form holds
no in-flight lock; concurrent calls fire `onSubmit` concurrently. See
[Double-submit defense](#double-submit-defense-concurrent-submit-is-a-footgun)
for the three patterns (button-disable, `@zakkster/lite-throttle`, or an
`isSubmitting.peek()` guard). If you only have a button, disabling it on
`isSubmitting()` is enough; if `submit()` is reachable from a hotkey or
multiple handlers, throttle is the safer answer.

**Q: How do I do `setFieldError("username", "already taken")` from my
server response?**
You don't -- lite-form has no imperative error-setter. Use the
[external-signal pattern](#surfacing-server-errors-the-setfielderror-story):
hold the server error in a `signal()`, read it from your per-field validator,
flip it when the server responds. The validator re-runs automatically (the
signal read is tracked). Disposal is automatic; race conditions don't exist.
It ends up being less code than a `setFieldError` API would be -- see the
section for a full example.

---

## License

MIT (c) Zahary Shinikchiev

---

#### The @zakkster stack

- [@zakkster/lite-signal](https://www.npmjs.com/package/@zakkster/lite-signal) -- the reactive primitives this all builds on
- [@zakkster/lite-project](https://www.npmjs.com/package/@zakkster/lite-project) -- the projection engine the value core rides (both modes)
- [@zakkster/lite-element](https://www.npmjs.com/package/@zakkster/lite-element) -- Custom Elements with state that survives reparents
- [@zakkster/lite-time](https://www.npmjs.com/package/@zakkster/lite-time) -- drift-corrected wall-clock cadence
- **@zakkster/lite-form** -- *this package*
