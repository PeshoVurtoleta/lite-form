---
package: "@zakkster/lite-form"
version_target: 1.3.0
status: ready (authored 2026-09-06; pipeline not started)
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_budget: "flat/dotted/schema t6 gates AND recorded baselines byte-unchanged for a form with no async validators (the seam is off-cost unused); async-validated keystroke cost measured + recorded (Promise machinery is inherent -- the debounce recipe is the documented mitigation, never a gate waiver for the sync path); merge-reinitialize is a COLD path (copies + policy calls legal), bounded by t7 soak leak-flatness"
leak_cycles: 4096
peers: ["@zakkster/lite-signal ^1.5.0", "@zakkster/lite-project ^1.4.1"]
dev: ["@zakkster/lite-signal ^1.5.0", "@zakkster/lite-project ^1.4.1", "@zakkster/lite-store ^1.4.0 (floor RAISED from ^1.3.0 -- 1.4.0 on npm 2026-09-05)", "@zakkster/lite-debounce ^1.1.0 (NEW, recipe test only)", "@zakkster/lite-gc-profiler ^1.16.0", "@zakkster/lite-leak ^1.10.0"]
findings: [LF-09, LF-10]
depends_on: ["S2 (shipped 2026-09-05 as v1.2.0, engine commit ff608b8, bump f2dffc0)"]
---

# lite-form -- forms live between two servers (S3)

Session S3 of ROADMAP.md (section "S3 -- lite-form v1.3.0"). Minor bump
1.2.0 -> 1.3.0. The three real-world flows the README only gestures at, all
additive on the S2 engine seam: (a) fresh server data arrives WHILE the user
edits -- reinitialize(next, policy) keeps the user's dirty overlays unless the
server echoed them; (b) dirty-only submit -- post toPatch() instead of
values(); (c) async validation -- a per-field async seam with isValidating,
last-write-wins ordering, debounce delegated to lite-debounce, and the
server-error signal pattern promoted from README prose to a tested recipe.
Validation algebra, reveal gating, and the engine core are untouched.

## ALREADY DONE (do not redo, do not re-derive)

- S2 shipped: value core on the lite-project projection (fromAccessors over
  per-field seed copies + baselineRev; source mode via fromProxy);
  commit(path?) fail-closed (unregistered path TypeError), toPatch(),
  reinitialize(next) 1-arg (atomic validate+copy, drops every edit), scratch
  tree for schema validate() (form-owned/transient contract). Suite 77.
  Form.js 621 lines / 6,473 B min. Gate numbers on this box (Node 26): flat
  ~0 B/op, dotted 0.06-0.13 B/op run noise under the <= 16384 B / 50k hard
  gate, schema 113.440 B/op recorded (~113 is the fixed window floor; the
  A3 attribution probe measured materialization itself FREE, |delta| 0.32).
- Preflight VERIFIED 2026-09-06 (do not re-verify, DO read current llms.txt
  of each package -- ROADMAP §S3 predates the S2 engine):
  - lite-project 1.4.1 npm+local. reconcileAll(policy?), confirmOnEcho
    (Object.is), makeReconciler(view, policy?) all present. Its llms RECORDS
    the trap this session inherits: reference-equality echo means an OBJECT
    draft can never auto-confirm across references -- and lite-form
    deep-copies every server payload at the boundary, so for us object
    leaves NEVER Object.is-echo. See PINNED 3.
  - lite-debounce 1.1.0 local = npm. API: debounce(sourceFn, ms = 0,
    { maxWait = 0 }) trailing; debounceLeading(sourceFn, ms = 0,
    { trailing = false }). Zero-GC on lite-signal.
  - lite-store 1.4.0 on npm (2026-09-05T22:18Z) + local; its 1.4.0 ported
    the same new-space transient witness (LS-08 closed) and raised its
    lite-signal floor to ^1.5.0 (same as ours -- no conflict). The S2
    brief's "transaction unshipped, LS-01 live" caveats are HISTORICAL:
    transaction shipped in its 1.3.0, deep walks iterative since 1.2.2.
    devDep floor moves ^1.3.0 -> ^1.4.0.
  - lite-resource exists locally only as the misspelled `LiteResourse`
    1.0.0. NOT used in S3 (PINNED 7 territory: the README's "use
    lite-resource inside an effect" aside is superseded by this session's
    seam and gets rewritten).

