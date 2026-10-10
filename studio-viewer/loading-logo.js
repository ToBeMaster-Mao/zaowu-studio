import { createLogoParticles } from '../studio-web/brand/logo-particles.js';

// This module is independent of Three.js so it starts while the renderer loads.
const notice = document.getElementById('notice');
const visual = document.getElementById('loading-logo');
const canvas = document.getElementById('loading-particles');
let particles;
let bootstrapFrame = 0, bootstrapTimer = 0, viewerStarted = false;

function startViewer() {
  if (viewerStarted) return;
  viewerStarted = true;
  cancelAnimationFrame(bootstrapFrame);
  clearTimeout(bootstrapTimer);
  import('./viewport.js').catch(error => {
    const message = String(error?.message || error || '视口无法载入').slice(0, 1000);
    notice.classList.add('error');
    document.getElementById('notice-text').textContent = `模型暂时无法预览：${message}`;
    window.parent.postMessage({ source: 'model-studio-viewport', type: 'error', message }, '*');
  });
}

function dispose() {
  cancelAnimationFrame(bootstrapFrame);
  clearTimeout(bootstrapTimer);
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
  try {
    particles ||= createLogoParticles(canvas, { maxLogoSize: 256 });
    if (particles.supported) {
      particles.setActive(true);
      visual.classList.add('is-animated');
    }
  } catch {
    // Animation is optional. Keep the dotted SVG if a canvas API is unavailable.
    try { particles?.destroy(); } catch { /* The renderer must still be allowed to start. */ }
    particles = null;
    visual.classList.remove('is-animated');
  }
}

const observer = new MutationObserver(update);
observer.observe(notice, { attributes: true, attributeFilter: ['hidden', 'class'] });
window.addEventListener('pagehide', dispose, { once: true });

// Paint the lightweight particle mark before importing the renderer and model.
// The timer also starts hidden validation frames, whose animation frames may pause.
bootstrapTimer = setTimeout(startViewer, 100);
bootstrapFrame = requestAnimationFrame(() => {
  bootstrapFrame = requestAnimationFrame(startViewer);
});
update();
