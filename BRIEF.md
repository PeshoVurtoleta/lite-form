# BRIEF -- S4: field arrays with preserved identity (v1.4.0, LF-08)

Authored 2026-09-06. Pipeline: planner -> coder -> reviewer -> qa, this session.
Supersedes the S3 brief (S3 shipped as 1.3.0, registry-verified 2026-09-06T02:10Z).

## Gate verdict (ROADMAP S4 opener, recorded 2026-09-06, first-hand)

lite-map is INELIGIBLE: 1.4.1 (local tree = npm latest, published
2026-09-05T19:22Z) rides peer `@zakkster/lite-signal ^1.6.0-beta-1` -- a
PRE-RELEASE core, while lite-form ships on stable `^1.5.0`. Building on it
would force a beta signal core on every co-install. Per the ROADMAP fallback:
**internal keyed-row helper on the S2 engine, overlay keys
`rows.<rowKey>.field`**. The lite-map adapter is a recorded follow-up for
when lite-map lands a stable peer. Record verdict + date in the ADR.

## Preflight facts (probed first-hand 2026-09-06)

- Arrays are copy-walk LEAVES today: `initialValues: {rows: [{name:"a"}]}`
  declares ONE field "rows"; values() returns the array.
- Numeric segments DO descend lazily: `field("rows.0.name")` works (reads
  "a"); `setValues({"rows.1.name": v})` works and materializes into the array.
- **OVERLAP HAZARD, live today**: a whole-array set on "rows" and a
  "rows.1.name" edit coexist as two overlay keys; toPatch() then lists BOTH
  "rows" and "rows.1.name" -- overlapping patch entries over one region with
  no defined winner. S4 must not extend this ambiguity into keyed arrays.
- lite-project 1.4.1 ships `prune()` (since 1.1): releases slots that are
  BOTH un-overlaid AND unobserved; O(slots); "call after removal or
  post-commit, never per frame". Its precondition `registry.hasObservers`
  EXISTS on our floor (lite-signal since 1.1.4, per-registry; verified in
  the 1.5.1 llms). This is the row-removal slot-reclaim seam.
- Current tree: Form.js 871 lines, suite 118, gate floors dotted 0.06-0.15,
  schema 113.4-114.6, asyncKeystroke 629.703-629.813 B/op.

## PINNED (law -- not up for re-decision)

P1. **Keyed arrays are OPT-IN by config declaration.** An UNDECLARED array
    path keeps 1.3.0 behavior byte-identical (leaf copy, lazy index descent,
    the overlap hazard included). Zero behavior change for existing forms;
    t6 floors unchanged (the S3 off-cost precedent: hoisted variants chosen
    at construction, no per-keystroke branch on the old path).
P2. **On a DECLARED array path, mixed addressing fails closed.** Index-
    segment paths under it (`rows.0.name`), `field("rows")` value writes,
    `setValues` at or under it by index, and `commit("rows.0.name")` all
    throw path-naming TypeError directing to the row API. One addressing
    model per path; the overlap class from the preflight probe is dead on
    declared arrays.
P3. **Row identity = caller-stable key; state travels with the key.**
    Values, dirty, touched, error, async lane, isValidating all ride the
    rowKey, never the index. Reorder writes ORDER ONLY: no per-row signal
    writes, no validator re-runs, proven by fuzz + a no-spurious-recompute
    probe.
P4. **Internal overlay key shape is `<arrayPath>.<rowKey>.<field>`**
    (ROADMAP-pinned). rowKey is a non-empty string; hostile segments
    (__proto__/constructor/prototype) rejected at the same boundary as every
    other path; a rowKey containing "." throws (it would forge paths).
    Duplicate keys throw. Key fn is called once per row per (re)seed --
    never per keystroke.
P5. **Zero-alloc law.** Keystroke into a row field: 0 B/op, GATED (same
    class as flat/dotted). add/remove/move are STRUCTURE ops: O(rows) work
    allowed, per-op bytes RECORDED in t6 (gated at measured+noise), and
    steady-state churn is BOUNDED: activeNodes flat during unbounded
    distinct-key add/remove cycles (row roots disposed + overlays cleared +
    prune() at the removal seam), lite-leak clean.
P6. **reset() restores baseline rows** (structure + values + pristine
    state): added rows vanish, removed baseline rows return. commit() folds
    structure + values into the baseline. toPatch() expresses structure
    honestly (D2) and NEVER emits overlapping entries.
P7. **Fail closed on every undecidable.** Declared array whose initial
    value is not an array -> TypeError at createForm. Source mode + declared
    arrays -> TypeError at createForm naming the limitation (the S3
    source-refusal precedent). Unknown array-config keys -> TypeError with
    the config door's existing style.
P8. **No new peers, no new devDeps** (recipe tests use what exists).
    lite-signal floor stays ^1.5.0; per-row signals live in per-row
    createRoot ownership (the LF-04 discipline).
P9. **No wildcard path grammar.** Per-row validators/validatorsAsync/
    asyncSources/fieldOpts are declared INSIDE the array's config block
    (keyed by sub-field name), never as "rows.*.name" strings.
P10. **Tier discipline.** Any new torture tier registers BEFORE t9 (t9
    re-runs all tiers in patched children with BREAK blanked). t9 realias
    anchor `const seeded =` in makeField must survive verbatim.
    FAST_SUITE_COUNT + README/llms doc counts synced or preflight dies.
