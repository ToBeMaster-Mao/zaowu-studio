/** A local, disposable particle wordmark for the model creation state. */
export function createCreationParticles(canvas) {
  if (!(canvas instanceof HTMLCanvasElement)) throw new TypeError('A canvas element is required.');

  const context = canvas.getContext('2d', { alpha: true });
  if (!context) return { setActive() {}, destroy() {} };

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const sampleCanvas = document.createElement('canvas');
  const sampleContext = sampleCanvas.getContext('2d', { willReadFrequently: true });
  const parent = canvas.parentElement || canvas;
  let active = false;
  let destroyed = false;
  let frame = 0;
  let width = 0;
  let height = 0;
  let ratio = 1;
  let elapsed = 0;
  let previousTime = 0;
  let particles = [];
  let dust = [];

  const random = (min, max) => min + Math.random() * (max - min);
  const easeOut = value => 1 - Math.pow(1 - value, 3);

  function sampleWordmark() {
    if (!sampleContext || !width || !height) return;
    sampleCanvas.width = Math.ceil(width);
    sampleCanvas.height = Math.ceil(height);
    const size = Math.floor(Math.min(width * 0.32, height * 0.64, 190));
    const gap = size * 0.24;
    sampleContext.font = `600 ${size}px "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif`;
    sampleContext.textAlign = 'center';
    sampleContext.textBaseline = 'middle';
    sampleContext.fillStyle = '#ffffff';
    // Separate characters give the wordmark enough breathing room on narrow stages.
    sampleContext.fillText('造', width / 2 - (size + gap) / 2, height / 2);
    sampleContext.fillText('物', width / 2 + (size + gap) / 2, height / 2);
    const pixels = sampleContext.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height).data;
    const spacing = Math.max(2.8, size / 47);
    particles = [];
    for (let y = 1; y < height; y += spacing) {
      for (let x = 1; x < width; x += spacing) {
        const index = (Math.floor(y) * sampleCanvas.width + Math.floor(x)) * 4;
        if (pixels[index + 3] < 100) continue;
        const angle = random(0, Math.PI * 2);
        const distance = random(size * 0.12, size * 1.1);
        particles.push({
          x, y,
          fromX: x + Math.cos(angle) * distance,
          fromY: y + Math.sin(angle) * distance,
          phase: random(0, Math.PI * 2),
          radius: random(0.65, 1.3) * Math.min(1.2, spacing / 3),
          brightness: random(0.5, 1),
          delay: random(0, 0.35),
          spark: Math.random() < 0.065,
        });
      }
    }
    dust = Array.from({ length: Math.round(Math.min(70, width / 8)) }, () => ({
      x: random(width * 0.08, width * 0.92),
      y: random(height * 0.08, height * 0.92),
      radius: random(0.45, 1.05),
      phase: random(0, Math.PI * 2),
      speed: random(0.2, 0.65),
    }));
  }

  function resize() {
    if (destroyed) return;
    const bounds = parent.getBoundingClientRect();
    const nextWidth = Math.round(bounds.width);
    const nextHeight = Math.round(bounds.height);
    if (nextWidth < 1 || nextHeight < 1) return;
    const nextRatio = Math.min(window.devicePixelRatio || 1, 2);
    if (nextWidth === width && nextHeight === height && nextRatio === ratio) return;
    width = nextWidth;
    height = nextHeight;
    ratio = nextRatio;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    sampleWordmark();
    if (active && !document.hidden) draw(reducedMotion.matches ? 4 : elapsed);
  }

  function draw(time) {
    context.clearRect(0, 0, width, height);
    const still = reducedMotion.matches;
    const breathe = still ? 1 : 0.9 + Math.sin(time * 1.1) * 0.1;
    context.fillStyle = '#cfeba5';

    for (const particle of dust) {
      const drift = still ? 0 : Math.sin(time * particle.speed + particle.phase);
      context.globalAlpha = (0.08 + (drift + 1) * 0.06) * Math.min(time, 1);
      context.beginPath();
      context.arc(particle.x + drift * 6, particle.y + drift * 10, particle.radius, 0, Math.PI * 2);
      context.fill();
    }

    for (const particle of particles) {
      const progress = still ? 1 : easeOut(Math.max(0, Math.min(1, (time - particle.delay) / 1.9)));
      const drift = still ? 0 : Math.sin(time * 0.95 + particle.phase);
      const x = particle.fromX + (particle.x - particle.fromX) * progress + drift * 0.75 * progress;
      const y = particle.fromY + (particle.y - particle.fromY) * progress + Math.cos(time * 0.8 + particle.phase) * 0.65 * progress * Number(!still);
      const opacity = particle.brightness * (0.14 + 0.86 * progress) * breathe;
      if (particle.spark) {
        context.globalAlpha = opacity * 0.075;
        context.beginPath();
        context.arc(x, y, particle.radius * 4, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = opacity;
      context.beginPath();
      context.arc(x, y, particle.radius, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
  }

  function tick(time) {
    frame = 0;
    if (!active || destroyed || document.hidden || reducedMotion.matches) return;
    if (!width || !height) resize();
    // Rendering at 30 fps is sufficient for the deliberately slow particle motion.
    if (!previousTime || time - previousTime >= 1000 / 30) {
      elapsed += previousTime ? Math.min((time - previousTime) / 1000, 0.1) : 0;
      previousTime = time;
      draw(elapsed);
    }
    frame = requestAnimationFrame(tick);
  }

  function pause() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    previousTime = 0;
  }

  function resume() {
    pause();
    if (!active || destroyed || document.hidden) return;
    resize();
    if (reducedMotion.matches) draw(4);
    else frame = requestAnimationFrame(tick);
  }

  const observer = new ResizeObserver(resize);
  observer.observe(parent);
  document.addEventListener('visibilitychange', resume);
  reducedMotion.addEventListener('change', resume);
  window.addEventListener('resize', resize);
  // A font becoming available should not leave sampled fallback glyphs behind.
  document.fonts?.ready.then(() => {
    if (destroyed || !width) return;
    sampleWordmark();
    if (active && !document.hidden) draw(reducedMotion.matches ? 4 : elapsed);
  });

  return {
    setActive(value) {
      if (destroyed) return;
      const next = Boolean(value);
      if (next === active) return;
      active = next;
      if (active) {
        elapsed = 0;
        resume();
      } else {
        pause();
        context.clearRect(0, 0, width, height);
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      active = false;
      pause();
      observer.disconnect();
      document.removeEventListener('visibilitychange', resume);
      reducedMotion.removeEventListener('change', resume);
      window.removeEventListener('resize', resize);
      context.clearRect(0, 0, width, height);
      particles = [];
      dust = [];
    },
  };
}
