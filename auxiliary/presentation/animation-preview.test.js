#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  EFFECTS,
  TRIGGERS,
  compileAnimationPlan,
  compileMediaPlan,
  mediaAtEnd,
  mediaInteractionState,
  findSlideObject,
  normalizedAssetSource,
  positiveBox,
} = require('./public/animation-preview.js');

const model = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'model.json'), 'utf8'));
const checks = [];

function check(description, run) {
  try {
    run();
    checks.push({ description, ok: true });
  } catch (error) {
    checks.push({ description, ok: false, error });
  }
}

function slide(id) {
  const found = model.slides.find((item) => item.id === id);
  assert(found, `missing fixture slide ${id}`);
  return found;
}

check('the preview supports every model-valid entrance effect and trigger', () => {
  assert.deepStrictEqual([...EFFECTS].sort(), ['appear', 'fade', 'rise-up', 'wipe']);
  assert.deepStrictEqual([...TRIGGERS].sort(), ['after-previous', 'click', 'with-previous']);
});

check('slide s8 keeps click-to-play media separate from object builds and preserves its poster', () => {
  const plan = compileAnimationPlan(slide('s8'));
  const mediaPlan = compileMediaPlan(slide('s8'));
  assert.strictEqual(plan.steps.length, 0);
  assert.strictEqual(plan.supportedItems.length, 0);
  assert.strictEqual(plan.unsupported.length, 0);
  const poster = findSlideObject(slide('s8'), 'd217c568a').object;
  const video = findSlideObject(slide('s8'), 'd563324be').object;
  assert.strictEqual(
    poster.source,
    'assets/kaiju-motion/kaiju-defeat-giant-poster.png'
  );
  assert.strictEqual(video.source, 'assets/kaiju-motion/kaiju-defeat-click-final.mp4');
  assert(fs.statSync(path.join(__dirname, '..', video.source)).size > 0);
  assert.strictEqual(video.autoplay, false);
  assert.strictEqual(video.loop, false);
  assert.deepStrictEqual(video.box, poster.box);
  assert.strictEqual(mediaPlan.items.length, 1);
  assert.strictEqual(mediaPlan.supportedItems.length, 1);
  assert.strictEqual(mediaPlan.unsupported.length, 0);
  assert.strictEqual(mediaPlan.supportedItems[0].targetId, 'd563324be');
  assert.strictEqual(mediaPlan.supportedItems[0].object.source, video.source);
  assert.strictEqual(mediaPlan.supportedItems[0].poster.id, 'd217c568a');
  assert.strictEqual(mediaPlan.supportedItems[0].autoplay, false);
  assert.strictEqual(mediaPlan.supportedItems[0].loop, false);
  assert.strictEqual(mediaPlan.supportedItems[0].muted, true);
  assert.strictEqual(mediaPlan.supportedItems[0].playsInline, true);
});

check('media planning fails closed on paths, generation, geometry, and playback flags', () => {
  const box = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
  const fixture = {
    id: 'invalid-media',
    elements: [],
    decor: [
      { id: 'escape', kind: 'media', generated: true, source: 'assets/../secret.mp4', box, autoplay: true, loop: false },
      { id: 'absolute', kind: 'media', generated: true, source: '/assets/a.mp4', box, autoplay: true, loop: false },
      { id: 'wrong-kind', kind: 'media', generated: true, source: 'assets/a.mov', box, autoplay: true, loop: false },
      { id: 'imported', kind: 'media', generated: false, source: 'assets/a.mp4', box, autoplay: true, loop: false },
      { id: 'flat', kind: 'media', generated: true, source: 'assets/a.mp4', box: { x: 0, y: 0, w: 0, h: 1 }, autoplay: true, loop: false },
      { id: 'flags', kind: 'media', generated: true, source: 'assets/a.mp4', box, autoplay: 'yes', loop: false },
    ],
  };
  const plan = compileMediaPlan(fixture);
  assert.strictEqual(plan.supportedItems.length, 0);
  assert.strictEqual(plan.unsupported.length, 6);
  assert(plan.unsupported.every((item) => item.reason));
  assert(normalizedAssetSource('assets/folder/video.MP4', '.mp4'));
  assert(!normalizedAssetSource('assets/../video.mp4', '.mp4'));
  assert(!normalizedAssetSource('assets\\video.mp4', '.mp4'));
});

check('media planning preserves explicit playback flags instead of coercing them', () => {
  const plan = compileMediaPlan({
    id: 'flags',
    elements: [],
    decor: [{
      id: 'media', kind: 'media', generated: true,
      source: 'assets/video.mp4',
      box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      autoplay: false, loop: true, muted: false, playsInline: false,
    }],
  });
  assert.strictEqual(plan.supportedItems.length, 1);
  assert.deepStrictEqual(
    ['autoplay', 'loop', 'muted', 'playsInline'].map((key) => plan.supportedItems[0][key]),
    [false, true, false, false]
  );
});

check('direct media interaction labels play, pause, and replay states clearly', () => {
  const video = { paused: true, ended: false, currentTime: 0, duration: 5.6 };
  assert.strictEqual(mediaAtEnd(video), false);
  assert.deepStrictEqual(mediaInteractionState(video, 's8'), {
    ended: false,
    playing: false,
    label: 'Play embedded video preview on slide s8',
    title: 'Play video',
  });
  video.paused = false;
  assert.strictEqual(mediaInteractionState(video, 's8').label,
    'Pause embedded video preview on slide s8');
  video.paused = true;
  video.currentTime = 5.6;
  assert(mediaAtEnd(video));
  assert.strictEqual(mediaInteractionState(video, 's8').label,
    'Replay embedded video preview from the beginning on slide s8');
});

