# Decisions

This file records why things are the way they are: tradeoffs, rejected alternatives and user directives that the code alone can't show. Newest entries go at the top. Each entry is one decision.

## 2026-10-13 — Cores explode; auto-plug; the harpoon tows batteries whole

The user asked for three things: "Make power cores explode when ruptured. Make it so if I grab and fly a power core to a receptacle the ship automatically grabs the surface and maneuvers and plugs the core in. Make it so the harpoon gun doesn't destroy the core when I spear the outside to pull it."

**Ruptured cores explode.** A new material flag, `RUPTURES`, means a cell explodes when it is destroyed (cut, blasted, crushed, shed) but not from heat. Power cores have it. Fuel (`EXPLOSIVE`) also cooks off in a hot gas field, but cores shouldn't go off just because you cut near one. Consequences:
- Drilling a robot's core from behind now blows the robot apart, not merely kills it. In the organs test the cause changed from "core" to "destroyed".
- The blast hurts the ship within about 7 m.
- The crew section's wall core and the batteries explode if cut.
This follows from the request and from the physics-damage rule: no exemptions.

**The harpoon no longer guts batteries.** It never damaged cells itself. Spearing a battery near its core triggered the robot core-rip, which tears a channel through the housing and pulls the core out, so the battery came apart. The rip now applies only to robots and wrecks (labels `securityBot`, `drone`, `wreck`). A battery speared on its casing is towed whole (84 of 84 core cells kept).

**Auto-plug** (`game/AutoPlug.ts`) is an assist on top of the real systems:
- **Trigger:** the arms hold a live core within 8 m of a dead socket.
- **Fly:** if no surface is underfoot, the thrusters ease the ship toward a stance beside the socket until the feet can clamp onto its wall.
- **Walk:** the feet walk to that stance.
- **Insert:** the arms swap the rigid hold for a force- and torque-limited spring-damper (`Arms.guide`). They turn the core so a terminal faces the socket and press it onto the face. A terminal is a live conductor sticking out of the core: a body's outermost cells on that side. Without that check it picked the side of the battery's copper strip and turned the battery 90° the wrong way.
- **Latch:** the socket goes live, its latch grips the core (a fixed joint to the wall), and the arms let go.

Plugging still depends on physical contact, as checked by PowerNet; the latch is new and keeps a plugged core from drifting off. Any input of the player's (A/D, thrust, E) takes over, and that socket is left alone until the core changes or the ship moves 14 m away. Grabbing a latched core with E unlatches it.

**Verified:** in Lantern's hall, starting mid-hall with the dock battery in the arms, the ship flew in, clamped on, walked, placed the battery and latched it in 5.2 s. The socket went live and the power-restored notice showed. The lantern, lab, airlock, rip and organs tests pass.

## 2026-10-13 — Less janky controls: the line lets go on arrival, E grabs, arms fend

Playtest: "When I grapple and attach to a surface my grapple should disengage automatically not hold me there. I think E to grab debris otherwise arms should just move slow moving debris around the ship."

**Harpoon arrival.** Winching up against what the line holds used to lock the ship there with a rigid joint ("clamped") until you clicked again. Now, winched against something to stand on, the hull-walk feet clamp on and the line lets go by itself. That covers the structure, a machine, or a body at least three times the ship's mass (`grapple.standMassRatio`); for the player, arriving means landing. Lighter debris just stays on a short line. The rigid clamp state is gone: carrying debris is now the arms' job, so the two features no longer overlap.

**E grabs.** The arms no longer catch whatever drifts slowly into them, which grabbed things you didn't want and made the ship's mass jump. E now does one thing at a time, in this order:
1. let go of what the arms hold;
2. grab the nearest debris in reach that is slower than `arms.grabSpeed` relative to you;
3. with nothing to grab, clamp onto the surface (see below: E no longer lets go of one).

Grabbing a body on the harpoon line hands it from the line to the arms.

**E is only the arms (follow-up the same day).** The user: "While walking on the surface E should not let go space should. E should be used for the arms I think so you can grab things and walk along the surface." Space already pushed off a surface, so E no longer detaches. While walking, E grabs or lets go: two arms (the nearest to the piece) keep the grip and the other two stay feet. The hull-walk probe and the feet's raycasts ignore the held body, so you never "stand" on what you're carrying. Floating with nothing in reach, E still clamps onto a surface: that's the arms too, used as feet.

**Arms fend.** With nothing held, the nearest arm meets slow debris drifting in and eases it out past a standoff. It damps the approach (spring-damper on the reduced mass) and pushes, so the debris slides round the ship rather than piling onto it. The push is capped at what an arm can exert (`arms.fendForce`), and the ship takes the reaction, so heavy junk shoves you instead. Debris faster than `grabSpeed` gets through and hits, as before. The body on the harpoon line is exempt, or towing would fight the arms.

**Tests:** the clamp, shield and ride autotests now use E and arrival. A new `arrive` test harpoons a wall 10.8 m away, holds RMB, and ends up walking on it with the line idle.

## 2026-10-13 — Hosted on GitHub Pages; PolyForm Noncommercial

The user wants to share builds with friends easily, the same way as Reclaimed (deployed the same day).

- **Hosting:** a GitHub Actions workflow (`.github/workflows/pages.yml`, copied from Reclaimed) builds and publishes `dist/` to Pages on every push to `main`. Vite's `base: './'` makes asset paths relative, so the build runs from `/<repo>/`. This was checked by serving `dist/` under `/space_junkers/` (the repo is `adrift`, so it is served from `/adrift/`) in headless Chrome: Lantern loads, with no errors.
- **Loading message:** building Lantern takes several seconds before the first frame, and a black page reads as broken to someone who just got a link. `index.html` now shows "Loading the derelict…" until the first Game exists.
- **License:** PolyForm Noncommercial 1.0.0, the same as Reclaimed. It's source-available: friends can play, read, change and share it, but not use it commercially.

## 2026-10-13 — Welding that works with the real cutter: the weld beam

Playtest: "Did you ever add welding with the heat ray? If so I can't get it to work."

Welding had been in since the materials-and-heat milestone, but every test cheated: pieces were teleported into contact and heat applied directly, never with the cutter. A test using the real beam showed it could not weld, for three reasons:

