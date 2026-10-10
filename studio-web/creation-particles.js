import { createLogoParticles } from './brand/logo-particles.js';

/** Keep the creation overlay and model loader on the same brand animation. */
export function createCreationParticles(canvas) {
  return createLogoParticles(canvas, { maxLogoSize: 256 });
}
