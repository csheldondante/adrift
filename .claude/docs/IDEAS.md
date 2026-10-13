# Ideas Backlog

A running list of design ideas so nothing gets lost. Newest directions near the top.
Each entry has a **Status**:
- *idea*: not built.
- *exploring*: being prototyped.
- *built*: in the game; see `docs/DECISIONS.md`.
- *dropped*: abandoned, with the reason.

Built decisions and their rationale live in `docs/DECISIONS.md`. This file is for things we haven't committed to.

---

## Making it a game: playtest notes and roadmap (user, 2026-10-12)

**Status:** in progress. A (materials and heat), B (robots with powered organs), C (power and pressure in the walls, `?level=lab`) D (the hand-built "Lantern" level, now the default) and E (vibration scan: V, footfalls) built 2026-10-12; see DECISIONS.

**What works (keep and build on):**
- The laser cutter: the most fun thing, especially precision cuts.
- Explosive decompression.
- The grapple: janky and hard to use, but great as an anchor during decompression and for whipping round corners.
- Hull-walking.
- Sound tied to what you touch. This should apply in vacuum only: decompression should rush, and pressurized rooms should sound normal. *Fixed 2026-10-12.*
- Dark rooms you light with the lamp.

**What doesn't work:**
- The cutter is overpowered against enemies and under-used everywhere else.
- Uncuttable things are annoying, and in the dark you can't tell what is cuttable. Prefer soft limits, like the laser overheating before you get through very much.
- The grapple never gets long corridors or corners that call for it.
- The mashers are too random, too gamey, too fast and too deadly.
- The ship should look like a submarine or deep-sea probe. The concept art (C:/Users/cshel/Pictures/ShipConceptArtMockup.png) shows:
  - a round hull with a rotating ring and four articulated arms;
  - magnetic feet and gripper claws;
  - the cutter as one of the arms;
  - the grapple as a winch.

**Ideas, grouped:**

1. **The material and heat model** (the foundation for most of the rest)
   - Cut areas glow white-hot and stay glowing longer, since the light is cool.
   - Some materials spark while being cut.
   - Hard materials soak heat and glow before they burn at all.
   - Weld by pressing hot pieces together.
2. **Precision targets**
   - Enemies have several vulnerable parts (power core, engines, weapons, sensors), shielded from some angles by heat-resistant armor.
   - Drill to the red core and the drone goes dead and drifts.
   - The derelict has internals worth cutting to as well.
3. **Vibration scan**
   - Walking the hull lets you scan it with vibrations to reveal hidden internals: conduits, cores, voids.
   - This solves "what is cuttable or worth cutting in the dark".
4. **Ship systems in the walls**
   - Power and pressure networks.
   - Restoring power lights rooms, opens doors and wakes sensors.
   - Pressure doors are hard to cut but open when their chamber is pressurized.
   - Puzzle chain: weld a hull breach, restore power, the room repressurizes, the pressure door opens.
5. **Steal power**
   - Harpoon an enemy's power and carry it into the ship's network.
6. **Stealth rooms**
   - Rooms full of scanners; hide behind debris.
   - Probes investigate debris that moves oddly and fly around it, so you have to keep repositioning.
7. **Level geometry that uses the tools**
   - Long corridors and sharp corners for grapple swings.
   - Rooms built to be vented deliberately: grapple in and blow the enemies into space.
   - Pressurized transit tubes that push the probe along.
   - Replace the mashers with slower, readable, purposeful machinery.
8. **Probe redesign**
   - Submarine or deep-sea-probe look.
   - The cutter on an arm, the grapple as a winch.

**Proposed order:**
- **A. Materials and heat:** glow, sparks, armor, weld, soft overheat.
- **B. A drone with weak points:** a core, armor, and engine, weapon and sensor parts.
- **C. Power and pressure networks in the walls**, with pressure doors and breach-welding; the first real puzzle.
- **D. A hand-built level** with corridors, a vent trap and a transit tube.
- **E. Vibration scan.**
- **F. Probe visuals:** cutter arm and winch.
- **G. Stealth rooms with curious probes.**

