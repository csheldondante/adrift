# Ideas Backlog

A running list of design ideas so nothing gets lost. Newest directions near the top.
Each entry has a **Status**:
- *idea*: not built.
- *exploring*: being prototyped.
- *built*: in the game; see `docs/DECISIONS.md`.
- *dropped*: abandoned, with the reason.

Built decisions and their rationale live in `docs/DECISIONS.md`. This file is for things we haven't committed to.

---

## Direction: the colossal dark derelict (2026-10-11)

**Status:** exploring on branch `explore/dark-derelict`, which is a prototype.
- Built: darkness, shadowed lighting, headlamp (F), emergency lamps, sensors that emit light and notice the lamp. See DECISIONS 2026-10-11.
- Next: hull-walking, then a first repair puzzle.

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

**Status:** idea; next on the branch.

Proposed controls: **E** attaches to the hull when you're near it, and **Space** detaches with a push-off. E is currently "reel out", so reel moves elsewhere.

The ship can attach to the hull and walk around it. Once attached, the camera rotates so the surface you're on is "down".

- **Surface normal:** use the gradient of solid occupancy in a radius of about 1.5 m, not per-pixel directions, so jagged pixel steps don't make the ship jitter. Hold the ship to the surface with a soft spring. Convex corners wrap around and concave corners hand off to the next surface, both by sampling the normal continuously.
- **Camera roll:** eases toward the surface normal. On detach, keep the last orientation rather than snapping to world-up, since there is no up in space. Damp the roll heavily, and offer an option to turn it off for motion-sickness comfort.
- **What already works:** aim is world-space, so mouse steering and the harpoon work at any camera roll. The minimap stays world-aligned and shows an indicator for your current "down".
- **Synergy with the dark derelict:** flying is fast and loud; hull-walking is slow, precise and quiet. Hull-walking is also the posture for repairs: clamp onto a junction box, crawl along a conduit to trace it, or cling to a moving structure while a sensor sweeps past.
- **Edge cases:** thin walls, edges of moving machinery, held debris, being cut free (the surface vanishing under you).

## Sound by conduction (2026-10-11)

**Status:** idea.

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

- Sealed bulkheads stay sealed after an alarm ends.
- The nav field is only rebuilt when an alarm starts.
- Drones exist only during alarms.
- Gas/heat CPU coupling only works inside the camera band.
- The rope's pull on the heading varies a lot with the nose pivot (3° to 26°).
