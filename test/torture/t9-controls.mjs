/**
 * t9 -- controls. Every gate must be provably able to fail.
 *
 * Four deliberately-broken variants, each spawned as a CHILD torture process
 * with FORM_TORTURE_BREAK set. A child with the break set runs ONLY the tier the
 * break targets (never t9 -- no recursive spawning) and must exit non-zero:
 *
 *   grow  -> t6 window (a) runs on a pool sized below the workload; the
 *            poolGrowths witness catches construction-time growth.
 *   alloc -> t6's measured hot body retains a Float64Array per iteration;
 *            arrayBuffers grows and runOpsGate rejects.
 *   drop  -> t5's oracle skips its per-field verdict recompute after a set; the
 *            cached validity goes stale and isValid diverges.
 *   leak  -> t7 retains a field record; the lite-leak witness never reaches 0.
 *
 * A gate that cannot fail is decorative: if any child exits 0, this tier fails
 * the whole run. status !== 0 alone is not enough -- each child's stderr must
 * also NAME its own gate's reason, so an unrelated early failure cannot pass for
 * "the right gate caught the right breakage".
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { check } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url)); // test/torture
const entry = join(here, "..", "torture.mjs");        // test/torture.mjs

const CONTROLS = ["grow", "alloc", "drop", "leak"];

const MARKERS = {
  grow: "the signal pool grew",
  alloc: "t6 alloc gate rejected",
  drop: "t5: oracle diverged",
  leak: "t7: leak witness sees",
};

export async function run() {
  for (let i = 0; i < CONTROLS.length; i++) {
    const name = CONTROLS[i];
    const res = spawnSync(
      process.execPath,
      ["--expose-gc", "--preserve-symlinks", entry],
      { env: { ...process.env, FORM_TORTURE_BREAK: name }, encoding: "utf8" },
    );
    const stderr = res.stderr || "";
    check(res.status !== 0,
      () => "t9 control '" + name + "' exited 0 -- a gate that cannot fail is decorative" +
        " (stdout=" + JSON.stringify((res.stdout || "").trim()) + ")");
    check(stderr.indexOf(MARKERS[name]) !== -1,
      () => "t9 control '" + name + "' exited " + res.status + " but its stderr did not name the " +
        "expected reason (" + JSON.stringify(MARKERS[name]) + ") -- it may have failed for an " +
        "unrelated cause instead of its own gate catching the breakage" +
        " (stderr=" + JSON.stringify(stderr.trim()) + ")");
  }
}
