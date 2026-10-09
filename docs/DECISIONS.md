# Decisions

This file records why things are the way they are: tradeoffs, rejected alternatives and user directives that the code alone can't show. Newest entries go at the top. Each entry is one decision.

## 2026-10-09 — Machinery: crushers and rideable movers

- **Machines are kinematic pixel bodies** made of new indestructible materials: PISTON steel and hazard STRIPE. They shove anything in the way, glow under the cutter but never cut, and report their velocity. So friction carries loose cargo, and a clamp (fixed joint) rides along: tested, the ship traveled exactly with the mover (8.64 m vs 8.64 m).
- **Crushers** slam on a cycle: rest 45%, ease-in slam 8%, hold 15%, linear retract 32%, with a random phase per crusher. A visual shaft runs from the wall housing to the ram.
- **Movers** shuttle along a 2-point path with eased ends and 1.5 s pauses.
- **Crushing = a contact force from a machine above 400 kN on the ship:** instant death, with the "CRUSHED" banner. A glancing knock is still ordinary impact damage. Pinned against a wall, the force is far above the threshold. Tested by parking the ship at the end of a ram's stroke while it's retracted; it was crushed within one cycle.
- **The ship records `deathCause`** for the banner and for tests.

## 2026-10-09 — Generated dungeon derelict (hybrid generator) + minimap

User choices: a hybrid generator, about 4× size, deep core extraction as the goal, and every alarm response (implemented in later phases).

- **Slot grid:** 13 × 6 slots of 256 cells (32 m). Rooms are carved from a solid hull. The bulk between rooms is plate with an indestructible 16 m girder lattice, so cutting shortcuts is possible but routed by girders, and everything stays anchored.
- **Graph = spine + branches + loops.** A plain random tree of about 25 rooms bunched into the left half of the hull, even when biased forward, and the deepest room ended up spatially close to the entry. A spine walk from the entry to the far end (forward, with 35% vertical jogs), short 1–3-room side branches, and about 14% extra loops gives a dungeon that spans the ship, with the vault (deepest by BFS) at the far end.
- **Room templates** (`rooms.ts`): entry, vault, cargo, fuel, crew (pressurized, doorways plugged), machinery, crusher, moverHall (one merged 2-slot hall), droneBay, security. Templates paint terrain and register bodies, plus entity markers (crusher, mover, securityBot, turret, droneBay) for later phases to bring to life. Doorways are recorded as `DoorSpec`s for alarm sealing.
- **Loose bodies only spawn into free space**, retrying random spots in the room. Bodies spawned overlapping walls got violent depenetration kicks, and explosive barrels detonated on load (22 explosions in 5 s).
- **Bug class fixed at the source:** `PixelGrid.set` now floors its coordinates. A template passing y = n + 0.5 shifted the flat index by half a row: 2048 cells sideways in a 4096-wide grid, which painted the vault's cage 256 m away in solid bulk.
- **Minimap with fog of war:** 16 cells per pixel, a 34 m reveal radius, redrawn at 4 Hz.

## 2026-10-09 — Scale-up groundwork for the dungeon ship

The world is now 4096 × 2048 cells (512 × 256 m), 8× the area of the first level. This was the user's "about 4× per side" choice, ahead of the generated derelict.

- **Tiled pixel rendering (`PixelView`):** grids are drawn as 256² tiles, each with its own texture. A cut re-uploads only the tiles it touched, and off-screen tiles are frustum-culled. Without this, every cut uploaded a 32 MB terrain texture. Small bodies use a single tile that shares the color buffer (no copy). Static layers such as the back wall `freeze()`: they upload once and drop the full-size source buffer.
- **Gas field at 1 m cells** (`FIELD_SCALE` 8, 512 × 256): walls 7 or more pixels thick always seal. Only changed rows are uploaded (`addUpdateRange`). CPU readback covers just a horizontal band around the camera (view ± 25 m). A whole-field readback would be about 4 MB per frame. Off-band, `sample()` returns 0, so distant gas doesn't push bodies and distant heat doesn't ignite fuel. The GPU still simulates everywhere, so effects resume when you get close.
- **Memory:** about 300 MB JS heap steady state, measured after a forced GC across 8 restarts with no growth. It's dominated by the world-sized typed arrays (material, hp, shade, heat, colors, tile copies, flood stamps). The flood-fill stack is now sized to the detach cap instead of the world, and `main` no longer holds the level spec. A restart takes about 0.3 s.

## 2026-10-09 — One-button harpoon (click / hold), clamping, heat glow, uncapped cutter

The user's direction: the grapple is the first thing to make fun. It should support skilled slingshotting, grabbing explosives and swinging them at enemies, and winching objects close, clamping them on, then using them as a barrier or a ram. You should also be able to hitch a ride on large moving things: attach, winch up, clamp on contact.

