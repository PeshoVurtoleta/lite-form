---
package: "@zakkster/lite-form"
version_target: 1.2.0
status: in-progress
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_budget: "flat AND dotted keystroke gated <= 16384 B total per 50k ops (must not regress); schema-mode keystroke must FALL from the 1.1.0 baseline ~20,990 B/op toward the validate() call's own cost, new baseline recorded"
leak_cycles: 4096
peers: ["@zakkster/lite-signal ^1.5.0", "@zakkster/lite-project ^1.4.1 (NEW)"]
dev: ["@zakkster/lite-signal ^1.5.0", "@zakkster/lite-project ^1.4.1", "@zakkster/lite-store ^1.3.0 (NEW, test-only)", "@zakkster/lite-gc-profiler ^1.16.0", "@zakkster/lite-leak ^1.10.0"]
findings: [LF-06, LF-10 partial]
depends_on: ["S1 (shipped 2026-09-05 as v1.1.0, commit c4fdb00)"]
---

# lite-form -- the state engine (S2)

Session S2 of ROADMAP.md (section "S2 -- lite-form v1.2.0"). Minor bump
1.1.0 -> 1.2.0: the hand-rolled baseline+edits+dirty+reset core is rebased on a
@zakkster/lite-project projection over the S1 detached baseline. The public API
is FROZEN and gains only additive surface: commit(), toPatch(),
reinitialize(next), and the opt-in `source` config. Validation, reveal gating,
and submit stay lite-form's own layer, untouched.

## ALREADY DONE (do not redo, do not re-derive)

- S1 shipped: baseline unreachable (copyLeaf iterative walk, whitelist
  primitives/Array/Date/plain-object, cycles TypeError, hostile own keys
  TypeError), snapshot own-walk (no structuredClone anywhere), dirty contract
  `!Object.is(value(), initialRef)`, lazy fields via registry.createRoot,
  peer floor lite-signal ^1.5.0. 53 tests. Form.js 461 lines.
- Preflight verified 2026-09-05 (do not re-verify): lite-project 1.4.0 local
  AND on npm; Project.js 943 lines, 7,115 B minified (record in ADR as the
  peer bundle cost). lite-store local 1.4.0, npm latest 1.3.0 -> devDep floor
  ^1.3.0 (NOT ^1.4.0; must stay npm-installable). lite-project peers on
  lite-signal ^1.5.0 (same floor as ours -- no conflict).
- Gate numbers on this box (Node 26): flat keystroke 0 B/op, dotted 0.057 B/op
  (GATED <= 16384 B / 50k), schema ~20,990 B/op (recorded baseline, sanity
  ceiling 32768 B/op).

## PINNED DECISIONS (law for this session; ADR records them, planner does not reopen)