1. **Welding heat was above burning heat.** The welder wanted 0.6, but hull burns at 0.5 and plate at 0.35. The beam ate the metal before it was hot enough to fuse, and the rim fell below 0.6 within about 0.2 s of letting go.
2. **Weak heat never accumulated.** Cooling zeroed any cell under 0.01 every frame. A cell at the edge of the beam gains less than that per step, so a plate next to a glowing wall stayed exactly cold. This is a real bug that affected all gentle heating; the cold floor is now 0.003.
3. **The beam pushed the plate away** (radiation pressure), and contact only counted within about 6 cm.

**Fix:**
- The weld point is now a fraction (0.5) of each material's own burn point: glowing, but not yet giving way. Tough material needs proportionally more.
- Contact reaches two cells, since molten metal bridges a hairline gap.
- New **weld beam** (Shift + LMB): the same laser, defocused three times wider at 0.12 power. Heat, damage, push and laser load all scale down with it. It brings a seam to a glow in about 1.3 s; hull under its centre starts burning at about 2.6 s, so the window is real but you can't hold it forever.

**Why not exempt welding from damage, or add a separate tool:** the user's physics-damage rule. The weld beam is the same beam with less intensity, so it still cuts soft metal if held.

**Verified with the real cutter in Lantern's hall:** a plate laid over the breach welds in 1.3 s, and a plate held in the arms welds in 2.2 s. All earlier weld tests still pass.

## 2026-10-13 — The scan map stays; doors have wired motors

Playtest ask: "Schematics in walls should stay after you map them and they should show wires connecting power to doors and whatnot."

**The map.** Every cell a pulse draws is remembered for its object, in a bitset, and kept on the walls as a dimmer schematic. A fresh pulse fades back to the map rather than to nothing. The map is redrawn from the matter as it is now, not frozen at scan time, so:
- a line you mapped while it was dead turns solid when you power it;
- doors show their current state;
- cut-away cells drop out of the map.

A frozen snapshot was the alternative. It's more "realistic", but it would leave you misled by stale wiring right after you fix it, which is the opposite of what the map is for. Knowing a door's state without rescanning is a small giveaway; we accept it.

**Cost.** Terrain is split into 64-cell chunks. Each chunk gets its own texture, made the first time a cell in it is mapped. Up to three chunks are redrawn per frame: newly mapped ones first, then a slow sweep over the rest. A 16 m knock touches about 8 chunks. N toggles the map, for when you want the lit walls back.

**Wires to doors.** Before this, airlock doors and hatches checked their panel's power: a logical link with nothing in the walls to show for it. Now each door and the vent valve has a motor cell (conduit) wired into the network, and it moves only while that motor is powered. In Lantern:
- the airlock's two door motors are fed by a line under the chamber, off the chamber-floor panel's riser;
- the valve's motor sits against the shaft-side panel;
- the store hatch's motor runs off the lower bus.

So the scan shows the real wiring, and cutting a motor's line jams that door, physically, with no special rule.

## 2026-10-13 — Never step time backwards

**Bug:** the first animation frame's timestamp can come before the `performance.now()` that `main.ts` takes at init, so the first `dt` was negative (about −0.7 s). The extraction objective's decay, `progress − dt·2`, then *added* 1.4. The default level could count as "Salvage extracted" on its first frame; headless runs hit it about 3 times in 4.

**Fix:** the frame loop clamps `dt` at 0. Clamping at the source is better than guarding each system, because any rate-based system could misbehave on a negative step.

## 2026-10-13 — Hatches, airlocks and life support

Playtest ask: "there also need to be airlocks, doors that I can open and close and double sets to keep pressure in (or systems to recreate pressure once a seal has been established)".

**Decision:** two new device types in `Devices`, and a new material `PANEL`, which glows, conducts and is cuttable.
- **Hatch:** a door you open and shut with **G** at its panel, while the panel is powered.
- **Airlock:** an inner and an outer door with a chamber between, plus a small vent valve to the outside. Using any of its panels cycles it:
  1. Shut whichever door is open. The doors are interlocked, so both are never open at once.
  2. Going out: open the valve until the chamber matches the outside. Going in: pump the chamber up until it matches the inside.
  3. Open the far door.
  - A 9 s cap stops a leak from trapping you.
- **Everything is physical.** Doors paint the terrain, and venting is a real slot opened to the outside, so the gas field supplies the wind, the sound and the push.
- **No power, no movement.** Doors stop where they are. The panels say they're dead, and the matter can still be cut, which is the soft constraint.
- **Re-pressurizing:** the existing powered `pump` already refills a room up to its target once it's sealed. The crew section has one as life support, so a welded breach heals itself.
- **Lantern:** a pressurized crew section off the shaft's right wall, behind an airlock. It has:
  - three panels: shaft side, chamber floor, crew side;
  - its own core in the wall, powering the panels, lamps and life support from the start, so the airlock teaches itself;
  - a floor hatch down to a store holding a second battery, an alternative power source for the hall socket.
  - Cutting in instead of cycling vents it the hard way.
- **Hints** name the panel's state and say what G will do.

**Measured:**
- Cycle out: 3.8 s; the chamber goes from 1.04 to 0.07.
- Cycle in: 2.8 s; the chamber goes back to 1.04.
- The crew section holds 1.04 throughout.
- The hatch opens in 1.4 s.

**Revisit if:** players want doors without power, for example a manual crank that is slow and noisy, or sensors that hear the airlock cycle.

## 2026-10-13 — Schematic scan, tearing cores out with the harpoon, contextual hints

Playtest notes (2026-10-13):
- "It wasn't really clear what to do with the power cores."
- "The graphics would be cooler if you could send out pulses when on the surface and see a black and white schematic of what's going on in the walls."
- "It didn't really seem possible to remove the power core of enemies."

**Decision:**
- **The scan is a black and white schematic** drawn over the walls it reached, like an x-ray. The colored additive glow is gone.
  - It renders at 3 texels per cell, so hairlines fit inside a cell.
  - Surfaces are bright lines, which outline hidden cavities. Boundaries between materials are finer lines, and plain structure gets a 1 m drafting grid.
  - Tough material is hatched.
  - Systems are told apart by pattern, not color:
    - cores solid white;
    - power lines solid when live, dashed when dead;
    - sockets solid when live, dotted when dead;
    - pumps cross-hatched, fixtures dotted, fuel ruled.
  - So the scan answers "is this line live, and where does it go".
  - A bright ring runs out at 45 m/s. The picture holds 2.5 s, then fades.
  - The finished image is drawn once per pulse, and frames only reveal it in reach order.
  - Footfall pulses are stronger (6 m, 0.75), and a knock now reaches things within 4 m.
  - A legend shows while a knock's schematic is up.
