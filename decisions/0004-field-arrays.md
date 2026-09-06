# 0004 -- field arrays with preserved identity (S4, v1.4.0)

Status: accepted, 2026-09-06. Session S4 of ROADMAP.md; BRIEF.md pins P1-P11
are law for this record, and D1-D6 below are the planner+audit DECIDED verdicts
this session implements. Everything here is additive on the S2 engine and the
S3 merge/async seam; an UNDECLARED array path keeps 1.3.0 behavior byte-for-byte
(P1), and the no-array keystroke path is byte-identical to 1.3.0.

## Gate verdict (recorded first-hand 2026-09-06)

lite-map is INELIGIBLE as the keyed-row backing: its 1.4.1 (local tree = npm
latest, published 2026-09-05T19:22Z) rides peer `@zakkster/lite-signal
^1.6.0-beta-1` -- a PRE-RELEASE core -- while lite-form ships on stable
`^1.5.0`. Building on it would force a beta signal core on every co-install.
Per the ROADMAP fallback, S4 ships an INTERNAL keyed-row helper on the S2
engine: overlay keys `rows.<rowKey>.field`, a form-owned keyed baseline, no new
peer. A lite-map adapter is a recorded follow-up for when lite-map lands a
stable peer.

## MUST-VERIFY probes (run first-hand this session, then deleted)

- **V2 (prune under live observers).** A projection over `fromAccessors` with a
  live observer on key "keep" and an unobserved warmed slot "drop": `prune()`
  returned 1, activeNodes dropped by 2 (one overlay signal + one read computed),
  and the observed "keep" slot was retained and still resolved. VERDICT: prune()
  is the row-removal slot-reclaim seam; the t7 churn bound is activeNodes-flat,
  NOT distinct-keys-ever. No fall-back to slots-persist.
- **V3 (keyed baseline shape).** A KEYED path `rows.<key>.name` resolved through
  a form-owned per-field `initialRef` seeded from a `rowBase` Map. `baselineGet`
  returns `f.initialRef` per-field regardless of path shape, so the hot read
  path gains ZERO new branches; an overlay edit on a key survived an order-array
  reversal untouched (state travels with the key; reorder is order-only).
  VERDICT: form-owned `rowBase` (Map arrayPath -> Map key -> itemCopy) +
  `rowOrder`/`rowCurrent` (Map arrayPath -> string[]); the ARRAY-ONLY seed
  variant is chosen at makeField/add time (cold), never on the read path.

## D1 -- public API

**Config door.** `arrays: { "<dotted path>": { key, validators?,
validatorsAsync?, asyncSources?, fieldOpts? } }`.

- The path MUST resolve to an Array in `initialValues`, else a TypeError at
  `createForm()` naming the path (P7 fail-closed).
- Sub-config maps (`validators` / `validatorsAsync` / `asyncSources` /
  `fieldOpts`) are keyed by the SUB-PATH within a row (dotted sub-paths legal,
  e.g. `"addr.city"`). This is the P9 "no wildcard grammar" shape: per-row
  config lives INSIDE the array block, never as `"rows.*.name"` strings.
- Any key in an array config block other than
  `key`/`validators`/`validatorsAsync`/`asyncSources`/`fieldOpts` is a TypeError
  matching the existing config-door style (fail closed, no silent ignore).
- `key(item, i) => string` is called ONCE per row per seed/add/reseed --
  NEVER per keystroke (P4). It must return a NON-EMPTY string that contains no
  "." and is not `__proto__`/`constructor`/`prototype` (P4 hostile boundary),
  else a TypeError naming the array path. Two rows yielding the SAME key in one
  seed is a TypeError naming the array path and the duplicate key.

**`form.array(path) -> ArrayHandle`.** An undeclared path is a TypeError. One
handle per array, cached. Surface:

- `keys()` -- tracked accessor; returns a readonly frozen `string[]` (the SAME
  frozen instance until structure changes; a new frozen array on structure
  change so the Object.is cutoff fires exactly once per structural mutation).
- `length()` -- tracked accessor (number of current rows).
- `structureDirty()` -- tracked accessor: true when current order differs from
  baseline order OR there are pending adds/removes.
- `row(key) -> { key, field(sub) -> Field }` -- cached, identity-stable; an
  unknown key is a TypeError. `row(key).field(sub)` returns the SAME Field as
  `form.field("<arrayPath>.<key>.<sub>")` (one fields Map, keyed paths are real
  paths).
- `add(item, atIndex?) -> string` -- returns the NEW key. `atIndex` is an
  integer `0..length` (else TypeError); omitted = append. `item` is deep-copied
  through the existing whitelist walk as the ADD SEED.
- `remove(key) -> void` -- unknown key TypeError.
- `move(key, toIndex) -> void` -- unknown key / non-integer / out-of-range
  TypeError.
- **No `setOrder`** (rejected): a whole-order setter invites partial or
  duplicate key lists with no non-ambiguous merge (which key wins on a dup?
  what happens to an omitted live key -- removed or error?). `move(key, i)` is
  the unambiguous primitive; a caller reorders by composing moves.

