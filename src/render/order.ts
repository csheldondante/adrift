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
  field: 40,
  fx: 50,
  debug: 60,
} as const;