## Direction: the colossal dark derelict (2026-10-11)

**Status:** exploring on branch `explore/dark-derelict`, which is a prototype.
- Built: darkness, shadowed lighting, headlamp (F), emergency lamps, sensors that emit light and notice the lamp. See DECISIONS 2026-10-11.
- Built: hull-walking (2026-10-11), four arms and sound by conduction (2026-10-12).
- Next: better levels (see open threads), then a first repair puzzle.

The ruined ship is colossal, empty and dark. Your ship carries a light to explore by. You repair things, avoid sensors and security, and gradually reawaken parts of the ship. Progress is puzzle-driven, and the goal is to reach the artifacts.

- **The light is the core mechanic.** You need it to see, and sensors can see it. Killing your light to slip past a sensor sweep gives stealth tension without combat.
- **Visible progress:** repaired sections stay lit and start moving again. The minimap fills in, Metroid-style.
- **Puzzles from existing systems:**
  - The harpoon drags power cells into sockets.
  - The cutter severs or heats conduits and fuses.
  - Venting a room pushes things.
  - The gas field could carry power or coolant through the ship.
- **Pacing:** fewer threats that matter more. Security is something you wake, avoid or repurpose; it isn't the main enemy. Scale comes from the parallax layers and empty dark, not from more rooms.
- **Rendering:** a 2D lighting pass with shadows cast against the pixel solids. The GPU already has a solid mask for the gas field, so the light can trace through the same data. A light cone from the ship, plus permanent lights in restored sections.
- **First puzzle to test the loop:**
  1. Restore power to a section by hauling a cell to a socket.
  2. Bridge a cut conduit.
  3. The section lights up and a door opens.

## Hull-walking with a reorienting camera (2026-10-11)

**Status:** exploring; first version built on `explore/dark-derelict` (see DECISIONS 2026-10-11).

Controls: **E** attaches or lets go, **A/D** walk, **Space** pushes off, **Q** pays out the tether.

Still to try:
- Walking on moving machinery: it works in principle but is untested.
- A comfort toggle in the UI. The `camera.roll` tunable exists.
- Footsteps conducted as sound.
- Whether the camera should ease back toward a "home" orientation after a long flight.

The ship can attach to the hull and walk around it. Once attached, the camera rotates so the surface you're on is "down".

- **Surface normal:** use the gradient of solid occupancy in a radius of about 1.5 m, not per-pixel directions, so jagged pixel steps don't make the ship jitter. Hold the ship to the surface with a soft spring. Convex corners wrap around and concave corners hand off to the next surface, both by sampling the normal continuously.
- **Camera roll:** eases toward the surface normal. On detach, keep the last orientation rather than snapping to world-up, since there is no up in space. Damp the roll heavily, and offer an option to turn it off for motion-sickness comfort.
- **What already works:** aim is world-space, so mouse steering and the harpoon work at any camera roll. The minimap stays world-aligned and shows an indicator for your current "down".
- **Synergy with the dark derelict:** flying is fast and loud; hull-walking is slow, precise and quiet. Hull-walking is also the posture for repairs: clamp onto a junction box, crawl along a conduit to trace it, or cling to a moving structure while a sensor sweeps past.
- **Edge cases:** thin walls, edges of moving machinery, held debris, being cut free (the surface vanishing under you).

## Four arms (2026-10-12)

**Status:** first version built on `explore/dark-derelict` (see DECISIONS 2026-10-12).
- The arms catch slow debris automatically, E lets go, and they are the feet when hull-walking. The nose faces out.

Still to try:
- Pull a caught body in snug, rather than holding it wherever it was caught. It's often held one-armed at arm's length.
- Arms as tools: hold a power cell to a socket, turn a valve, pry a panel.
- A carry limit by mass.
- Per-arm grips, so cutting the cell under a hand loosens the hold.
- Walking with something held.
- A gentle throw on release.

