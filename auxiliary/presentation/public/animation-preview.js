(function animationPreviewModule(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StudioAnimationPreview = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function animationPreviewFactory() {
  'use strict';

  const EFFECTS = new Set(['appear', 'fade', 'wipe', 'rise-up']);
  const TRIGGERS = new Set(['click', 'with-previous', 'after-previous']);

  function finiteNumber(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  function positiveBox(box) {
    return !!box && ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(box[key]))
      && box.w > 0 && box.h > 0;
  }

  function mediaAtEnd(video) {
    if (!video) return false;
    if (video.ended) return true;
    const duration = video.duration;
    const currentTime = video.currentTime;
    return Number.isFinite(duration) && duration > 0
      && Number.isFinite(currentTime) && currentTime >= duration - 0.05;
  }

  function mediaInteractionState(video, slideId) {
    const ended = mediaAtEnd(video);
    const playing = !!video && !video.paused && !ended;
    const action = playing ? 'Pause' : ended ? 'Replay' : 'Play';
    const suffix = ended ? ' from the beginning' : '';
    return {
      ended,
      playing,
      label: `${action} embedded video preview${suffix} on slide ${slideId}`,
      title: `${action} video${suffix.toLowerCase()}`,
    };
  }

  function findSlideObject(slide, targetId) {
    if (!slide || targetId == null) return null;
    const element = (slide.elements || []).find((item) => item && item.id === targetId);
    if (element) return { object: element, kind: 'element' };
    const decor = (slide.decor || []).find((item) => item && item.id === targetId);
    return decor ? { object: decor, kind: 'decor' } : null;
  }

  /*
   * Turn PowerPoint's linear MainSequence into click-sized steps. A click
   * begins a new local timeline; with-previous is relative to the prior
   * effect's start, and after-previous is relative to its end.
   */
  function compileAnimationPlan(slide) {
    const animations = Array.isArray(slide && slide.animations) ? slide.animations : [];
    const steps = [];
    const unsupported = [];
    let step = null;
    let previous = null;

    animations.forEach((raw, sourceIndex) => {
      const animation = raw && typeof raw === 'object' ? raw : {};
      const trigger = TRIGGERS.has(animation.trigger)
        ? animation.trigger
        : (sourceIndex === 0 ? 'click' : 'after-previous');
      if (!step || trigger === 'click') {
        step = { index: steps.length, items: [], durationMs: 0 };
        steps.push(step);
        previous = null;
      }

      const delayMs = Math.max(0, finiteNumber(animation.delay, 0) * 1000);
      const durationMs = Math.max(0, finiteNumber(animation.duration, 0.5) * 1000);
      let startMs = delayMs;
      if (previous && trigger === 'with-previous') startMs = previous.startMs + delayMs;
      else if (previous && trigger === 'after-previous') startMs = previous.endMs + delayMs;

      const found = findSlideObject(slide, animation.targetId);
      const reason = !found
        ? 'target is missing'
        : !positiveBox(found.object.box)
          ? 'target has no usable geometry'
          : !EFFECTS.has(animation.effect)
            ? `effect "${animation.effect || ''}" is not supported`
            : null;
      const item = {
        sourceIndex,
        stepIndex: step.index,
        targetId: String(animation.targetId == null ? '' : animation.targetId),
        effect: EFFECTS.has(animation.effect) ? animation.effect : 'appear',
        trigger,
        durationMs,
        delayMs,
        startMs,
        endMs: startMs + durationMs,
        object: found ? found.object : null,
        objectKind: found ? found.kind : null,
        supported: !reason,
        reason,
      };
      step.items.push(item);
      step.durationMs = Math.max(step.durationMs, item.endMs);
      previous = item;
      if (reason) unsupported.push(item);
    });

    return {
      steps,
      items: steps.flatMap((item) => item.items),
      supportedItems: steps.flatMap((item) => item.items).filter((item) => item.supported),
      unsupported,
    };
  }

  function normalizedAssetSource(value, extension) {
    if (typeof value !== 'string' || !value || value.includes('\\')
        || value.startsWith('/') || value.includes('\0')) return false;
    const suffix = typeof extension === 'string' ? extension.toLowerCase() : '';
    if (!suffix.startsWith('.') || suffix.length < 2) return false;
    const parts = value.split('/');
    if (parts.length < 2 || parts[0].toLowerCase() !== 'assets'
        || parts.some((part) => !part || part === '.' || part === '..')) return false;
    return value.toLowerCase().endsWith(suffix);
  }

  function sameBox(a, b) {
    return positiveBox(a) && positiveBox(b)
      && ['x', 'y', 'w', 'h'].every((key) => Math.abs(a[key] - b[key]) < 1e-9);
  }

  function compileMediaPlan(slide) {
    const decor = Array.isArray(slide && slide.decor) ? slide.decor : [];
    const pictures = decor.filter((item) => item && item.kind === 'pic'
      && item.generated === true && positiveBox(item.box)
      && normalizedAssetSource(item.source, pathExtensionForImage(item.source)));
    const items = decor
      .map((object, sourceIndex) => ({ object, sourceIndex }))
      .filter(({ object }) => object && object.kind === 'media')
      .map(({ object, sourceIndex }) => {
        let reason = null;
        if (object.generated !== true) reason = 'media is not generated';
        else if (!positiveBox(object.box)) reason = 'media has no usable geometry';
        else if (!normalizedAssetSource(object.source, '.mp4')) reason = 'media source is not a normalized assets MP4';
        else if (typeof object.autoplay !== 'boolean') reason = 'autoplay is not boolean';
        else if (typeof object.loop !== 'boolean') reason = 'loop is not boolean';
        else if (object.muted !== undefined && typeof object.muted !== 'boolean') reason = 'muted is not boolean';
        else if (object.playsInline !== undefined && typeof object.playsInline !== 'boolean') reason = 'playsInline is not boolean';
        const matchingPictures = pictures.filter((picture) => sameBox(picture.box, object.box));
        const poster = matchingPictures.find((picture) => /poster/i.test(String(picture.source || '')))
          || matchingPictures[0] || null;
        return {
          sourceIndex,
          targetId: String(object.id == null ? '' : object.id),
          object,
          poster,
          autoplay: object.autoplay === true,
          loop: object.loop === true,
          muted: object.muted === undefined ? true : object.muted,
          playsInline: object.playsInline === undefined ? true : object.playsInline,
          supported: !reason,
          reason,
        };
      });
    return {
      items,
      supportedItems: items.filter((item) => item.supported),
      unsupported: items.filter((item) => !item.supported),
    };
  }

  function pathExtensionForImage(value) {
    const match = typeof value === 'string' && /\.(png|jpe?g|gif)$/i.exec(value);
    return match ? match[0].toLowerCase() : '.invalid';
  }

  function escapeSelector(value) {
    const text = String(value == null ? '' : value);
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(text);
    return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function intersects(a, b) {
    return positiveBox(a) && positiveBox(b)
      && a.x < b.x + b.w && a.x + a.w > b.x
      && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function setBoxStyle(node, box) {
    node.style.left = `${box.x * 100}%`;
    node.style.top = `${box.y * 100}%`;
    node.style.width = `${box.w * 100}%`;
    node.style.height = `${box.h * 100}%`;
  }

  function elementText(element) {
    if (Array.isArray(element.items)) return element.items.join('\n');
    return String(element.text == null ? '' : element.text);
  }

  function applyTextStyle(node, element, slideHeight) {
    const style = element.style || {};
    const size = finiteNumber(style.size, element.type === 'title' ? 30 : 13);
    node.style.fontSize = `${(size / (slideHeight * 72) * 100).toFixed(3)}cqh`;
    node.style.fontWeight = style.bold ? '700' : '400';
    node.style.color = style.color || '#14161d';
    node.style.textAlign = style.align || 'left';
    node.style.alignItems = style.align === 'center'
      ? 'center'
      : style.align === 'right' ? 'flex-end' : 'flex-start';
    if (style.fill) node.style.background = style.fill;
    if (style.outline) node.style.outline = `1px solid ${style.outline}`;
    if (style.font) node.style.fontFamily = `"${String(style.font).replace(/"/g, '')}", sans-serif`;
  }

  function createObjectNode(doc, slide, descriptor, context) {
    const object = descriptor.object;
    const node = doc.createElement(descriptor.kind === 'element' ? 'div' : 'div');
    node.className = `sap-model-object sap-model-${descriptor.kind}`;
    node.dataset.objectId = object.id || '';
    setBoxStyle(node, object.box);

    if (descriptor.kind === 'element') {
      node.classList.add('sap-model-text');
      node.textContent = elementText(object);
      applyTextStyle(node, object, context.slideHeight);
      return node;
    }
    if (object.kind === 'shape') {
      node.classList.add('sap-model-shape');
      node.style.background = object.fill || 'transparent';
      return node;
    }
    if (object.kind === 'pic' && context.assetUrl) {
      const image = doc.createElement('img');
      image.alt = '';
      image.draggable = false;
      image.src = context.assetUrl(slide.id, object.id, object.source);
      image.addEventListener('error', () => {
        image.hidden = true;
        if (context.onApproximation) context.onApproximation('Some source artwork could not be loaded.');
      }, { once: true });
      node.classList.add('sap-model-picture');
      node.appendChild(image);
      return node;
    }
    node.classList.add('sap-model-unavailable');
    return node;
  }

  function createReconstruction(doc, slide, target, animatedIds, context) {
    const clip = doc.createElement('div');
    clip.className = 'sap-reconstruction-clip';

    const fullSlide = doc.createElement('div');
    fullSlide.className = 'sap-slide-reconstruction';
    fullSlide.style.left = `${-(target.box.x / target.box.w) * 100}%`;
    fullSlide.style.top = `${-(target.box.y / target.box.h) * 100}%`;
    fullSlide.style.width = `${(1 / target.box.w) * 100}%`;
    fullSlide.style.height = `${(1 / target.box.h) * 100}%`;

    const append = (object, kind) => {
      if (!object || !positiveBox(object.box) || animatedIds.has(object.id)) return;
      if (!intersects(object.box, target.box)) return;
      fullSlide.appendChild(createObjectNode(doc, slide, { object, kind }, context));
    };
    (slide.decor || []).forEach((object) => append(object, 'decor'));
    (slide.elements || []).forEach((object) => append(object, 'element'));
    clip.appendChild(fullSlide);
    return clip;
  }

  function createTargetNode(doc, slide, item, context) {
    const shell = doc.createElement('div');
    shell.className = `sap-reveal sap-effect-${item.effect}`;
    shell.dataset.animationTarget = item.targetId;
    setBoxStyle(shell, item.object.box);

    const local = JSON.parse(JSON.stringify(item.object));
    local.box = { x: 0, y: 0, w: 1, h: 1 };
    shell.appendChild(createObjectNode(
      doc,
      slide,
      { object: local, kind: item.objectKind },
      context
    ));
    return shell;
  }

  function signatureFor(slide, plan, mediaPlan, model, reducedMotion) {
    return JSON.stringify({
      id: slide && slide.id,
      slideW: model && model.slideW,
      slideH: model && model.slideH,
      reducedMotion: !!reducedMotion,
      animations: (slide && slide.animations) || [],
      // Covers repaint every intersecting static object, not only animation
      // targets. Include that source material so an SSE text/geometry edit
      // cannot leave a stale reconstruction over a freshly updated thumbnail.
      decor: (slide && slide.decor) || [],
      elements: (slide && slide.elements) || [],
      plannedTargets: plan.items.map((item) => item.targetId),
      plannedMedia: mediaPlan.items.map((item) => item.targetId),
    });
  }

  class PreviewController {
    constructor(options) {
      const opts = options || {};
      this.document = opts.document || (typeof document !== 'undefined' ? document : null);
      this.window = opts.window || (typeof window !== 'undefined' ? window : null);
      this.getModel = typeof opts.getModel === 'function' ? opts.getModel : () => ({ slides: [] });
      this.getMode = typeof opts.getMode === 'function' ? opts.getMode : () => 'grid';
      this.getCurrentId = typeof opts.getCurrentId === 'function' ? opts.getCurrentId : () => null;
      this.assetUrl = typeof opts.assetUrl === 'function'
        ? opts.assetUrl
        : (slideId, objectId) => `/api/animation-preview-asset?slideId=${encodeURIComponent(slideId)}&objectId=${encodeURIComponent(objectId)}`;
      this.mediaAssetUrl = typeof opts.mediaAssetUrl === 'function'
        ? opts.mediaAssetUrl
        : (slideId, objectId) => `/api/media-preview-asset?slideId=${encodeURIComponent(slideId)}&objectId=${encodeURIComponent(objectId)}`;
      this.host = null;
      this.controls = null;
      this.mediaControls = null;
      this.plan = null;
      this.mediaPlan = null;
      this.slide = null;
      this.signature = '';
      this.completed = 0;
      this.runningStep = null;
      this.playing = false;
      this.approximationNotes = new Set();
      this.itemNodes = new Map();
      this.mediaNodes = new Map();
      this.mediaStatus = '';
      this.timers = new Set();
      this.animations = new Set();
      this.pendingResolves = new Set();
      this.generation = 0;
      this.destroyed = false;
      this.boundKeydown = (event) => this.onKeydown(event);
      this.motionQuery = this.window && this.window.matchMedia
        ? this.window.matchMedia('(prefers-reduced-motion: reduce)') : null;
      this.boundMotionChange = () => this.sync();
      if (this.document) this.document.addEventListener('keydown', this.boundKeydown, true);
      if (this.motionQuery && this.motionQuery.addEventListener) {
        this.motionQuery.addEventListener('change', this.boundMotionChange);
      } else if (this.motionQuery && this.motionQuery.addListener) {
        this.motionQuery.addListener(this.boundMotionChange);
      }
    }

    reducedMotion() {
      return !!(this.motionQuery && this.motionQuery.matches);
    }

    hasMotionApi() {
      return !!(this.window && this.window.Element
        && this.window.Element.prototype
        && typeof this.window.Element.prototype.animate === 'function');
    }

    sync() {
      if (this.destroyed || !this.document) return;
      const model = this.getModel() || { slides: [] };
      const slide = (model.slides || []).find((item) => item.id === this.getCurrentId());
      if (this.getMode() !== 'single' || !slide) {
        this.unmount();
        return;
      }
      const plan = compileAnimationPlan(slide);
      const mediaPlan = compileMediaPlan(slide);
      if (!plan.items.length && !mediaPlan.items.length) {
        this.unmount();
        return;
      }
      const card = this.document.querySelector(`.card[data-slide="${escapeSelector(slide.id)}"]`);
      const frame = card && card.querySelector('.frame');
      if (!frame) {
        this.unmount();
        return;
      }
      const signature = signatureFor(slide, plan, mediaPlan, model, this.reducedMotion());
      if (this.host === frame && this.signature === signature) {
        this.paint();
        return;
      }
      this.mount(frame, slide, plan, mediaPlan, signature, model);
    }

    mount(frame, slide, plan, mediaPlan, signature, model) {
      this.unmount();
      this.host = frame;
      this.slide = slide;
      this.plan = plan;
      this.mediaPlan = mediaPlan;
      this.signature = signature;
      this.completed = 0;
      this.mediaStatus = '';
      this.approximationNotes.clear();

      const slideHeight = Math.max(0.01, finiteNumber(model.slideH, 7.5));
      const context = {
        slideHeight,
        assetUrl: this.assetUrl,
        onApproximation: (note) => {
          this.approximationNotes.add(note);
          this.paint();
        },
      };
      const animatedIds = new Set(plan.supportedItems.map((item) => item.targetId));

      mediaPlan.supportedItems.forEach((item) => {
        const media = this.createMediaNode(slide, item);
        frame.appendChild(media.shell);
        this.mediaNodes.set(item.sourceIndex, media);
      });

      plan.supportedItems.forEach((item) => {
        const cover = this.document.createElement('div');
        cover.className = 'sap-cover';
        cover.dataset.animationCover = item.targetId;
        setBoxStyle(cover, item.object.box);
        cover.appendChild(createReconstruction(
          this.document,
          slide,
          item.object,
          animatedIds,
          context
        ));

        const reveal = createTargetNode(this.document, slide, item, context);
        frame.appendChild(cover);
        frame.appendChild(reveal);
        this.itemNodes.set(item.sourceIndex, { cover, reveal });
      });

      if (plan.items.length) {
        this.controls = this.createControls();
        frame.appendChild(this.controls);
      }
      if (mediaPlan.items.length) {
        this.mediaControls = this.createMediaControls();
        frame.appendChild(this.mediaControls);
      }
      this.applyPosition(0);
      this.paint();
      this.startAutoplayMedia();
    }

    createMediaNode(slide, item) {
      const shell = this.document.createElement('div');
      shell.className = 'sap-media-preview';
      shell.dataset.mediaPreview = item.targetId;
      setBoxStyle(shell, item.object.box);

      const video = this.document.createElement('video');
      video.className = 'sap-media-video';
      video.preload = item.autoplay && !this.reducedMotion() ? 'auto' : 'metadata';
      video.autoplay = item.autoplay && !this.reducedMotion();
      video.loop = item.loop;
      video.muted = item.muted;
      video.defaultMuted = item.muted;
      video.playsInline = item.playsInline;
      video.setAttribute('aria-label', `Embedded video preview for slide ${slide.id}`);
      if (item.muted) video.setAttribute('muted', '');
      else video.removeAttribute('muted');
      if (item.playsInline) video.setAttribute('playsinline', '');
      else video.removeAttribute('playsinline');
      if (item.poster) video.poster = this.assetUrl(slide.id, item.poster.id, item.poster.source);
      video.src = this.mediaAssetUrl(slide.id, item.object.id, item.object.source);

      const media = { shell, video, item };
      const syncAccessibility = () => {
        if (item.autoplay) return;
        const state = mediaInteractionState(video, slide.id);
        video.setAttribute('aria-label', state.label);
        video.setAttribute('aria-pressed', String(state.playing));
        video.title = state.title;
      };

      const update = (status) => {
        syncAccessibility();
        this.mediaStatus = status;
        this.paint();
      };
      video.addEventListener('loadedmetadata', () => {
        if (!this.mediaStatus) update('Video ready');
      });
      video.addEventListener('play', () => update('Playing video preview'));
      video.addEventListener('pause', () => {
        if (!video.ended && this.host) update('Video paused');
      });
      video.addEventListener('ended', () => update('Video preview ended'));
      video.addEventListener('error', () => {
        video.hidden = true;
        update('Video unavailable; showing the final slide thumbnail');
      }, { once: true });

      if (!item.autoplay) {
        shell.classList.add('sap-media-clickable');
        video.setAttribute('role', 'button');
        video.tabIndex = 0;
        const activate = (event) => {
          if (event.type === 'click') {
            // Keep both clicks bubbling to Studio: its selection/lock gesture
            // reuses the first hit on dblclick. Only the first click toggles
            // playback so double-clicking does not immediately pause again.
            event.preventDefault();
            if (event.detail > 1) return;
          } else {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            event.stopPropagation();
          }
          this.toggleMedia([media]);
        };
        video.addEventListener('click', activate);
        video.addEventListener('keydown', activate);
        syncAccessibility();
      }
      shell.appendChild(video);
      return media;
    }

    createMediaControls() {
      const section = this.document.createElement('section');
      section.className = 'sap-media-controls';
      section.setAttribute('role', 'group');
      section.setAttribute('aria-label', 'Embedded video preview controls');
      section.innerHTML = [
        '<span class="sap-media-caveat" title="Plays the model-bound MP4 over the final slide thumbnail. Browser playback may differ slightly from PowerPoint.">Browser video</span>',
        '<button type="button" data-sap-media-action="toggle" aria-label="Play embedded video preview">Play video</button>',
        '<output class="sap-media-status" aria-live="polite"></output>',
      ].join('');
      section.addEventListener('click', (event) => {
        const button = event.target.closest('[data-sap-media-action="toggle"]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        this.toggleMedia();
      });
      return section;
    }

    startAutoplayMedia() {
      if (!this.mediaPlan || !this.mediaPlan.supportedItems.length) return;
      if (this.reducedMotion()) {
        this.mediaStatus = 'Motion paused because reduced motion is on';
        this.paint();
        return;
      }
      const autoplayNodes = [...this.mediaNodes.values()].filter(({ item }) => item.autoplay);
      if (!autoplayNodes.length) {
        this.mediaStatus = 'Video ready; click the video or press Play video';
        this.paint();
        return;
      }
      autoplayNodes.forEach(({ video }) => {
        let promise;
        try { promise = video.play(); }
        catch (_) { promise = null; }
        if (promise && typeof promise.catch === 'function') {
          promise.catch(() => {
            if (!video.hidden) {
              this.mediaStatus = 'Autoplay unavailable; showing the poster';
              this.paint();
            }
          });
        }
      });
    }

    toggleMedia(onlyNodes) {
      const candidates = Array.isArray(onlyNodes) ? onlyNodes : [...this.mediaNodes.values()];
      const nodes = candidates.filter(({ video }) => !video.hidden);
      if (!nodes.length) return;
      if (nodes.some(({ video }) => !video.paused && !video.ended)) {
        nodes.forEach(({ video }) => video.pause());
        return;
      }
      nodes.forEach(({ video }) => {
        if (mediaAtEnd(video)) video.currentTime = 0;
        let promise;
        try { promise = video.play(); }
        catch (_) { promise = null; }
        if (promise && typeof promise.catch === 'function') {
          promise.catch(() => {
            this.mediaStatus = 'Video could not play; showing the poster';
            this.paint();
          });
        }
      });
    }

    createControls() {
      const section = this.document.createElement('section');
      section.className = 'sap-controls';
      section.setAttribute('role', 'group');
      section.setAttribute('aria-label', 'Approximate animation preview controls');
      section.innerHTML = [
        '<span class="sap-caveat" title="Uses model geometry and source artwork over the final slide thumbnail. This is not PowerPoint playback.">Approx. builds</span>',
        '<button type="button" data-sap-action="previous" aria-label="Previous animation step" title="Previous build (Page Up or Shift+Space)">Previous</button>',
        '<button type="button" data-sap-action="next" aria-label="Next animation step" title="Next build (Page Down or Space)">Next</button>',
        '<button type="button" data-sap-action="reset" aria-label="Reset animation preview" title="Reset builds (Home)">Reset</button>',
        '<button type="button" data-sap-action="play" aria-label="Play remaining animation steps" title="Play remaining builds">Play</button>',
        '<progress class="sap-progress" value="0" max="1" aria-label="Animation build progress"></progress>',
        '<output class="sap-status" aria-live="polite"></output>',
      ].join('');
      section.addEventListener('click', (event) => {
        const button = event.target.closest('[data-sap-action]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        const action = button.dataset.sapAction;
        if (action === 'next') void this.next();
        else if (action === 'previous') this.previous();
        else if (action === 'reset') this.reset();
        else if (action === 'play') {
          if (this.playing) this.stop({ finishStep: true });
          else void this.play();
        }
      });
      return section;
    }

    setTimer(callback, delay) {
      const id = setTimeout(() => {
        this.timers.delete(id);
        callback();
      }, Math.max(0, delay));
      this.timers.add(id);
      return id;
    }

    clearWork() {
      this.generation += 1;
      this.timers.forEach((id) => clearTimeout(id));
      this.timers.clear();
      this.animations.forEach((animation) => {
        try { animation.cancel(); } catch (_) { /* an already-finished animation is harmless */ }
      });
      this.animations.clear();
      this.pendingResolves.forEach((resolve) => resolve(false));
      this.pendingResolves.clear();
      this.runningStep = null;
    }

    applyPosition(completed) {
      this.completed = Math.max(0, Math.min(completed, this.plan ? this.plan.steps.length : 0));
      if (!this.plan) return;
      this.plan.items.forEach((item) => {
        if (!item.supported) return;
        const nodes = this.itemNodes.get(item.sourceIndex);
        if (!nodes) return;
        nodes.cover.hidden = item.stepIndex < this.completed;
        nodes.cover.style.opacity = '';
        nodes.cover.style.clipPath = '';
        nodes.reveal.hidden = true;
        nodes.reveal.style.opacity = '';
        nodes.reveal.style.transform = '';
        nodes.reveal.style.clipPath = '';
      });
      this.paint();
    }

    animateItem(item, token) {
      return new Promise((resolve) => {
        let settled = false;
        const finishPromise = (value) => {
          if (settled) return;
          settled = true;
          this.pendingResolves.delete(finishPromise);
          resolve(value);
        };
        this.pendingResolves.add(finishPromise);
        const nodes = this.itemNodes.get(item.sourceIndex);
        if (!nodes || token !== this.generation) {
          finishPromise(false);
          return;
        }
        const start = () => {
          if (token !== this.generation) {
            finishPromise(false);
            return;
          }
          if (item.effect === 'appear' || this.reducedMotion() || !this.hasMotionApi()) {
            nodes.cover.hidden = true;
            nodes.reveal.hidden = true;
            finishPromise(true);
            return;
          }
          nodes.reveal.hidden = item.effect !== 'rise-up';
          let frames;
          let animatedNode = nodes.reveal;
          if (item.effect === 'fade') {
            animatedNode = nodes.cover;
            frames = [{ opacity: 1 }, { opacity: 0 }];
          } else if (item.effect === 'wipe') {
            animatedNode = nodes.cover;
            frames = [{ clipPath: 'inset(0 0 0 0)' }, { clipPath: 'inset(0 0 0 100%)' }];
          } else {
            frames = [
              { opacity: 0, transform: 'translateY(28%)' },
              { opacity: 1, transform: 'translateY(0)' },
            ];
          }
          let animation;
          try {
            animation = animatedNode.animate(frames, {
              duration: Math.max(1, item.durationMs),
              easing: item.effect === 'rise-up' ? 'cubic-bezier(.2,.78,.25,1)' : 'linear',
              fill: 'both',
            });
          } catch (_) {
            nodes.cover.hidden = true;
            nodes.reveal.hidden = true;
            finishPromise(true);
            return;
          }
          this.animations.add(animation);
          const finish = () => {
            this.animations.delete(animation);
            if (token === this.generation) {
              nodes.cover.hidden = true;
              nodes.reveal.hidden = true;
            }
            finishPromise(token === this.generation);
          };
          animation.finished.then(finish, finish);
        };
        if (item.startMs > 0 && !this.reducedMotion()) this.setTimer(start, item.startMs);
        else start();
      });
    }

    async runStep(index) {
      if (!this.plan || index < 0 || index >= this.plan.steps.length || this.runningStep !== null) return false;
      const step = this.plan.steps[index];
      this.runningStep = index;
      const token = this.generation;
      this.paint();
      const supported = step.items.filter((item) => item.supported);
      if (!supported.length) {
        this.applyPosition(index + 1);
        this.runningStep = null;
        this.paint();
        return true;
      }
      await Promise.all(supported.map((item) => this.animateItem(item, token)));
      if (token !== this.generation) return false;
      this.runningStep = null;
      this.applyPosition(index + 1);
      return true;
    }

    async next() {
      if (!this.plan || this.runningStep !== null || this.completed >= this.plan.steps.length) return false;
      return this.runStep(this.completed);
    }

    previous() {
      if (!this.plan || this.runningStep !== null) return;
      this.playing = false;
      this.clearWork();
      this.applyPosition(Math.max(0, this.completed - 1));
    }

    reset() {
      this.playing = false;
      this.clearWork();
      this.applyPosition(0);
    }

    stop(options) {
      const finishStep = !!(options && options.finishStep);
      const step = this.runningStep;
      this.playing = false;
      this.clearWork();
      if (finishStep && step !== null) this.applyPosition(step + 1);
      else this.applyPosition(this.completed);
    }

    async play() {
      if (!this.plan || this.playing || this.runningStep !== null) return;
      if (this.completed >= this.plan.steps.length) this.applyPosition(0);
      this.playing = true;
      this.paint();
      while (this.playing && this.completed < this.plan.steps.length) {
        const advanced = await this.runStep(this.completed);
        if (!advanced || !this.playing) break;
      }
      this.playing = false;
      this.paint();
    }

    onKeydown(event) {
      if (!this.host || !this.plan || !this.plan.steps.length || event.defaultPrevented) return;
      const target = event.target;
      const tag = String(target && target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (target && target.isContentEditable)) return;
      if (target && target.closest && target.closest('.sap-controls, .sap-media-clickable')) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      let handled = true;
      if (event.key === 'PageDown' || (event.key === ' ' && !event.shiftKey)) void this.next();
      else if (event.key === 'PageUp' || (event.key === ' ' && event.shiftKey)) this.previous();
      else if (event.key === 'Home') this.reset();
      else if (event.key === 'End') {
        this.stop();
        this.applyPosition(this.plan.steps.length);
      } else handled = false;
      if (handled) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }

    paint() {
      if (this.controls && this.plan) {
      const total = this.plan.steps.length;
      const busy = this.runningStep !== null;
      const previous = this.controls.querySelector('[data-sap-action="previous"]');
      const next = this.controls.querySelector('[data-sap-action="next"]');
      const reset = this.controls.querySelector('[data-sap-action="reset"]');
      const play = this.controls.querySelector('[data-sap-action="play"]');
      const progress = this.controls.querySelector('.sap-progress');
      const status = this.controls.querySelector('.sap-status');
      const supportedCount = this.plan.supportedItems.length;

      previous.disabled = busy || this.completed <= 0;
      next.disabled = busy || this.completed >= total || supportedCount === 0;
      reset.disabled = !busy && this.completed === 0;
      play.disabled = supportedCount === 0 || (!this.playing && busy);
      play.textContent = this.playing ? 'Stop' : 'Play';
      play.setAttribute('aria-label', this.playing
        ? 'Stop animation playback'
        : 'Play remaining animation steps');
      progress.max = Math.max(1, total);
      progress.value = busy ? this.runningStep : this.completed;

      const notes = [];
      if (!supportedCount) {
        notes.push('Static thumbnail only');
      } else if (busy) {
        notes.push(`Building ${this.runningStep + 1} of ${total}`);
      } else {
        notes.push(`Step ${this.completed} of ${total}`);
      }
      notes.push(`${supportedCount} object${supportedCount === 1 ? '' : 's'}`);
      if (this.plan.unsupported.length) notes.push(`${this.plan.unsupported.length} omitted`);
      if (this.reducedMotion()) notes.push('reduced motion');
      else if (!this.hasMotionApi()) notes.push('instant fallback');
      this.approximationNotes.forEach((note) => notes.push(note));
      status.textContent = notes.join(' · ');
      this.controls.classList.toggle('sap-static', !supportedCount);
      this.controls.classList.toggle('sap-playing', this.playing);
      }

      if (this.mediaControls && this.mediaPlan) {
        const supportedMedia = this.mediaPlan.supportedItems.length;
        const videos = [...this.mediaNodes.values()].map(({ video }) => video);
        const mediaPlaying = videos.some((video) => !video.hidden && !video.paused && !video.ended);
        const button = this.mediaControls.querySelector('[data-sap-media-action="toggle"]');
        const mediaStatus = this.mediaControls.querySelector('.sap-media-status');
        button.disabled = supportedMedia === 0;
        button.textContent = mediaPlaying ? 'Pause video' : 'Play video';
        button.setAttribute('aria-label', mediaPlaying
          ? 'Pause embedded video preview'
          : 'Play embedded video preview');
        const notes = [];
        if (this.mediaStatus) notes.push(this.mediaStatus);
        else if (!supportedMedia) notes.push('Video unavailable; final thumbnail shown');
        else notes.push('Loading video preview');
        if (this.mediaPlan.unsupported.length) notes.push(`${this.mediaPlan.unsupported.length} omitted`);
        mediaStatus.textContent = notes.join(' · ');
        this.mediaControls.classList.toggle('sap-media-static', !supportedMedia);
        this.mediaControls.classList.toggle('sap-media-playing', mediaPlaying);
      }
    }

    unmount() {
      this.playing = false;
      this.clearWork();
      this.itemNodes.forEach(({ cover, reveal }) => {
        if (cover.parentNode) cover.parentNode.removeChild(cover);
        if (reveal.parentNode) reveal.parentNode.removeChild(reveal);
      });
      this.itemNodes.clear();
      if (this.controls && this.controls.parentNode) this.controls.parentNode.removeChild(this.controls);
      if (this.mediaControls && this.mediaControls.parentNode) {
        this.mediaControls.parentNode.removeChild(this.mediaControls);
      }
      this.controls = null;
      this.mediaControls = null;
      this.mediaNodes.forEach(({ shell, video }) => {
        try { video.pause(); } catch (_) { /* already stopped */ }
        video.removeAttribute('src');
        try { video.load(); } catch (_) { /* detached media teardown */ }
        if (shell.parentNode) shell.parentNode.removeChild(shell);
      });
      this.mediaNodes.clear();
      this.host = null;
      this.plan = null;
      this.mediaPlan = null;
      this.slide = null;
      this.signature = '';
      this.completed = 0;
      this.mediaStatus = '';
      this.approximationNotes.clear();
    }

    destroy() {
      if (this.destroyed) return;
      this.unmount();
      if (this.document) this.document.removeEventListener('keydown', this.boundKeydown, true);
      if (this.motionQuery && this.motionQuery.removeEventListener) {
        this.motionQuery.removeEventListener('change', this.boundMotionChange);
      } else if (this.motionQuery && this.motionQuery.removeListener) {
        this.motionQuery.removeListener(this.boundMotionChange);
      }
      this.destroyed = true;
    }

    getState() {
      return {
        active: !!this.host,
        slideId: this.slide ? this.slide.id : null,
        completed: this.completed,
        totalSteps: this.plan ? this.plan.steps.length : 0,
        supportedObjects: this.plan ? this.plan.supportedItems.length : 0,
        unsupportedObjects: this.plan ? this.plan.unsupported.length : 0,
        mediaObjects: this.mediaPlan ? this.mediaPlan.supportedItems.length : 0,
        unsupportedMedia: this.mediaPlan ? this.mediaPlan.unsupported.length : 0,
        mediaPlaying: [...this.mediaNodes.values()].some(({ video }) =>
          !video.hidden && !video.paused && !video.ended),
        reducedMotion: this.reducedMotion(),
        mediaStatus: this.mediaStatus,
        runningStep: this.runningStep,
        playing: this.playing,
        approximation: true,
      };
    }
  }

  function create(options) {
    return new PreviewController(options);
  }

  return {
    EFFECTS,
    TRIGGERS,
    PreviewController,
    compileAnimationPlan,
    compileMediaPlan,
    mediaAtEnd,
    mediaInteractionState,
    findSlideObject,
    normalizedAssetSource,
    positiveBox,
    create,
  };
});
