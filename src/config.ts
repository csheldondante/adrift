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
    density: 160, // kg/m² (ship collider, ~300 kg)
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
    snugTension: 400, // N sustained pretension at which the fast winch hands over to take-up
    autoTakeUp: true, // keep reeling in slack while attached (rope stays straight); E pays out
    takeUpSpeed: 4, // m/s take-up winch
    stiffness: 40000, // N per unit strain (EA): 3000 N tow ≈ 7.5% stretch
    damping: 0.9, // fraction of critical damping on the stretch spring
    maxStretch: 0.15, // hard limit beyond the spring
  },
  cutter: {
    radius: 0.55, // m
    damagePerSecond: 420, // hp/s at beam center
    range: 200, // m (effectively unlimited; the raycast stops at the first solid pixel)
    heat: 0.9, // gas-field heat injected per second
    glowRate: 3, // visual surface heat per second at the beam center (1 ≈ bright orange)
    push: 600, // N pushed onto a loose body the beam is hitting (radiation pressure, tuned for fun)
    heatPerSecond: 0.22, // laser heat gained while firing (≈4.5 s from cold to overheat)
    coolPerSecond: 0.45, // laser heat lost while not firing
    overheatCoolPerSecond: 0.4, // when overheated: locked out until it has cooled all the way down
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
    reach: 2.8, // m from the surface at which E can clamp on
    standoff: 1.05, // m from ship center to the surface while walking
    stiffness: 8, // 1/s: standoff error -> normal speed
    landSpeed: 4, // m/s max approach/retreat speed of the feet
    footAccel: 60, // m/s² grip (normal hold, and braking when idle)
    accel: 25, // m/s² walking acceleration
    speed: 5, // m/s walking speed
    pushOff: 5, // m/s kick away from the surface on Space
    normalSmoothing: 10, // 1/s surface-normal smoothing
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