- **RMB does everything.** Press when idle to fire. When attached, a click under 0.18 s lets go, and a hold winches in at 9 m/s. The hold counts from the press, so fire-and-hold winches as soon as the harpoon sticks. Click while clamped to unclamp. Q/E still reel in and out.
- **Clamping:** while winching (or fully reeled in), touching the tethered object locks the ship to it with a Rapier fixed joint at the current relative pose. Ship thrust and turning then move the combined body, so it serves as a shield or ram. Clamped to terrain you're perched; clamped to a mover you ride it.
- **Docking isn't a crash:** contact with the tethered object never damages the ship, and the winch eases off over the last few meters. Without this, winching into a crate at speed killed the ship.
- **Rapier gotcha:**
  - Calling a world query (`contactPair`) inside another query's callback (`contactPairsWith`) panics with "recursive use of an object".
  - Reading a removed body (`worldCom` on a destroyed PixelBody) panics with "unreachable".
  - Either panic leaves the wasm module poisoned: every later call fails.
  - So collect first, query after, and check `PixelBody.alive` before touching `.body`.
- **Heat glow:** each pixel grid has a cosmetic `heat` array. The cutter heats the struck surface at 3/s for any material, so indestructible girders and the core glow from dull red through orange to yellow and never lose a pixel. Heat cools exponentially and is repainted only for hot cells. Split-off pieces keep their glow.
- **Cutter range:** raised from 16 m to 200 m, effectively unlimited, at the user's request. The beam still stops at the first solid pixel.

## 2026-10-09 — Grapple v4: harpoon (supersedes v3's coil)

**User:** "I want the hook to feel like a harpoon shot out at high velocity to stick into the side of something. Don't let out a big coil (I was wrong, that looks bad), but when it thunks into something there is slack that quickly gets pulled taut by the winch. The rope is still too noisy; it should be almost a straight line when it is taut."

- **Flight:** the head is a swept kinematic projectile at 70 m/s. Its path is a pixel raycast each step, and there is no physics body or rope in flight; a thin straight cord is drawn to the ship. Firing kicks the ship back 100 N·s. A miss at 26 m zips the head back.
- **Thunk:** the anchor snaps to the nearest solid cell. The head's momentum (6 kg × closing speed) goes into a pixel body it hits. The physical rope spawns along a parabolic slack bow at 1.15 × the distance, with the bow side chosen at random.
- **Winch:** reels at 12 m/s until the rope is straight and holds about 400 N of pretension. "Straight" is geometric whenever the line between the ends is clear, because a swinging slack bow spikes tension mid-swing and fooled a tension-only check (it stopped at 9% slack). When the rope is wrapped, sustained tension is the only signal.
- **Take-up:** after the snap, the winch keeps taking up slack at 4 m/s, so the rope stays straight as the ship drifts toward the anchor. Without it, the snap pulse sent the ship drifting in and the rope bowed again. Holding E pays out, and take-up pauses for 0.4 s afterwards; it can be toggled with `autoTakeUp`.

### Getting rid of the noise
- **Fewer, heavier links:** 1 m and 1 kg each, instead of 0.5 m and 0.35 kg.
- **Internal damping:** each segment's velocity is pulled toward its neighbors' average. This kills the high-frequency wobble without dragging on the rope's bulk motion.
- **Chord damping:** while the rope is taut and nothing blocks the line between its ends, segment motion across the chord is damped and segments are nudged onto the line. This kills the slow swing of the whole bow, which neighbor averaging can't see. Wrapped or slack rope keeps its natural sway.
- **Measured:** about 0.3 s after impact the physical rope settles to a 0.00 m deviation from straight. Before these changes the bow kept swinging 0.3–2.5 m.
- **Rendering:** once snug, with a clear line of sight, the rope is drawn as an exact straight line. While snapping, slack or wrapped, it's drawn through Chaikin-smoothed segment positions, so the slack bow is visible at impact.

## 2026-10-09 — Grapple v3: coiled rope, drifting head, gentle snug; impacts; RCS brake

**Superseded by v4 the same day**, after the user saw it ("the coil looks bad"). The impacts and RCS brake parts below still apply.

### What the user asked for
- "Shoot out with slack cord visible that unfurls until it clamps… pull taut as soon as it makes contact… a little bit of spring."
- The goal: round corners, grab hazards and whip them into things, pull a door off its hinges after cutting the bolts.
- After seeing v2, the user said it was "way too noisy and chaotic and should be drifty and slow. A rope that uncoils as the head flies off until it is at tension… way more dampening… loops or coils that unfurl so the ones far from the head take time to change due to the propagating tension."

