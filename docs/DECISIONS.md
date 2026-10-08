# Decisions

This file records why things are the way they are: tradeoffs, rejected alternatives and user directives that the code alone can't show. Newest entries go at the top. Each entry is one decision.

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
