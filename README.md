# Space Junkers

A 2D zero-G salvage game: fly on inertia, carve a derelict apart pixel by pixel, grapple the core, and get it out.
It draws on PixelJunk Shooter's handling and Noita-style destructible pixels.
The design doc is at `.claude/docs/design/Zero_G_Salvage_Reconciled_Prototype_Handoff.md`.

## Run

```sh
npm install
npm run dev        # http://localhost:5180 — needs a WebGPU browser (Chrome/Edge)
npm run typecheck
npm run smoke -- <outDir> "autotest=all"   # headless Chrome run with scripted scenarios + screenshots
```

## Levels & URL parameters

- Default: a **generated derelict**. It's about 512 × 256 m, with 30–36 rooms off a spine from the prow entry to the vault at the far end. Every run is a new ship.
- `?seed=N`: pin the generator to a specific ship.
- `?level=classic`: the original small derelict. Autotests use it by default.
- `?group.key=value`: override a tunable, e.g. `?grapple.hookSpeed=90`.
- `?autotest=all|hook|clamp|glow|overview|soak|…`: scripted scenarios for `npm run smoke`.

Security: bots patrol rooms with visible vision cones. Stay out of a cone, or break line of sight before the WATCHED meter fills. An alarm seals nearby bulkheads (cut through them, or cut their edges and yank the slab out), wakes turrets, and launches drones from their bays. Destroy a robot by breaking its red eye.

The top-left minimap reveals the ship as you explore. It always shows you (white), the core (cyan) and the extraction zone (green).

## Controls

| Input | Action |
| --- | --- |
| W / S | Thrust forward / reverse |
| A / D | Rotate |
| Mouse | Aim tools |
| Left mouse (hold) | Cutter |
| Right mouse | Fire harpoon; click again to let go; hold to winch in (clamps on contact) |
| Q / E | Reel in / out (E pays out slack) |
| Wheel | Zoom |
| R | Restart |
| H | Hide help |
| ` | Tuning / debug panel |

## Architecture

```
src/
  config.ts            world scale constants + live `tune` values (bound to the debug panel)
  core/Input.ts        device state; edge presses latched until consumed
  physics/Physics.ts   Rapier world, collider→owner map, contact-force events
  pixel/               CPU-authoritative pixel matter (Noita model)
    materials.ts       material table → typed lookup arrays (flags: SOLID/ANCHOR/EXPLOSIVE…)
    PixelGrid.ts       grid + algorithms: damageCircle, greedyRects, components, DDA raycast
    PixelObject.ts     grid + texture + mesh + local↔world transform (shared base)
    Terrain.ts         static world grid, per-chunk box colliders
    PixelBody.ts       dynamic cuttable rigid body made of pixels
    PixelWorld.ts      facade: damage, raycast, flush() → collider rebuild, detach, split
  fields/GasField.ts   GPU (TSL compute) gas + heat field, wall mask from terrain, async readback
  render/              stage/camera, parallax background layers, particles, back-wall layer
  game/                Game (composition root, fixed step), Ship, tools (Cutter, Grapple),
                       Hazards (explosions + heat ignition), Objective, level/ (painter, props, derelict)
  ui/                  DOM HUD, lil-gui debug panel
  dev/autotest.ts      scripted scenarios for the smoke runner (?autotest=fly|cut|vent|boom|grapple|all)
```

**How destruction works:**
1. Tools call `PixelWorld.damageCircle()`.
2. Once per fixed step, `flush()` rebuilds colliders for the chunks that changed.
3. It then flood-fills from the cut edges. A region that doesn't reach an indestructible `FRAME` cell, and stays under the size cap, becomes a `PixelBody`. Tiny regions become debris particles.
4. A body split by a cut keeps its largest piece; the other pieces spawn as new bodies with the right velocity.

**How the systems compose:**
- The cutter heats the GPU field.
- Heat at a fuel site, or a destroyed fuel cell, starts an explosion.
- An explosion carves pixels, kicks bodies, and injects gas and heat.
- The gas flow pushes bodies and particles.
- Breaching the pressurized room vents it the same way.

Nothing is scripted. Every effect comes from these shared inputs.

**Extension points:**
- New materials: add an entry to `materials.ts`.
- New tools or weapons: implement `Tool` and assign it to `Game.slots`.
- New hazards: subscribe to `PixelWorld.events` and field samples.
- New background layers: implement `Layer` in `Background.ts`.
- New gas channels: widen the `GasField` state.

Each file's header comment notes how that module is likely to grow.