1. lite-project is a PEER + devDep, floor ^1.4.1 (the floor moved mid-session:
   the t6 transient witness falsified 1.4.0 -- its slotFor/peek allocated a
   ~40 B/op closure context on get/peek/set, invisible to its own pool-census
   gate; fixed upstream as 1.4.1 with the witness ported, so 1.4.0 would fail
   lite-form's own gate on a fresh install). NOT a hard dep -- suite
   convention, same rationale as decisions/0001's peer-flip refutation.
   lite-store enters as devDependency ^1.3.0 ONLY (qa round-trip); it is NOT
   the core engine (its transaction surface is unshipped, LS-01 live).
2. Projection binding: `createProjector(formRegistry).project(...)` -- the
   projection's nodes live in the FORM's registry, never the default one,
   unless the form itself is on the default registry. Engine handles per-key
   createRoot detachment internally (lite-project gotcha #1); lite-form does
   NOT wrap slot creation in its own createRoot.
3. Overlay keys ARE dotted field paths, verbatim (the stable contract, in the
   ADR). One overlay key per field path. Keys are warmed at makeField (first
   read creates the slot -- construction is the warm path, keystroke never
   allocates a slot for a declared or already-touched field).
4. The S1 unreachability law survives the engine: `source.get(path)` returns
   the field's captured seed copy (initialRef), NEVER a reference into the
   baseline tree. `source.set(path, v)` (reached only via engine commit)
   deep-copies v into the baseline (copyLeaf) and re-captures initialRef as a
   fresh copy. The caller can never reach the baseline through any read, and
   commit cannot alias caller-owned objects into it. All copies sit on cold
   paths (commit/reset/reinitialize/construction), never the keystroke.
5. Reactivity of the plain-tree source: baseline reads track nothing by
   themselves, so `source.get` reads (and thereby tracks) a form-level
   `baselineRev` signal bumped by reinitialize()/commit()/reset(). Without
   this, a pristine (never-overlaid) field's projected computed would never
   re-run on reinitialize. This is the ONLY new signal on the read path; it
   is read, not written, on keystrokes.
6. Dirty contract UNCHANGED and unified with the engine: `field.set(v)` calls
   `handle.clear(path)` when `Object.is(v, initialRef)`, else
   `handle.set(path, v)`. Overlay presence then coincides with dirty for the
   default (detached-baseline) form: per-field `dirty` stays the S1 computed
   `!Object.is(value(), initialRef)` byte-for-byte, and `form.isDirty`
   becomes `cmp(() => handle.dirtyCount() > 0)` (tracked). The one extra
   Object.is on the keystroke is the same compare the dirty computed already
   performs. No TTL opts are EVER passed to set (state in ADR: TTL is
   optimistic-UI machinery; a form draft has no expiry).
7. t9 patch anchors WILL move (makeField seed line changes shape). The coder
   updates the anchor strings in t9-controls.mjs to the new verbatim lines,
   keeps the occurs-exactly-once assertion (`source.split(anchor).length ===
   2`, die "patch anchor not found -- Form.js drifted"), and both controls
   (realias/reproto) must still die at t1 with their existing markers
   ("t1 LF-02" / "t1 LF-03"). The construction walk (copyLeaf, hostileSeg,
   whitelist) itself is NOT to be modified by the swap.

## TASKS (planner refines into atomic ordered tasks with file targets)

1. decisions/0002-engine.md FIRST: default = projection over
   fromAccessors(baselineGet, baselineSet); recorded alternative = keep S1
   internals, hand-write commit/toPatch (choose it only if a gate falsifies
   the projection). Record: peer-vs-hard-dep, bundle cost (7,115 B min),
   overlay-key<->field-path mapping, TTL refusal, the baselineRev mechanism,
   and the source-mode dirty decision (see DECISION POINTS).
2. Swap the value core: field value reads ride the projected computed;
   field.value stays the public WritableSignal-shaped surface (facade over
   handle get/set if needed -- planner pins the exact shape against the
   current Form.d.ts types). set/reset/setValues/values/readValues rebased.
   reset() = revert() + re-seed semantics identical to S1 (initialRef
   re-captured from baseline copies).
3. Additive API: `commit(path?)` (fold dirty values into the baseline via the
   engine; all fields pristine after; reset() now targets the committed
   state), `toPatch()` -> [{path, from, to}] for exactly the dirty paths
   (engine toPatch; from = baseline value, to = current), `reinitialize(next)`
   (next validated + deep-copied exactly like createForm initialValues, all
   overlays reverted, baselineRev bumped, initialRefs re-captured; lazy
   fields whose path is absent from next re-seed undefined). Declare all
   three in Form.d.ts + document.
4. Schema mode stops cloning per keystroke: the INTERNAL materialization for
   validate() reuses a per-form scratch tree (leaves written in place;
   object leaves passed by reference), rebuilt only on reinitialize. Document
   scratch ownership: the object handed to schema validate is form-owned and
   transient; retaining or mutating it is undefined behaviour. PUBLIC
   values()/readValues() keep the S1 copying + TypeError contract unchanged.
   Record the new schema B/op number; it becomes the new recorded baseline.
5. Opt-in `source` config: createForm({source: store}) rides
   projectStore(store) instead of the detached-baseline projection.
   Minimal honest contract only (see DECISION POINTS D3) -- this mode's
   semantics are documented as engine semantics, additive, and MUST NOT
   change any default-mode test.
6. Torture: t6 gains the schema-mode measurement against the new baseline
   (keystroke gates unchanged and must not regress); t5 fuzz extends to
   commit/toPatch/reinitialize vs the mirror (mirror folds overlay into
   baseline on commit; toPatch compared against the mirror's dirty-path set);
   t7 soak covers commit/revert churn (pooled-node reuse: warmed keys, flat
   poolGrowths); t9 anchors updated per PINNED 7. lite-store round-trip
   proven in the fast suite or t5 (reconcile -> overlay -> submit).
7. Wiring: package.json peers/devDeps per frontmatter; 4th + 5th symlinks
   (lite-project -> ../../../LiteProject, lite-store -> ../../../LiteStore);
   README wiring section updated (the fresh-clone drill must pass on the
   documented symlinks alone); FAST_SUITE_COUNT + README + llms.txt test
   counts move together (t9 preflight exits 2 on drift). CHANGELOG gains an
   `## Unreleased` section (release flips it to 1.2.0). VERSION const stays
   1.1.0 until /release.
8. Docs: README (positioning + deep-dive + API reference + design notes gain
   the engine story; composability example with commit/toPatch), llms.txt
   (new surface + invariants), Form.d.ts additive types. ASCII-only. Do NOT
   touch the Node-22 bench records (deferred doc pass, not S2).

## DECISION POINTS FOR PLANNER (pin each in the spec; ADR records D1/D3)

D1. field.value writable facade: today field.value IS the writable signal.
    Under the engine the projected computed is read-only and writes go
    through handle.set/clear. Pin the exact object shape that keeps
    Form.d.ts's WritableSignal-typed surface true (e.g. a tiny facade
    {get/peek/set} delegating to the handle) AND keeps props()/set()/blur()
    allocation-free per keystroke. If lite-signal's WritableSignal is a
    nominal class the facade cannot satisfy, pin the d.ts change (additive
    union, not a break) and say so in the CHANGELOG.
D2. commit(): engine commit() writes ALL overlays including
    Object.is-unchanged ones -- but PINNED 6's clear-on-initial means
    overlaid === dirty, so plain commit() suffices; assert in a test that a
    set-back-to-initial field is not visited by toPatch and not written by
    commit. commit(path?) one-key form uses engine commit(key).
D3. Source-mode (projectStore) dirty semantics -- THE hairy one. The store is
    live; an authoritative store write under an un-overlaid field changes
    value() and would flip the S1 Object.is-vs-initialRef dirty without any
    user edit. Pin ONE of: (a) source-mode dirty = overlay presence
    (document as engine semantics for this mode; field.dirty rides
    !Object.is(value(), source-current) via a re-captured ref on
    authoritative change), or (b) a makeReconciler-based re-capture effect.
    Choose the smallest contract that keeps the default mode untouched and
    the assertion honest; record in the ADR. If neither survives contact,
    the fallback is source-mode ships WITHOUT dirty guarantees (documented
    "dirty is engine overlay presence in source mode"), never a silent
    half-contract.
D4. Scratch-tree rebuild triggers: reinitialize obviously; does a lazy field
    materializing a NEW path require a scratch grow? Pin when the scratch is
    (re)built and assert schema keystrokes allocate ~validate()-only after
    warmup.
D5. prune(): NOT exposed on the form in S2 unless it falls out free --
    fields map already retains per-field objects; dispose() is the teardown.
    If exposed, it needs a test; leaning NO (record one line in ADR).

## ASSERTIONS (qa falsifies each)

- A1 Public API byte-compatible: all 53 existing tests green UNMODIFIED (the
  file diff of test/0[0-4]*.test.js + 05-fail-closed is empty).
- A2 Keystroke gates: flat AND dotted <= 16384 B / 50k ops still green;
  dotted stays ~0 B/op steady-state (slot warm at construction).
- A3 Schema keystroke: new recorded B/op materially below 20,990, with the
  delta attributable to materialization (measured with the same t6 window
  discipline: 50 ops, new-space delta).
- A4 commit()/toPatch()/reinitialize proven by t5 fuzz vs the mirror: after
  arbitrary op sequences, commit folds exactly the dirty paths, toPatch
  lists exactly the dirty paths (set-back-to-initial excluded), reinitialize
  leaves every field pristine reading next's values (missing paths
  undefined).
- A5 The S1 falsifier battery still fires: realias/reproto controls die at
  t1 through the UPDATED anchors; whitelist/cycle/hostile construction
  TypeErrors unchanged (t1 enforced).
- A6 lite-store round-trip: store-sourced form stages overlays, reconciles
  an authoritative write per the pinned D3 contract, commit() lands in the
  store, submit reads committed values -- green under lite-form's gate AND
  lite-store's own fast suite run on the symlinked checkout.
- A7 Unreachability survives: mutate every object handed out or in
  (initialValues, values() result, toPatch from/to, committed objects) and
  prove reset()/reinitialize() still restore pristine state (extend
  test/05's probes to the new surface).
- A8 form.dispose() disposes the projection (engine dispose()) -- lite-leak
  cycle stays flat with create/dispose churn including overlaid keys.

## NON-GOALS

No lite-map, no async validation (S3/S4). No validation/reveal/submit-layer
changes. No TTL surface. No prune() on the public form (unless D5 flips with
a one-line ADR note). No bench-record refresh (deferred doc pass). No
lite-store engine. No version bump (release does it).

## DONE WHEN

values/dirty/reset/patch ride the gated engine; schema mode stopped cloning
per keystroke (new baseline recorded); commit/toPatch/reinitialize ship
additive and fuzz-proven; the 53-test suite is green unmodified; both t6
keystroke gates hold; the ADR records the engine decision and the
source-mode dirty contract; docs + counts + wiring updated; tree committed.