P11. **The merge purity latch covers the row API.** add/remove/move/setOrder
    from inside a merge policy window throw the existing
    "[lite-form] cannot mutate the form from inside a merge policy".

## D-questions (planner DECIDES, records in decisions/0004-field-arrays.md)

D1. Public API shape. Lean: config
    `arrays: { rows: { key: (item, i) => string, validators?,
    validatorsAsync?, asyncSources?, fieldOpts? } }` and
    `form.array("rows") -> ArrayHandle` with
    `keys(): ReadSignal-shaped tracked accessor -> readonly string[]`,
    `row(key) -> { key, field(sub) -> Field }` (cached, identity-stable),
    `add(item, atIndex?) -> key`, `remove(key)`, `move(key, toIndex)`,
    `length` tracked. Planner pins exact names, signatures, d.ts, and what
    `form.field("rows.<key>.name")` does (lean: works -- same Field object
    as row(key).field("name")).
D2. Patch shape for structure. Lean: per-field edits ride keyed paths;
    structure emits ONE entry per array path, JSON-able, e.g.
    `{path: "rows", structure: {order: [...keys], added: [...keys],
    removed: [...keys]}}`; document the round-trip. submit({patch:true})
    includes it. Empty-structure arrays emit nothing.
D3. Added-row baseline semantics. Lean: an added row's presence is
    structure-dirty; its fields compare dirty against the ADD SEED; commit()
    promotes seeds to baseline; reset() drops the row.
D4. 2-arg reinitialize (merge) x declared arrays. Lean: per-row merge is
    OUT of 1.4.0 -- a 2-arg reinitialize on a form with ANY declared array
    throws TypeError naming the limitation (fail closed); 1-arg reinitialize
    re-seeds declared arrays fully (keys re-derived from the new items, all
    row state cleared -- documented). Record keyed-row merge as the 1.5.0
    candidate.
D5. Row field creation timing. Lean: eager per baseline row at createForm
    (the eager law), per-row createRoot; add() creates lazily inside the
    form root; remove() disposes the row root, clears its overlays, then
    prune()s the engine handle.
D6. Dirty composition. Lean: form.isDirty = engine dirtyCount > 0 OR any
    array structure-dirty (order != baseline order or adds/removes pending);
    per-array `dirty` tracked accessor on the ArrayHandle. isValid
    aggregates row-field rawErrors exactly like declared fields (schema mode
    interplay: planner rules how `validate(values)` sees rows -- lean: rows
    materialize in ORDER as plain arrays in the scratch tree, keyed errors
    address back via the keyed path).

## MUST-VERIFY probes (before architecture lock; in test/torture/.tmp-*.mjs)

V2. prune() under a live projection with other observers active frees
    removed-row slots (activeNodes drops); measure cost + confirm no
    disruption to live fields.
V3. Baseline shape for keyed rows through fromAccessors: the baseline tree
    holds an ARRAY; keyed reads need a defined mapping (lean: form-owned
    keyed baseline map per array, order array beside it; the engine's
    readBase for `rows.<key>.field` resolves through it). Probe what the
    existing baselineGet/baselineSet seam needs.

## Assertions (the qa contract; A4 is ROADMAP-verbatim)

A1. Reorder preserves per-row dirty/touched/error/isValidating -- identity
    fuzz vs a keyed mirror oracle.
A2. Add/remove churn, 4096+ cycles with DISTINCT keys: activeNodes bounded
    during churn and baseline-flat after dispose; lite-leak clean.
A3. Row-field keystroke 0 B/op gated; existing t6 floors byte-stable
    (dotted/schema/asyncKeystroke) -- the off-cost proof.
A4. Index-path forms from before S4 behave identically (additive): the
    118-test fast suite green unmodified; preflight probe behaviors
    reproduced on 1.4.0 for undeclared arrays.
A5. Every P2/P7 door throws its path-naming TypeError -- one test per door.
A6. reset/commit/toPatch round-trip structure per D2/D3 -- fuzz + unit.
A7. t9 controls: an identity-regression control (hand-broken index keying)
    and a slot-leak control (remove() without root-dispose/prune) each die
    with their markers.
A8. Doc truth: counts + new API synced across README/llms/d.ts/CHANGELOG;
    PLUS the deferred doc-truth rider -- refresh the Node-22-era records
    (8x speedup / ~1.5M keystrokes/s / ~210K create+dispose/s) with
    Node-26 numbers measured THIS session via bench, and fix the size line
    ("621 lines, ~6.4 KB minified" -> real measured values). package.json
    description is NOT touched (npm listing; user's call at release).

## Non-goals

No virtualization, no rendering, no lite-map adapter (follow-up), no
per-row merge policy (D4 records it), no wizard runtime, no collab.

## Pipeline notes (S3 lessons, binding)

ADR FIRST -- both S3 coder rounds skipped it; order it as T1 and verify it
exists before round 2. Coder rounds hit 40 turns: scope punch lists, expect
me to finish docs/counts. Probes live in test/torture/.tmp-*.mjs (gitignored,
relative ../../Form.js import + bare lite-signal). zsh: no `===X===` echo,
`cmd > f 2>&1; echo EXIT=$?`. Commit BEFORE qa; qa restores via file-scoped
`git checkout -- <file>` ONLY. Gate noise: dotted 0.06-0.15, schema
113.4-114.6 (127.8 outlier = machine load), asyncKeystroke 629.703-629.813.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