- **The harpoon tears out power cores.**
  - Why: cutting a core free with the laser was nearly impossible in play. The core is softer than its housing, so the beam ate the core along with the cut, and on a moving robot.
  - Rule: a harpoon that bites within about 0.9 m of a body's POWER cells hooks the core. Hold RMB to winch; the core comes out when the line pulls past `ripTension` (900 N) or the winch drags you against the body.
  - The core leaves along the line. The cells in its path are torn to debris, so it isn't extracted inside its own housing; an early version was, and physics shoved the overlap apart hard enough to smash it.
  - The core keeps its power. The robot dies of core loss and drifts. The core arrives on the line or in the arms.
  - This is the "take power from enemies with the grappling hook" ask. The front armor still matters, because you need a bite near the core: from the rear, or from close above or below.
  - Measured: hooked about 0.1 s after firing, torn out about 0.2 s later, core intact (20/20 cells) in repeated runs.
- **Hints and beacons** (`ui/hints.ts`): one context line, from game state.
  - It covers: a core is hooked; a live core is in tow (with or without a dead socket nearby); a dead socket and what feeds it; a wreck with a live core; a shut pressure door and what opens it.
  - "POWER RESTORED" shows when a socket goes live.
  - Dead sockets pulse a slow blue light, so you can find them in the dark.

**Revisit if:** the hint text is too hand-holdy once the loop is learned (retire hints after first success), or ripping makes robots too easy (raise `ripTension`, shrink the 7-cell hook radius).

## 2026-10-12 — Curious sensors and a scanner gallery (milestone G)

Playtest ask: "rooms with lots of scanners where you can hide behind debris to get by but I would make the probes look at debris that is moving oddly and fly around it so the player has to move around the debris to stay hidden."

**Decision:**
- **Oddness.** In zero-g, junk drifts in straight lines, so `Security` tracks each loose body's *unexplained* acceleration.
  - It is the velocity change per step, minus the gas drag the physics applied. That drag comes from a shared `fields/drag.ts`, so the physics push and the prediction can't disagree.
  - It is clamped and smoothed over about 0.5 s.
  - Carried, towed or pushed junk reads several m/s². Junk jostling in a pressurized room reads about 1–2 m/s², and that is after removing the air's own push, which was up to 5 m/s².
  - A bot reacts above 1.5 m/s².
- **Investigate.** A patrolling bot that sees odd junk (in its cone, line of sight to it) switches to `investigate`.
  - It circles the junk at 5.5 m, at 0.55 rad/s, keeping its eye on it, so anything hiding behind gets seen unless you move round it too.
  - It keeps looking while the junk stays odd, and gives up 7 s after it stops.
  - Its cone turns pale gold, so you can read what it's doing.
  - Measured: it reacts to a crate pushed at 3 m/s² within about 0.5 s and circles about 85° in 3.5 s.
- **Gallery in Lantern,** midway along spine B: two sweeping sentry turrets, a bot circling the room, spine B's bot passing through, and six slowly drifting crates and scrap for cover.
- **Bots avoid loose bodies.** On patrol they look 3.5 m ahead along their path and sidestep toward the clear side.

**Fixes found along the way:**
- **A per-frame crash.** Robot lights and vision cones read a body that had been destroyed since the last physics step: a drone smashed during the hangar vent. The per-frame paths now check `pb.alive`.
- **Air-relative steering is for idle station-keeping only** (an idle drone hovering).
  - Robots going somewhere (patrol, hunt, investigate) steer in the world frame again and fight wind with their thrusters.
  - Making everything air-relative let patrol bots ride the dungeon's startup gusts at 12 m/s into fuel tanks.
  - The hangar vent still works, because its drones are idle.
- **Robot spawn and patrol points** now need 2 m clear of *any* matter, loose bodies included.
- **Tests:**
  - The sneak test judges only the bot you're behind. Other bots legitimately investigate.
  - The curious test faces its bot into the gallery before placing the crate.

**Known (dungeon only):** with the new generator mix, seed 3 has pressurized fuel rooms that leak hard at startup. The gusts shove whatever is inside, including bots, into the tanks within half a second. This is a dungeon level-design issue, not robot logic. Lantern isn't affected.

**Revisit if:**
- Investigations feel too sharp or too blind. Tunables: `ODD` 1.5, orbit 5.5 m at 0.55 rad/s.
- Sensors should also hear you, through the knock or clunk sounds.

## 2026-10-12 — The probe looks like a probe (milestone F)

Playtest: "The ship itself should look more like a submarine or deep sea probe", following the user's concept art (`C:/Users/cshel/Pictures/ShipConceptArtMockup.png`). The concept shows a round hull with a rotating ring and four articulated arms. The cutter is an arm, and the grapple is a winch.

**Decision:**
- **Hull.** A round hull, 2.3 × 1.9 m, drawn procedurally at the world's 8 px/m so it matches the pixel matter:
  - off-white plates with seams, grime and shadowed lower plates;
  - a yellow and black hazard band for the ring, with the harpoon **winch drum at its hub**, where the line leaves (the default `com` pivot);
  - a cockpit window and headlamp at the nose, twin rear thrusters with twin plumes, and orange running lights.
- **Collider.** A matching 12-gon. Density 160 → 90 keeps the mass at about 295 kg (from 306), so thrust and handling tuning carry over.
- **Arms** are recolored off-white and yellow, with dark claws.
- **The cutter is a fifth arm** under the nose: two bones of 0.75 m.
  - While firing, its tip swings out toward the aim, up to 1.35 m, stopping 0.2 m short of any wall. When idle it folds under the nose.
  - The beam leaves the tip along the mount → aim line.
  - It is purely kinematic: the tip eases at 16/s, and there's no collider.

**Measured:** the full classic suite passes. Shifts from the new shape:
- Clamp standoff gap 1.85 → 2.48 m.
- Harpoon snug 0.3 → 1.3 s.
- Arm catch 0.14 → 0.7 s.
- Rope heading error is now 3.5–3.7° for both pivots.