**`form.field("rows.<key>.name")`.** Under a DECLARED array path, the first
segment after the array path MUST be a LIVE rowKey. A live rowKey resolves to
the same Field object as `row(key).field("name")` (keyed paths are real paths in
the one fields Map). Sub-fields under a live row lazily create INSIDE that row's
own createRoot (so `remove()` disposes them). Anything else fails closed with a
TypeError directing to the row API (P2):

- an INDEX segment (`rows.0.name`) -- even a numeric that is not a live key;
- a segment that is not a live key;
- `field("rows")` itself (addressing the array as a whole);
- `setValues` AT `rows` or under it by index;
- `commit("rows.0.name")` / any write addressing the array as a whole.

`setValues({"rows.<key>.name": v})` on a LIVE key is legal.

**Row validator ctx.** A row validator gets the existing `get(path)` (any
absolute path, tracked) PLUS `local(sub)` which reads
`<arrayPath>.<thisRowKey>.<sub>` with dependency tracking. `local` is present
ONLY on array (row) validators; plain validators keep their current
`{get}`-only ctx shape byte-for-byte.

## D2 -- patch shape

Per-field entries ride keyed paths for EXISTING (baseline) rows only:
`{path: "rows.<key>.name", from, to}`.

Structure emits ONE entry per structurally-dirty array:

```
{ path: "rows", structure: {
    order:   [...currentKeys],           // full current key order
    added:   [{ key, index, value }],    // added rows, FULL current value each
    removed: [...baselineKeysNoLongerPresent],
} }
```

- An ADDED row's full current value rides in `structure.added[].value`; its
  fields NEVER emit field entries (no overlap, P6). `order` is the full current
  order; `removed` is the baseline keys no longer present.
- A structure entry is emitted ONLY when the array is structure-dirty
  (order != baseline order OR adds/removes pending). A structurally clean array
  with only field edits emits just its per-field keyed entries.
- `submit(ev, {patch: true})` includes structure entries. `toPatch()` stays
  untracked + read-only (safe inside an effect).

## D3 -- added-row baseline semantics

- An added row's PRESENCE is structure-dirty.
- Its fields' `dirty` compares against the ADD SEED (the deep-copied `item`
  passed to `add`), exactly like a baseline field compares against its
  `initialRef`.
- `commit()` PROMOTES: the row enters the baseline with its current values,
  structure folds (added/removed cleared), and the current order becomes the
  baseline order.
- `reset()` drops added rows, restores removed baseline rows pristine, and
  restores the baseline order.

## D4 -- 2-arg reinitialize x declared arrays

A `reinitialize(next, policy)` (2-arg MERGE) on a form with ANY declared array
is a TypeError naming the limitation and pointing to 1-arg reinitialize (house
message style, the S3 source-refusal precedent). Per-row keyed merge is the
recorded 1.5.0 candidate: it needs a merge-by-key table (adopt/echo/conflict
PER ROW plus row add/remove reconciliation) that is a design in its own right,
not a mechanical extension of the flat verdict scan.

1-arg `reinitialize(next)` re-seeds declared arrays FULLY: keys are re-derived
from `next`'s items via `key()`, all row state is cleared, order becomes
`next`'s order, and the atomic validate-before-mutation contract is preserved
(a hostile leaf or a bad key throws with nothing mutated).

## D5 -- lifecycle

- Eager: one row created per baseline row at `createForm`. Each row's signals +
  async lanes live inside a PER-ROW `createRoot` owned by the form (the LF-04
  discipline).
- `add()` creates the row root LAZILY.
- `remove(key)`: dispose the row root FIRST (its async lanes' in-flight
  settlements become no-ops -- the S3 lane-teardown discipline reused), clear
  its overlays, delete its entries from the fields Map, THEN call `handle.prune()`
  ONCE (the V2 seam). Row-field slots are un-overlaid + unobserved after
  teardown, so prune reclaims them; the t7 churn bound is activeNodes-flat.
- `dispose()` of the form tears down row roots like everything else.
- **prune() reclaims WIDER than the removed row, by contract.** Every slot
  that is both un-overlaid and unobserved is released -- including a pristine
  unobserved field's slot elsewhere in the form (observed first-hand: a
  remove() returned activeNodes BELOW the pre-add baseline by exactly one
  slot pair). This is lite-project's documented behavior and is SAFE: a
  released slot re-creates lazily on the next read/write with the correct
  baseline resolve; staged (overlaid) values are never touched. The cost
  class is one cold first-touch per pruned slot on its next access (pool-
  served, the same class as any first touch of a new key). The law is
  therefore a BOUND, not an exact refund: remove() never grows the pool, and
  distinct-key add/remove churn stays activeNodes-flat (t7/A2).

## D6 -- dirty / valid / schema composition

- `form.isDirty` = engine `dirtyCount() > 0` OR any array `structureDirty()`.
- `form.isValid` aggregates row-field `rawError`s exactly like normal fields
  (they ARE normal fields -- no special casing).
