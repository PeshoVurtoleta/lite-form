---
package: "@zakkster/lite-form"
version_target: 1.0.2
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

Session S0 of ROADMAP.md, retargeted 1.0.1 -> 1.0.2: the 1.0.1 slot was
consumed by the out-of-band LF-01 hotfix (ROADMAP section 7 escape hatch,
published to npm 2026-09-05). Scope unchanged minus what the hotfix front-ran.

ALREADY DONE (do not redo)
  - git repo + baseline commits (2ffe70f, 14147b4, c32c1d6, 94c54dd)
  - CHANGELOG.md (1.0.0 back-entry + 1.0.1) shipped via files[]
  - VERSION export + Form.js header version line + Form.d.ts declaration
  - LF-01 FIXED and regression-tested (test/04-hostile-paths.test.js, 8
    tests; the fast suite is 41 tests total)

PURPOSE
  No gate, a bench that cannot fail, a fresh checkout that cannot run its own
  tests, non-ASCII source, an author field with no email, docs that mis-state
  reality. Stand the package up under the suite's law without changing any
  behaviour, and register the three remaining adversarial findings
  (LF-02/03/04) as reproduced, failing, on the books. LF-01's guard is proven
  as a passing witness.

TASKS
  - Wire node_modules symlinks: @zakkster/lite-leak -> ../../../LiteLeak and
    @zakkster/lite-gc-profiler -> ../../../LiteGCProfiler (NOTE the sibling
    dir spelling: "LiteGCProfiler", GC in caps). devDeps
    "@zakkster/lite-leak": "^1.10.0", "@zakkster/lite-gc-profiler": "^1.16.0"
    (both live on npm). Record the wiring convention in the README dev
    section.
  - Build test/torture.mjs + test/torture/ per ROADMAP section 4, template
    ../LiteStore/test/torture.mjs + ../LiteStore/test/torture/: harness spine
    (SEED + makePrng xorshift32 0-seed-guarded, check(cond, msgThunk), die,
    runOpsGate with RULES = { maxMajor: 0, maxPauseMs: 4,
    maxArrayBuffersGrowth: 0 }, stabilize: "deep", mirror(form) oracle),
    preflight (--expose-gc guard; witness devDeps dynamic-import check that
    exits 2 with a remedy; three-place VERSION sync package.json === Form.js
    VERSION === header; FAST_SUITE_COUNT === doc-claimed test count === 41),
    FORM_TORTURE_BREAK env-gated controls, entry prints exactly "ok", exit
    0/1, tiers strictly sequential (lite-gc-profiler is
    one-measurement-at-a-time).
    Tiers: t0-laws (create/values/reset/dispose identities, reveal-gate truth
    table), t1-degenerate (LF-01 hostile paths must THROW -- guard witness;
    LF-02 alias leaves / LF-03 non-cloneables / LF-04 zombie lazy fields
    registered as reproduced-FAILING, gate-neutral until S1 flips them),
    t2-scale (1k-field forms, deep dotted paths; construction and keystroke
    bounds), t5-fuzz (random op sequences set/blur/reset/setValues/submit vs
    a plain-JS mirror oracle: values()/isDirty()/isValid() always agree),
    t6-alloc (flat per-field keystroke gated at ZERO now; dotted + schema
    modes measured and recorded in-tier as the LF-06 S1/S2 baselines),
    t7-soak (create/dispose + keystroke churn over 4096 cycles, lite-leak
    witness, activeNodes conservation), t9-controls (a leaked field handle,
    an allocating keystroke, a dropped validator re-run, a "grow" registry
    under the gate -- each broken child must exit non-zero or the run fails).
    Measured tiers pre-grow createRegistry({ maxNodes, maxLinks,
    onCapacityExceeded: "throw" }); never grow inside a gate. Await a settle
    tick before reading GC summaries; lite-leak cleanups/tags never close
    over the tracked target.
  - Scripts: "torture": "node --expose-gc --preserve-symlinks
    test/torture.mjs"; "verify": "npm test && npm run torture" (bench leaves
    verify, stays reporting-only); "prepublishOnly": "npm run verify". Keep
    the test and bench scripts as-is.
  - Author email: "Zahary Shinikchiev <shinikchiev@yahoo.com>". ASCII pass
    over Form.js / Form.d.ts / bench (U+00D7 and U+00B5 excepted) --
    comment/doc bytes only, zero behaviour change.
  - Doc truth pass: verify lite-resource / lite-debounce existence on npm and
    fix whichever README claim is wrong (lite-resource DOES exist locally, in
    the misspelled dir LiteResourse); llms.txt "~240 lines" -> the real
    count; state the real fast-suite count (41) everywhere a count is
    claimed, gated by the preflight.

ASSERTIONS
  - npm test 41/41 green on a FRESH clone after the documented wiring step.
  - npm run torture prints exactly "ok", exit 0; every t9 control exits
    non-zero for its named reason.
  - t1: LF-01 hostile path THROWS (guard witnessed); LF-02/03/04 each
    reproduce as registered-failing.
  - t6: flat per-field keystroke at 0 alloc (profiler + stats() witness);
    dotted and schema modes' measured costs recorded in the tier as the
    S1/S2 improvement baselines.
  - t7: activeNodes conservation + lite-leak clean over 4096 cycles (the
    README pool-clean claim, now witnessed).
  - npm pack --dry-run ships Form.js / Form.d.ts / README.md / llms.txt /
    CHANGELOG.md / LICENSE.txt and excludes test/ bench/ demo/ ROADMAP*.md
    BRIEF.md.

NON-GOALS
  No behaviour change. No fix to LF-02/03/04 (S1). No engine work (S2). No
  peer floor bump (S1).

DONE WHEN
  the package sits under the suite gate, docs and version are honest, the
  three remaining findings are registered as failing, and /release 1.0.2
  passes end-to-end.
