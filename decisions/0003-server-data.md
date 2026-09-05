# 0003 -- the server-data story (S3, v1.3.0)

Status: accepted, 2026-09-06. Session S3 of ROADMAP.md; BRIEF.md pins 1-8 are
law for this record. Everything here is additive on the S2 engine seam; the
1-arg contracts and the no-async keystroke path are byte-identical to 1.2.0.

## Context

Three real-world flows the package only gestured at: (a) fresh server data
arriving WHILE the user edits, (b) posting only the dirty paths, (c) async
business validation. All three ride surfaces the S2 engine already proves
(overlays, dirtyCount, toPatch, reconcileAll); lite-form adds contracts, not
machinery.

## The merge table (reinitialize(next, policy) -- default mode only)

Phases: REFUSE (2-arg in source mode -> TypeError naming reconcile; bad next /
non-function policy -> TypeError) -> VALIDATE+COPY (cloneConfig(next); hostile
key / cycle / uncopyable leaf -> TypeError, nothing mutated) -> PRE-SCAN
(verdicts computed for every field BEFORE any state change; a policy throw
propagates here, so a throwing policy is ATOMIC) -> APPLY in one batch with
exactly ONE baselineRev bump as the last write; scratch invalidated.

Per registered field, n = the copied next leaf (undefined when absent), d =
the staged draft:

| row | verdict | result |
| --- | --- | --- |
| not overlaid | ADOPT | baseline + initialRef re-seed to n; touched cleared |
| overlaid, Object.is(n, d) or policy(n, d) === true | ECHO | overlay cleared; pristine at n; touched cleared |
| overlaid, anything else | CONFLICT | overlay kept (masks n); initialRef re-seeds to n underneath: reset() lands n, toPatch().from === n; touched kept |
| path absent from next | same table with n = undefined | |

Sub-rules, both load-bearing:

- **Forced echo.** Object.is(n, d) short-circuits the policy. A policy that
  returned false for an equal pair would leave an overlay whose staged value
  equals the reseeded initialRef -- breaking the S2 clear-on-initial invariant
  (overlay presence === dirty: dirtyCount() > 0 while dirty() reads false).
- **Fail closed on non-boolean.** Only `=== true` is an ECHO. undefined, 0,
  "", truthy non-true -- all CONFLICT: keeping the user's draft is the side
  that never discards data.

**Touched/submit fate (D1).** ADOPT and ECHO rows clear touched (the server
owns that value now; a revealed error about data the user no longer holds is
a lie). CONFLICT rows keep touched (the user is mid-edit; un-revealing their
error mid-keystroke is worse). submitAttempted / submitError / isSubmitting
are NEVER written by a merge -- a background refresh must not flash every
revealed error off and back on. This is the one deliberate deviation from the
1-arg form, and the deviation is the point.

**Re-entrancy latch (reviewer blocker, fixed).** The policy must be PURE.
Verdicts are pre-scanned against a snapshot of the drafts; a policy that
mutated the form mid-scan would have those verdicts applied over different
state, and a nested reinitialize would splice the reused verdicts scratch
(same length -> no realloc -> slots [0..i-1] from the inner merge under slots
[i..n-1] from the outer). A form-scoped `merging` latch is raised before the
pre-scan and lowered in a finally after the apply batch; every mutating entry
point (field.set / blur / field.reset / props().onBlur / setValues via the
set funnel / form.reset / commit / reinitialize / reconcile / submit /
dispose) throws `TypeError("[lite-form] cannot mutate the form from inside a
merge policy")` while it is up. Lazy field CREATION is guarded too (round-2
reviewer nit, taken): a field born mid-merge would seed its initialRef from
the pre-merge baseline outside the verdict loop, which captured n before the
append -- and setValues on a new path would create it before the set guard
fired. The window deliberately covers the apply FLUSH: effects and subscribe
callbacks run at batch close, so caller code reached from them cannot mutate
mid-merge either. Reads (and field() on an EXISTING path) are unrestricted --
the pre-scan state is consistent. Cost: one predicted-false boolean check on the
set funnel -- instructions, not bytes; t6 unchanged. The hostile-policy throw
rides the throwing-policy atomicity path: nothing is mutated.

**Policy contract.** A policy is caller-supplied `(nextValue, draftValue) =>
boolean`; the default is Object.is (confirm-on-echo). lite-form ships NO
structural deep-equal: the t5 mirror would have to mirror it, and every
structural definition is wrong for somebody. Recorded consequence, stated
loudly in the docs: lite-form deep-copies every payload at the boundary, so an
OBJECT leaf can never Object.is-echo -- object edits are always CONFLICTS
under the default; a structural policy is the caller's escape hatch (the same
recorded limitation as lite-project's own confirmOnEcho).

## The async ordering law (validatorsAsync)

One monotonically increasing sequence per async field. A settlement (resolve
OR reject) carrying a stale sequence is dropped WHOLE -- no signal write, no
error flash, no trace (proven by a subscribe-recorder over the whole window,
not an end-state check). isValidating is true exactly while the LATEST
sequence is unsettled; a re-trigger while pending bumps the sequence only
(pending edges drive the form-level count -- no double increment, no stuck
counter). dispose() sets the disposed flag first, so mid-flight settlements
arriving later are complete no-ops.

**Rejections.** The latest rejection is a verdict: it surfaces as the field's
error via `String(reason && reason.message || reason) || "async validator
rejected"` -- a rejection can never leave a field valid. Stale rejections are
swallowed with handlers attached (no unhandledRejection can fire).

