// Draw order for the 2D stack (no depth testing; renderOrder decides everything).
// Background layers use negative values; add new bands between existing ones.
export const ORDER = {
  bgStars: -50,
  bgPlanet: -45,
  bgGiant: -40,
  bgMid: -30,
  bgDust: -20,
  backWall: -10,
  zone: -5,
  terrain: 0,
  bodies: 10,
  ship: 20,
  particles: 30,
  light: 35, // darkness overlay: multiplies everything drawn before it by the lightmap
  glow: 36, // emissive things drawn after the overlay (sparks, flames, sensor cones)
  field: 40,
  fx: 50,
  debug: 60,
} as const;
