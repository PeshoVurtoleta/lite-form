/**
 * @zakkster/lite-form -- torture gate.
 *
 * The DONE-WHEN of every session is a single command:
 *
 *     node --expose-gc --preserve-symlinks test/torture.mjs   -> prints "ok", exit 0
 *     npm run torture
 *
 * The fixed T0..T9 tier namespace, sparse -- the tiers this package needs now:
 *
 *     t0  identities + reveal truth table   t1  degenerate + registered-failing
 *     t2  scale (1000+ fields)              t5  differential fuzz vs an oracle
 *     t6  the zero-alloc gate + baselines   t7  soak + retention witnesses
 *     t9  controls (each gate, broken, must fail)
 *
 * lite-gc-profiler is one-measurement-at-a-time, so tiers run STRICTLY
 * SEQUENTIALLY -- never nested, never concurrent.
 *
 * PREFLIGHT: the two witness peers (lite-gc-profiler, lite-leak) are
 * devDependencies. A fresh clone that skipped `npm install` must fail loudly
 * (exit 2) with a remedy, not a raw ERR_MODULE_NOT_FOUND. Two more preflight
 * gates run before any tier: (a) three-place version sync -- Form.js's runtime
 * VERSION and its header comment must equal package.json's version, fail closed
 * (exit 2) on drift; (b) the fast-suite count (README.md/llms.txt's documented
 * "N deterministic tests") must equal harness.mjs's FAST_SUITE_COUNT.
 *
 * CONTROLS: with FORM_TORTURE_BREAK={grow|alloc|drop|leak} the run executes ONLY
 * the tier that break targets (no recursive spawning) and must exit non-zero; if
 * that tier's gate does NOT catch the breakage, reaching the end is itself a
 * failure (exit 1). A normal run executes every tier and t9 spawns the four
 * broken children, asserting each exits non-zero.
 *
 * @license MIT
 */

async function main() {
  // --- guard: the GC gate is meaningless without --expose-gc ----------------
  if (typeof globalThis.gc !== "function") {
    process.stderr.write(
      "torture: FAIL -- run with --expose-gc: " +
      "node --expose-gc --preserve-symlinks test/torture.mjs\n");
    process.exit(1);
  }

  // --- preflight: witness peers must be installed before any tier imports ----
  for (const pkg of ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]) {
    try {
      await import(pkg);
    } catch {
      process.stderr.write(
        "torture: FAIL -- missing devDependency " + pkg + " -- run: npm install\n");
      process.exit(2);
    }
  }

  const { SEED, BREAK, FAST_SUITE_COUNT } = await import("./torture/harness.mjs");
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url)); // test/

  // --- preflight: three-place version sync -----------------------------------
  // package.json is read as data (never imported as a module). Form.js's runtime
  // VERSION const AND its header comment (` * v1.0.1`) must both match.
  const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
  const { VERSION } = await import("../Form.js");
  const formSrc = readFileSync(join(here, "..", "Form.js"), "utf8");
  const headerRe = new RegExp("^\\s*\\*\\s*v" + pkg.version.replace(/\./g, "\\."), "m");
  if (typeof VERSION !== "string" || VERSION !== pkg.version || !headerRe.test(formSrc)) {
    process.stderr.write(
      "torture: FAIL -- VERSION drift: Form.js VERSION=" + JSON.stringify(VERSION) +
      ", header matches=" + headerRe.test(formSrc) +
      " !== package.json version=" + JSON.stringify(pkg.version) +
      " -- keep Form.js's VERSION const, its ` * v` header comment, and package.json in sync\n");
    process.exit(2);
  }

  // --- preflight: fast-suite count must match its recorded expectation -------
  // Global match: a doc must state its test count EXACTLY ONCE. Zero matches is
  // an unmeasurable claim; two matches is a drift hazard (one can go stale while
  // the other passes) -- both fail closed (exit 2).
  const DOC_COUNT_RE = /(\d+)\s+deterministic tests/g;
  const readmeText = readFileSync(join(here, "..", "README.md"), "utf8");
  const llmsText = readFileSync(join(here, "..", "llms.txt"), "utf8");
  const docChecks = [
    ["README.md", readmeText],
    ["llms.txt", llmsText],
  ];
  for (const [file, text] of docChecks) {
    const matches = [...text.matchAll(DOC_COUNT_RE)];
    if (matches.length !== 1) {
      process.stderr.write(
        "torture: FAIL -- " + file + " must state its fast-suite test count exactly " +
        "once (pattern " + DOC_COUNT_RE + "), found " + matches.length +
        " -- an unmeasurable or duplicated doc claim is a FAIL\n");
      process.exit(2);
    }
    const n = Number(matches[0][1]);
    if (n !== FAST_SUITE_COUNT) {
      process.stderr.write(
        "torture: FAIL -- " + file + " claims " + n + " test(s) but harness.mjs's " +
        "FAST_SUITE_COUNT is " + FAST_SUITE_COUNT + " -- update whichever one is stale\n");
      process.exit(2);
    }
  }

  const { run: t0 } = await import("./torture/t0-laws.mjs");
  const { run: t1 } = await import("./torture/t1-degenerate.mjs");
  const { run: t2 } = await import("./torture/t2-scale.mjs");
  const { run: t5 } = await import("./torture/t5-fuzz.mjs");
  const { run: t6 } = await import("./torture/t6-alloc.mjs");
  const { run: t7 } = await import("./torture/t7-soak.mjs");
  const { run: t9 } = await import("./torture/t9-controls.mjs");

  // --- control mode: run ONLY the targeted tier, never t9 --------------------
  if (BREAK) {
    const targeted = { grow: t6, alloc: t6, drop: t5, leak: t7 };
    const run = targeted[BREAK];
    if (run === undefined) {
      process.stderr.write("torture: FAIL -- unknown FORM_TORTURE_BREAK '" + BREAK + "'\n");
      process.exit(2);
    }
    try {
      await run();
    } catch (err) {
      // A thrown fault under a control still exits non-zero (fail-closed).
      process.stderr.write(
        "torture: FAIL -- control " + BREAK + " threw: " + (err && err.stack || err) + "\n");
      process.exit(1);
    }
    // Reaching here means the targeted gate did NOT catch its breakage.
    process.stderr.write(
      "torture: FAIL -- FORM_TORTURE_BREAK=" + BREAK + " was set but the gate still passed\n");
    process.exit(1);
  }

  // --- normal run: every tier in order --------------------------------------
  const TIERS = [
    ["t0 laws", t0],
    ["t1 degenerate", t1],
    ["t2 scale", t2],
    ["t5 fuzz", t5],
    ["t6 alloc", t6],
    ["t7 soak", t7],
    ["t9 controls", t9],
  ];

  for (const [name, run] of TIERS) {
    try {
      await run();
    } catch (err) {
      process.stderr.write(
        "torture: FAIL -- " + name + " threw: " + (err && err.stack || err) +
        "\n  replay: FORM_TORTURE_SEED=" + SEED +
        " node --expose-gc --preserve-symlinks test/torture.mjs\n");
      process.exit(1);
    }
  }

  process.stdout.write("ok\n");
  process.exit(0);
}

main();