**Revisit if:** the round hull snags corners differently in play, or the cutter arm reads as too small at normal zoom.

## 2026-10-12 — Vibration scan (milestone E)

Playtest: "the one downside of the darkness right now is it is hard to tell what is and isn't cuttable". The suggested fix was to let walking on a surface scan it with vibrations and find the hidden innards.

**Decision:** a `Scanner` sends pulses through solid matter.
- **Triggers:**
  - Footfalls while hull-walking send small pulses: 5 m, at most one every 0.45 s.
  - **V** knocks on whatever you're standing on or within arm's reach of: 16 m, with a 0.8 s cooldown, and it makes a clunk.
- **How a pulse travels:** breadth-first from the contact cell through solid cells only, up to the radius. Distance is path length through the matter, so like conducted sound it doesn't jump gaps.
- **What it lights up:**
  - Systems: cores red, conduits orange, sockets blue, pumps green, fixtures yellow, fuel orange-red.
  - Tough material (burn point 0.85 or more) as a dim violet fill, so you can see what will cost the laser.
  - Every surface it reached as a cyan outline. That outlines hidden cavities and rooms behind walls.
- **Display:** the ring expands at 45 m/s, brightest at its front, then fades over 4.5 s. The overlay is drawn additively after the darkness pass, so it reads with the lamp off. It is parented to the scanned object's view, so a scan of a moving body rides along with it.

Measured in Lantern's hall: a knock reaches 4,105 cells and reveals 409 system cells. These are the socket riser, the hall fixture, the floor conduit to the pump, and the breach cavity.

**Why through matter, not a radius:** it's the same rule as conducted sound, and it rewards touching the ship, which is the hull-walking fantasy. It also tells you what is connected to what, which is exactly what you need when tracing power.

**Revisit if:**
- Scans are too free. They're silent to sensors for now, and an obvious next step is to let sensors hear knocks.
- The edge outline is too noisy in dense areas.

## 2026-10-12 — "Lantern": a hand-built level around the tools (milestone D)

Playtest asks:
- The grapple never got long corridors or corners.
- There should be places where it makes sense to vent a room deliberately: grapple in, then blow the enemies out.
- Pressurized transit tubes that push the probe.
- The mashers were too random, too fast and too deadly.

**Decision:** a hand-built derelict, `level/lantern.ts`, is now the default level. The generator stays available as `?level=dungeon`. Lantern has:
- **Two long dark spines** (75 m and 70 m) joined by a 45 m shaft, with hard 90° corners for harpoon swings. Each spine has a security bot walking its length. Spine A has dark alcoves in its ceiling to hide in while the bot passes.
- **A pressurized hangar** under spine A, behind a glass window. You can watch its four idle drones safely, because sensors don't see through glass while light does. Its floor is a 2 m plate hangar door.
  - Cut both ends of the door and the slab blows out.
  - Measured: the hangar empties (gas 1 → 0.22 in 3 s) and 3 of the 4 drones go out with it.
- **The power-and-pressure puzzle** from the lab, at full size:
  - A dock locker holds a battery; you can also cut a drone's core free and use that.
  - A hall socket, a breached chamber, a pump, lamps, and a pressure door. Measured: the door opens 7.3 s after the patch is welded.
- **A transit tube.** Behind the pressure door, the network also runs a station pump. The air flows down a 60 m drop into the vault, then out through exhaust slots to space. Measured: the ship rides it 67 m to the vault in 11 s, peaking at about 20 m/s, without damage.
- **The core** sits in the vault. Extraction is outside the slots.

**Supporting changes:**
- **Flight assist is air-relative.** Ship assist and robot steering hold velocity relative to the local air, weighted by density, instead of relative to the world.
  - In vacuum nothing changes.
  - In a tube current the assist no longer fights the ride. Before, its 700 N brake beat the air's push of about 65 N per m/s, so the ship sat still (0.1 m/s).
  - In a decompression, idle robots go with the wind, which is what makes venting a room clear it. Before, the drones' 4 m/s² station-keeping held against a 3 m/s² gust.
  - The ship gets carried too, unless you're anchored with the harpoon. That's the intended drama.
- **New `drone` entity** for drones placed in the level (idle until an alarm). Spawns go through `freeSpot`.
- **Dungeon crushers** are slower and rhythmic: a 6 s period, a 0.8 s slam, phases staggered across a room. There is now one crusher room in the generator's pool instead of three.

**Known limits:**
- Gas forces only act inside the camera's vertical band (view ± 25 m) because of readback bandwidth. A vent you aren't looking at won't move things. The test watches from just below the hangar.
- The hull is a very large solid mass. Cutting a shortcut through it is possible but slow, which is the soft constraint.

**Revisit if:** the tube is too fast (20 m/s), or the pressure door's hysteresis (open at ≥ 0.6, close below 0.3) traps players when the station leaks.

## 2026-10-12 — Power and pressure in the walls; the lab station (milestone C)

Playtest asks:
- Puzzles about restoring power, which can wake sensors or open doors, and can light things up.
- Using the weld to seal a breach, then restoring power to pressurize a room so a pressure-sensitive door opens.
- Pressure doors that are hard to cut through but open when you pressurize the chamber.
- Taking power from enemies with the grapple and putting it into the ship.

**Decision:** the terrain carries a power network made of matter, with three device types that read it.
- **`PowerNet`** floods `terrain.grid.powered` outward from two kinds of source, through conducting cells only (`energizeFrom`). The cost is the size of the network, not the 8M-cell grid.
  - Built-in `POWER` cells.
  - Live `SOCKET` cells. A socket is live while a powered conductor of a loose body is within two cells of its open face. That body can be a battery prop, or a robot core you've cut free and hauled over, since `POWER` conducts and is its own source. That is the "steal power from enemies" path, and it falls out of the model with no extra code.
  - The network re-floods on any terrain change, and checks the sockets every 10 steps. Loose bodies that carry power energize themselves.
- **Consumers:**
  - `LIGHT` now conducts. Powered fixtures glow through the existing `glows()`, and each cluster casts an omni light (`PowerNet.lights`).
  - `PUMP` cells pour air in at an outlet up to a target.
  - Doors slide open while their motor cell is powered.
  - **Pressure doors** (new `PDOOR` material: burn 1.1, 650 hp, load 3, the toughest thing that can still be cut) open while their chamber's sensor reads at least 0.6 gas, and close below 0.3.
