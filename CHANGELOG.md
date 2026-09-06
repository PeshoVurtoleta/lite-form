# Changelog

## 1.3.0 - 2026-09-06

Server-data story (S3). Three flows, additive on the S2 engine seam: merge
reinitialize, per-field async validation, dirty-only patch submit. The 1-arg
contracts are frozen and the no-async keystroke path is allocation-identical
to 1.2.0 -- its dirty body gained one tracked baselineRev read (the LF-12 fix)
and one predicted-false latch check; t6 numbers unchanged, all 77 prior tests
green unmodified.

### Added
- `reinitialize(next, policy)` -- MERGE variant (default mode only; source
  mode throws a TypeError naming `reconcile`). Per registered field, with n =
  the deep-copied next leaf and d = the draft: pristine ADOPTS n; dirty with
  `Object.is(n, d)` (forced echo) or `policy(n, d) === true` ECHOES -- overlay
  cleared, pristine at n; anything else is a CONFLICT -- the draft is kept
  masking n while the baseline re-seeds underneath (`reset()` lands n,
  `toPatch().from === n`). Only `=== true` confirms; a throwing policy is
  atomic (verdicts pre-scanned before any mutation); one batch, one
  baselineRev bump. touched clears on ADOPT/ECHO and survives CONFLICT;
  `submitAttempted`/`submitError` are never written by a merge. Deep-copied
  payloads mean object leaves never auto-confirm under the default policy.
  The policy must be PURE: every mutating entry point (set/blur/reset/
  setValues/commit/reinitialize/reconcile/submit/dispose, and lazy field
  CREATION -- a field born mid-merge would seed from the pre-merge baseline
  outside the verdict loop) throws a TypeError while the merge window is
  open (pre-scan through the apply flush) --
  verdicts are pre-scanned against a snapshot, and applying them over
  policy-mutated state (or letting a nested merge splice the reused verdict
  scratch) would be silent corruption.
- `validatorsAsync` + `asyncSources` + `field.isValidating` +
  `form.isValidating` -- a per-field async validation lane with a
  last-write-wins ordering law: per-field monotone sequence, stale
  settlements (resolve or reject) dropped whole, `isValidating` true exactly
  while the latest is unsettled, `dispose()` mid-flight settlements are
  no-ops, the latest rejection surfaces as the field error (never silently
  valid). `isValid` is strict-false while any verdict is pending, so
  `submit()` refuses during validation through the existing gate. No timers
  inside Form.js -- debounce is the caller's via the `asyncSources`
  lite-debounce recipe (tested). A form with no async validators allocates no
  lane machinery and keeps the 1.2.0 keystroke numbers byte-for-byte;
  async-validated keystroke measured 629.703 B/op (recorded, t6 window (d):
  trigger + promise creation, settlements outside the window).
- `submit(ev?, { patch: true })` -- posts `toPatch()` to `onSubmit` instead of
  `values()`; the rest of the submit lifecycle is the same code path. An
  empty patch still submits `[]` (the caller checks `.length`).
- `form.reconcile(policy?)` -- source-mode merge: drops exactly the overlays
  the live source now agrees with (engine `reconcileAll`, default
  `Object.is`). Legal in default mode, where it is a no-op under the default
  policy by design (clear-on-initial makes a confirmable overlay impossible).
