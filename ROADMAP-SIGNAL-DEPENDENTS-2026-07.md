# lite-signal Hard-Dependents Program — REWORKED (July 2026)

**Status change:** the build phase largely happened. Eight packages shipped: `lite-store`, `lite-clock`, `lite-time`, `lite-persist`, `lite-router`, `lite-form`, `lite-undo`, `lite-spring`. But the dependency audit shows the program's stated mechanism is **not yet in place**: only **lite-router** hard-depends on lite-signal. Everything else declares it as a peer, ranges are scattered across five different values, and one range is broken. The remaining work is therefore two campaigns: **the flip** (peer → `dependencies`, uniform range) and **the level-ups** on the shipped set — plus four packages still to build, born hard-dep from day one.

---

## Dependency audit (ground truth, fetched from package.json)

| Package | Version | signal field | Range | Verdict |
|---|---|---|---|---|
| lite-router | 1.0.0 | **dependencies** | `^1.1.2` | ✅ Already flipped — the reference implementation |
| lite-store | 1.0.0 | peer | `^1.1.3` | Flip + normalize |
| lite-form | 1.0.0 | peer | `^1.1.3` | Flip + normalize |
| lite-time | 1.1.0 | peer | `^1.1.3` | Flip + normalize |
| lite-persist | 1.1.0 | peer | `^1.1.5` | Flip + normalize (already hard-deps `lite-debounce` — proof the compounding mechanism is live) |
| lite-clock | 1.0.0 | peer | `^1.2.2` | Flip + normalize |
| lite-undo | 1.0.0 | peer | `>=1.5.0-alpha` | **Broken range — fix first** (see below) |
| lite-spring | 1.x | — (hard-deps lite-lerp only) | n/a | Not a signal dependent by design — stays as-is |

**The lite-undo range problem:** `>=1.5.0-alpha` excludes 1.4.0 stable (due today) and is unbounded above — it would accept a hypothetical 2.0.0 breaking release. Either verify undo against 1.4.0 and widen to the uniform range, or hold it on the 1.5 line with an explicit `>=1.5.0-alpha <2` until 1.5.0 goes stable. Decide per what 1.5-only API undo actually uses (likely owner/cursor APIs); if 1.4.0 has them, normalize.

---

## Campaign 1 — Step Zero + the flip

### Step Zero — lite-signal 1.4.1: single-graph guard
Unchanged from the original program and now *more* urgent, because flipping seven packages multiplies duplicate-copy surface. Ship `assertSingleGraph()` using `globalThis[Symbol.for('zakkster.lite-signal.graph')]` — first copy registers, second copy warns with both versions. Add the "Dependent ecosystem contract" section (range policy) to signal's README.

### Step One — the flip (one patch release per package, one session total)
For each of store, form, time, persist, clock (+ undo after its range decision):
1. Move `@zakkster/lite-signal` from `peerDependencies` to `dependencies`.
2. Normalize the range to **`^1.4.0`** — verbatim identical across all packages (this is what lets npm dedupe to one hoisted copy; it also matches 1.5+, 1.9+ when they go stable).
3. Update the README badge — the shields.io `dependency-version/.../peer/...` badge URL breaks on flip; switch to the non-peer variant.
4. Add `assertSingleGraph()` call in dev path.
5. Publish as patch: store 1.0.1, form 1.0.1, time 1.1.1, persist 1.1.1, clock 1.0.1, undo 1.0.1.

**Why the flip still matters given npm ≥7 auto-installs peers:** (a) the npm dependents graph counts `dependencies` — peer-only dependents don't reliably appear; (b) pnpm and yarn do *not* auto-install peers, so hard deps guarantee the co-install across all package managers; (c) no peer-warning UX for consumers. The download compounding works either way; the graph visibility and cross-PM guarantee only work with the flip.

**The dual-copy hazard mitigations (non-negotiable, unchanged):** uniform `^1.4.0` everywhere + CI grep for range drift; Step Zero runtime guard; every package usable via callback/getter APIs so a pathological duplicate degrades instead of silently not tracking.