- **Doors move by painting terrain,** like the security bulkheads. Colliders, the gas mask and lighting follow automatically. A hole you cut in a door stays when it closes.
- **`?level=lab`** is a small station that is both the test rig and a sandbox for the loop:
  - a dark hall with a drifting battery, a socket and a fixture;
  - a chamber with a roof breach to space, a pump and a ceiling light, all wired through the walls;
  - a pressurized vault behind a pressure door, holding the salvage core.

**Measured** (`autotest=lab&level=lab`):
- Plugging the battery in makes the socket live: lights on, pump running.
- With the breach open, the chamber leaks and only reaches 0.25 gas in 4 s.
- With the patch welded over the breach (heat the seam, press it on), the chamber fills: 0.26 → 0.39 → 0.52 → 0.66. The pressure door opens 6.8 s after the weld.
- Unplugging the battery switches everything off.

**Why matter and not a wiring graph:** a cut conduit has to really cut the power, and a welded-in core has to really power what it touches. Keeping power in the pixels means no graph can fall out of sync with the matter. Rendering, robots and devices all read one layer.

**Known flake (pre-existing):** the `rope pivot=nose` phase sometimes misses its harpoon shot (`attached:false`). It does the same at the earlier `playtest-2026-10-12` commit, about 1 run in 3: the core is still drifting from the `com` phase when it fires.

**Revisit if:**
- Sockets plug in by accident while debris drifts by. If so, require a held or welded body.
- Batteries should drain. There is no capacity yet.
- Re-floods get frequent on a big powered network. The fix is to scope the re-flood to the network that touches the changed rect.

## 2026-10-12 — Robots have organs on a power network (milestone B)

Playtest: the cutter was overpowered against enemies. The fun was in precision cuts: cutting a door free, or drilling to a drone's red core so it drifts. Enemies should have several vulnerable parts (engines, weapons, sensors) shielded from some angles by material that takes more heat.

**Decision:** robots are built from organs, and a per-cell power layer decides what works.
- **New materials:**
  - `POWER`: the red core. It is the power source and always glows.
  - `CONDUIT`: copper bus that carries power.
  - `THRUSTER`
  - `WEAPON`
  - `EYE`, which now also conducts.
- **`pixel/power.ts` `energize(grid)`** floods outward from the `POWER` cells through the cells that conduct, into `grid.powered`. A robot re-floods its own grid every 4 steps.
- **What each organ does while powered:**
  - Eyes give sight: the vision cone, noticing the lamp, and aiming.
  - The fraction of thrusters still powered scales acceleration and turning.
  - Weapon cells are the gun or the shock prongs.
- **A robot is disabled** (`cause`) and becomes a drifting wreck when:
  - the core drops below 40%;
  - nothing works any more (unpowered);
  - the body breaks up; or
  - it is mostly cut away.
- **The layouts are ASCII art** (`gridFromArt`) and readable at a glance:
  - Both robots have an armored front.
  - The eye sits in an armor plug, with its bus routed around it, so a frontal beam can't drill down a soft channel. The first layout made that mistake, and the test caught it: a frontal kill in 0.8 s.
  - Thrusters and the main bus sit at the soft back.
- **What precision cuts do:**
  - Sever the forward bus and the drone is blind and unarmed, but still flying.
  - Cut the engine bus and it is stranded.
  - Drill in from behind and the core dies in about 0.5 s.
  - From the front, the armor overheats the laser first: about 0.8 heat in 1.5 s, which only blinds it.
- **`grid.powered` also gates emissive glow** (`glows()`), in both the pixel colors and the lightmap. An unpowered eye goes dark, so you can see that a cut worked. Milestone C reuses the same layer to light the derelict's fixtures once a section is re-powered.

**Supporting changes:**
- **Beam radius 0.55 → 0.35 m.** The old beam was as tall as a drone, so precision cuts were impossible.
- **Armor:** 320 hp, heat capacity 2.5, load 2.5.
- **Gas wall mask, breached cells.** A kerf narrower than a field cell, or one straddling two, used to leave both cells over half solid, so the cut never vented. That nearly broke decompression: the vent test kept 0.73 of its gas. Cells that are cut or blasted now stay walls only while at least 7/8 full. Untouched walls keep the half rule, so thin walls still seal. The vent test is back to 0.12.
- **Spawn fix:** 4 of 14 dungeon bots (seed 3) spawned inside furniture or walls and blew apart. Spawn and patrol points now move to the nearest spot with 1.5 m clearance (`Security.freeSpot`). A second bot in a room starts at the opposite corner.
- **Test fix:** the spot/sneak/lit tests now pick a bot whose line of sight ahead (or behind) is clear.

**Why one power layer for everything:** the pixels are the only state. A cut conduit really disconnects whatever is past it. A robot's systems, its glow, and later the derelict's lights, doors and pressure all read the same flood, so none of them can disagree with the matter.

**Revisit if:**
- Robots feel too easy to sneak up on. Bots turn toward any sighting at 4 rad/s, and getting behind one needs stealth or the grapple, which is the intent.
- Re-flooding many robots becomes a cost. It is O(cells), about 400 cells per robot, every 4 steps.

## 2026-10-12 — Heat is physical: burn points, conduction, welding (milestone A)

Playtest: the cutter is the best toy, but it was an eraser. Uncuttable material was annoying, especially in the dark where you can't tell what's what. The user asked for things to glow longer, for some materials to spark, for tough material that has to glow before it burns, and for welding by pressing hot pieces together.

**Decision:** the per-cell `heat` that used to be cosmetic now drives the cutter.
- **Burn points.** The beam pours heat in (`amount / heatCap`). A cell only takes beam damage once it's past its material's burn point, with damage ramping in over 0.12 heat.
  - Soft metal gives almost at once.
  - Armor, girders and machine steel give only at white heat. They also multiply the laser's heat-meter gain (`load`), so a sustained cut through them costs an overheat.
  - Explosions and impacts are not heat-gated.
