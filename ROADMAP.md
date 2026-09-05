# lite-form -- enriched roadmap

Five sessions for one package. lite-form v1.0.0 shipped (2026-05-30) as a
headless, signal-bound form core: 294 lines, flat path->signal Map, two
cutoff-gated validation modes, reveal-gated display, eager field allocation.
The architecture is genuinely fine-grained -- a keystroke on 1 of 100 fields
runs one validator, the schema is hoisted to one computed, and the pool
returns to baseline on dispose (reproduced: 1000 create/dispose cycles,
activeNodes 8 -> 8). The shape is right.

What is wrong is one layer down, and none of it is visible in the 33-test
suite: a hostile path segment pollutes `Object.prototype` globally; object
leaves alias the caller's `initialValues` so in-place edits corrupt the reset
baseline and blind `dirty`; lazily-created fields self-destruct inside
re-running effects exactly as the header comment predicts -- and the API lets
it happen silently; `values()` crashes on non-cloneable config at submit time,
not at construction. And there is no gate: no torture harness, no lite-leak or
lite-gc-profiler witness, a bench that cannot fail, and a package that is not
even a git repository.

**Every finding below was reproduced against the live tree on 2026-09-05**
(probes run with `@zakkster/lite-signal@1.5.0` wired), not inferred from
reading. Baseline: `npm test` -> 33/33 pass -- but only after hand-wiring
`node_modules/@zakkster/lite-signal`; a fresh checkout fails every test with
`ERR_MODULE_NOT_FOUND`.

| Axis | State |
| --- | --- |
| **Publishing** | Weak. package.json is fine (files[], sideEffects, engines) but there is NO CHANGELOG.md (law: llms.txt + CHANGELOG per package; files[] omits it too), no VERSION export, no version in the Form.js header, author field lacks the email, and the directory is NOT a git repository. Peer floor `lite-signal ^1.1.3` predates the owner API the fixes need. |
| **Correctness (shallow)** | Good. 33 tests pass; the validation algebra (hoisted schema, cutoff, reveal gating, cross-field ctx.get) is correct and the design rationale in the header is sound. |
| **Correctness (adversarial)** | **Broken.** LF-01 prototype pollution (S1, security), LF-02 leaf aliasing (S1, silent corruption), LF-03 clone crash (S2), LF-04 zombie lazy fields (S2). All fail-open; none covered by a test. |
| **Gate** | **Absent.** `verify` = `npm test && npm run bench`; the bench reports numbers and can never exit non-zero. The README's zero-alloc and pool-clean claims are unwitnessed. No test/torture.mjs, no controls, no leak tracker, no profiler. |
| **Ecosystem fit** | Greenfield. Zero textual references to lite-store / lite-project / lite-map / lite-crdt anywhere in the package. Meanwhile lite-project v1.2.0 already ships the hard half of form state (overlays, dirty, commit/revert, reconcile policies, zero-alloc patch diff) behind a stable `^1.5.0` signal peer, torture-gated. |

The one sentence this roadmap turns on:

> **The validation layer is right and the state layer is wrong. Form state --
> baseline, edits, dirty, reset, patch -- is exactly the problem lite-project
> has already solved behind a gate; lite-form's own clone-and-alias state
> model is where every S1 lives. Fix fail-closed first, then swap the state
> engine out from under the unchanged public API.**

---

## 1. Scope check (do this before anything else)

Verified 2026-09-05 against the live tree:

| Package | Directory | Version | Role |
| --- | --- | --- | --- |
| `@zakkster/lite-signal` | `LiteSignal` | 1.5.0 | peer (has createRoot/runWithOwner/getOwner since 1.5.0 -- the eager-only rationale in Form.js's header cites 1.2.0 and is stale) |
| `@zakkster/lite-project` | `LiteProject` | 1.2.0 | S2 engine candidate. Peer `lite-signal ^1.5.0`, torture-gated, CHANGELOG cadence active. Exports project/keyedStore/confirmOnEcho/makeReconciler/fromAccessors/fromProxy/projectStore + Projection {get,set,clear,commit,revert,dirtyCount,isDirty,toPatch,forEachPatch,...} |
| `@zakkster/lite-store` | `LiteStore` | 1.2.1 | optional source bridge (via lite-project's `projectStore`). Shipped: store/unwrap/snapshot/dispose/reconcile/VERSION. NOT shipped: transaction, storeStats/observeStore, createStoreFactory (its S2-S4). Live S2 defect LS-01: unbounded recursion crashes deep walks. |
| `@zakkster/lite-map` | `LiteMap` | 1.1.0 | field-array candidate -- DEFERRED. Peer is `lite-signal ^1.6.0-preview.2` (pre-release core) and the package carries its own three-place version drift (CHANGELOG says 1.1.1, package.json+header say 1.1.0). Re-evaluate at S4. |
| `@zakkster/lite-crdt` | `LiteCrdt` | 2.0.0 | OUT of core scope. Hard runtime deps on both signal+store, read-only `.store` projections (two-way binding impossible by design), own packaging drift (deps vs "zero runtime deps" README vs llms.txt peers). Future `lite-form-collab` adapter, not a session here. |
| `@zakkster/lite-gc-profiler` | `LiteGCProfiler` | 1.16.0 | devDep for the gate. (`LiteGcProfiler` is the SAME directory -- case-insensitive filesystem; pin this casing.) |
| `@zakkster/lite-leak` | `LiteLeak` | 1.10.0 | devDep for the gate (createLeakTracker). |

devDep wiring convention: relative symlinks under `node_modules/@zakkster/`
(lite-signal is already wired that way by hand; S0 makes it reproducible) and
run gates with `--preserve-symlinks`.

Doc cross-references to verify at S0: README links `@zakkster/lite-resource`
(no local directory exists) and calls `@zakkster/lite-debounce` "a future
package" (LiteDebounce exists locally). Check npm before repeating either
claim; fix whichever direction is wrong.

---

## 2. Shared law (holds every session)

1. **Zero allocation on the keystroke path -- for every declared field shape,
   not just flat paths.** A dotted-path field's dirty recompute must not
   allocate (today `getPath` splits the path string per recompute). State the
   cost of schema mode at the call site and gate the per-field mode at zero.
2. **The caller's `initialValues` is never aliased and never mutated.** The
   baseline is the package's contract with the caller; a form that edits its
   own reset target has no reset. Prove with identity checks in the gate.
3. **Fail closed on every unverified state.** Hostile path segments throw at
   the boundary; non-cloneable config throws at `createForm`, not at submit;
   a field created where its signals cannot survive throws or detaches -- it
   never half-exists. null is not zero; undefined is not a value.
4. **A claim without a witness does not ship.** Zero-alloc, pool-clean and
   throughput claims are proven by lite-gc-profiler + `stats()` + lite-leak
   under `test/torture.mjs`, with a controls tier proving every gate can fail.
   The bench stays a bench; the gate is the gate.
5. **The public API survives the engine.** `createForm`'s returned surface
   (field/values/setValues/reset/submit/isValid/isDirty/isSubmitting/
   submitError/submitAttempted/dispose) is the contract; S2 swaps internals
   under it. New surface (commit/toPatch/reinitialize) is additive and
   off-cost when unused.

---

## 3. Verified findings

Reproduced 2026-09-05. Probes live in the session scratchpad; each repro below
is a five-liner. Severity: **S1** = silent corruption or security, **S2** =
broken documented guarantee / crash, **S3** = hygiene / gate / doc gap.

| ID | Sev | Finding | Reproduction |
| --- | --- | --- | --- |
| **LF-01** | **S1** | **Prototype pollution via path segments.** `setPath` descends into inherited objects: a `__proto__` segment walks into `Object.prototype` and writes there. `setValues({"__proto__.x": v})` (or any hostile path reaching `field()`) followed by ANY `values()`/`readValues()` sets `Object.prototype.x` globally -- and schema mode re-runs `readValues` per keystroke, re-polluting after every cleanup. `setValues(await res.json())` is the documented server-patch idiom, so the hostile key needs no privileged position. | `f.setValues({"__proto__.polluted":"PWNED"}); f.values(); ({}).polluted === "PWNED"` -- reproduced. (`constructor.prototype.*` and hostile `initialValues` via JSON.parse do NOT pollute -- verified inert.) |
| **LF-02** | **S1** | **Object-typed leaves alias `initialValues` live.** `makeField` seeds `value` with `getPath(initialValues, path)` -- the same reference. For array/Date/object leaves: in-place mutation (a) never flips `dirty` (compares the reference against itself), (b) mutates the caller's own `initialValues`, (c) makes `reset()` restore the corrupted value. Silent, spreading corruption. | `iv={tags:["a"]}; f.field("tags").value().push("b")` -> `dirty()===false`, `iv.tags` now `["a","b"]`, `reset()` keeps `["a","b"]` -- all three reproduced. Same with a Date and `setFullYear`. |
| **LF-03** | S2 | **Non-cloneable config crashes at submit time.** `values()`/`readValues()` run `structuredClone(initialValues)`; a function or method-bearing class instance anywhere in `initialValues` throws `DataCloneError` -- accepted silently at `createForm`, exploding later in `submit()` or on the first schema keystroke. Fail-open. | `createForm({initialValues:{cb:()=>{}}})` succeeds; `f.values()` throws `DOMException: could not be cloned` -- reproduced. |
| **LF-04** | S2 | **Zombie lazy fields.** `field(path)` for an undeclared path inside a re-running reactive context creates its signals as children of that effect; the effect's next run disposes them while the record stays cached in the `fields` Map. Reads then return `undefined` silently; writes land in pool-recycled nodes. The Form.js header documents this hazard as the reason for eager allocation -- and then `getField` allows it without a guard. lite-signal 1.5.0 has `createRoot`/`runWithOwner`, so the stated blocker for a safe lazy path is gone. | `effect(()=>{trigger(); f.field("lazy").value();}); trigger.set(1)` -> activeNodes 21 -> 19 (children disposed), subsequent read `undefined`, `set(5)` "works" into a recycled node -- reproduced. |
| **LF-05** | **S3 (blocker)** | **No gate.** No `test/torture.mjs`, no lite-leak / lite-gc-profiler devDeps, no controls tier; `verify` = test + bench and `bench.mjs` contains no assert and no non-zero exit path. The README's "zero allocation on the keystroke path", "~1.5M ops/sec" and "pool clean" claims are unwitnessed. Also: fresh checkout cannot run tests (no node_modules wiring convention applied). | grep bench.mjs for `assert\|process.exit` -> nothing; `npm test` on fresh tree -> `ERR_MODULE_NOT_FOUND` |
| **LF-06** | S3 | **Keystroke allocation by construction.** (a) Dotted-path fields: `dirty` recomputes per keystroke and calls `getPath` -> `path.split(".")` -- a fresh array + strings per keystroke; flat fields don't pay it. (b) Schema mode: `readValues()` = `structuredClone(initialValues)` + `setPath` x N per keystroke (README admits ~33 us/keystroke at N=100, "dominated by snapshot construction"). The zero-alloc claim is true only for flat-path per-field mode. | read `Form.js:48-55` (split per call), `Form.js:142-149` (clone per schema run); probes measure net-of-minor-GC growth only -- the S0 alloc gate pins exact bytes |
| **LF-07** | S3 | **Packaging/hygiene debt.** Not a git repository. No CHANGELOG.md (and files[] omits it). No VERSION export; version exists in package.json only -- not even the Form.js header. Non-ASCII source throughout (header box-drawing, arrows, bullets in Form.js/Form.d.ts/bench). Author field missing `<shinikchiev@yahoo.com>`. Peer floor `^1.1.3` predates the 1.5.0 owner API S1 needs. README references `@zakkster/lite-resource` (absent locally) and mis-states lite-debounce as future. | `git -C LiteForm status` -> "not a git repository"; `ls CHANGELOG.md` -> absent; `grep -P '[^\x00-\x7F]' Form.js | wc -l` -> dozens |

### Declared / natural feature debt (not defects)

| ID | Kind | Gap |
| --- | --- | --- |
| **LF-08** | README promise | **Field arrays.** "adds/removes/reorders with preserved field identity" is deferred to a future `lite-form-fields`. lite-map's `mapArray(list, mapFn, {key})` is the exact primitive but rides a preview signal core today. |
| **LF-09** | README promise | **Async validation.** "use lite-resource inside an effect" -- the referenced package does not exist locally; there is no isValidating, no async seam, no debounce story beyond a FAQ aside. |
| **LF-10** | natural | **Server-data lifecycle.** No `reinitialize(next)` (adopt fresh server data as the new baseline), no dirty-only submit diff, no first-class optimistic/echo reconciliation -- all three are literally lite-project's `commit` / `toPatch` / `confirmOnEcho`. |
| **LF-11** | natural | **Typed schema surface.** Form.d.ts types every path as `any` (admits "schema-inferred per-path types" as future). |

---

## 4. The torture suite (`test/torture.mjs`) -- spec

Suite-standard spine (copy the shape from LiteStore/LiteBake): `SEED` +
`makePrng` (xorshift32, 0-seed guarded), `check(cond, msgThunk)`, `die`,
`runOpsGate` with `RULES = { maxMajor: 0, maxPauseMs: 4,
maxArrayBuffersGrowth: 0 }`, `stabilize: 'deep'`, entry prints exactly "ok",
exit 0/1, controls spawned as env-gated children (`FORM_TORTURE_BREAK`) that
must each exit non-zero. Preflight gates: VERSION === package.json ===
header; doc-claimed test count === recorded FAST_SUITE_COUNT. Registry law:
measured tiers pre-grow `createRegistry({maxNodes, maxLinks,
onCapacityExceeded:"throw"})`; never "grow" inside a gate. Await a settle
tick before reading GC summaries; lite-leak cleanups/tags never close over
the tracked target.

```
test/
  torture.mjs           # entry: preflight, tiers in order, "ok", exit 0/1
  torture/
    harness.mjs         # SEED, makePrng, check/die, runOpsGate, mirror(form) oracle
    t0-laws.mjs         # create/values/reset/dispose identities; reveal-gate truth table
    t1-degenerate.mjs   # hostile paths (LF-01), non-cloneables (LF-03), alias leaves (LF-02),
                        #   zombie lazy field (LF-04) -- registered failing until S1
    t2-scale.mjs        # 1k-field forms, deep dotted paths; construction and keystroke bounds
    t5-fuzz.mjs         # random op sequences (set/blur/reset/setValues/submit) vs a plain-JS
                        #   mirror oracle: values(), isDirty, isValid always agree
    t6-alloc.mjs        # keystroke zero-alloc gate: flat AND dotted per-field mode at 0;
                        #   schema mode measured and pinned at its documented budget
    t7-soak.mjs         # create/dispose + keystroke churn, lite-leak witness,
                        #   activeNodes conservation (the README pool-clean claim, witnessed)
    t9-controls.mjs     # a leaked field handle; an allocating keystroke; a dropped
                        #   validator re-run; a "grow" registry under the gate -- each fails
```

The oracle: `mirror(form)` -- a plain object + hand-run validators, updated by
the same op stream, compared with `values()`/`isValid()`/`isDirty()` after
every fuzz step. The bench stays `bench/bench.mjs`, reporting; every number
the README quotes gets its gate twin here or loses the claim.

---

## 5. Session order

```
S0 --> S1 --> S2 --> S3 --> S4
 |      |      |      |      |
1.0.1  1.1.0  1.2.0  1.3.0  1.4.0
gate   fail-  engine server field
+repo  closed swap   story  arrays
```

`S0` blocks everything: no finding can be *held* fixed without the gate, and
the package is not even under version control. `S1` is the security and
correctness headline -- LF-01 is a live prototype-pollution vector in a
published package, so if anything ships out of band, it is the two-line
hostile-segment guard as a 1.0.1 hotfix; otherwise S1 carries it. `S2` swaps
the state engine under the frozen public API -- after it, LF-02/03-class bugs
are structurally impossible rather than patched. `S3` and `S4` are the
declared promises (server lifecycle, field arrays), sequenced by leverage.

**Out of scope, on purpose.** Collaborative forms (lite-crdt) -- a future
`lite-form-collab` adapter; renderer bindings (lite-signal-dom's job); wizard
runtimes (two createForm calls and your own nav state, per the README).

---

## 6. The briefs

===============================================================================
# S0 -- lite-form v1.0.1 -- repo, gate, hygiene
===============================================================================

```markdown
---
package: "@zakkster/lite-form"
version_target: 1.0.1
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-signal"]
dev: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: [LF-05, LF-07]
blocks: [S1, S2, S3, S4]
---

# lite-form -- put the package under law

PURPOSE
  No git, no CHANGELOG, no VERSION, no gate, a bench that cannot fail, and a
  fresh checkout that cannot run its own tests. Stand the package up under the
  suite's law without changing any behaviour, and register the four
  adversarial findings as reproduced, failing, on the books.

TASKS
  - git init + initial commit of the current tree (the "before" S1 forensic
    baseline). Wire node_modules symlinks (lite-signal, lite-gc-profiler,
    lite-leak) and record the convention in the README dev section.
  - Build test/torture.mjs + test/torture/ per section 4: harness spine,
    T0 laws, T5 fuzz-vs-mirror, T6 alloc gate (flat per-field mode gated at
    zero NOW -- it passes today; dotted + schema modes measured and recorded,
    gated after S1/S2), T7 soak with both witnesses, T9 controls. T1 carries
    LF-01/02/03/04 as registered-failing repros (gate-neutral until S1).
  - devDeps + scripts: torture / verify (test && torture) / prepublishOnly.
    Keep test and bench as-is; bench stays reporting-only.
  - CHANGELOG.md created (1.0.0 back-entry + 1.0.1), added to files[].
    VERSION const exported from Form.js, header gains the version line,
    Store-style three-place sync gated in torture preflight. Author email
    fixed. ASCII pass over Form.js/Form.d.ts/bench (U+00D7/U+00B5 excepted).
  - Doc truth pass: verify lite-resource / lite-debounce existence on npm and
    fix whichever claim is wrong; record the real test count and gate it.

ASSERTIONS
  - npm test 33/33 green on a FRESH clone after the documented wiring step.
  - npm run torture prints exactly "ok", exit 0; every T9 control exits
    non-zero for its named reason.
  - T6: flat per-field keystroke at 0 alloc (profiler + stats() witness);
    dotted and schema modes' measured costs recorded in the tier as the
    S1/S2 improvement baselines.
  - T7: activeNodes conservation + lite-leak clean over 4096 cycles (the
    README pool-clean claim, now witnessed).
  - LF-01/02/03/04 each reproduce inside T1 as registered-failing.
  - npm pack --dry-run ships Form.js/.d.ts/README/llms.txt/LICENSE/CHANGELOG
    and excludes test/ bench/ demo/ ROADMAP.md BRIEF.md.

NON-GOALS
  No behaviour change. No fix to any LF finding (S1). No engine work (S2).

DONE WHEN
  the package is a git repo under the suite gate, docs and version are
  honest, and the four adversarial findings are registered as failing
```

===============================================================================
# S1 -- lite-form v1.1.0 -- fail closed
===============================================================================

```markdown
---
package: "@zakkster/lite-form"
version_target: 1.1.0
status: planned
findings: [LF-01, LF-02, LF-03, LF-04]
depends_on: [S0]
blocks: [S2]
---

# lite-form -- a hostile payload must not own the prototype chain

PURPOSE
  All four adversarial findings, fixed fail-closed, flipping the T1 tier from
  registered-failing to enforced. Peer floor moves to lite-signal ^1.5.0 for
  the owner API. Minor bump: behaviour changes, every one of them from
  fail-open to fail-closed. (If a hotfix is wanted sooner, the LF-01 guard
  alone is back-portable as 1.0.1+hotfix -- two lines in setPath/getField.)

THE DECISION (record in decisions/0001-fail-closed.md before coding)
  - LF-01: getField/setPath/getPath REJECT path segments __proto__,
    constructor, prototype with a thrown TypeError at the API boundary
    (field(), setValues(), validators/fieldOpts keys at createForm). Throw,
    not sanitize -- a dropped segment is silent data loss.
  - LF-02: the baseline is DETACHED at createForm: initialValues is deep-
    copied once by lite-form's own iterative walk (no structuredClone), and
    field seeds come from the copy. Caller's object is never read again after
    construction; document that reset() targets the detached baseline.
    Object-leaf in-place mutation still cannot flip dirty (Object.is) --
    document set-with-new-reference as the contract, now safe because the
    baseline cannot be corrupted.
  - LF-03: the same construction-time walk validates leaf cloneability and
    throws at createForm on functions/exotics -- the config is verified where
    it is supplied. values() drops structuredClone entirely (the walk
    materializes from the detached baseline + field peeks).
  - LF-04: getField, when called under a live tracking context (isTracking())
    for a path that must allocate, creates the field inside createRoot so its
    signals survive the effect -- ownership detached, disposed only by
    form.dispose(). Record why not "throw": the README documents lazy
    variable-shape forms as a feature; keep the feature, kill the hazard.

TASKS
  - Implement the four fixes; per-field cached key arrays (split once at
    makeField) so dotted-path dirty recomputes allocate zero (retires the
    LF-06(a) allocation without waiting for S2).
  - Flip T1 to enforced; add T9 controls: a reinstated aliasing baseline and
    a reinstated __proto__ descent must each fail the gate.
  - T6 gains the dotted-path keystroke at 0 alloc, gated.

ASSERTIONS
  - The four probes from section 3 now: throw TypeError (LF-01 -- and
    Object.prototype stays clean), dirty/reset/caller-object all correct
    under in-place mutation attempts (LF-02), createForm throws on the
    function leaf (LF-03), the effect-created lazy field survives re-runs
    and reads back its value, activeNodes stable (LF-04).
  - Flat AND dotted keystroke at 0 alloc under T6. 33 existing tests still
    green except those pinning the old fail-open behaviours (update those
    deliberately, one by one, each named in the CHANGELOG).

NON-GOALS
  No engine swap (S2). No new public API beyond errors thrown earlier.

DONE WHEN
  every unverified state fails closed; T1 is enforced; dotted keystrokes are
  allocation-free; peer floor is ^1.5.0
```

===============================================================================
# S2 -- lite-form v1.2.0 -- the state engine (the lite-project decision)
===============================================================================

```markdown
---
package: "@zakkster/lite-form"
version_target: 1.2.0
status: planned
findings: [LF-06, LF-10 partial]
depends_on: [S1]
---

# lite-form -- swap the state layer under the frozen API

PURPOSE
  lite-form hand-rolls baseline+edits+dirty+reset+diff -- the exact surface
  lite-project v1.2.0 ships gated: per-key overlay signals, tracked
  isDirty/dirtyCount, commit/revert/clear, toPatch/forEachPatch (zero-alloc
  diff), reconcile policies. Rebase form VALUES on a projection over the
  detached baseline; keep validation/reveal/submit as lite-form's own layer.
  Schema mode stops cloning: readValues materializes baseline+overlay
  directly. New public surface is additive: commit(), toPatch(),
  reinitialize(next) become one-liners over the engine.

THE DECISION (record in decisions/0002-engine.md before coding)
  Default: lite-project as peer, projection over fromAccessors on the
  detached baseline, one overlay key per field path. Recorded alternative if
  the ADR falsifies it: keep S1's internal state, add commit/toPatch by hand
  (more code, no new peer). Explicitly NOT lite-store as the core engine:
  its transaction/storeStats/createStoreFactory are unshipped (its S2-S4)
  and LS-01 depth is live; instead ship an OPT-IN `source` config accepting
  a lite-store store via lite-project's projectStore, for callers whose
  canonical state already lives in a store. Decide and record: peer vs hard
  dep (peer, matching the suite), bundle cost stated, and the overlay-key <->
  field-path mapping as the stable contract.

ASSERTIONS
  - Public API byte-compatible: the whole fast suite green unmodified.
  - Schema-mode keystroke: no structuredClone, allocation reduced to the
    validate() call's own cost, measured vs the S0-recorded baseline.
  - commit()/reinitialize(next)/toPatch() proven by T5 fuzz vs the mirror
    (commit folds overlay into baseline; toPatch lists exactly dirty paths).
  - A lite-store-sourced form round-trips reconcile -> overlay -> submit
    with both packages' gates green.

NON-GOALS
  No lite-map, no async validation (S3/S4). No validation-layer changes.

DONE WHEN
  values/dirty/reset/patch ride the gated engine; schema mode stopped
  cloning; commit/toPatch/reinitialize ship additive; API unchanged
```

===============================================================================
# S3 -- lite-form v1.3.0 -- the server-data story
===============================================================================

```markdown
---
package: "@zakkster/lite-form"
version_target: 1.3.0
status: planned
findings: [LF-09, LF-10]
depends_on: [S2]
---

# lite-form -- forms live between two servers

PURPOSE
  The three real-world flows the README only gestures at: (a) fresh server
  data arrives while the user edits -- reinitialize(next, policy) with
  confirmOnEcho semantics (keep the user's dirty overlays unless the server
  echoed them); (b) dirty-only submit -- submit({patch:true}) posts
  toPatch(); (c) async validation -- a validateAsync seam per field with
  isValidating, last-write-wins on resolution, debounce delegated to
  lite-debounce, and the server-error signal pattern promoted from README
  prose to a tested recipe (or a tiny serverErrors helper if the ADR says
  the prose pattern is too footgun-prone -- decide, record, test either way).

ASSERTIONS
  - reinitialize under concurrent edits: fuzz interleavings of user set()
    and server reinitialize(); the mirror oracle agrees on every outcome;
    no zombie signals; pool flat.
  - Async validators: out-of-order resolutions cannot regress isValid
    (stale results dropped); isValidating true exactly while unsettled.
  - Double-submit surface re-examined with isValidating in the mix.

NON-GOALS
  No field arrays (S4). No transport, no fetch wrapper, no cache.

DONE WHEN
  the three flows are first-class, fuzz-proven, and allocation-gated
```

===============================================================================
# S4 -- lite-form v1.4.0 -- field arrays with preserved identity
===============================================================================

```markdown
---
package: "@zakkster/lite-form"
version_target: 1.4.0
status: planned
findings: [LF-08]
depends_on: [S2]
---

# lite-form -- rows that keep their fields

PURPOSE
  The README's declared future: add/remove/reorder rows with preserved field
  identity (values, touched, errors travel with the row, not the index).
  GATE at session start: if lite-map has landed on a STABLE lite-signal peer
  (not ^1.6.0-preview) and cleared its own version drift, build on
  mapArray(list, mapFn, {key}); otherwise ship a minimal internal keyed-row
  helper on the S2 engine (overlay keys become "rows.<rowKey>.field") and
  leave the lite-map adapter as a follow-up. Record the choice and its date.

ASSERTIONS
  - Reorder preserves per-row touched/error/dirty (identity fuzz vs mirror).
  - Add/remove churn at a cap: pool bounded, nodes returned, lite-leak clean.
  - Index-path forms from before S4 still behave identically (additive).

NON-GOALS
  No virtualization, no rendering. Whether it ships as core API or as
  @zakkster/lite-form-fields is decided in the session ADR -- the README
  promised the capability, not the package boundary.

DONE WHEN
  a 1,000-row form churns rows with preserved identity under the gate
```

---

## 7. How to run it

In order. `status: planned -> shipped` after each `/release`. Author BRIEF.md
in the package from the session block, then planner -> coder -> reviewer ->
qa, then `/release`. Reviewer REJECTED goes back to coder, not forward. Every
module change is proven by `node --expose-gc --preserve-symlinks
test/torture.mjs`. No gate output is a FAIL.

### If you only do a subset

1. **S0 then S1, always, in that order.** S0 because nothing can be trusted
   or even version-controlled without it; S1 because LF-01 is a live
   prototype-pollution vector reachable from `setValues(await res.json())`
   in a published package -- if you ship exactly one thing, ship the
   hostile-segment guard.
2. **S2 is the leverage headline.** One decision retires the whole
   clone-and-alias bug class, deletes the per-keystroke structuredClone, and
   gets commit/revert/toPatch/reconcile from a package that already proves
   them under its own gate.
3. **S3/S4 are the promises.** Server lifecycle before field arrays; both
   are additive on the S2 seam.

### The habit this roadmap is built around

Every finding in section 3 came from running the code. The suite passes 33/33
and every S1 lives outside what it tests: the pollution needs one hostile
key, the aliasing needs one in-place push, the zombie needs one lazy field
inside one effect -- each a five-line probe, none a test. The validation
algebra survived adversarial reading untouched; the state layer did not. The
reviewer question for every future lite-form diff is the LiteStore lesson
transposed: not "does the keystroke stay fast" but "would the gate fail if
the baseline aliased, if a segment descended the prototype chain, if a lazy
field's signals died with somebody else's effect". Until S0, the answer is
no such gate exists; after S1, the controls prove it.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