- Torture: t8-async ordering tier (seeded out-of-order settlements, zero wall
  clock; registered before t9 so patched-module controls die there), t9
  `staleseq` control (seq guard disabled must die "t8 LF-09 stale settlement
  landed"), t5 fuzz gains the merge op with an independent merge mirror plus
  per-path dirty/touched and toPatch from/to value comparison, t7 async-churn
  and merge-churn soak loops, t6 window (d). 41 new tests bring the suite to
  118.

### Fixed
- LF-12 (latent since 1.2.0): a `field.dirty()` read (cached) before a
  `commit()` -- or a forced-echo merge row -- stayed true forever after it.
  The fold is value-preserving, so `value()`'s output never changes across a
  commit and the Object.is cutoff never re-ran the cached dirty computed
  while `initialRef` was re-captured underneath it. `dirty` now tracks
  `baselineRev` (the re-capture notifier) directly. Found by the new t5
  per-path oracle; regression tests pinned in test/08.

### Changed
- devDependencies: `@zakkster/lite-store` floor `^1.3.0` -> `^1.4.0` (1.4.0
  is its witness-gated release); `@zakkster/lite-debounce` `^1.1.0` added
  (recipe test only). Peers unchanged.
- The stale "use lite-resource inside an effect" async aside is gone from
  Form.js and README -- the shipped async seam replaced it.

## 1.2.0 - 2026-09-05

Engine swap (S2). The value core now rides a `@zakkster/lite-project` projection
over the S1 detached baseline. The public API is frozen: every S1 contract
survives verbatim (baseline unreachable, `dirty = !Object.is(value(),
initialRef)`, construction whitelist/cycle/hostile `TypeError`s, copying
snapshot + path-naming `TypeError`). Validation, reveal gating, and submit are
unchanged lite-form code.

### Added
- `form.commit(path?)` -- fold the dirty values into the baseline (all fields,
  or one path). Every committed field is pristine afterwards and `reset()`
  targets the committed state; committed values are deep-copied through the
  construction whitelist. An unregistered `path` throws a path-naming
  `TypeError` -- a typo'd commit is loud, never a lazy field creation.
- `form.toPatch() -> [{path, from, to}]` -- exactly the dirty paths (`from` =
  baseline value, `to` = current). A field set back to its initial reference is
  excluded. Untracked and read-only, safe inside an effect.
- `form.reinitialize(next)` -- re-seed from `next` exactly like `createForm`
  `initialValues` (deep-copied + whitelist-validated BEFORE any state changes --
  atomic `TypeError` on bad input). Every edit is dropped, paths absent from
  `next` re-seed `undefined`, and touched/submit state is cleared.
- `createForm({ source })` -- ENGINE mode: project a live keyed source (e.g. a
  lite-store proxy) instead of the detached baseline. Edits stage as overlays
  (source untouched); `commit()` writes through. In this mode `dirty` is overlay
  presence -- an authoritative source write under an un-overlaid field is not an
  edit and never flips dirty; a conflicting write under an overlaid field stays
  masked.
- t5 fuzz extended to `commit`/`toPatch`/`reinitialize` against the mirror.
- t7 commit/revert churn witness.
- t6 schema-mode keystroke re-recorded (see Changed).

### Changed
- Value core rebuilt on the `@zakkster/lite-project` projection: default mode is
  `fromAccessors` over per-field seed copies + a `baselineRev` signal; the engine
  owns a per-key overlay signal + a projected computed, slot warmed at field
  creation. API frozen; all 53 prior tests green unmodified; 24 new tests bring
  the suite to 77.
- Schema mode stopped cloning per keystroke: the internal materialization for
  `validate()` reuses a per-form scratch tree (leaves written in place, object
  leaves by reference), rebuilt only on `reinitialize`/`commit`. Contract: the
  object handed to schema `validate()` is form-owned and transient -- retaining
  or mutating it is undefined behaviour. Public `values()` still returns a fresh
  deep copy every call. Schema-mode keystroke 27,181 -> 20,990 (1.1.0) ->
  113.440 B/op measured; dotted keystroke 0.112 B/op still gated.
- Dirty/overlay unification: `field.set(v)` with `Object.is(v, seed)` clears the
  overlay instead of staging it, so "overlaid" coincides with "dirty" and
  `form.isDirty` rides the engine's tracked `dirtyCount()`.
- Peer `@zakkster/lite-project` `^1.4.1` added (two peers now, alongside
  `@zakkster/lite-signal`). 1.4.0 was falsified by lite-form's t6 (a ~40 B/op
  hot-path context allocation inside the engine's `get`/`peek`/`set`, invisible
  to its own pool-census gate) and fixed upstream as 1.4.1 with the transient
  witness ported. See `decisions/0002-engine.md`.

## 1.1.0 - 2026-09-05

Fail-closed hardening (S1). The keystroke path is untouched -- every new check
lives at the construction and snapshot boundaries, not in `set`/`dirty`/`error`.

### Fixed
- LF-02 unreachable baseline: the caller's `initialValues` is deep-copied once at
  `createForm` and never aliased or read again; object leaves are copied again at
  each seed. `reset()` restores pristine copies, so an in-place-mutated object or
  array leaf is fully restored.
- LF-03 construction-time config validation: uncopyable and hostile config is
  rejected at `createForm` with a path-precise `TypeError`, not at some later
  snapshot (which previously surfaced a `DataCloneError`) or never.
- LF-04 lazy fields: a `field(path)` for an undeclared path allocated while a
  tracking context is live is now created inside the form's own
  `registry.createRoot()`, so its nodes belong to the form and survive effect
  re-runs instead of being torn down as the effect's own children.

### Changed
- Every value type that used to work by accident now throws a `TypeError` at
  `createForm` naming its path: function, Map, Set, RegExp, TypedArray, class
  instance, symbol. The whitelist is primitives / Array / Date / plain object.
- Cycle policy deltas: an object-branch cycle was a `RangeError` (stack overflow)
  -> now a `TypeError` at `createForm`; an array-internal cycle was silently
  accepted by `structuredClone` -> now a `TypeError`. A shared non-cyclic subtree
  stays legal (copied independently for each reference).
- Snapshot boundary: `values()`/`readValues()` materialize by an own-key walk
  that deep-copies each leaf; an uncopyable runtime value throws a path-naming
  `TypeError` (replacing the late `DataCloneError` from `structuredClone`).
- `dirty` contract documented: `!Object.is(value(), initialRef)` against the
  field's captured initial reference (re-captured on `reset()`); in-place
  mutation does not flip it, `set(newRef)` does.
