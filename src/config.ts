// World scale constants (fixed at startup) and live tunables (edited from the debug panel).

/** Meters per pixel cell. All physics runs in meters. */
export const CELL = 0.125;
/** Terrain size in cells. */
export const WORLD_W = 4096;
export const WORLD_H = 2048;
/** Terrain collider chunk size in cells. */
export const CHUNK = 32;
/** Pixel cells per gas-field cell (1 m). Walls ≥ 7 cells thick always seal. */
export const FIELD_SCALE = 8;

export const FIXED_DT = 1 / 60;

/**
 * Live tunables. Systems read these every frame, so the debug panel can edit them in place.
 * Grouped by system so new systems add a group rather than growing a flat bag.
 */
export const tune = {
  ship: {
    thrust: 2600, // N
    turnRate: 4.5, // rad/s max spin from A/D
    turnAccel: 45, // rad/s² (spin-up and braking; torque scales with inertia)
    density: 90, // kg/m² (round 2.3 × 1.9 m hull, ~306 kg)
    flightAssist: true, // RCS jets brake drift when not thrusting (visible as side puffs)
    brakeForce: 700, // N of braking from the RCS jets (≈2.3 m/s² unloaded)
    maxHealth: 100,
    shieldMax: 60, // recharging shield that soaks damage before the hull
    shieldRegen: 20, // shield per second once recharging
    shieldDelay: 2.5, // s without taking damage before the shield starts recharging
    contactEventThreshold: 1500, // N: contact force at which the ship registers that it touched something
    safeImpactSpeed: 3.5, // m/s velocity change in one contact step that the hull shrugs off
    impactDamagePerSpeed: 6, // hp per m/s above the safe speed (12 m/s crash ≈ 50 hp, ~20 m/s is fatal)
    heatDamage: 25, // hp/s at heat 1
    crushForce: 400000, // N contact force from a machine that counts as being crushed (instant death)
  },
  grapple: {
    maxLength: 26, // m harpoon range / rope on the spool
    minLength: 1.5,
    reelSpeed: 7, // m/s (Q/E)
    segmentLength: 1.0, // m per physical rope segment (fewer, longer links = straighter taut rope)
    segmentMass: 1.0, // kg per segment
    segmentDamping: 0.6, // linear damping on segments: slack settles without jitter
    internalDamping: 12, // 1/s: segment velocity pulled toward neighbors' average (kills string wobble)
    chordDamping: 10, // 1/s: when taut with a clear line, segments are pulled onto the straight line
    /** Where the rope attaches to the ship: center of mass (no torque) or nose (tension steers the ship). */
    pivot: 'com' as 'com' | 'nose',
    hookSpeed: 70, // m/s harpoon muzzle speed (plus ship velocity)
    hookMass: 6, // kg; its momentum is delivered to whatever it thunks into
    recoil: 100, // N·s kick on the ship when firing
    biteSlack: 1.15, // rope length at impact = distance × this (visible slack bow)
    tightenSpeed: 12, // m/s winch that snaps the slack taut after impact
    winchSpeed: 4, // m/s winch while RMB is held (slow enough that docking is under the safe impact speed)
    holdToWinch: 0.18, // s: RMB held longer than this winches; a shorter click releases
    retractSpeed: 60, // m/s head returning after a miss
    standMassRatio: 3, // winched against a body at least this many ship masses: the feet clamp on and the line lets go
    ripTension: 900, // N: a hooked power core tears out of its housing past this pull
    snugTension: 400, // N sustained pretension at which the fast winch hands over to take-up
    autoTakeUp: true, // keep reeling in slack while attached (rope stays straight); E pays out
    takeUpSpeed: 4, // m/s take-up winch
    stiffness: 40000, // N per unit strain (EA): 3000 N tow ≈ 7.5% stretch
    damping: 0.9, // fraction of critical damping on the stretch spring
    maxStretch: 0.15, // hard limit beyond the spring
  },
  cutter: {
    radius: 0.35, // m (kerf ≈ 0.7 m: narrow enough to pick out a robot's parts)
    damagePerSecond: 650, // hp/s at beam center, once a cell is past its burn point
    range: 200, // m (effectively unlimited; the raycast stops at the first solid pixel)
    heat: 0.9, // gas-field heat injected per second
    glowRate: 6, // heat energy per second at the beam center (hull: 1 heat ≈ bright orange; burns above 0.5)
    push: 600, // N pushed onto a loose body the beam is hitting (radiation pressure, tuned for fun)
    heatPerSecond: 0.22, // laser heat gained while firing (≈4.5 s from cold to overheat)
    coolPerSecond: 0.45, // laser heat lost while not firing
    overheatCoolPerSecond: 0.4, // when overheated: locked out until it has cooled all the way down
    weldSpread: 3, // Shift: the beam defocused this many times wider...
    weldPower: 0.12, // ...at this fraction of the power (heat, damage, push, laser load)
  },
  heat: {
    conduction: 4, // 1/s heat exchange between neighboring cells (the glow spreads around a cut)
    weldHeat: 0.5, // fraction of a material's burn point at which pressed-together pieces fuse (glowing, not yet burning away)
    weldMinCells: 4, // hot touching cell pairs needed for a weld
    weldSpeed: 1.5, // m/s max relative speed at the joint (pressed, not bumped)
    weldGrace: 1.5, // s after a piece is cut free before it can weld (else it re-fuses across the kerf)
  },
  gas: {
    stiffness: 900, // pressure -> flow acceleration (field units)
    damping: 0.996, // per-substep face-velocity retention
    pushStrength: 60, // drag coefficient for gas flow pushing bodies
    heatDiffusion: 2.0,
    heatDecay: 0.5, // per second
  },
  hazard: {
    enabled: true,
    explosionRadius: 3.2, // m
    explosionDamage: 900,
    explosionImpulse: 900, // N·s at center for a 1 m² body
    explosionGas: 6,
    explosionHeat: 2.5,
    ignitionHeat: 1.6,
    chainDelay: 0.09, // s
  },
  impact: {
    eventThreshold: 2000, // N contact force before pixel bodies report impacts
    damageImpulse: 250, // N·s per hit before pixel matter takes damage
    damageScale: 0.5, // hp per N·s above threshold
    damageRadius: 0.5, // m
    detonationDv: 7, // m/s velocity change in one hit that sets off an explosive body
  },
  pixel: {
    debrisMinCells: 10, // components smaller than this become particles
    detachCap: 24000, // flood-fill cap; larger floating regions stay static
  },
  physics: {
    solverIterations: 8, // applied on restart; more = stiffer joints/rope, more CPU
  },
  walk: {
    reach: 3.4, // m from the surface at which E can clamp on
    standoff: 1.9, // m from ship center to the surface while walking (tail corners clear at any lean: hull reaches 1.55 m)
    lookAngle: 0.6, // rad the nose may turn from straight out toward the aim
    stiffness: 8, // 1/s: standoff error -> normal speed
    landSpeed: 4, // m/s max approach/retreat speed of the feet
    footAccel: 60, // m/s² grip (normal hold, and braking when idle)
    accel: 25, // m/s² walking acceleration
    speed: 5, // m/s walking speed
    pushOff: 5, // m/s kick away from the surface on Space
    normalSmoothing: 10, // 1/s surface-normal smoothing
  },
  arms: {
    upper: 1.25, // m upper arm
    fore: 1.25, // m forearm (reach = upper + fore from the mount)
    grabSpeed: 2.5, // m/s: loose bodies slower than this relative to the ship can be grabbed (E) or fended off
    fendStandoff: 1.6, // m from an arm's mount: slow debris is eased back out past this
    fendStiffness: 6, // 1/s² per m inside the standoff (times the reduced mass)
    fendDamping: 3, // 1/s on the closing speed
    fendForce: 900, // N an arm can push with
    guideStiffness: 14, // 1/s²: placing a held body (auto-plug), spring toward the target pose
    guideDamping: 7, // 1/s
    guideForce: 1800, // N the arms can place with
    guideTorque: 900, // N·m
    minMass: 20, // kg: lighter scraps are ignored
    frontSpread: 0.8, // m out along the surface from under the front mounts (walking stance)
    rearSpread: 1.3, // m, rear mounts
    stepDistance: 0.6, // m a planted foot may lag its stance point before it steps
    stepTime: 0.17, // s per step at a standstill (faster when walking fast)
    stepLift: 0.35, // m arc height of a step
    strideLead: 0.18, // s of walking velocity the stance point leads by
    maxLead: 0.6, // m cap on that lead (feet stay within reach)
  },
  audio: {
    volume: 0.7, // master (M mutes)
    muted: false,
    conductRange: 45, // m: conducted sound falls to half at this distance through structure
    airRange: 12, // m: airborne sound falls to half at this distance
  },
  camera: {
    roll: true, // camera turns so the surface you walk on is down (keeps its angle after you let go)
    rollRate: 3, // 1/s
  },
  light: {
    enabled: true, // darkness + lightmap overlay
    lampRange: 30, // m, ship headlamp
    lampHalf: 0.42, // rad half-angle of the headlamp cone
    lampIntensity: 2.2,
    ambientInterior: 0.16, // light level inside the derelict (over the back wall)
    ambientSpace: 0.75, // starlight in open space
    darkVisibility: 0.3, // sensor range multiplier when the lamp is off and you are quiet
    roomLightChance: 0.35, // fraction of rooms with a flickering emergency light
  },
  debug: {
    showColliders: false,
    showField: true,
  },
};

export type Tune = typeof tune;