- Schema mode (`validate`): the scratch tree materializes declared arrays IN
  ORDER as plain arrays. Index-based error keys the schema returns for a
  declared array path are translated index -> key via the order array, INSIDE
  the same `formErrors` computed (ONE pass over error keys that start with a
  declared array path; ZERO work when no arrays are declared). After a `move()`,
  a schema error lands on the row currently AT that index -- the schema sees the
  current order, and that is the correct semantics.

## P11 -- the merge purity latch covers the row API

`add` / `remove` / `move`, lazy row sub-field creation (`createRowSubField` --
creation is a mutation, the S3 ruling), and every ArrayHandle-reachable write
throw the existing `"[lite-form] cannot mutate the form from inside a merge
policy"` while the `merging` latch is up.

**Reachability ruling (review find, 2026-09-06).** On a declared-arrays form
the 2-arg merge refuses up front (D4), so the latch's reachable window there
is `reconcile(policy)` -- whose policy runs inside the ENGINE's own overlay
iteration. 1.3.0 shipped reconcile WITHOUT raising the latch (a mutating
policy could corrupt the scan silently -- fail-open); S4 makes reconcile raise
the latch around `reconcileAll` (raise before, lower in `finally`). This is a
named fail-open -> fail-closed behaviour change, and it is what makes the row
API guards real rather than decorative: a reconcile policy calling
`rows.remove()` or lazily creating a row field now throws with nothing
mutated. Two tests pin both doors.

## baselineRev / one-bump discipline

Structure changes (add/remove/move) and commits bump `baselineRev` exactly ONCE
per batch (the S3 one-bump discipline). `structureDirty`/`keys`/`length` track a
per-array structure-revision signal bumped once per structural mutation, so a
reorder is a single reactive propagation.

## Off-cost proof (P1/P5)

`values()` / `toPatch` / `commit` / `reset` / `reinitialize` / `submit` /
`dispose` gain array-aware variants SELECTED AT CONSTRUCTION (`hasArrays`, the
S3 `hasAsync` precedent). A form with no declared arrays takes the 1.3.0 path
byte-for-byte. The row-field keystroke path allocates nothing: sub-paths are
pre-split at field creation, the keyed lookup is `Map.get` on an interned path
string, and no string is concatenated per keystroke. The `const seeded =` line
in `makeField` (a t9 realias anchor) is preserved verbatim; the array seed
variant is a sibling branch chosen before it, not a rewrite of it.

## LF-13 -- teardown without a notifier (found by this session's own gate, fixed)

The extended t5 keyed fuzz (seed 2654435770, step 573, op rowRemove) caught
`isValid()` permanently stuck false after removing the row that carried the
only validation error. Mechanism -- the LF-12 class transposed to the validity
lane: `rowFieldsValid()` short-circuits, so the `isValid` computed can hold
exactly ONE live dependency (that row field's `rawError`); `remove()` disposes
it, and nothing ever notifies the memoized verdict again. Inspection found the
same class on the async lane (LF-13b): `teardownRow` set `lane.dead` but never
released a PENDING lane's `pendingCount` slot, and the settlement returns on
`lane.dead` BEFORE the normal decrement -- `isValidating()` stuck true,
`isValid` strict-false forever. Fixes: `rowFieldsValid` tracks every declared
array's `structRev` (the add/remove/move notifier each structural mutation
already bumps -- exactly how LF-12's fix tracked `baselineRev`), and
`teardownRow` releases the pending slot at `lane.dead` time. Two regression
tests in test/11 (suite 137 -> 139). The reviewer question this leaves behind:
every short-circuiting computed over a DYNAMIC field population must track the
population's revision, not only the members it happened to read.

## Anchor rulings (2026-09-06, supersedes the "not a rewrite" clause above)

The engine made the makeField seed a two-arm ternary (`ri === undefined ?
copyLeaf(readBase(...)) : copyLeaf(ri.leaf)`), which broke the t9 realias
control's single-line anchor. Rather than force a cosmetic refactor onto a
green engine, the control RE-ANCHORS to the ternary's readBase arm
(`? copyLeaf(readBase(baseline, path, segs))` -> drops the copy), which
reinstates exactly the LF-02 aliasing on plain fields -- detection power
unchanged. The staleseq control anchor is synced to the guard's new text
(`disposed || lane.dead || lane.seq !== mySeq`); its `if (false)` replacement
now also proves dead-lane settlements would land without the guard.

## Alternatives rejected

- **`setOrder(keys[])`** -- partial/duplicate ambiguity with no correct merge
  (above). `move` is the unambiguous primitive.
- **Index paths on declared arrays** -- reintroduces the preflight overlap
  hazard (a whole-array set and an index edit as two overlapping overlay keys
  with no defined winner). One addressing model per path (P2).
- **lite-map backing** -- beta signal peer (gate verdict above).
- **Per-row 2-arg merge in 1.4.0** -- a keyed merge table is its own design;
  deferred to 1.5.0 (D4).
- **Materializing keyed rows into the baseline tree** -- the baseline tree holds
  the plain array; keyed reads resolve through per-field `initialRef` (V3), so
  the flat/dotted read path gains zero branches.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