**isValid while pending (D6): strict-false.** Pending is not-yet-valid (null
is not zero). This satisfies the fail-closed submit law with ZERO new submit
code: submit()'s existing untracked isValid gate refuses while a verdict is
in flight. Recorded UX consequences: the submit button disables during
validation (the honest state), and isValid flickers during typing on an
async-validated field -- the debounce recipe is the documented mitigation.
The rejected alternative (last-settled isValid) avoids flicker but lets a
submit race a pending verdict, which the law forbids.

**Surface (D3).** BOTH form.isValidating and per-field field.isValidating
ship now. Downstream consumer: @zakkster/lite-headless createFormField (its
H11 roadmap session adds a pending state that reads exactly this per-field
signal). The off-cost rule (BRIEF pin 4) holds structurally: every field
record carries one uniform `asyncLane: null` slot; seq/pending/err/reader
live inside a lane object allocated ONLY for paths present in
validatorsAsync; sync-only fields expose one shared frozen FALSE read-callable
(the NULL/EMPTY precedent), and the error/isValid bodies are chosen at
construction from hoisted sync/async variants -- the sync variants are the
1.2.0 bodies verbatim.

**Trigger topology (asyncSources).** A reader FACTORY `(field, ctx) => (() =>
any)`, called once at construction inside the form's createRoot AFTER the
public Field is assembled, defaulting to the field's own value accessor. This
is the only shape the lite-debounce recipe can express in one line
(`(fld) => debounce(() => fld.value(), 300)`) while keeping every timer
outside Form.js and the debounce's internal nodes form-owned (the LF-04
lazy-allocation class is why the factory runs detached). Lane teardown
disposes only factory-supplied readers, never the field's own facade.

**No timers (BRIEF pin 7).** Form.js contains no timer or scheduling
machinery of any kind; lite-form only sequences caller promises with plain
then-callbacks. Debounce/throttle belong to the caller (lite-debounce is a
devDependency for the recipe test only -- the S2 TTL refusal's sibling).

## Patch submit (D2)

`submit(ev?, opts?)`, opts = { patch?: boolean }. Per-call, not per-config: a
form legitimately does draft-saves (patch) and a final submit (values) in one
lifetime; a config flag or second handler would force the choice to
construction and duplicate a lifecycle. `patch: true` swaps ONLY the payload
expression (toPatch() instead of values()); the validity gate, isSubmitting,
submitError, the structural-error rethrow, and the return value are the same
code. Recorded non-decision: an EMPTY patch still runs onSubmit([]) --
lite-form does not invent a "nothing to save" policy; the caller checks
.length. d.ts models onSubmit as a union of the two handler shapes (additive;
every existing narrow handler stays assignable).

## Source mode (D4)

Recorded actual 1.2.0 behaviour (read from the code, no test existed): 1-arg
reinitialize never branched on sourceMode -- observable effect: revert every
draft + clear touched/submit state (the projection rides the live source, so
the baseline swap is read-dead there). That behaviour is FROZEN and now
pinned by a regression test.

Rulings: `form.reconcile(policy?)` ships as a thin delegation to the engine's
reconcileAll (default Object.is) -- the only merge story a mode without a
detached baseline can have, and its masked-conflict semantics were already
proven by test/07. `reinitialize(next, policy)` in source mode THROWS a
TypeError naming reconcile: silently ignoring the policy argument is the
fail-open version. reconcile is legal in default mode, where it is a no-op
under the default policy BY DESIGN: clear-on-initial means an overlay whose
staged value Object.is-equals the authoritative read cannot exist (AM-7).

## Server errors (D5)

Promoted tested recipe, zero new API: a caller-owned signal merged inside the
caller's validate inherits reveal-gating, isValid, the formErrors cutoff and
field.error() for free. A serverErrors helper would have to own a
clear-on-edit policy (this field's next keystroke? submit? reinitialize?) --
every answer is wrong for some caller, so none ships.

## LF-12 (found and fixed in this session)

Latent since 1.2.0, exposed by the new t5 per-path oracle: field.dirty() read
(cached) before commit() stayed true after it. commit() folds the staged
value into the baseline, so value()'s output never changes across the fold --
the Object.is cutoff therefore never re-ran the cached dirty computed while
initialRef (a plain property, deliberately untracked) was re-captured
underneath it. The forced-echo merge row is the same class. Fix: dirty tracks
baselineRev directly -- every initialRef re-capture site already bumps it
(field.reset, form.reset, commit, reinitialize, merge), the read costs no
allocation, and the keystroke profile is unchanged (rev only moves on cold
ops). Regression tests pin both shapes in test/08.

## The staleseq gate ordering

The t8 async tier is registered BETWEEN t7 and t9 on purpose: t9's
patched-module children run every tier with the break env blanked, and the
staleseq child (seq guard disabled) must die at t8 -- if it reached t9 it
would spawn recursively. Marker: "t8 LF-09 stale settlement landed".

## Alternatives rejected

- Await-settle submit (submit waits for pending verdicts): a re-entrancy
  window and a timeout question for zero safety gain over strict-false.
- Per-config patch mode / onSubmitPatch: forces a construction-time choice a
  call site owns; duplicates the submit lifecycle.
- A shipped structural deep-equal policy: mirror cost + every definition is
  wrong for somebody; the caller's policy is four lines.
- Merge-reinitialize in source mode: there is no detached baseline to
  re-seed; reconcile IS that mode's merge.
- A serverErrors helper export: owns an unownable clear policy (above).
- Making initialRef a per-field signal (LF-12 alternative): one extra node
  per field for the same observable behaviour baselineRev already provides.