check('slide s1 keeps all 14 rise-up bar effects in one chained click build', () => {
  const plan = compileAnimationPlan(slide('s1'));
  assert.strictEqual(plan.steps.length, 1);
  assert.strictEqual(plan.items.length, 14);
  assert.strictEqual(plan.supportedItems.length, 14);
  assert(plan.items.every((item) => item.effect === 'rise-up'));
  assert.strictEqual(plan.items[0].targetId, 's1_d5');
  assert.strictEqual(plan.items[13].targetId, 's1_d18');
  assert.strictEqual(plan.steps[0].durationMs, 3080);
});

check('with-previous delays from the prior start and after-previous delays from its end', () => {
  const plan = compileAnimationPlan({
    id: 'timing',
    decor: [
      { id: 'a', kind: 'shape', box: { x: 0, y: 0, w: 0.1, h: 0.1 } },
      { id: 'b', kind: 'shape', box: { x: 0, y: 0, w: 0.1, h: 0.1 } },
      { id: 'c', kind: 'shape', box: { x: 0, y: 0, w: 0.1, h: 0.1 } },
    ],
    elements: [],
    animations: [
      { targetId: 'a', effect: 'fade', trigger: 'click', duration: 0.4, delay: 0.1 },
      { targetId: 'b', effect: 'fade', trigger: 'with-previous', duration: 0.2, delay: 0.05 },
      { targetId: 'c', effect: 'fade', trigger: 'after-previous', duration: 0.3, delay: 0.07 },
    ],
  });
  assert.deepStrictEqual(
    plan.items.map((item) => [item.startMs, item.endMs]),
    [[100, 500], [150, 350], [420, 720]]
  );
});

check('slide s3 preserves twelve pipeline objects in five speaking clicks', () => {
  const plan = compileAnimationPlan(slide('s3'));
  assert.strictEqual(plan.steps.length, 5);
  assert.strictEqual(plan.items.length, 12);
  assert.deepStrictEqual(
    plan.steps.map((step) => step.items.length),
    [4, 2, 2, 2, 2]
  );
  assert(plan.steps.every((step) => step.durationMs === 300));
  assert.deepStrictEqual(
    plan.items.map((item) => item.targetId),
    ['e2_10', 'e2_21', 'e2_12', 'e2_22', 'e2_14', 'e2_23',
      'e2_24', 'e2_25', 'e2_16', 'e2_26', 'e2_17', 'e2_27']
  );
});

check('invalid targets and geometry are reported and never masked', () => {
  const plan = compileAnimationPlan({
    id: 'fallback',
    decor: [{ id: 'flat', kind: 'shape', box: { x: 0, y: 0, w: 0, h: 1 } }],
    elements: [],
    animations: [
      { targetId: 'missing', effect: 'fade', trigger: 'click', duration: 0.3, delay: 0 },
      { targetId: 'flat', effect: 'fade', trigger: 'click', duration: 0.3, delay: 0 },
    ],
  });
  assert.strictEqual(plan.steps.length, 2);
  assert.strictEqual(plan.supportedItems.length, 0);
  assert.deepStrictEqual(
    plan.unsupported.map((item) => item.reason),
    ['target is missing', 'target has no usable geometry']
  );
});

check('an unknown future effect degrades to an omitted static target', () => {
  const plan = compileAnimationPlan({
    id: 'future',
    decor: [{ id: 'x', kind: 'shape', box: { x: 0, y: 0, w: 1, h: 1 } }],
    elements: [],
    animations: [
      { targetId: 'x', effect: 'spin', trigger: 'click', duration: 1, delay: 0 },
    ],
  });
  assert.strictEqual(plan.supportedItems.length, 0);
  assert.match(plan.unsupported[0].reason, /not supported/);
});

check('planning is read-only and object lookup distinguishes elements from decor', () => {
  const fixture = JSON.parse(JSON.stringify(slide('s8')));
  const before = JSON.stringify(fixture);
  compileAnimationPlan(fixture);
  assert.strictEqual(JSON.stringify(fixture), before);
  assert.strictEqual(findSlideObject(fixture, 'd217c568a').kind, 'decor');
  assert.strictEqual(findSlideObject(fixture, 'd563324be').kind, 'decor');
  assert.strictEqual(findSlideObject(fixture, 'e7_30').kind, 'element');
  assert.strictEqual(findSlideObject(fixture, 'nope'), null);
});

check('box validation rejects non-finite and non-positive dimensions', () => {
  assert(positiveBox({ x: 0, y: 0, w: 1, h: 1 }));
  assert(!positiveBox({ x: 0, y: 0, w: 0, h: 1 }));
  assert(!positiveBox({ x: 0, y: Number.NaN, w: 1, h: 1 }));
  assert(!positiveBox(null));
});

const passed = checks.filter((item) => item.ok).length;
for (const item of checks) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
  if (!item.ok) console.log(`      ${item.error && (item.error.stack || item.error)}`);
}
console.log(`\n${passed}/${checks.length} passed`);
process.exit(passed === checks.length ? 0 : 1);