**lockstep liability:** with 7+ hard dependents on `^1.4.0`, a semver break inside 1.x forces a seven-package range-bump release train. The rebuilt 1.9–1.12 line's hash-parity and bench gates are now protecting eight packages, not one.

---

## Campaign 2 — level-ups on the shipped set

### lite-store (1.0.0) — fine-grained proxy store
Shipped: lazy per-key signals, direct mutation, stable proxy identity, cycle-safe disposal, four exports.
- **v1.1.0 — `reconcile(target, data, { key })`:** keyed diffing for server-payload swaps — preserve proxy identity, fire only the paths that actually changed. This is the feature that makes a proxy store viable for data apps, and the natural lite-query integration point.
- **v1.2.0 — persistence bridge:** `persistPath(s, 'user.settings', storageKey)` joint feature with lite-persist v1.2 (path-granular persistence, one debounced writer per path). Plus `onPath(s, path, cb)` subscription utility for non-reactive consumers.
- **v1.3.0 — SPP devtools probe:** stream path-write events to lite-scope; the store becomes inspectable next to profiler/leak telemetry.
- Gates: proxy-identity invariants; lazy-allocation proof (reads outside reactive contexts allocate zero signals — `signalCount`-style counter).

### lite-clock (1.0.0) — SoA lane engine
Shipped: TypedArray lane pool, deterministic `advance(dt)`, one force-propagated frame signal, `attachRAF`, 10K lanes per one signal write.
- **v1.1.0 — lane shaping:** per-lane easing via lite-ease LUT (hard-dep lite-ease → each install bumps two scores), repeat/yoyo/loop flags in the lane SoA, stagger helper for lane groups.
- **v1.2.0 — sequencing:** lane chaining (`after(lane)`), timeline groups; visibility auto-pause on the rAF driver.
- **v1.3.0 — spring lanes:** spring dynamics as a lane type inside the SoA pool (integration or port of lite-spring math) — springs and tweens in one pool, one frame signal.
- Gates: 10K-lane one-write-per-tick invariant re-proven per version; determinism replay test (`advance` sequence → identical lane states).

### lite-time (1.1.0) — drift-corrected wall-clock cadence
Shipped: `relativeTime`, `countdown`, `every`, one 1s heartbeat, injectable clock, 16 B/tick at 100 cells headline.
- **v1.2.0 — boundary signals:** `today()` / day-week-month rollover signals (drift-corrected midnight, DST-safe), `duration()` elapsed-formatter cells.
- **v1.3.0 — authority injection:** server-offset sync (shared time authority with lite-room), documented + tested visibility catch-up semantics (tab sleeps 3h → one beat, correct display, no 10,800 catch-up ticks).
- Gates: the 16 B/tick and 3.4×/180× headlines re-proven per version; DST-boundary test matrix.

### lite-persist (1.1.0) — debounced reactive storage
Shipped: one-line signal↔localStorage binding, quiet-window write collapse, cross-tab sync, 100k-mutations→1-write benchmark, hard-dep lite-debounce.
- **v1.2.0 — async driver seam:** IndexedDB driver behind the same API with a hydration-status signal; `flush()` wired to `pagehide`/`freeze` if not already; TTL entries.
- **v1.3.0 — versioned codecs:** schema-version + migration hook; the lite-store path binding (joint with store v1.2).
- Gates: write-coalescing invariant (burst → exactly 1 write) per version; cross-tab echo-loop prevention test.

### lite-router (1.0.0) — surgical URL signals *(already hard-dep — reference implementation)*
Shipped: per-param/per-route signals, `interceptLinks`, ~0 B/navigation, 16× fewer downstream re-renders.
- **v1.1.0 — navigation control:** blockers (`beforeLeave` confirm), scroll restoration.
- **v1.2.0 — structure:** nested routes/outlet helper, link-hover prefetch hook (the lite-query loader seam).
- **v1.3.0 — typed routes:** TS template-literal param types (`route('/users/:id')` → `{ id: string }` inferred).
- Gates: ~0 B/navigation invariant; match ops/s bench (500k two-param baseline) per version.

