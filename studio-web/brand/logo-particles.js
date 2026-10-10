// The paths match logo-mark.svg so the loader keeps the same folded Z silhouette.
const logoPaths = [
  ['M8 7H55L61 19L40 36L29 28L44 17H2L8 7Z', '#D3F28A'],
  ['M24 28L35 36L20 48H62L56 58H9L3 46L24 28Z', '#D3F28A'],
  ['M55 7L61 19L50 18L44 17L55 7Z', '#EDFCCB'],
  ['M3 46L9 58L20 48L14 47L3 46Z', '#9EC65B'],
];

const clamp = value => Math.max(0, Math.min(1, value));
const smooth = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
const random = (min, max) => min + Math.random() * (max - min);

/** A low-cost, disposable logo animation shared by loading and model creation. */
export function createLogoParticles(canvas, { maxLogoSize = 112 } = {}) {
  if (!(canvas instanceof HTMLCanvasElement)) throw new TypeError('A canvas element is required.');
  const context = canvas.getContext('2d', { alpha: true });
  const sampler = document.createElement('canvas');
  const sampleContext = sampler.getContext('2d', { willReadFrequently: true });
  if (!context || !sampleContext || typeof Path2D === 'undefined') {
    return { supported: false, setActive() {}, destroy() {} };
  }

  const paths = logoPaths.map(([path, color]) => ({ path: new Path2D(path), color }));
  const parent = canvas.parentElement || canvas;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let active = false, destroyed = false, frame = 0;
  let width = 0, height = 0, ratio = 0, logoSize = 0;
  // Show the mark immediately even when the model loads before a full cycle.
  let elapsed = 2.2, previousTime = 0, particles = [];

  function paintLogo(target, size, x = 0, y = 0) {
    target.save();
    target.translate(x, y);
    target.scale(size / 64, size / 64);
    for (const { path, color } of paths) {
      target.fillStyle = color;
      target.fill(path);
    }
    target.restore();
  }

  function sampleLogo() {
    const size = 128;
    sampler.width = sampler.height = size;
    paintLogo(sampleContext, size);
    const pixels = sampleContext.getImageData(0, 0, size, size).data;
    const scale = logoSize / size;
    const spread = Math.min(logoSize * 0.84, width * 0.24, height * 0.3);
    particles = [];
    for (let y = 1; y < size; y += 3) {
      for (let x = 1; x < size; x += 3) {
        const index = (y * size + x) * 4;
        if (pixels[index + 3] < 128) continue;
        const angle = random(0, Math.PI * 2);
        const distance = random(spread * 0.35, spread);
        particles.push({
          x: width / 2 + (x - size / 2) * scale,
          y: height / 2 + (y - size / 2) * scale,
          dx: Math.cos(angle) * distance,
          dy: Math.sin(angle) * distance,
          phase: random(0, Math.PI * 2),
          lag: random(-0.13, 0.13),
          radius: random(0.8, 1.14) * Math.min(1.3, logoSize / 100),
          alpha: random(0.72, 1),
          color: `rgb(${pixels[index]}, ${pixels[index + 1]}, ${pixels[index + 2]})`,
        });
      }
    }
  }

  function draw(time) {
    context.clearRect(0, 0, width, height);
    const cycle = (time % 6.8) / 6.8;
    // Gather, hold the readable mark, disperse, then pause before gathering again.
    // Reduced motion keeps the same dotted mark, without replacing it with a solid logo.
    const dispersion = reducedMotion.matches ? 0 : cycle < 0.32 ? 1 - smooth(cycle / 0.32)
      : cycle < 0.51 ? 0
        : cycle < 0.87 ? smooth((cycle - 0.51) / 0.36) : 1;
    for (const particle of particles) {
      const scatter = clamp(dispersion + Math.sin(dispersion * Math.PI) * particle.lag);
      const drift = Math.sin(time * 0.7 + particle.phase) * 3.5 * scatter;
      const x = particle.x + particle.dx * scatter + drift;
      const y = particle.y + particle.dy * scatter + Math.cos(time * 0.6 + particle.phase) * 3 * scatter;
      context.globalAlpha = particle.alpha * (1 - scatter * 0.67);
      context.fillStyle = particle.color;
      context.beginPath();
      context.arc(x, y, particle.radius, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
  }

  function pause() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    previousTime = 0;
  }

  function resize() {
    if (!active || destroyed) return;
    const bounds = parent.getBoundingClientRect();
    const nextWidth = Math.round(bounds.width), nextHeight = Math.round(bounds.height);
    if (nextWidth < 1 || nextHeight < 1) { pause(); return; }
    const nextRatio = Math.min(window.devicePixelRatio || 1, 2);
    if (width !== nextWidth || height !== nextHeight || ratio !== nextRatio) {
      width = nextWidth;
      height = nextHeight;
      ratio = nextRatio;
      logoSize = Math.min(maxLogoSize, width * 0.42, height * 0.53);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      sampleLogo();
    }
    draw(elapsed);
    if (!frame && !document.hidden && !reducedMotion.matches) frame = requestAnimationFrame(tick);
  }

  function tick(time) {
    frame = 0;
    if (!active || destroyed || document.hidden || reducedMotion.matches) return;
    if (!previousTime || time - previousTime >= 1000 / 30) {
      elapsed += previousTime ? Math.min((time - previousTime) / 1000, 0.15) : 0;
      previousTime = time;
      draw(elapsed);
    }
    frame = requestAnimationFrame(tick);
  }

  function resume() {
    pause();
    if (active && !destroyed && !document.hidden) resize();
  }

  const observer = new ResizeObserver(resize);

  function setActive(value) {
    if (destroyed || Boolean(value) === active) return;
    active = Boolean(value);
    if (active) {
      elapsed = 2.2;
      observer.observe(parent);
      document.addEventListener('visibilitychange', resume);
      reducedMotion.addEventListener('change', resume);
      window.addEventListener('resize', resize);
      resume();
    } else {
      pause();
      observer.disconnect();
      document.removeEventListener('visibilitychange', resume);
      reducedMotion.removeEventListener('change', resume);
      window.removeEventListener('resize', resize);
      particles = [];
      width = height = ratio = 0;
      canvas.width = canvas.height = sampler.width = sampler.height = 1;
    }
  }

  return {
    supported: true,
    setActive,
    destroy() {
      if (destroyed) return;
      setActive(false);
      destroyed = true;
    },
  };
}
