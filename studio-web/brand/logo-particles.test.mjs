import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogoParticles } from './logo-particles.js';

function environment(t, reduced = false) {
  class Target {
    listeners = new Map();
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    removeEventListener(type) { this.listeners.delete(type); }
    emit(type) { this.listeners.get(type)?.(); }
  }
  const media = Object.assign(new Target(), { matches: reduced });
  const frames = new Map();
  let nextFrame = 0, observer;
  const makeContext = () => ({
    clears: 0, paths: 0, dots: [],
    save() {}, restore() {}, translate() {}, scale() {}, setTransform() {}, beginPath() {},
    arc(x, y, radius) { this.dots.push({ x, y, radius }); },
    fill(path) { if (path) this.paths++; },
    clearRect() { this.clears++; this.dots = []; },
    getImageData() { return { data: new Uint8ClampedArray(128 * 128 * 4).fill(255) }; },
  });
  const context = makeContext();
  class Canvas {
    width = 300;
    height = 150;
    parentElement = { getBoundingClientRect: () => ({ width: 280, height: 200 }) };
    constructor(paintContext = context) { this.context = paintContext; }
    getContext() { return this.context; }
  }
  class Observer {
    constructor(callback) { this.callback = callback; observer = this; }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
  }
  const doc = Object.assign(new Target(), { hidden: false, createElement: () => new Canvas(makeContext()) });
  const win = Object.assign(new Target(), { devicePixelRatio: 3, matchMedia: () => media });
  const globals = {
    HTMLCanvasElement: Canvas, Path2D: class {}, ResizeObserver: Observer, document: doc, window: win,
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  t.after(() => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { canvas: new Canvas(), context, media, doc, win, frames, get observer() { return observer; } };
}

test('stopping and destroying the logo releases frames, listeners, observers and bitmap memory', t => {
  const env = environment(t);
  const logo = createLogoParticles(env.canvas);
  logo.setActive(true);
  assert.equal(env.frames.size, 1);
  assert.equal(env.canvas.width, 560, 'DPR is capped at two');
  assert.equal(env.observer.connected, true);
  logo.setActive(false);
  assert.equal(env.frames.size, 0);
  assert.equal(env.observer.connected, false);
  assert.equal(env.doc.listeners.size + env.win.listeners.size + env.media.listeners.size, 0);
  assert.equal(env.canvas.width * env.canvas.height, 1);
  logo.setActive(true);
  assert.equal(env.frames.size, 1, 'a later task can start the same component');
  logo.destroy();
  logo.setActive(true);
  assert.equal(env.frames.size, 0, 'a disposed component cannot restart');
});

test('hidden tabs suspend the animation and resume with only one frame scheduled', t => {
  const env = environment(t);
  const logo = createLogoParticles(env.canvas);
  logo.setActive(true);
  env.doc.hidden = true;
  env.doc.emit('visibilitychange');
  assert.equal(env.frames.size, 0);
  env.doc.hidden = false;
  env.doc.emit('visibilitychange');
  env.observer.callback();
  assert.equal(env.frames.size, 1);
  logo.destroy();
});

test('reduced motion renders a static particle logo and changing the preference cancels animation', t => {
  const env = environment(t, true);
  const logo = createLogoParticles(env.canvas);
  logo.setActive(true);
  assert.equal(env.frames.size, 0);
  assert.equal(env.context.paths, 0, 'solid logo paths never appear on the visible canvas');
  assert.ok(env.context.dots.length > 500, 'the mark remains composed of individual particles');
  const staticDots = structuredClone(env.context.dots);
  env.observer.callback();
  assert.deepEqual(env.context.dots, staticDots, 'the dots stay still with reduced motion');
  env.media.matches = false;
  env.media.emit('change');
  assert.equal(env.frames.size, 1);
  env.media.matches = true;
  env.media.emit('change');
  assert.equal(env.frames.size, 0);
  logo.destroy();
});

function nextFrame(env, time) {
  assert.equal(env.frames.size, 1, 'only one animation loop is scheduled');
  const [id, callback] = env.frames.entries().next().value;
  env.frames.delete(id);
  callback(time);
}

function averageTravel(dots, reference) {
  return dots.reduce((distance, dot, index) => distance + Math.hypot(dot.x - reference[index].x, dot.y - reference[index].y), 0) / dots.length;
}

test('a newly activated loader visibly moves within its first 400 ms', t => {
  t.mock.method(Math, 'random', () => 0.5);
  const env = environment(t);
  const logo = createLogoParticles(env.canvas);
  logo.setActive(true);
  const initialDots = structuredClone(env.context.dots);
  for (let time = 1000; time <= 1400; time += 50) nextFrame(env, time);
  assert.ok(averageTravel(env.context.dots, initialDots) > 4, 'short loads must not sit in a stationary logo phase');
  logo.destroy();
});

test('the animated mark repeatedly gathers and disperses without solid paths or extra animation loops', t => {
  t.mock.method(Math, 'random', () => 0.5);
  const env = environment(t, true);
  const logo = createLogoParticles(env.canvas);
  logo.setActive(true);
  const gatheredDots = structuredClone(env.context.dots);
  env.media.matches = false;
  env.media.emit('change');
  let gathers = 0, dispersals = 0, wasGathered = false, wasDispersed = false;
  for (let time = 1000; time <= 11000; time += 50) {
    nextFrame(env, time);
    const travel = averageTravel(env.context.dots, gatheredDots);
    const isGathered = travel < 0.5;
    const isDispersed = travel > 25;
    if (isGathered && !wasGathered) gathers++;
    if (isDispersed && !wasDispersed) dispersals++;
    wasGathered = isGathered;
    wasDispersed = isDispersed;
  }
  assert.ok(gathers >= 2, 'the silhouette becomes readable again on each cycle');
  assert.ok(dispersals >= 2, 'particles visibly disperse on each cycle');
  assert.equal(env.context.paths, 0);
  logo.destroy();
});