### Design now
- **Coil at fire:** the full rope (22 m) spawns as a flat spiral coil at the nose. A weighted head (6 kg) is launched at 16 m/s and flies freely, with nothing forcing its velocity.
- **Unfurling is emergent:** the cord is light (0.35 kg segments, about 15 kg total) and joined by max-distance links. Tension reaches the loops next to the head first, and the far coils lag. The head slows as it drags more rope; measured head distance every 150 ms: 4.6, 6.0, 7.4, 8.5 … 13.4 m.
- **Heavy damping on segments** (linear damping 1.5) and on the stretch spring (0.9 of critical) is what makes it read as floaty instead of jittery.
- **Bite:** the head bites when a pixel raycast along its motion, or a short probe in four directions, finds matter. The anchor snaps to the nearest solid cell. The earlier half-cell nudge could land just outside a plate, the anchor check then dropped the hook immediately, and the ship flew into the roof. If a cut removes the anchor cell, the hook re-seats on a solid neighbor within 2 cells before letting go.
- **Gentle auto-winch:** after the bite, a 6 m/s winch reels in until the ends are a full rope-length apart, or until the 0.3 s average tension exceeds 1.5 kN (wrapped around a corner, or already hauling a load). It never reels past the target in one step. Momentary tension spikes from the head's momentum stretching the front links are deliberately ignored; they stopped the winch at about 50% slack.
- **Miss:** the head stalls, hangs for 0.8 s, then reels home at 10 m/s. Right-click reels home early.

### Rejected along the way (v2, the same day)
- **Hook velocity forced each step, with rope paid out from the ship:** chaotic. Each new segment yanked the ship through its short link, and the 100 kg of cord moving at 25 m/s dragged the ship to about 10 m/s on impact. A free-spool fix with momentum bleeding worked, but looked noisy. The coil design replaces all of that.
- **Counting only links stretched past rest as tension:** rejected. The ship-end link's rest length doesn't match its geometry, so it showed phantom tension. Path length minus rest length (the signed sum) is used instead.
- **Spring damping from dE/dt:** spiked every time the winch shortened a link, and yanked. Damping now uses how fast the two rope ends are separating.

### Impacts ("whip hazards into things")
- **Pixel bodies report contact forces.** An explosive body detonates on a hit that changes its velocity by more than 7 m/s.
- **Heavy hits damage pixel matter at the contact point:** impulses above 250 N·s, at 0.5 hp per N·s, within a 0.5 m radius, on both bodies. A 219 kg crate at 22 m/s chips the hull.
- **No structural-stress breaking yet.** "Pull the door off" works by cutting it free, then hauling. Hinges that tear under rope tension would need a stress model; it's a candidate next step.

### Flight assist RCS brake (user request)
- When not thrusting, RCS jets push against drift with a bounded force (700 N, about 2.3 m/s² unloaded). It's a real force, so towed loads slow far less. It shows as white side puffs on the hull facing the drift, plus nose/tail puffs while turning.
- This deliberately supersedes "no braking" from the initial build. It can be toggled in the tuning panel.

## 2026-10-09 — No out-of-bounds spring

The soft boundary that pushed bodies back into the level rectangle is gone. The user found it weird in a physics game: things that should drift off came back. Nothing applies boundary forces now, the ship included. Debris more than 150 m outside the level is deleted to save CPU, since with no forces acting on it, it could never return. Salvage and whatever is on the tether are never deleted. If someone loses the core to deep space, that is a legitimate physical outcome; they can still chase it.

## 2026-10-09 — Turning, rope physics, grapple pivot

### Turning is a rate controller, not raw torque (user: "too floaty")
A/D now drive angular velocity toward ±`turnRate` with bounded angular acceleration (`turnAccel`). Releasing A/D brakes to zero at the same rate. It still acts through torque impulses scaled by inertia, so impacts and loads can knock the ship around and it has to recover. Steering is central to aiming, so response is quick: about 90 ms to reach full spin rate and about 90 ms to stop. The old `torque` and `rotationAssistStrength` knobs are gone, because the right knobs are a rate and an acceleration.

### Rope is a chain of physical segments (user asked for rope physics)
- **Rejected: wrapping pivots (Worms-style ninja rope).** That breaks down when the rope wraps around moving bodies.
- **Rejected: a CPU Verlet rope that applies forces at its ends.** It's a stiff spring between masses up to 1.5 t, which would be unstable.
- **Chosen: Rapier segment chain.** Small balls linked by max-distance joints, colliding with world matter but not with the ship or each other. It wraps around anything and sags when slack.
- **Stretch:** light segments between heavy bodies stretch under Rapier's iterative solver, and there is no joint-stiffness setting to fix it. Raising solver iterations (8 → 16) or segment mass (4 → 15 kg) barely helped; measured path stretch stayed about 15%. A hidden straight-line rope joint between the two ends (length × `safetySlack` = 1.03) carries the load whenever the rope is straight. It can't bind while the rope is wrapped, because the wrapped path is longer than the straight line. Measured stretch is now ≤ 3% at both pivots.
- **Reeling** adds and removes segments at the ship end. The ship-end link carries the leftover fraction of the length, so length changes are smooth.

