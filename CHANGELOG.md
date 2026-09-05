# Changelog

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
