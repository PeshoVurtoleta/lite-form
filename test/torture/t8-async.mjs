/**
 * t8 -- async ordering torture (LF-09). A deterministic deferred scheduler with
 * NO wall clock: settlements drain over awaited microtask turns. Seeded
 * resolution-order shuffles over N (>= 3) in-flight validations per round prove
 * the ordering law:
 *   - only the LATEST settlement lands;
 *   - a stale settlement leaves NO trace -- a subscribe-recorder over the window
 *     catches any flash of a poison message the guard should have dropped;
 *   - isValidating flips false exactly at the latest settle, even after rapid
 *     re-triggers (two triggers, one latest settle -> false, no stuck counter);
 *   - a stale rejection is swallowed whole (an unhandledRejection watcher stays
 *     empty) and never surfaces.
 *
 * This tier runs BEFORE t9 on purpose: t9's staleseq control patches Form.js to
 * disable the settlement-callback seq guard and runs the full tier list with the
 * break env blanked, so a stale settlement lands and this tier must die HERE with
 * exactly "t8 LF-09 stale settlement landed" before t9 would recursively spawn.
 */

import { SEED, check, die, loadForm, makePrng } from "./harness.mjs";

const ROUNDS = 32;
const N = 4; // in-flight validations per round (>= 3)

// Microtask drain: no wall clock, only awaited resolved promises. The settlement
// path is Promise.resolve(p).then(...), so a handful of turns flushes every
// attached callback deterministically.
async function drain() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

// A validator whose every call parks a deferred in `q` (push order). Resolve or
// reject q[i] by hand to control settlement order -- deterministic, no timer.
function deferredLane() {
  const q = [];
  const validator = (value) => new Promise((resolve, reject) => q.push({ value, resolve, reject }));
  return { validator, q };
}

// Seeded Fisher-Yates over an index array.
function shuffle(arr, prng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = prng() % (i + 1);
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

export async function run() {
  const { createForm } = await loadForm();
  const prng = makePrng(SEED);

  // --- core: out-of-order settlement, latest-wins, no stale trace ------------
  for (let r = 0; r < ROUNDS; r++) {
    const { validator, q } = deferredLane();
    const f = createForm({ initialValues: { x: 0 }, validatorsAsync: { x: validator } });
    await drain();
    q[0].resolve(null);                                  // clear the construction-time validation
    await drain();
    check(f.isValidating() === false,
      () => "t8: isValidating stuck true after the construction settle (round " + r + ")");

    for (let k = 1; k <= N; k++) f.field("x").set(k * 7 + r); // q[1..N]; q[N] is the LATEST
    check(f.isValidating() === true,
      () => "t8: isValidating not true while N validations are in flight (round " + r + ")");

    const rec = [];
    const stop = f.field("x").error.subscribe((e) => rec.push(e)); // starts [null], dirty reveals the lane

    // Settle in a seeded shuffled order: the latest resolves CLEAN (null), the
    // stale ones resolve a POISON message that the seq guard must drop whole.
    const order = [];
    for (let k = 1; k <= N; k++) order.push(k);
    shuffle(order, prng);
    for (let idx = 0; idx < order.length; idx++) {
      const k = order[idx];
      if (k === N) q[k].resolve(null);
      else q[k].resolve("poison-" + k);
      await drain();
    }

    // Only the latest landed: no poison ever flashed in the recorder window, and
    // the final verdict is the latest null. A non-null anywhere == guard failed.
    for (let j = 0; j < rec.length; j++) {
      if (rec[j] != null) {
        die("t8 LF-09 stale settlement landed -- a stale verdict flashed " +
          JSON.stringify(rec[j]) + " (round " + r + " seed " + SEED + ")");
      }
    }
    if (f.field("x").error.peek() != null) {
      die("t8 LF-09 stale settlement landed -- final error " +
        JSON.stringify(f.field("x").error.peek()) + " is not the latest null verdict (round " + r + ")");
    }
    check(f.isValidating() === false,
      () => "t8: isValidating stuck true after the latest settle (round " + r + ")");

    stop();
    f.dispose();
  }

  // --- real latest error surfaces (latest is a rejection/error, stale clean) --
  for (let r = 0; r < ROUNDS; r++) {
    const { validator, q } = deferredLane();
    const f = createForm({ initialValues: { x: 0 }, validatorsAsync: { x: validator } });
    await drain();
    q[0].resolve(null);
    await drain();

    for (let k = 1; k <= N; k++) f.field("x").set(k + r);   // q[1..N]
    const order = [];
    for (let k = 1; k <= N; k++) order.push(k);
    shuffle(order, prng);
    for (let idx = 0; idx < order.length; idx++) {
      const k = order[idx];
      if (k === N) q[k].resolve("real-latest");             // latest: a real error
      else q[k].resolve(null);                              // stale: clean -- must be dropped
      await drain();
    }
    check(f.field("x").error.peek() === "real-latest",
      () => "t8: the latest real error did not surface (round " + r + ")");
    check(f.isValid() === false,
      () => "t8: a real latest error left the form valid (round " + r + ")");
    check(f.isValidating() === false,
      () => "t8: isValidating stuck true after a real latest error (round " + r + ")");
    f.dispose();
  }

  // --- rapid re-triggers: one latest settle returns isValidating to false -----
  for (let r = 0; r < 16; r++) {
    const { validator, q } = deferredLane();
    const f = createForm({ initialValues: { x: 0 }, validatorsAsync: { x: validator } });
    await drain();
    q[0].resolve(null);
    await drain();

    f.field("x").set(1);                                    // q[1]: false->true (count 1)
    f.field("x").set(2);                                    // q[2]: already pending -> seq bump only
    check(f.isValidating() === true,
      () => "t8: isValidating not true after rapid re-triggers (round " + r + ")");
    q[1].resolve("stale");                                  // stale: dropped, NO decrement
    await drain();
    check(f.isValidating() === true,
      () => "t8: a stale settle decremented the pending counter (round " + r + ")");
    q[2].resolve(null);                                    // latest: single decrement
    await drain();
    check(f.isValidating() === false,
      () => "t8: stuck pending counter after rapid re-triggers (round " + r + ")");
    f.dispose();
  }

  // --- a stale rejection is swallowed whole, no unhandledRejection ------------
  {
    const seen = [];
    const onUnhandled = (reason) => seen.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      for (let r = 0; r < 16; r++) {
        const { validator, q } = deferredLane();
        const f = createForm({ initialValues: { x: 0 }, validatorsAsync: { x: validator } });
        await drain();
        q[0].resolve(null);
        await drain();

        f.field("x").set(1);                               // q[1]
        f.field("x").set(2);                               // q[2] latest
        const rec = [];
        const stop = f.field("x").error.subscribe((e) => rec.push(e));
        q[1].reject(new Error("stale boom"));              // stale rejection -> dropped
        await drain();
        q[2].resolve(null);                                // latest ok
        await drain();
        for (let j = 0; j < rec.length; j++) {
          if (rec[j] != null) {
            die("t8 LF-09 stale settlement landed -- a stale rejection flashed " +
              JSON.stringify(rec[j]) + " (round " + r + ")");
          }
        }
        check(f.field("x").error.peek() == null,
          () => "t8: a stale rejection left a trace (round " + r + ")");
        stop();
        f.dispose();
      }
      await drain();
      await drain();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    check(seen.length === 0,
      () => "t8: a stale rejection surfaced as unhandledRejection (" + seen.length + " seen)");
  }
}