## PINNED DECISIONS (law for this session; ADR 0003 records them, planner does not reopen)

1. reinitialize(next) 1-ARG CONTRACT IS FROZEN: atomic validate+copy BEFORE
   any state change, drops every edit, absent paths re-seed undefined,
   clears touched + submit state. The policy variant is ADDITIVE; all 77
   existing tests stay green UNMODIFIED.
2. THE MERGE TABLE (default/detached-baseline mode; the whole merge runs in
   ONE registry batch; next is validated + deep-copied atomically first --
   a TypeError mutates nothing). For each registered field path p, with
   n = the copied next leaf at p (undefined when absent) and d = the
   field's current draft value:
   - pristine field            -> adopt n (baseline reseeded, initialRef
                                  re-captured; field stays pristine at n)
   - dirty field, policy(n, d) -> ECHO: clear the overlay AND adopt n;
     returns true                 field is PRISTINE at n (the server
                                  confirmed the edit)
   - dirty field, policy(n, d) -> CONFLICT: KEEP the overlay (the user's
     returns false                draft stays visible, masking n) but
                                  reseed the baseline to n underneath --
                                  dirty stays true, reset() now targets n,
                                  toPatch() reports from = n
   - path absent from next     -> same rules with n = undefined (a dirty
                                  undefined draft Object.is-echoes and goes
                                  pristine-undefined; falls out of the
                                  table, no special case)
3. Default policy = Object.is(n, d) -- confirmOnEcho semantics. A policy is
   caller-supplied `(nextValue, draftValue) => boolean`; lite-form ships NO
   structural deep-equal (mirror-oracle cost + feature creep). DOCUMENT the
   consequence loudly: deep-copied payloads mean object-leaf edits are
   always CONFLICTS under the default policy; a caller-supplied structural
   policy is the escape hatch -- the same recorded contract as
   lite-project's own confirmOnEcho limitation.
4. The async seam is OFF-COST when unused: a form with no async validators
   allocates NO per-field async machinery, adds NO signal reads to
   keystroke/submit, and reproduces 1.2.0's t6 numbers byte-for-byte.
   Fields WITHOUT an async validator pay nothing even on a form that has
   async fields elsewhere.
5. Ordering law: one monotonically increasing sequence per async field; a
   resolution (or rejection) carrying a stale seq is DROPPED WHOLE -- no
   signal write, no error surface, no trace. isValidating is true exactly
   while the LATEST seq is unsettled. dispose() mid-flight is safe: a
   post-dispose settlement is a complete no-op (no throw, no write).
6. Fail-closed submit law: onSubmit NEVER runs on stale or unsettled
   validity -- a pending async verdict cannot race a submit into a false
   positive. The mechanism (refuse-while-pending vs await-settle) is D6;
   the law is not negotiable.
