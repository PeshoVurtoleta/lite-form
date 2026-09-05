/**
 * t9 -- controls. Every gate must be provably able to fail.
 *
 * Six deliberately-broken variants, each spawned as a CHILD torture process that
 * must exit non-zero AND name its own gate's reason in stderr (status != 0 alone
 * is not enough -- an unrelated early failure must not pass for "the right gate
 * caught the right breakage"). Two selection mechanisms:
 *
 *   FORM_TORTURE_BREAK -- runs ONLY the targeted tier (no recursive spawning):
 *     grow  -> t6 window (a) runs on a pool sized below the workload; the
 *              poolGrowths witness catches construction-time growth.
 *     alloc -> t6's measured hot body retains a fresh object per iteration; the
 *              transient-garbage witness rejects it.
 *     drop  -> t5's oracle skips its per-field verdict recompute after a set; the
 *              cached validity goes stale and isValid diverges.
 *     leak  -> t7 retains a field record; the lite-leak witness never reaches 0.
 *
 *   FORM_TORTURE_MODULE -- points every tier at a PATCHED copy of Form.js and
 *     runs normally (all tiers); the patched form reintroduces an S1 bug and the
 *     child must die at t1 with the matching marker:
 *     realias -> makeField seeding aliases the baseline (no copyLeaf); reset()
 *                cannot restore a mutated object leaf -> "t1 LF-02".
 *     reproto -> the construction-walk hostile-key check is disabled; a hostile
 *                own key is no longer rejected at createForm -> "t1 LF-03".
 *
 * A gate that cannot fail is decorative: if any child exits 0, this tier fails.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { check, die } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url)); // test/torture
const entry = join(here, "..", "torture.mjs");        // test/torture.mjs
const formSrc = join(here, "..", "..", "Form.js");    // the REAL Form.js

const CONTROLS = ["grow", "alloc", "drop", "leak", "realias", "reproto"];

const MARKERS = {
  grow: "the signal pool grew",
  alloc: "t6 alloc gate rejected",
  drop: "t5: oracle diverged",
  leak: "t7: leak witness sees",
  realias: "t1 LF-02",
  reproto: "t1 LF-03",
};

// Source-patch controls: an anchor that must occur EXACTLY once in Form.js and
// the reintroduced-bug replacement. If the anchor drifts, die loudly rather than
// silently patch nothing.
const PATCH = {
  realias: {
    anchor: "const seeded = copyLeaf(readBase(baseline, path, segs));",
    replacement: "const seeded = readBase(baseline, path, segs);",
  },
  reproto: {
    anchor: 'if (hostileSeg(k)) throwHostile(k, p ? p + "." + k : k);',
    replacement: 'if (false) throwHostile(k, p ? p + "." + k : k);',
  },
};

function spawnChild(env) {
  return spawnSync(
    process.execPath,
    ["--expose-gc", "--preserve-symlinks", entry],
    { env: { ...process.env, ...env }, encoding: "utf8" },
  );
}

function assertControl(name, res) {
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

export async function run() {
  for (let i = 0; i < CONTROLS.length; i++) {
    const name = CONTROLS[i];
    const patch = PATCH[name];
    if (patch) {
      const source = readFileSync(formSrc, "utf8");
      if (source.split(patch.anchor).length !== 2) {
        die("t9 " + name + ": patch anchor not found -- Form.js drifted, update the control");
      }
      // Write the patched copy INSIDE the package so its bare @zakkster/lite-signal
      // import still resolves (an OS temp dir cannot).
      const tmp = join(here, ".tmp-" + name + ".mjs");
      writeFileSync(tmp, source.replace(patch.anchor, patch.replacement), "utf8");
      let res;
      try {
        // FORM_TORTURE_MODULE selects the patched form; BLANK the BREAK so the
        // child runs every tier normally and must die at t1.
        res = spawnChild({ FORM_TORTURE_MODULE: pathToFileURL(tmp).href, FORM_TORTURE_BREAK: "" });
      } finally {
        // Unlink BEFORE the assertions: check() dies via process.exit, which
        // skips finally blocks, and a failing control must not strand the copy.
        unlinkSync(tmp);
      }
      assertControl(name, res);
    } else {
      const res = spawnChild({ FORM_TORTURE_BREAK: name });
      assertControl(name, res);
    }
  }
}