- Peer and dev floor `@zakkster/lite-signal` `^1.5.0` (the version whose
  `createRoot` makes LF-04 safe). No existing test changed meaning; 12 new tests
  bring the suite from 41 to 53.

### Added
- t6 dotted keystroke gate: a 3-segment dotted keystroke is now a hard
  transient-garbage gate (<= 16384 B / 50,000 ops), not a recorded baseline.
  Measured 0.057 B/op (2,850 B total / 50,000 ops; the 1.0.2 baseline was
  32.150 B/op). Schema-mode baseline re-recorded with `structuredClone` gone:
  27,181.120 -> ~20,990 B/op, sanity ceiling re-pinned 65,536 -> 32,768.
- t7 lazy-field churn witness.
- t9 realias / reproto patched-module controls (a reintroduced S1 bug in a
  patched Form.js copy must die at t1).
- `decisions/0001-fail-closed.md` recording the six pinned S1 decisions (not
  shipped; excluded from the `files[]` whitelist).

## 1.0.2 - 2026-09-05

Gate and hygiene (S0). No behaviour change.

### Added
- Torture gate: `test/torture.mjs` entry + 7 tiers (t0 laws, t1 degenerate,
  t2 scale, t5 fuzz, t6 alloc, t7 soak, t9 controls) + 4 spawned controls
  (grow/alloc/drop/leak). Preflights fail closed (exit 2) on a missing
  witness devDependency, three-place VERSION drift, or a doc test-count that
  disagrees with the recorded 41.
- Transient-allocation witness: V8 new-space used-bytes delta around the
  measured loop (GC-observer rules and stabilized `bytesPerOp` cannot see
  transient garbage in a synchronous window). Flat per-field keystroke gated
  at <= 16384 B total per 50,000 ops; measured 4,720 B (0 B/op). Recorded
  LF-06 baselines: dotted path 32.150 B/op, schema mode 27,181.120 B/op.
- t1 registers LF-02 (leaf aliasing), LF-03 (non-cloneable crash), LF-04
  (zombie lazy fields) as reproduced-failing; fixing any of them without
  flipping its check fails the gate.
- devDependencies `@zakkster/lite-leak` and `@zakkster/lite-gc-profiler`.
- Scripts `torture`, `verify`, `prepublishOnly`.
- README Testing section and development/wiring notes (symlink the peers, run
  the gate with `--preserve-symlinks`).

### Changed
- `verify` now runs the torture gate (`npm test && npm run torture`) instead of
  the bench.
- Author email set to `<shinikchiev@yahoo.com>`.
- ASCII-only source pass across Form.js, Form.d.ts, and bench/bench.mjs.
- Doc corrections: real line count (328) and test count (41 deterministic
  tests) in README.md and llms.txt; bundlephobia badge repointed to lite-form;
  lite-debounce noted as published.

## 1.0.1 - 2026-09-05

Security hotfix -- prototype pollution (LF-01).

### Added
- `VERSION` export (the package version string) and the version line in the
  Form.js header, declared in Form.d.ts.
- 8 regression tests (`test/04-hostile-paths.test.js`); the suite is now
  41 tests.
- This CHANGELOG.md, shipped via `files[]`.

### Changed
- Fail-closed path boundary: the segments `__proto__`, `constructor`, and
  `prototype` are rejected with a thrown `TypeError` everywhere a path
  enters the form: `createForm` config keys (`validators`, `fieldOpts`,
  `initialValues` leaf paths -- including an own `__proto__` key from
  `JSON.parse`), `field(path)`, `setValues(patch)`, and validator `ctx.get`.
  Thrown, not sanitized: a silently dropped segment would be silent data
  loss. A rejected path is never cached, so the form stays usable after the
  throw. Fields may no longer be named exactly `__proto__`, `constructor`,
  or `prototype` (reads of such fields already resolved through the
  prototype chain, i.e. were broken).
- Zero allocation added to the keystroke path: the guard is segment string
  compares inside the existing walks. Measured keystroke throughput on the
  100-field per-field-validator scenario after the change: 10,099,056
  ops/sec.

### Fixed
- Prototype pollution: a `__proto__` path segment walked `setPath` into
  `Object.prototype`, so `setValues({"__proto__.x": v})` (reachable from the
  documented `setValues(await res.json())` server-patch idiom) followed by
  any `values()`/`readValues()` call wrote to `Object.prototype` globally.
  In schema mode the write re-fired on every keystroke.

## 1.0.0 - 2026-05-30

Initial release. Headless reactive form state for `@zakkster/lite-signal`:
per-field validators (one validator per keystroke), hoisted form-level schema
(`validate`) with Object.is cutoff, reveal-gated error display split from live
validity, cross-field `ctx.get`, parse/format `fieldOpts`, batched
`setValues`, untracked `submit` lifecycle (`isSubmitting`/`submitError`/
`submitAttempted`), registry scoping, full `dispose()`.