## Sound by conduction (2026-10-11)

**Status:** first version built (see DECISIONS 2026-10-12). Procedural WebAudio:
- Self, conduct and air buses.
- Conduction runs through whatever you touch, hold or have harpooned.
- Wind and room tone come from the gas field.

Next:
- A vibration field through solid cells, so cuts muffle sound.
- Bots and movers making noise.
- Sensors hearing your clanks.
- A tension creak on the tether.

The original idea follows.

There's no air in most of the derelict, so sound is mostly physical. The player hears three things.

1. **Your own ship, always.** Maneuvering jets, the main thruster, the cutter, the winch, clamps and the shield. Sound travels through your own frame, so it's close, mechanical and a little muffled.
2. **Conduction through contact.**
   - While touching, clamped to or walking on a structure, you hear metallic sounds traveling through it: impacts, machinery, crushers, bots moving, explosions, and debris hitting the hull.
   - The tether conducts too, weighted by tension. A taut line rings; a slack one is nearly silent.
   - Conducted sound is filtered: low thumps and metallic ringing and resonance, with no crisp highs.
3. **Air, only where there's atmosphere.**
   - In pressurized rooms, sound behaves normally.
   - Wind noise comes from gas moving past the ship, as when a room vents or a breach whistles. The volume follows gas density at the ship and the speed of the gas relative to it.

**Implementation sketch:**
- Sources emit events (impact, machine, explosion, cutter, etc.) with a world position and an energy.
- The listener receives each event through whichever channels connect it to the source: self, conduction or air.
- **Conduction path:** is the source on the same connected solid as the body you're touching? We already compute components with flood fills. Attenuate by the distance through solid. Later, this could become a GPU vibration field that diffuses through solid cells, like the heat field.
- **Air path:** gas density at both ends, and along the line between them.
- WebAudio with procedural synthesis where possible: filtered noise for jets and wind, modal or ringing filters for metal.

**Gameplay hooks:**
- In the dark, sound is information. Clamping to the hull lets you hear a bot crawling two rooms away. That's a reason to touch the ship.
- **Symmetry:** sensors could hear your clanks through the hull too. Clamping on hard makes noise; crawling is quiet.

---

## Grapple play (from earlier sessions)

**Status:** mostly built; these are the remaining ideas.

- Attach to detritus and use it as a visual or physical shield. *Built:* clamp plus the held-debris cushion. Visual cover could also matter in the dark: a held slab blocks sensor sight lines.
- Tow detritus, then release so it flies on into things and knocks them out of the way. *Works physically* (release keeps momentum); worth a level that asks for it.

- Round corners with the tether; slingshot.
- Grab hazards or explosives and whip them into enemies or obstacles.
- Shoot out a door's bolts, then pull the door off its hinges.
- Winch close, clamp, and use the held object as a shield or battering ram. *Built.*

## More pressurized air sources (2026-10-11)

**Status:** idea.

The user wants more of them. Options:
- Pressurized rooms in the generated dungeon (currently only the classic level has one).
- Air tanks and canisters as props. Cutting one gives a jet, or a thrust source if you tow it.
- Burst pipes along corridors that blow gusts.

These also feed sound by conduction: atmosphere is where you hear things through the air.

## Firefight modes (from the design brief)

**Status:** idea, deferred. Local or vs-AI only.

## Known open threads in the current build

- **Levels are bad** (user, 2026-10-11, playing the dark build): the lighting is fun, but the generated levels don't serve it yet. Probably needs colossal hand-shaped spaces, landmarks and puzzle rooms rather than dense room grids.
- Sealed bulkheads stay sealed after an alarm ends.
- The nav field is only rebuilt when an alarm starts.
- Drones exist only during alarms.
- Gas/heat CPU coupling only works inside the camera band.
- The rope's pull on the heading varies a lot with the nose pivot (3° to 26°). The `rope pivot=nose` test also misses its shot about 1 run in 3. This predates the 2026-10-12 work.
