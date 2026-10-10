import { createLogoParticles } from '../studio-web/brand/logo-particles.js';

// This module is independent of Three.js so it starts while the renderer loads.
const notice = document.getElementById('notice');
const visual = document.getElementById('loading-logo');
const canvas = document.getElementById('loading-particles');
let particles;

function dispose() {
  observer.disconnect();
  particles?.destroy();
  particles = null;
  visual.classList.remove('is-animated');
  window.removeEventListener('pagehide', dispose);
}

function update() {
  if (notice.hidden || notice.classList.contains('error')) {
    dispose();
    return;
  }
  particles ||= createLogoParticles(canvas);
  if (particles.supported) {
    particles.setActive(true);
    visual.classList.add('is-animated');
  }
}

const observer = new MutationObserver(update);
observer.observe(notice, { attributes: true, attributeFilter: ['hidden', 'class'] });
window.addEventListener('pagehide', dispose, { once: true });
update();
