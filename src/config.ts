// World scale constants (fixed at startup) and live tunables (edited from the debug panel).

/** Meters per pixel cell. All physics runs in meters. */
export const CELL = 0.125;
/** Terrain size in cells. */
export const WORLD_W = 1024;
export const WORLD_H = 768;
/** Terrain collider chunk size in cells. */
export const CHUNK = 32;
/** Pixel cells per gas-field cell. */
export const FIELD_SCALE = 4;

export const FIXED_DT = 1 / 60;

/**
 * Live tunables. Systems read these every frame, so the debug panel can edit them in place.
 * Grouped by system so new systems add a group rather than growing a flat bag.
 */
export const tune = {
  ship: {
    thrust: 2600, // N
    reverseThrust: 1500, // N
    turnRate: 4.5, // rad/s max spin from A/D
    turnAccel: 45, // rad/s² (spin-up and braking; torque scales with inertia)
    density: 160, // kg/m² (ship collider, ~300 kg)
    rotationAssist: true, // brakes spin when A/D released
    flightAssist: true, // RCS jets brake drift when not thrusting (visible as side puffs)
    brakeForce: 700, // N of braking from the RCS jets (≈2.3 m/s² unloaded)
    maxHealth: 100,
    impactDamageThreshold: 30000, // contact force (N) before hull damage starts (~1.7 m/s bump)
    impactDamageScale: 0.0002,
    heatDamage: 25, // hp/s at heat 1
  },
  grapple: {
    maxLength: 22, // m of rope on the spool
    minLength: 1.5,
    reelSpeed: 5, // m/s (Q/E)
    segmentLength: 0.5, // m per physical rope segment
    segmentMass: 0.35, // kg per segment (whole cord ≈ 15 kg) — light vs the head so it unfurls
    segmentDamping: 1.5, // linear damping on segments: slack rope drifts and settles, no jitter
    /** Where the rope attaches to the ship: center of mass (no torque) or nose (tension steers the ship). */
    pivot: 'com' as 'com' | 'nose',
    hookSpeed: 16, // m/s launch speed of the head (plus ship velocity); slows as it drags rope out
    hookMass: 6, // kg; heavier head = carries the coil further
    tightenSpeed: 6, // m/s gentle auto-winch after the hook bites, until the rope is taut
    snugTension: 1500, // N sustained tension at which the auto-winch considers the rope snug
    retractSpeed: 10, // m/s reel-in after a miss
    hangTime: 0.8, // s a missed hook hangs at full extension before reeling home
    stiffness: 40000, // N per unit strain (EA): 3000 N tow ≈ 7.5% stretch
    damping: 0.9, // fraction of critical damping on the stretch spring (high = no bounce-chatter)
    maxStretch: 0.15, // hard limit beyond the spring
  },
  cutter: {
    radius: 0.55, // m
    damagePerSecond: 420, // hp/s at beam center
    range: 16, // m
    heat: 0.9, // heat injected per second
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
  debug: {
    showColliders: false,
    showField: true,
  },
};

export type Tune = typeof tune;