### lite-form (1.0.0) — headless reactive forms
Shipped: one-validator-per-keystroke on 100-field forms, two validation pipelines, cross-field validation, ~1 byte retained per form lifecycle.
- **v1.1.0 — field arrays:** dynamic rows with keyed identity (the feature that decides whether real apps can adopt it); multi-step/wizard state.
- **v1.2.0 — schema seam:** standard-schema adapter (zod/valibot interop with zero added deps); dirty-diff submit (send changed fields only).
- **v1.3.0 — undo integration:** form history via lite-undo transactions (recipe + adapter).
- Gates: one-validator-per-keystroke invariant; pool return-to-baseline (`stats().activeNodes === 0`) per version.

### lite-undo (1.0.0) — transactional undo on lite-project
Shipped: commit-as-transaction over projection overlays, bounded history, free preview of historical states.
- **Immediate:** the peer-range fix (see audit) — this precedes everything.
- **v1.1.0 — coalescing + labels:** typing-burst coalescing window (N commits within `coalesceMs` merge into one transaction); labeled commits (`commit('Rename layer')`) for history-panel UIs.
- **v1.2.0 — persistent history:** serialize the transaction ring via lite-persist codec; restore across sessions.
- **v2.0 exploration:** branch history (tree undo) — park until a real editor consumer (gradient-studio "Tiles") demands it.
- Gates: bounded-ring reuse proof (capacity exceeded → zero new allocation); preview-doesn't-move-cursor invariant.

### lite-spring (1.x) — stays signal-free by design
Its identity is the framework-free SoA spring pool; forcing signal into it would dilute both the pitch and the <1.5KB budget. Level-ups on its own track: vec2/vec3 pools, auto-sleep flags (settled springs skip integration). The signal story is an optional adapter — see Bench.

---

## Campaign 3 — still to build (born hard-dep, `^1.4.0` from day one)

The four survivors of the original ten, unchanged in scope, now with the flip lesson baked in:
1. **lite-pointer** — reactive pointer state, ring-buffer velocity, fixed multi-touch slots; v1.1 gesture layer (drag/pinch/swipe).
2. **lite-keys** — bitset `isDown`, combos, `axis2` WASD vector; v1.1 sequences + record/replay; v1.2 rebindable action maps (persist via lite-persist).
3. **lite-media** — shared-registry `matchMedia` signals, `prefersReducedMotion`/`prefersDark`/`pointerCoarse`, breakpoints; v1.1 online/visibility/color-gamut (`p3Supported` feeds the wide-gamut story).
4. **lite-viewport** — one-observer-many-signals `inView`/`elementSize`, rAF-sampled scroll signals; v1.2 virtual-list measurement for lite-table.

## Bench (on demand)
- **lite-spring-signal** — micro-adapter: `springSignal(initial, preset)` driven by a shared lite-clock lane; hard-deps signal + spring + clock (triple bump per install).
- **lite-idle**, **lite-head**, **lite-i18n** — unchanged from the original bench.

---

## Sequencing

1. **lite-signal 1.4.0 stable** (today) → **1.4.1 with `assertSingleGraph()`**.
2. **lite-undo range fix** — broken range ships to every installer until fixed.
3. **The flip session** — six patch releases in one sitting, plus the CI range-grep script.
4. Level-ups by consumer pull: store `reconcile` (unlocks data apps) → persist async driver + store bridge → clock lane shaping → form field arrays → router blockers → time boundaries → undo coalescing.
5. Campaign 3 builds slotted into gaps: pointer → keys → media → viewport.
6. **Verify the mechanism:** two weeks after the flip, check signal's npm dependents tab and weekly downloads; the dependents count should now reflect all seven, and the download curve should begin tracking the sum of dependents' curves.

---

*Program reworked July 2026 against fetched package.json ground truth. Copyright Zahary Shinikchiev.*
