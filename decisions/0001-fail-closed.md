# 0001 -- Fail-closed forms (S1)

Status: accepted (2026-09-05). Scope: @zakkster/lite-form S1. Not shipped
(excluded from package.json `files[]`); this records why the code is shaped the
way it is.

The keystroke path is sacred: zero allocation in `set`/`dirty`/`error`. Every
decision below moves a check to the construction boundary or the snapshot
boundary, never into a hot body.

## 1. Unreachable baseline

`initialValues` is deep-copied once at `createForm`. Object leaves are copied
AGAIN at seed, at `reset()`, and at snapshot materialization. The caller's
object is never read after construction, so a caller mutating its own
`initialValues` later cannot reach into the form, and the form cannot leak an
alias back out through `values()`.

## 2. dirty is a reference compare

`dirty = !Object.is(value(), initialRef)` where `initialRef` is the field's OWN
captured initial reference (re-captured inside `reset()` BEFORE `value.set`, so
an object-leaf field is not dirty at construction or after reset). It is never a
baseline-tree walk. In-place mutation of an object/array leaf does NOT flip
dirty; setting a new reference is the API. This keeps `dirty` O(1) and
allocation-free on the keystroke path.

## 3. One construction walk

A single walk at `createForm` does three things at once: deep copy, cloneability
whitelist, and hostile-own-key rejection -- including the empty
`{"__proto__":{}}` case that arrives via `JSON.parse` (an explicit own-`__proto__`
probe, belt-and-braces alongside `Object.keys`). `structuredClone` is deleted.
The snapshot walk throws a path-precise `TypeError` on an uncopyable runtime
value, replacing the late `DataCloneError` that `structuredClone` used to raise
far from the offending `set()`.

## 4. Whitelist, and where the door is

Copyable: primitives, arrays, Date, plain-object branches. Rejected at
`createForm`: function, Map, Set, RegExp, TypedArray, class instance, symbol.
Runtime `set()` stays UNCHECKED -- the keystroke law forbids a per-set type
probe. The snapshot boundary (`values()`/`readValues()`) is the door where an
uncopyable value that slipped in via `set()` is caught, path-named.

## 5. LF-04: lazy fields under createRoot

A lazy `field(path)` allocated under a live tracking context is created inside
the form's own `registry.createRoot()` (guarded by `registry.isTracking()`), so
its nodes belong to the form and survive effect re-runs. The feature is kept and
the hazard killed. Why not simply throw on lazy-under-effect: the README
documents lazy, variable-shape forms as a supported pattern; removing it would
break a shipped contract.

## 6. Peer floor ^1.5.0; the July hard-dependency flip is refuted

Peer and dev floor is `@zakkster/lite-signal` `^1.5.0` (the version whose
`createRoot` makes decision 5 safe). The July 2026 program's proposal to flip
the peer into a hard dependency is REFUTED: its precondition
`assertSingleGraph()` is still unshipped in LiteSignal, the suite convention is
peers, and the July rationale (npm dependents-graph visibility, co-install
ergonomics) does not outweigh those.

## Behaviour deltas (cycle policy)

- Object-branch cycle: was a `RangeError` (stack overflow) -> now a `TypeError`
  at `createForm`.
- Array-internal cycle: was silently accepted by `structuredClone` -> now a
  `TypeError`.
- Shared non-cyclic subtree: legal, copied independently for each reference.