- **No uncuttable structure.** Frame, piston and stripe are now just very tough. The salvage core is the only exception, because it's the prize.
- **New `ARMOR` material,** for drones and pressure doors later.
- **Conduction.** Heat spreads to neighboring cells (`tune.heat.conduction`), so the metal around a cut glows. Cooling is per material and much slower than before, about 0.3/s against 1.1/s, so cuts stay lit longer. The glow already feeds the lightmap.
- **Sparks** depend on the material under the beam: glass melts quietly, armor showers sparks. The HUD shows `on <material>`, so the beam itself tells you what you're touching.
- **Welding (`Welder`).**
  - Every 4 steps, hot edge cells (at `weldHeat` or above) probe one cell past their open side. Where that lands in another piece, the two are touching.
  - Two pieces weld when there are at least 4 touching pairs and they move less than 1.5 m/s relative to each other at the joint.
  - A body welded to terrain is rasterized into the terrain grid. It becomes structure: static, gas-tight and walkable. The terrain then gets the same connectivity re-check a cut gets, so a piece that only touches at a corner falls straight off again.
  - Two bodies welded together merge into one body in the heavier body's frame, with momentum conserved.
  - Either side being hot is enough, so you can heat the rim of a breach and push a cold plate into it.
  - Machines, the salvage and live robots never weld.

**Why rasterize instead of using joints:** welded matter should *be* the hull. Patching a breach has to seal the gas (the wall mask comes from the terrain grid), take cuts and be walkable. A joint would be a second representation that could disagree with the pixels. The cost is nearest-cell resampling of a rotated piece, about one cell of error at the seam.

**Grace period:** a piece that was just cut free can't weld for 1.5 s. Its edge is white-hot and only one cell from the kerf, so it would otherwise fuse straight back on.

**Tuning:**
- Beam: `glowRate` 6 (from 3), `damagePerSecond` 650 (from 420), so the first hull cell still goes in about a third of a second.
- Measured with a 2 m block: hull loses its first cell at about 0.33 s with laser heat 0.27; armor at about 0.69 s with laser heat 0.58.
- A girder under 1.5 s of beam loses 7 of 207 cells and still glows at 0.4 heat 2.5 s later.

**Revisit if:**
- Welds happen by accident in play, for example debris resting on hull you're cutting near. If so, require a pressing force from contact events rather than just proximity.
- Merging bodies' spin feels wrong. Spin is mass-weighted, not a true angular-momentum merge.

## 2026-10-12 — Conduction is for vacuum

Playtest note: hearing through the hull should only happen in vacuum. Pressurized rooms should sound normal, and decompression should rush.

**Decision:** scale conducted sound by `1 − air at the listener`. In atmosphere the air path takes over, so you hear normal sound, plus wind from gas moving past the ship.

**Why:** a single scale factor keeps the model physical. Air drowns out the hull's ring, so there is no separate mode switch that could get out of sync with the gas field.

## 2026-10-12 — Four arms, and sound by conduction (branch `explore/dark-derelict`)

