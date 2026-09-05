# 0002 -- Engine swap: projection over the detached baseline (S2)

Status: accepted (2026-09-05). Scope: @zakkster/lite-form S2 (v1.2.0). Not
shipped (excluded from package.json `files[]`); this records why the value core
is now a lite-project projection instead of a hand-rolled baseline+edits core.

## Context

S1 hand-rolled per-field value signals, an Object.is dirty compare against a
captured `initialRef`, and hand-written reset/snapshot. The additive S2 surface
(commit / toPatch / reinitialize) is exactly what a projection over a keyed
source already ships, granular and zero-GC. Re-deriving commit/patch/revert by
hand would duplicate a reviewed, gated engine.

## Decision

The value core is a `@zakkster/lite-project` projection.

    projector = createProjector(<the form's registry surface>)
    handle = config.source
        ? projector.project(fromProxy(config.source))       // source mode
        : projector.project(fromAccessors(baselineGet, baselineSet))  // default

`field.value` is a WritableSignal-shaped facade: `value()` reads the projected
computed, `value.set` writes the overlay (clear-on-initial in default mode). No
keystroke body branches on mode -- the two set closures and two dirty closures
are built once at construction.

### Recorded alternative (not taken)

Keep the S1 internals and hand-write commit/toPatch on top of them. Chosen only
if a gate falsifies the projection. The gate DID falsify lite-project 1.4.0 as
shipped -- t6 caught the flat keystroke at ~120 B/op (5,999,008 B / 50k ops),
isolated by probe to ~40 B/op inside the engine's own get/peek/set: slotFor's
inline slot-creation closure captured `key`, so V8 allocated a context object on
every call (hit or miss), and peek carried the same trap twice via inline
untrack closures. The defect was invisible to lite-project's own gate (pool
census + heap gate + retained bracket -- all blind to transient garbage). The
alternative was NOT taken: the falsification was a fixable engine defect, not a
falsified architecture. Fixed upstream as lite-project 1.4.1 (creation hoisted
to `_createSlot`; peek/reconcileAll on the hoisted `_pk`/`_readSrc` scratch)
with the new-space transient witness ported to its t6 as Proof 0 so the class
cannot regress silently. After the fix: both keystroke gates green (flat noise,
dotted 0.112 B/op), schema baseline falls 20,990 -> ~113 B/op. The alternative
stays recorded so a future engine regression has a fallback.

## Consequences

### peer, not a hard dep

lite-project is a peerDependency + devDependency, floor `^1.4.1` (1.4.x carries
the full toPatch / commitWhere surface; the floor moved 1.4.0 -> 1.4.1
mid-session because 1.4.0's hot-path allocation defect -- see the recorded
alternative above -- would fail lite-form's own t6 on a fresh install resolving
it). NOT a hard dep -- the suite
convention, same rationale as decisions/0001's peer-flip refutation: a single
shared reactive graph must not be duplicated by a transitive install, so the
reactive engine and its projection layer are peers the app pins once. Form.js
imports lite-project at the top level, so it is a REQUIRED peer (no
peerDependenciesMeta.optional). lite-store enters devDependencies `^1.3.0` ONLY
(npm latest is 1.3.0, not 1.4.0) for the qa round-trip; it is not the core
engine.

### bundle cost

The engine is opt-in weight: Project.js is 943 lines, 7,115 B minified. lite-form
itself carries no projection code -- it composes the peer.

### overlay key === dotted field path, verbatim

One overlay key per field path; the key IS the dotted path (`user.name`), warmed
at makeField by an untracked `handle.get(path)` AFTER `fields.set` (baselineGet
fails closed on an unregistered path, so the record must exist first). The
keystroke never allocates a slot for a declared or already-touched field.

### TTL refused

No `{ttl}` is ever passed to `set`. TTL is optimistic-UI expiry machinery; a form
draft has no expiry. The overlay lives until the user commits, reverts, or resets.

### baselineRev mechanism

A plain baseline tree tracks nothing, so a pristine (never-overlaid) field's
projected computed would never re-run on reinitialize/commit/reset. `baselineGet`
reads a form-level `baselineRev` signal (the ONLY new read-path signal, read on
keystrokes, never written there); reset/commit/reinitialize bump it (peek+1) in
the same batch. This also fixes the field.reset() no-op case (D-C3 below).

### D3 -- source-mode dirty = overlay presence

The store is live: an authoritative write to an un-overlaid field changes
`value()` and would flip an Object.is-vs-initialRef dirty with no user edit. So
source-mode dirty is overlay presence (`isOverlaid(path)`, count-tracked via
`dirtyCount()`), documented as this mode's engine semantics. A write under an
overlaid field stays masked by the engine's Object.is short-circuit. The
makeReconciler-based re-capture alternative was rejected: it adds a per-source
event effect for a contract the overlay bag already expresses honestly.

### D1 -- structural facade

lite-signal's WritableSignal is structural, not nominal, so the facade
`{ (), peek, set, update, subscribe }` satisfies Form.d.ts's WritableSignal
without a d.ts break. `update` APPLIES its function (`set(fn(peek()))`).
`subscribe` is a detached (createRoot) registry effect over `handle.get(path)`,
returning a disposer tracked for `form.dispose()`.

### D-C3 -- field.reset() bumps rev

A public `field.reset()` re-captures `initialRef` then `handle.clear(path)` -- but
clear on an un-overlaid key (an in-place-mutated pristine object leaf) is a no-op,
so nothing re-runs the projected computed and `value()` would serve the stale
mutated ref. field.reset() therefore bumps baselineRev inside its batch.

### D4 -- scratch invalidation = { reinitialize, commit }

The schema materialization reuses a per-form scratch tree (leaves written in
place, object leaves by reference), invalidated (`scratch = null`) only when the
baseline changes shape/value: reinitialize and commit. A lazy field on a NEW path
materializes its containers in the scratch in place on next read (no rebuild).
This drops the schema keystroke from cloning the whole tree per keystroke to
~validate()-only. The fields Map is walked through a parallel plain array so the
in-place write loop allocates no per-entry iterator tuple.

### D5 -- no prune()

Not exposed. The fields Map retains its per-field records regardless of overlay
state, so a projection prune() would reclaim nothing the form can see;
`dispose()` is the teardown (it calls `handle.dispose()` before draining the
form's own owned nodes and the subscribe disposers).
