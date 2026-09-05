---
package: "@zakkster/lite-form"
version_target: 1.1.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_budget: "<= 16384 B total per 50k-op keystroke window (flat AND dotted gated at zero; schema re-recorded)"
leak_cycles: 4096
peers: ["@zakkster/lite-signal ^1.5.0"]
dev: ["@zakkster/lite-signal ^1.5.0", "@zakkster/lite-gc-profiler ^1.16.0", "@zakkster/lite-leak ^1.10.0"]
findings: [LF-02, LF-03, LF-04, LF-06a]
depends_on: ["S0 (shipped 2026-09-05 as v1.0.2)"]
blocks: [S2]
---

# lite-form -- fail closed (S1)

Session S1 of ROADMAP.md (section 6/S1). Minor bump 1.0.2 -> 1.1.0: every
behaviour change is fail-open -> fail-closed. The public API gains nothing;
inputs that silently half-worked now throw at the boundary, earlier.

ALREADY DONE (do not redo)
  - S0 gate: test/torture.mjs entry (4 preflights, FORM_TORTURE_BREAK
    dispatch) + tiers t0/t1/t2/t5/t6/t7/t9 + harness with the new-space
    allocTotal witness. All green at v1.0.2.
  - LF-01 fixed and enforced (t1 asserts the throw); 41-test fast suite.
  - t1 carries LF-02/03/04 as REGISTERED-FAILING with "S1 flips this check"
    comments -- those comments mark the exact sites this session flips.
  - lite-signal 1.5.0 verified on npm AND local: Registry.createRoot /
    getOwner / runWithOwner / isTracking (Signal.d.ts:280-336) plus
    top-level twins bound to the default registry. createRoot(fn: () => T)
    has NO dispose parameter -- roots are detachment-only; per-node disposal
    stays with form.dispose().

