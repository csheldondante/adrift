# Zero-G Salvage — Prototype Coding Handoff

## Goal
Build a **browser-based, 2D zero-gravity salvage game** inspired by the tactile physics of *PixelJunk Shooter* and the destructible environments of *Noita*. The focus is the environment: prove that **flying, cutting, grappling, and extracting salvage** are fun together, then grow toward firefight modes. Build fast and efficiently, but not stupidly.

## Engineering Guidance
Keep it **simple but well architected**: modular pieces with narrow interfaces that can each be improved later. When designing a module, think briefly about how it is likely to change (new materials, more fluid types, enemies/weapons, more layers, bigger worlds) so that added complexity slots in rather than forcing rewrites — but don't build those futures now.

## Technical Direction
- **TypeScript + Vite**, **three.js `WebGPURenderer`** (TSL / compute shaders). Target WebGPU browsers (Chrome/Edge); no WebGL2 fallback for now.
- **Noita-style physics model:**
  - **Solids (hull, debris) are CPU-authoritative** in a chunked pixel grid. Cuts mark chunks dirty → per-chunk collider rebuild (currently greedy-merged box colliders: robust, solid, correct mass; marching-squares polylines are the upgrade path if stair-step corners snag). Connected-component detection turns detached regions into dynamic **pixel rigid bodies** (still cuttable); tiny scraps become particles.
  - **Rigid bodies via Rapier2D** (WASM).
  - **Fluids/fields on the GPU**: coarse grids for gas/pressure, heat, and simple pixel-rule materials (e.g. molten metal, sparks). A small per-frame readback samples fields to apply forces (venting, blasts) to rigid bodies.
- **2D with layers**: parallax background layers (distant derelicts, giant structures, planets, starfield) for a sense of scale. Only the foreground layer is simulated physically.
- **Multiplayer**: future firefight modes are local / vs-AI only; the sim does not need to be deterministic or networked.

## First Playable: One Derelict, One Extraction
A small fixed wreck with several connected spaces, a few obstructing hull sections, **one initially pressurized compartment**, loose debris, **one explosive or thermal hazard**, one heavy salvage component, and a marked extraction zone. The player approaches, cuts an entry, navigates the resulting hazards, tethers the component, and maneuvers it out. Make this a short, repeatable scenario with multiple physical solutions—not a scripted sequence.

## Required Systems

**1. Newtonian ship flight and aiming**
- Top-down 2D. **W/S = forward/reverse thrust; A/D = rotate ship; mouse = independent tool aim.** Inputs apply force/torque rather than setting velocity.
- Momentum and angular motion persist in vacuum; **no default auto-braking or drag**. Allow tunable thrust, turning, mass, and optional stabilization *for testing*, but do not require upgrades or fuel.
- **Left-click = fire cutter/weapon** at the cursor. **Right-click = fire grapple; right-click again = release.** The two tool slots should be easy to swap later.

**2. Physical grappling**
- Tether attaches to static hull or dynamic objects, with a visible line, maximum length, and forces applied to both endpoints as appropriate.
- Enable swinging around structures, towing heavy salvage, reeling in/out (choose simple convenient keys), and releasing cargo so it continues on its trajectory.
- Mass and momentum should matter: towing a large component changes how the ship moves. Prefer a stable, fun rope/joint approximation over elaborate rope simulation.

**3. Arbitrary pixel destruction with rigid-body fragments**
- Represent cuttable terrain as pixel/grid material. The cutter removes material along an arbitrary path or brush footprint—not only predetermined break points.
- Update collision shapes to reflect cuts. Detect disconnected regions; **substantial detached chunks become dynamic rigid bodies**, preserving plausible position and gaining motion from impacts/forces. Tiny scraps can be particles for performance.
- Pieces, player, and salvage collide. Favor a bounded implementation (local dirty-region remeshing and connected components) over a general-purpose destruction engine.

**4. Composing environmental hazards**
- Pressurized rooms vent into vacuum when breached, imparting outward force to nearby loose objects, detached hull, and potentially the player. Pressure falls as the compartment empties. Model this with the GPU gas/pressure field (simple, stable, fun — not accurate CFD).
- Add **one** explosive *or* superheated-material hazard that is triggered by cutting/damage and interacts physically with surroundings (impulses, moving debris, damage, or dangerous particles).
- The intent is emergent cause-and-effect: cutting may clear a path, unleash a hazard, or turn a hull fragment into a projectile.

**5. Physical salvage extraction**
- One valuable, sizable component with its own mass, collisions, and inertia. The player must grapple and move it to the extraction zone.
- It should be possible to tow it carefully **or** impart momentum, release it, and intercept/guide it. Simple collision damage is optional if it helps the feel test.
- Show unmistakable completion feedback and a quick reset.

## UI and Debug
Minimal HUD: objective/extraction marker, player health if hazards can damage it, and preferably a small velocity cue. Provide **restart** and quick tuning/debug controls for thrust, mass, tether strength/length, cutter radius, pressure impulse, and hazard activation. Use visible outlines or overlays for physics diagnostics when useful.

## Implementation Order
1. Ship thrust/rotation, camera, collision, and independent mouse aim.
2. Grapple attach/swing/tow/release with a heavy test object.
3. Arbitrary cutting, updated collision geometry, and free rigid-body chunks.
4. Pressure breach plus one reactive hazard.
5. Assemble the tiny derelict extraction challenge; playtest and tune repeatedly.
6. Parallax background layers.

## Not Yet (later milestones)
Upgrade tree, progression, inventory, fuel economy, procedural levels, star map, campaign, shops. Enemies and firefight modes come after the salvage loop is fun.

## Success Test
A player enjoys **flying on inertia, swinging around corners, carving openings, dodging physically launched debris, and towing or flinging salvage** for several repeat runs—even with placeholder visuals and no metagame. Physics systems should compose rather than play out as isolated scripted events.