User request: four articulated arms that grab things you approach slowly and closely (so close debris doesn't need the tether), that walk on the hull with the body swung to face out; and sound for the probe's own systems, air rushing past, clunks against the hull and harpoon hits, conducted through the hull, with airborne sound only in atmosphere.

**Arms** (`src/game/Arms.ts`)
- **Catching is automatic.** A loose body (not machinery, at least 20 kg) is caught when an arm can reach it (rays from each mount, 2.5 m) and it drifts slower than 2.5 m/s relative to the ship. The hold is a fixed joint at the current pose, the same construction as the harpoon clamp, so a held body is a shield or ram and is a crash cushion like clamped debris.
- **E lets go first.** E releases what the arms hold; with nothing held it toggles hull-walking as before. The released body keeps its momentum (tow, then throw) and is ignored until it drifts out of reach, so it isn't re-caught instantly.
- **Fast hits bounce.** A body that slams into the hull faster than the catch speed is knocked away from the arms and not caught on the rebound. Without that, a 6 m/s crate bounced, slowed, and was caught.
- **When the arms catch what the harpoon holds, the line is released.** The arms take over.
- **Walking:** the arms are the feet, purely visual. HullWalk still does the physics. Diagonal pairs alternate. A foot steps when it lags its stance point by max(0.6 m, 0.15 s × speed), and lands ahead by the stride lead (capped at 0.6 m so feet stay in reach). Measuring lag from the stance point without the lead keeps strides long. The first version re-stepped every frame because the led target was out of reach.
- **Facing out:** while walking, the nose points away from the surface and turns toward the aim by up to 0.6 rad, so the lamp and tools can look around. That needed a larger standoff, 1.9 m (was 1.05). Tilted, the tail corners reach 1.55 m below the center. At 1.7 m they scraped the hull, which made the ship wobble and clunk when idle.

**Sound** (`src/audio/`): procedural WebAudio, no sample files.
- **AudioEngine** is long-lived and only synthesizes:
  - Continuous loops: power hum, thruster, RCS hiss, cutter, sizzle, winch, servos, wind, room tone.
  - One-shots: struck plate, thump, boom, click, zip.
  - Three buses:
    - **self:** muffled, with a short metallic ring; brightens in air.
    - **conduct:** lowpassed, with a long synthetic hull ring.
    - **air:** plain.
- **Soundscape** (per run) decides the path for each event:
  - Your ship's own sounds are always heard.
  - Other events need conduction or air.
  - **Conduction** means the event is on something the ship is coupled to:
    - the walked-on surface;
    - what the arms hold;
    - the harpoon target, weighted by how taut the line is;
    - anything with real contact points against the hull.
    - Terrain and machines count as one structure. The harpoon bite is always heard up the line.
  - **Air** needs gas at both ends.
  - In open vacuum with nothing touching, the derelict is silent. That's the point.
  - Wind follows gas density times the gas speed relative to the ship.
- **Impacts sound once, at onset.** Contact-force events repeat every step while bodies rest against each other.
- **M mutes.** The context starts on the first key or mouse press (autoplay rules); headless tests launch Chrome with autoplay allowed.
- **Rejected for now:** a vibration field diffused through solid cells, like heat. It would make cuts between you and a source muffle it, but "same object, distance falloff" was enough to hear whether the idea plays. The vibration field is the planned upgrade.

**Bug fixed along the way.** A Space press made while flying stayed latched in the input (thrust reads held state, and nothing consumed the press). The next time you clamped on with E, it kicked you straight off. Space presses are now consumed every frame.

**Measured** (headless):
- Arms:
  - A 1.2 m/s approach is caught in 0.15 s and carried with the gap unchanged under thrust.
  - Release leaves the crate moving; it isn't re-grabbed.
  - A 6 m/s hit is not caught.
- Walk: 40 m at 5 m/s, gap 1.72–2.08 m, 4 feet planted, idle 0 m/s, no hull scrapes.
- Sound:
  - A far collision in vacuum is silent.
  - Hull bumps clunk on the self bus.
  - A blast 20 m away conducts while clamped to the hull.
  - In a gas puff, wind and an airborne impact are heard.
- Full regression and dungeon/stealth tests pass.

## 2026-10-11 — Hull-walking and camera roll (branch `explore/dark-derelict`)

User request: the ship can attach to the hull and walk around it, and the camera reorients around the ship. The user proposed E to attach and Space to detach.

- **Controls:**
  - E toggles clamping onto the nearest surface (within 2.8 m).
  - A/D walk.
  - Space pushes off at 5 m/s.
  - E was "reel out", so Q now pays out slack. Reel-in is already holding RMB.
- **Surface normal from a sampled gradient:** rings of samples (0.8–2.8 m) are summed into a gradient that points away from matter, weighted by 1/r, then smoothed. Per-pixel normals would jitter on stair-stepped pixel surfaces. The gradient wraps convex corners and blends through concave ones without special cases. Pixel bodies count too, so you can cling to debris or machinery. The feet match the surface's velocity at the contact point, and reaction impulses push back on what you hold.
- **The standoff gap is the shortest of a three-ray fan around -normal.** A single ray along the normal fails in concave corners: the blended normal points into the corner, which is farther away than either wall. Holding the standoff along it pinned the ship into the corner and friction locked it (measured: stuck at 1.35 m along the bisector).
- **Look-ahead slowdown:** the walking speed drops near a wall ahead so the nose turns the corner instead of ramming it.
- **Heading:** nose along the walking direction, belly to the surface, using the same stopping-aware steering as aim (`Ship.steerTo`). The tools still aim at the cursor from the nose, so you can cut and shoot while walking.
- **Camera roll:**
  - Eases toward "surface is down" (3/s), and keeps its angle after you let go, since there is no up in space.
  - `camera.roll` turns it off, for comfort.
  - The stage maps the mouse through the roll.
  - Coverage for the lighting grid, the gas readback band and the background starfield uses the rolled view's bounds and diagonal.
- **Measured on the classic level's outer hull:**
  - 39.7 m walked in 8 s at 5 m/s, wrapping corners (normal 180° → 145° → 90°).
  - Gap stayed between 0.88 and 1.29 m (target 1.05).
  - Roll matched the surface to within 3°.
  - Idle drift was 0.01 m/s; push-off was 4.3 m/s; no damage.
  - In the fuel room the feet shoved loose fuel barrels into walls and set off a chain reaction. That's real physics, so the test uses the outer hull.

## 2026-10-11 — Darkness and light (branch `explore/dark-derelict`)

The user wants to test a different direction: a colossal, empty, dark derelict that you explore with a light, repairing and reawakening it, with puzzles over firefights. This is a prototype on a branch; `main` keeps the lit action version. The first step is darkness plus light.

- **Lightmap, not per-pixel shading.** A fixed 384×256 camera-centered grid. The CPU rasterizes occluders and emitters into it from the pixel grids, which are CPU-authoritative, so light and physics agree on what's solid. A compute pass adds ambient, emission with a little bloom, and every light with a shadow march. A full-view overlay multiplies the scene by the result. The texel size follows the zoom (at least 0.25 m), so the cost doesn't grow when zoomed out. The origin snaps to whole texels so shadows don't shimmer.
  - Rejected: rendering occluders to a render target, which needs alpha tricks in the shared pixel material and a second scene pass. Also rejected: a GPU copy of the terrain, which would need syncing with CPU cuts.
  - The raster was 6 ms in its first naive form. Material lookup tables, precomputed columns, and heat reads only when something is hot brought it to about 1.2 ms.
- **2× multiply with pre-decoded output.** Blend = dst·src + src·dst, so light up to 2 can brighten dark surfaces. The canvas output is sRGB-encoded before blending, so the overlay writes sRGB⁻¹(light/2). That makes the final factor equal the light value, and the tuning numbers mean what they say.
- **Emissive things draw after the overlay** (`ORDER.glow`): sparks, fire, the thruster flame, the shield bubble, sensor cones. They read as light sources and aren't darkened.
- **Ambient:**
  - Starlight in open space.
  - Near-dark over the back wall, which marks the interior.
  - Solid matter gets starlight only on its outer skin, within about 1 m of open space. Without that, the hull's whole mass glowed at starlight level, because the back wall doesn't extend under walls.
  - The back wall's base tint was raised from 0.3 to 0.62, because darkness now comes from lighting. Lit rooms would otherwise stay black.
- **Fixtures are unpowered.** LIGHT cells don't emit; restoring a section is meant to switch them on. Emergency lamps (a seeded 35% of rooms) are dim flickering point lights. The core glows cyan as a beacon, and the extraction zone glows green.
- **Light is visible to sensors.** Sensors emit their own light, so bot and turret cones light the room.
  - **Lamp shining on a sensor:** the sensor notices. Suspicion builds at about half the rate of seeing you, and the sensor turns to look, which usually turns into seeing you.
  - **Lamp off:** sensor range drops to 30% (`light.darkVisibility`). Thrusting and cutting each add 35% back.
  - Tests:
    - `sneak`: dark, behind the bot → no alarm.
    - `lit`: lamp on the bot from behind → alarm in about 1 s on seed 3.
    - `spot`: unchanged.
- **TSL gotcha:** nested `Loop`s both declare `i` unless named. Expressions built from the outer counter get inlined into the inner loop and read the inner one. No error is raised; the symptom was light passing through walls. Loops are now named, and per-light values are pinned with `toVar()`.

## 2026-10-10 — Aim steering: the ship faces the cursor; Space thrusts

The user wanted "a minor change with a major impact": the ship always accelerates itself to turn toward the cursor, with no A/D or S, and thrust on Space.

- **Steering profile:** desired spin = sign(err) · min(turnRate, 0.85·√(2·turnAccel·|err|), 14·|err|). That's the fastest spin that can still brake to zero by the target angle, plus a linear tail so it settles without chatter. It's applied as bounded torque, so impacts and loads still knock the ship around and it recovers. Measured: a 90° swing settles in 0.5 s and 180° in 0.84 s, with 0° overshoot. Within 1.5 m of the ship the cursor is ignored, so the heading doesn't whip around when you aim at yourself.
- **Removed:** reverse thrust, the A/D turn input (`Controls.turn`), and the `rotationAssist` toggle; steering is always on. Flight-assist RCS braking is unchanged and is now the only way to slow down besides turning around and burning.
- **The rope pivot matters more now:** with the tether at the center of mass, the ship holds its aim while towing: the max heading error stayed at about 5° across test runs. At the nose, the load can drag the aim off, and the steering has to fight it; that varies with geometry, from 26.5° in one isolated run to 3° in another.

## 2026-10-09 — Laser push + heat meter, recharging shields

The user asked: "The laser should also push things. The ship should have recharging shields. The laser should have limited use with a heat meter that has a cooldown if it fills up."

- **Laser push:** while the beam hits a loose pixel body, 600 N is applied at the hit point along the beam ("radiation pressure", tuned for fun). The first try was 1400 N; it flung a partly cut crate at 17 m/s. Machines are kinematic and ignore it.
- **Heat meter:** firing adds 0.22/s, so about 4.5 s from cold to overheat. Idling cools it at 0.45/s. Overheating locks the laser until it has cooled all the way to 0 (0.4/s, so about 2.5 s), with smoke at the nose and a blinking HUD bar. A lockout until fully cool, rather than until just below full, makes overheating a real cost. Cutting through thick hull now takes pacing: the roof-cut test pauses between cuts.
- **Shields:** a 60-point pool soaks damage before the hull. Recharging starts 2.5 s after the last hit, at 20/s. A cyan bubble flashes when it soaks a hit and blips when full again. Crushing (infinite damage) bypasses it. With full shields, a 12 m/s crash (57 damage) costs no hull, which is intended: shields buy you one mistake.

## 2026-10-09 — Crash damage from physics; held debris is a cushion; visible sentries

**User feedback:** "When grappling, if I hold reel in I avoid damage even if I link into something else … the winch speed [should be] slow and safe, but we still base damage on the physics speed." Then: "I do want the grappled item to not cause damage and to work as a shield. That is fun even if it isn't realistic … imagine the ship has arms to hold the debris close and use it as a cushion." And: "The turret doesn't seem to shoot and I don't see any sweeping vision cones."

- **Ship crash damage = the ship's velocity change in a physics step in which it touched something.** The old rule (contact force above 30 kN) was replaced. That's the impact speed the user means by "physics speed". Up to 3.5 m/s is free, then 6 hp per m/s: 6 m/s costs 9 hp, 12 m/s costs 57, and about 20 m/s is fatal. Gentle pushing (thrusting into a crate, riding a mover) never registers. Machine crushing stays force-based and instant.
- **Held debris is a cushion and shield.** Contact with the loose pixel body you're tethered or clamped to doesn't count as touching. So the ship isn't hurt by it, and when only the held body hits something (the clamped crate rams a wall) the jolt through the clamp doesn't count either. Tested: a clamped crate ramming the hull at 12 m/s left the ship at 100 hp. Terrain you're anchored to gets no pass; that was the "hack" the user objected to.
- **The winch is slow (4 m/s), easing toward ~1 m/s** as the line shortens, so docking is safe by physics rather than by exemption.
- **Turrets are sentries now.** Idle, they sweep a narrow scanning cone (±0.22 rad, 30 m) across their arc. Holding you in it builds suspicion fast (about 0.6 s), and they raise the alarm themselves. Previously they slept until a bot raised the alarm, so a player who never got spotted by a bot never saw one fire.
- **Cones are readable:** bright edge lines with a faint fill. The patrol fill had been 8% additive and was effectively invisible, while the alarm fill, at its first fix, covered the play area.
- **Patrol bots** are added to about 45% of ordinary rooms past depth 2. With only 4 security rooms out of 30+, a run could miss them all.

## 2026-10-09 — Security: vision-cone bots, alarm, bulkheads, turrets, drones

The user asked for security bots with vision cones you can evade, and every alarm response.

- **Robots are pixel bodies with controllers.** Bounded thrust means the ship can out-muscle them on a tether, and they can be harpooned, thrown, cut and blown up. A robot dies when its glowing EYE cells are destroyed, its body is broken, or under 40% of it remains; the wreck stays as debris.
- **Security bots** patrol their room, sweeping a 70° cone with an 18 m range. The cone is drawn clipped by matter, so walls and crates visibly block sight. Suspicion builds while the bot can see you and decays when it can't: about 0.6 s point-blank to about 2 s at the cone's edge. The first pass (about 0.45 s) left no time to break line of sight. At full suspicion the bot raises the alarm, hunts, and shocks you on contact at 18 hp/s.
- **Alarm:** ship-wide, ending 28 s after the last sighting. Any bot, drone or turret sighting refreshes the timer and the last known position.
  - Bulkheads within 48 m seal: BULKHEAD slabs slide into the doorway specs over 0.8 s. They're terrain, so you can cut through, blast, or cut the edges and harpoon the slab out. Sealed doors stay sealed after the alert.
  - Turrets wake. They track within ±77° of their wall normal, lead their shots, and die when 65% of the housing is cut away.
  - Drone bays within 140 m launch three drones each, capped at 12. Drones hold about 10 m, strafe, and fire led shots.
- **Nav field:** 2 m blocks with a BFS distance field toward the last known position, so any number of hunters can follow corridors without per-robot pathfinding. It's rebuilt when an alarm starts, to include anything cut since.
- **Bullets** sweep each step. They chip pixels, robots included, so friendly fire happens. The ship is hit by a circle test.
- **Testing lessons:**
  - Placements must be validated, because teleporting into terrain registers MN-scale contact forces and kills the ship ("impact").
  - Damage causes are tagged: impact, heat, explosion, shot, shocked, crushed.
  - Autotest logs are JSON, because Chrome's console preview truncates objects and hid fields.

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