PINNED DECISIONS (write them to decisions/0001-fail-closed.md BEFORE coding;
settled -- do not re-litigate, implement exactly)
  1. LF-02: the baseline is UNREACHABLE, not merely detached. Deep-copy
     initialValues once at createForm into a private baseline; copy object
     leaves AGAIN at field seed, at reset(), and at values()/readValues()
     materialization. No caller-reachable reference is ever a baseline leaf.
     Every copy is construction/reset/snapshot-time; the keystroke path
     allocates nothing new. The caller's object is never read again after
     createForm returns.
  2. Dirty stays a reference compare, against the field's captured pristine
     reference: each field records initialRef = its seed copy, re-captured
     on reset(); dirty = !Object.is(value(), initialRef). NEVER by walking
     the baseline tree per recompute -- that kills the LF-06a per-keystroke
     path.split AND keeps object-leaf fields pristine at construction
     (Object.is(seedCopy, baselineCopy) would be false; comparing against
     initialRef is what makes the double-copy design correct). Document the
     contract: in-place mutation does not flip dirty; set-with-new-reference
     is the API -- now harmless instead of corrupting.
  3. LF-03: validate where the config is supplied. ONE construction-time
     walk does three jobs: copy, cloneability-validate, hostile-own-key
     reject. Any own key named __proto__ / constructor / prototype anywhere
     in initialValues throws TypeError immediately -- including the
     empty-object case ({"__proto__": {}} from JSON.parse) that forms no
     leaf path and slipped the 1.0.1 guard. structuredClone is DELETED from
     Form.js entirely: values()/readValues() materialize via the package's
     own walk (private baseline + field peeks, object leaves copied out).
  4. Copyable-leaf whitelist, fail closed: primitives, arrays, Date, and
     plain objects (as branches) are supported config material; any other
     leaf in createForm config (function, Map, Set, TypedArray, RegExp,
     class instance, symbol, ...) throws TypeError at createForm with the
     offending path in the message. RUNTIME field values stay unchecked at
     set() (zero-cost keystroke law wins; any value is fine reactively);
     the snapshot walk (values()/readValues()) throws a path-precise
     TypeError when it meets an uncopyable leaf -- replacing the old
     late DataCloneError with a typed, named-path error at the same
     boundary. Document both halves. Every type that moves from
     works-by-accident to throws is named in the CHANGELOG.
  5. LF-04: keep the lazy feature, kill the hazard. getField, when an
     undeclared path must allocate under a live tracking context
     (registry.isTracking()), creates the field's signals inside
     registry.createRoot() so a re-running effect cannot dispose them.
     Registry-scoped forms use the form's OWN registry surface, never the
     top-level default-bound functions. Record why not "throw": the README
     documents lazy variable-shape forms as a feature.
  6. Peer floor ^1.5.0 in BOTH peerDependencies and devDependencies. Fold
     the carried July peer-vs-hard-dep question into the same ADR, verdict:
     stays a peer -- assertSingleGraph() (the flip's stated precondition) is
     still unshipped in LiteSignal, and the suite convention is peers. Cite
     and refute the July rationale (dependents-graph visibility, co-install)
     explicitly so the decision is on the record, not just the outcome.

TASKS
  - decisions/0001-fail-closed.md (new dir; files[] is a whitelist so it
    cannot ship -- assert that in pack).
  - Form.js: the construction walk (iterative, explicit stack, zero deps);
    private baseline; seed/reset/values copies; initialRef dirty compare;
    cached per-field path-segment arrays (split ONCE at makeField; every
    per-field walk uses the array); values()/readValues() materialization
    without structuredClone; the LF-04 isTracking/createRoot guard in
    getField. Header rationale for eager allocation is now stale (it cites
    the lazy hazard and lite-signal 1.2.0) -- rewrite it truthfully.
  - Form.d.ts: no API surface change; update doc comments that describe the
    old fail-open behaviours (values() clone note, lazy-field hazard note).
  - Fast suite: new regression tests for every flip (LF-02 trio: caller
    identity untouched + reset pristine after in-place edit + post-construction
    mutation of the caller's object does not affect the form; LF-03
    construction throws incl. the whitelist types and empty-__proto__;
    LF-04 effect-survival; snapshot TypeError contract). Existing tests that
    pin old fail-open behaviour get updated DELIBERATELY, each named in the
    CHANGELOG. FAST_SUITE_COUNT + README + llms.txt counts move together
    (the preflight exits 2 otherwise).
  - t1: flip the three REGISTERED-FAILING checks to enforced assertions of
    the fixed behaviour; LF-01 check unchanged; add the empty-__proto__ and
    whitelist-throw checks.
  - t6: dotted window becomes a GATE at the same fixed total budget
    (<= 16384 B per 50,000 ops, allocTotal witness); flat window unchanged;
    schema window re-recorded (the 27,181.120 B/op baseline falls once
    structuredClone is gone) with a re-pinned ceiling; keep the 50-op
    schema window sizing discipline (window must fit the ~2 MB semispace)
    and the stderr baseline line format.
  - t7: add lazy-field-inside-effect churn (create undeclared fields under
    a re-running registry effect, re-trigger, dispose the form; activeNodes
    conservation + lite-leak witness stay clean).
  - t9: two new controls, realias and reproto. Mechanism: tiers import
    Form.js through an env indirection (FORM_TORTURE_MODULE, default
    ../../Form.js); each control reads Form.js source, applies a TARGETED
    string replacement (realias: neuter the seed copy to identity; reproto:
    neuter the hostile-segment throw), writes the patched copy to a temp
    file, spawns the gate entry with FORM_TORTURE_MODULE pointing at it,
    and asserts non-zero exit AND the t1 marker in stderr. If a patch
    anchor is not found in Form.js source, the control DIES loudly
    ("patch anchor not found -- Form.js drifted, update the control") --
    a control that silently patches nothing is fail-open.
  - package.json: peerDependencies AND devDependencies lite-signal ^1.5.0.
  - Docs: peer-floor sites (README, llms.txt line 10); new invariants
    documented (unreachable baseline, construction validation, whitelist +
    snapshot TypeError, Object.is dirty contract, lazy fields now safe);
    Testing counts; zero-GC design notes table (dotted now gated 0, schema
    re-recorded); CHANGELOG gains an Unreleased head (Added/Changed/Fixed,
    /release renames it); docs-wide ASCII sweep over README.md + llms.txt
    FULL files (S0 only cleaned touched lines; U+00D7 and U+00B5 excepted,
    e.g. llms.txt's (c) symbol on the license line).
  - Version stays 1.0.2 in all three places during the session; /release
    1.1.0 performs the bump (three-place preflight enforces).

DECISION POINTS FOR PLANNER (resolve by reading code, report evidence)
  - Cycle policy for the construction walk. Recommended: a revisited object
    throws TypeError at createForm (structuredClone accepted cycles; if the
    existing leaf-collection already hangs or throws on branch cycles, only
    leaf-internal cycles change behaviour -- verify which and name the
    change in the CHANGELOG).
  - ctx.get(path) audit: does the validator hot path split the path string
    per run? If yes, route it through the fields Map / cached segments.
  - The exact list of existing fast tests that pin old fail-open behaviour.
  - The exact patch anchors for realias/reproto and whether the env-module
    indirection lands in every tier or only where imports happen once.
  - t5 mirror-oracle parity with the new dirty/copy contracts.
  - t2 construction-cost note: the copy walk adds construction-time
    allocation; confirm no t2/t7 bound depends on the old construction
    cost.

ASSERTIONS
  - The three findings' probes flip: in-place edits through field.value()
    never corrupt the caller's object nor reset(); mutating the caller's
    initialValues AFTER createForm does not affect the form; object-leaf
    fields are NOT dirty at construction; createForm({initialValues:
    {cb: () => {}}}) throws TypeError at construction; the effect-created
    lazy field survives effect re-runs, reads back its value, set() works,
    activeNodes stable; {"__proto__": {}} initialValues throws.
  - grep structuredClone Form.js -> 0 hits. No path.split reachable from a
    keystroke (dirty is a ref compare; ctx.get audited; per-field walks use
    cached segments).
  - npm test green on the updated suite; every deliberately-updated test
    named in the CHANGELOG; counts synced in three places.
  - npm run torture prints exactly "ok", exit 0. t6 flat AND dotted windows
    each <= 16384 B total per 50k ops; schema baseline re-recorded below
    27,181.120 B/op with a re-pinned ceiling.
  - SIX t9 controls (grow, alloc, drop, leak, realias, reproto) each exit
    non-zero with their named marker; missing patch anchors die loudly.
  - npm pack --dry-run: the same 7 files as 1.0.2; decisions/ absent.
  - Repo-wide ASCII grep clean including FULL README.md and llms.txt
    (U+00D7, U+00B5 excepted).
  - peerDependencies and devDependencies floors read ^1.5.0; the fresh-clone
    drill (symlink wiring per README) still runs suite + gate green.

NON-GOALS
  No engine swap, no commit/toPatch/reinitialize (S2). No async validation
  (S3). No field arrays (S4). No new public API beyond earlier throws. No
  set()-time deep validation (the snapshot boundary is the pinned door).
  Bench untouched.

DONE WHEN
  every unverified state fails closed; t1 is enforced; flat AND dotted
  keystrokes are gated at zero; the peer floor is ^1.5.0; the ADR exists;
  docs are truthful and ASCII-clean; reviewer APPROVED; qa PASS; ready for
  /release 1.1.0.