7. NO timers inside Form.js: no setTimeout/interval/microtask scheduling
   machinery for debounce purposes (the S2 TTL refusal's sibling). Debounce
   belongs to the caller via the lite-debounce recipe -- devDep ^1.1.0,
   6th symlink, recipe TESTED in the fast suite. lite-form only sequences
   caller promises with plain .then callbacks.
8. t9 identifier discipline continues (re-capture sites use fresh/landed/
   reseed naming, never `const seeded =`); any moved anchor is updated
   verbatim with the occurs-exactly-once assertion kept, and the
   realias/reproto controls must still die at t1 with their markers.

## TASKS (planner refines into atomic ordered tasks with file targets)

1. decisions/0003-server-data.md FIRST: the merge table + policy contract
   (PINNED 2/3), the ordering law (PINNED 5), the submit gating choice (D6
   under PINNED 6), isValidating surface (D3), patch-submit shape (D2),
   touched/submit-state fate per merge row (D1), source-mode reconcile
   verdict (D4), server-error story verdict (D5), the no-timers rule
   (PINNED 7), and the lite-store floor move.
2. Merge-reinitialize: implement PINNED 2 exactly (atomic pre-validate ->
   one batch -> per-field table application; policy called only for dirty
   fields; engine overlays cleared/kept via handle.clear / left in place;
   baselineRev bumped once). Declare in Form.d.ts + document.
3. Async validation seam: config surface (planner pins the name, e.g.
   validatorsAsync: Record<path, (value, ctx) => Promise<msg|null>>);
   per-async-field seq guard + result lane merged into rawError semantics;
   form.isValidating (+ per-field per D3); D6 isValid semantics; dispose
   safety per PINNED 5. Hint, not law: mirror the rawError shape -- an
   async result signal written only by latest-seq settlements; a field is
   invalid when EITHER lane says so.
4. Dirty-only submit per D2: posts toPatch() to the caller's handler;
   submit lifecycle (isSubmitting/submitError/submitAttempted) unchanged.
5. Server-error story per D5: tested recipe (lean) or a tiny helper --
   either way a fast-suite test proves the 409-flow end to end.
6. Source mode: verify and PRESERVE 1.2.0's source-mode reinitialize
   behavior unchanged (read the code + test/07 first); implement D4's
   verdict (form.reconcile(policy?) over engine reconcileAll, or an ADR
   line deferring it). Merge-reinitialize itself is DEFAULT-MODE ONLY.
7. Torture: t5 fuzz gains seeded interleavings of set/blur/reset/commit/
   setValues/reinitialize(next)/reinitialize(next, policy) vs the mirror
   (mirror implements the PINNED 2 table + D1 verdicts); an async-lane
   fuzz with a deterministic deferred scheduler (seeded resolution-order
   shuffles, NO wall clock); t6 asserts the no-async numbers byte-stable
   and records the async-validated keystroke; t7 soaks async churn
   (create -> N in-flight validations -> out-of-order settle -> dispose)
   and merge churn, both leak-flat over 4096; t9 gains a stale-seq control
   (a patched copy that drops the seq guard must die in the ordering test)
   plus anchor upkeep per PINNED 8.
8. Wiring + docs: devDeps per frontmatter (lite-store ^1.4.0,
   lite-debounce ^1.1.0 + 6th symlink ../../../LiteDebounce); README/llms
   gain the three flows (merge semantics table, async ordering contract,
   patch submit, debounce recipe, server-error recipe) and the stale
   lite-resource aside is rewritten; FAST_SUITE_COUNT + README + llms
   counts move together; CHANGELOG `## Unreleased`; VERSION stays 1.2.0
   until /release. Do NOT touch the Node-22 bench records (still the
   deferred doc pass).

## DECISION POINTS FOR PLANNER (pin each in the spec; ADR records all)

D1. Touched/submitAttempted/submitError fate per merge row. Lean: CONFLICT
    rows keep touched (the user is mid-edit on that field); ECHO/adopt rows
    clear touched; submit state untouched by the merge (a background
    refresh must not un-reveal errors mid-flow). Whatever is pinned, the
    mirror implements it and a truth-table test proves it.
D2. Patch-submit shape: submit(ev?, opts?) vs a config flag vs a separate
    onSubmitPatch handler. Constraints: ev.preventDefault compat preserved,
    existing onSubmit signature untouched, additive d.ts, isSubmitting
    lifecycle identical in both shapes.
D3. isValidating surface: form-level signal is required; per-field
    field.isValidating only if it allocates solely for async-configured
    fields (PINNED 4). Also pin the trigger topology so the lite-debounce
    recipe actually composes: the caller must be able to debounce the
    async lane without lite-form owning a timer (e.g. the async validator
    reads a debounced source via ctx, or the async lane keys off a
    caller-wrapped debounce(field.value, ms) -- planner picks the shape the
    recipe can TEST).
D4. Source-mode reconcile: expose form.reconcile(policy?) as a one-liner
    over engine reconcileAll (the masked-conflict tests already exist in
    test/07) or defer past S3. Lean: ship it if it lands under ~15 lines
    incl. d.ts + one test; otherwise one ADR line defers it.
D5. Server-error story: promoted tested recipe (zero new API -- lean) vs a
    tiny serverErrors helper export. Decide by which test reads cleaner;
    record why.
D6. isValid while an async verdict is pending: strict-false (pending =
    not-yet-valid, hard fail-closed) vs last-settled-value (no flicker;
    submit still gated by PINNED 6 either way). Record the reveal-gating
    and submit-button UX consequences in the ADR.

## ASSERTIONS (qa falsifies each)

- A1 Additive API: all 77 existing tests green UNMODIFIED (diff of
  test/0[0-7]*.test.js empty vs f2dffc0).
- A2 t6: flat/dotted/schema numbers for a no-async form unchanged vs the
  1.2.0 recordings (byte-level: same gates, same recorded baselines);
  async-validated keystroke measured + recorded with the debounce recipe
  cross-referenced; no gate regresses.
- A3 Merge fuzz vs mirror: seeded interleavings (incl. policy true/false/
  throwing-policy paths) -- values()/isDirty/isValid/toPatch()/reset
  targets agree with the mirror after every step; pool flat; no zombie
  signals.
- A4 The echo truth table proven directly: all four PINNED-2 rows x
  {primitive leaf, object leaf, absent path}; object leaf under the
  default policy stays a CONFLICT (documented behavior), a structural
  policy confirms it; after ECHO the field is pristine (toPatch empty for
  it, reset() a no-op on it); after CONFLICT reset() lands the SERVER
  value and toPatch() reports from = server value.
- A5 Async ordering: >= 3 manually-controlled deferreds settled out of
  order -> only the latest lands; a stale settlement leaves NO trace (its
  would-be error never flashes); isValidating flips exactly at the latest
  settle; rejection handled per the pinned semantics; dispose() mid-flight
  then settle = no-op, no throw.
- A6 Submit fail-closed: a submit racing a pending async verdict can never
  run onSubmit on stale validity (per the D6 mechanism); the three
  documented double-submit defenses still hold with isValidating in the
  mix.
- A7 Unreachability extended: the `next` handed to reinitialize(next,
  policy) is never aliased (mutating it afterwards changes nothing);
  toPatch() from/to under merged baselines are copies (mutation-bite
  probes extended from test/05/06).
- A8 Soak + control: t7 async churn and merge churn leak-flat over 4096
  cycles; the t9 stale-seq control (guard dropped in a patched copy) dies
  with its named marker; realias/reproto still die at t1.

## NON-GOALS

No field arrays (S4). No transport, no fetch wrapper, no cache, no retry.
No timers or debounce machinery inside Form.js (recipe only). No shipped
deep-equal (policies are caller-supplied). No lite-resource usage. No TTL
surface. No bench-record refresh (deferred doc pass stays open). No
merge-reinitialize in source mode (reconcile is that mode's story, per D4).
No version bump (release does it).

## DONE WHEN

the three flows are first-class and fuzz-proven vs the mirror; the merge
table and ordering law are falsifiable (truth-table tests + the stale-seq
control dies); a no-async form's t6 numbers are byte-identical to 1.2.0;
ADR 0003 records every pinned and decided contract; docs, counts, wiring,
and symlinks updated; tree committed.