### Grapple pivot at the center of mass by default; nose available for testing
The user wanted the pivot at the center of mass so the tether doesn't rotate the ship, but asked to be able to test it. Press P to toggle, or use the tuning panel; the change applies live. Measured with rotation assist off, towing at 45° for 2 s:
- **Center of mass:** max spin 0, heading change 0.
- **Nose:** max spin 4.8 rad/s, heading change −1.6 rad.

### Testing note
An earlier rope test teleported the ship's rotation after the rope was attached. That jumps the nose anchor about 1.3 m in one frame and looked like 49% stretch. Never teleport anchored bodies in tests; set their pose before attaching.

### URL tunable overrides
`?group.key=value` (for example `?grapple.segmentMass=15`) overrides `tune` at boot, for parameter sweeps in smoke runs without code edits.

## 2026-10-08 — Initial build

### Direction (from the user)
- **Not a throwaway prototype.** Build fast and efficiently, but not stupidly. Keep it simple but well architected, with modular pieces that each have a narrow interface. When designing a module, think about how it is likely to change, so new complexity slots in instead of forcing a rewrite. Don't build those futures yet.
- **Stack:** three.js `WebGPURenderer` with TypeScript and Vite. Physics modeled after Noita: pixel grids that turn into rigid bodies when cut loose, plus simple GPU rules and fields for fluids.
- **View:** 2D, with parallax layers that show giant things in the background. The focus is the environment; firefight modes come later.
- **Firefights are local / vs-AI only.** So the simulation does not need to be deterministic or networked. That is why GPU fields and their non-deterministic readback are acceptable.
- **Standalone repo.** The WebGPU carve engine in WebGamesPlatform was deliberately *not* reused. That avoids coupling to that monorepo; borrow ideas only.

### Solid pixels live on the CPU; gas and heat on the GPU
Rigid-body extraction needs synchronous access to the solid grid: flood fill, collider rebuilds, splitting. Reading that back from the GPU would add a frame or more of latency and a lot of complexity to every cut. Gas and heat are bulk diffusion work that tolerates one or two frames of lag, so they run on the GPU. The CPU uses them only for forces and ignition.

### Box colliders, not marching squares
Each terrain chunk, and each pixel body, gets colliders built by greedy-merging solid cells into rectangles. Boxes are solid, so there is no tunneling through thin polyline walls. They also give correct mass and inertia for dynamic bodies, and they are robust in Rapier. The cost is stair-step corners on diagonal cuts. If those snag, swap in marching-squares polylines inside `Terrain.rebuildChunk` / `PixelBody.rebuildColliders`; nothing else would need to change.

### What counts as "detached"
- Terrain detaches when a flood fill from a cut edge fails to reach an indestructible `FRAME` (anchor) cell, and the region stays under `tune.pixel.detachCap` cells.
- Huge regions that are free but over the cap stay static, on purpose, to keep the flood fill bounded.
- During one flush, a flood that touches cells an earlier anchored flood already visited stops immediately. Those cells must be anchored too, so this keeps repeated seeds cheap.

### Gas model
The field is a staggered, compressible-ish grid: pressure equals density, face velocities are capped to keep it stable (the CFL limit), and gas and heat move with upwind fluxes. The field's outer border acts as the vacuum of space. This is deliberately "fun, not CFD", per the design doc. A field cell counts as a wall until more than half of its pixels are open, so walls at least 4 pixels thick always seal.

### Tuning choices that aren't obvious
- **Rotation assist is on by default.** It damps spin only when A/D are released, and does no linear braking. Without it, collisions leave the ship spinning in an annoying way. Toggle it in the tuning panel.
- **The ship is about 300 kg and the core about 1.5 t.** The 5:1 ratio makes towing feel heavy without being impossible.
- **Ship impact damage starts at about 30 kN contact force,** roughly a 1.7 m/s bump. That way gentle scrapes are free.
- **The heat display is tone-mapped and dim.** Additive light in linear space comes out much brighter after the sRGB conversion. Sealed rooms full of blast heat used to clip to white.

### Testing approach
`npm run smoke` launches system Chrome headless with WebGPU through playwright-core, so no browser download is needed. It runs the scripted scenarios in `src/dev/autotest.ts` and logs measurable outcomes. These scenarios only check that mechanics work; they say nothing about whether the game is fun, which needs hand playtesting.
