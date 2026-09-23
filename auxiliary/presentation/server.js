#!/usr/bin/env node
'use strict';
/*
 * Presentation Suite — coordinator server.
 *
 * Single source of truth: data/model.json (a JSON outline of the deck).
 * Every mutation flows through POST /api/edit, which is GATED by the pause
 * flag, so no editor — including multiple Claude Code instances — can change
 * the deck while paused. As defense-in-depth, pausing also flips the OS
 * read-only bit on presentation.pptx and model.json, so even a direct file
 * write is refused until resume.
 *
 * Live view: the dashboard subscribes to /api/events (SSE) and receives every
 * edit, pause, resume, editor join/leave and render result in real time.
 *
 * No external npm dependencies — Node built-ins only.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const { Agents, agentColor, agentIdentityError, agentPoolForName, isWorkerAgentName,
        GUARD_LOG_PATH, PROFILES, PROFILE_NAMES, DEFAULT_PROFILE,
        PROVIDER_MODELS, PROVIDER_NAMES, DEFAULT_PROVIDER } = require('./agents');

const HERE = __dirname;                                  // .../suite
const ROOT = path.resolve(HERE, '..');                  // .../Presentation
const DATA = path.join(HERE, 'data');
const PUBLIC = path.join(HERE, 'public');
const MODEL_PATH = path.join(DATA, 'model.json');
const STATE_PATH = path.join(DATA, 'state.json');
const BOARD_PATH = path.join(DATA, 'board.json');
const ELEMENT_HISTORY_PATH = path.join(DATA, 'element-history.json');
const ELEMENT_HISTORY_PENDING_PATH = path.join(DATA, 'element-history.pending.json');
const RENDER_STATE_PATH = path.join(DATA, 'render-state.json');
const PPTX_PATH = path.join(ROOT, 'presentation.pptx');
const RENDER_PY = path.join(HERE, 'render_pptx.py');
const LINT_FONTS_PY = path.join(HERE, 'lint_fonts.py');
const THUMBS_PS1 = path.join(HERE, 'export_thumbs.ps1');
const THUMBS_DIR = path.join(DATA, 'thumbs');
const THUMBS_SRC = path.join(DATA, 'thumbs-src.pptx'); // snapshot exported FROM, so a concurrent render can't rewrite the file the COM host has open
const PDF_PS1 = path.join(HERE, 'export_pdf.ps1');
const PDF_PATH = path.join(DATA, 'presentation.pdf');
const COM_HOST_PS1 = path.join(HERE, 'com_host.ps1');
const COM_HOST_PID_PATH = path.join(DATA, 'com_host.pid.json');

const PORT = parseInt(process.env.SUITE_PORT || '4599', 10);
const HOST = process.env.SUITE_HOST || '127.0.0.1';
const PY = process.env.SUITE_PYTHON || 'python';
const EDITOR_TTL = 15000;      // ms before a silent editor is considered gone
const LOCK_TTL = 20 * 60 * 1000;   // ms before an unrefreshed slide lock auto-expires
const UNDO_LIMIT = 50;         // max entries kept on either the undo or redo stack
const PROTECTION_HISTORY_LIMIT = 200; // dedicated approval/rejection audit, independent of the mixed activity log
const ELEMENT_HISTORY_VISIBLE_LIMIT = 10;
const ELEMENT_HISTORY_ARCHIVE_LIMIT = 100;
const ELEMENT_HISTORY_RESTORE_UNDO_LIMIT = 3;
const IS_WIN = process.platform === 'win32';
// server.js/agents.js only run once at boot: unlike ppt.js (fresh process per
// invocation) or the Python scripts (spawned fresh per call), editing either
// file has no effect on the live process until it's restarted. This project
// has needed that restart dozens of times across its history and nothing
// ever surfaced when a session forgot, `ppt status` just kept showing
// whatever the stale in-memory code produced with no signal anything was
// off. Recording boot time here lets a client compare it against these
// files' own mtimes and warn instead of silently running stale code.
const BOOTED_AT = Date.now();
const PROJECT_ASSETS = path.join(ROOT, 'assets');
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif']);
const VIDEO_EXTENSIONS = new Set(['.mp4']);
const BOX_SHAPE_PRESETS = new Set([
  'rect',
  'roundRect',
  'round1Rect',
  'round2SameRect',
  'round2DiagRect',
  'snip1Rect',
  'snip2SameRect',
  'snip2DiagRect',
  'snipRoundRect',
]);

// ------------------------------------------------------------------ utilities
function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function storedImageSourceError(value) {
  if (typeof value !== 'string' || !value.trim()) return 'source must be a non-empty string';
  if (path.isAbsolute(value)) return 'source must be stored as a project-relative path';
  const normalized = value.replace(/\\/g, '/');
  if (normalized !== value || normalized.startsWith('/') || normalized.includes('\0')) {
    return 'source must use a normalized project-relative path';
  }
  const parts = normalized.split('/');
  if (parts.length < 2 || parts[0].toLowerCase() !== 'assets' ||
      parts.some((part) => !part || part === '.' || part === '..')) {
    return 'source must be inside the project assets folder';
  }
  if (!IMAGE_EXTENSIONS.has(path.extname(normalized).toLowerCase())) {
    return 'source must be a PNG, JPEG, or GIF image';
  }
  return null;
}

function resolveProjectImageSource(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: 'source must be a non-empty image path' };
  }
  let absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(ROOT, value);
  let realRoot;
  let realAssets;
  try {
    realRoot = fs.realpathSync(ROOT);
    realAssets = fs.realpathSync(PROJECT_ASSETS);
    absolute = fs.realpathSync(absolute);
  } catch (_) {
    return { ok: false, error: 'image source does not exist' };
  }
  const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
  if (!inside(realRoot, absolute) || !inside(realAssets, absolute)) {
    return { ok: false, error: 'image source must stay inside this project\'s assets folder' };
  }
  let stat;
  try { stat = fs.statSync(absolute); } catch (_) { /* handled below */ }
  if (!stat || !stat.isFile()) return { ok: false, error: 'image source must be a file' };
  if (!IMAGE_EXTENSIONS.has(path.extname(absolute).toLowerCase())) {
    return { ok: false, error: 'image source must be a PNG, JPEG, or GIF image' };
  }
  const source = path.relative(realRoot, absolute).split(path.sep).join('/');
  const invalid = storedImageSourceError(source);
  return invalid ? { ok: false, error: invalid } : { ok: true, source, absolute };
}

function storedVideoSourceError(value) {
  if (typeof value !== 'string' || !value.trim()) return 'source must be a non-empty string';
  if (path.isAbsolute(value)) return 'source must be stored as a project-relative path';
  const normalized = value.replace(/\\/g, '/');
  if (normalized !== value || normalized.startsWith('/') || normalized.includes('\0')) {
    return 'source must use a normalized project-relative path';
  }
  const parts = normalized.split('/');
  if (parts.length < 2 || parts[0].toLowerCase() !== 'assets' ||
      parts.some((part) => !part || part === '.' || part === '..')) {
    return 'source must be inside the project assets folder';
  }
  if (!VIDEO_EXTENSIONS.has(path.extname(normalized).toLowerCase())) {
    return 'source must be an MP4 video';
  }
  return null;
}

function resolveProjectVideoSource(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: 'source must be a non-empty MP4 path' };
  }
  let absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(ROOT, value);
  let realRoot;
  let realAssets;
  try {
    realRoot = fs.realpathSync(ROOT);
    realAssets = fs.realpathSync(PROJECT_ASSETS);
    absolute = fs.realpathSync(absolute);
  } catch (_) {
    return { ok: false, error: 'video source does not exist' };
  }
  const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
  if (!inside(realRoot, absolute) || !inside(realAssets, absolute)) {
    return { ok: false, error: 'video source must stay inside this project\'s assets folder' };
  }
  let stat;
  try { stat = fs.statSync(absolute); } catch (_) { /* handled below */ }
  if (!stat || !stat.isFile()) return { ok: false, error: 'video source must be a file' };
  if (!VIDEO_EXTENSIONS.has(path.extname(absolute).toLowerCase())) {
    return { ok: false, error: 'video source must be an MP4 video' };
  }
  const source = path.relative(realRoot, absolute).split(path.sep).join('/');
  const invalid = storedVideoSourceError(source);
  return invalid ? { ok: false, error: invalid } : { ok: true, source, absolute };
}

function validateModelDocument(value, requireDecorIds = false) {
  if (!isRecord(value)) return 'root must be an object';
  if (typeof value.title !== 'string') return 'title must be a string';
  if (!Number.isInteger(value.rev) || value.rev < 0) return 'rev must be a non-negative integer';
  if (!Array.isArray(value.slides) || value.slides.length === 0) return 'slides must be a non-empty array';
  if (value.theme !== undefined && !isRecord(value.theme)) return 'theme must be an object';
  if (value.theme && value.theme.accent !== undefined &&
      (typeof value.theme.accent !== 'string' ||
       !/^#[0-9a-fA-F]{6}$/.test(value.theme.accent))) return 'theme.accent must be a #RRGGBB color';
  if (value.mode !== undefined && !['native', 'overlay'].includes(value.mode)) return 'mode must be native or overlay';
  if (value.mode === 'overlay' && (typeof value.base !== 'string' || !value.base.trim())) {
    return 'an overlay model needs a base PowerPoint path';
  }
  if (value.shapePresetSchema !== undefined && value.shapePresetSchema !== 1) {
    return 'shapePresetSchema must be 1 when present';
  }
  const slideIds = new Set();
  const sources = new Set();
  const objectIds = new Set();
  const shapeRefs = new Set();
  const validNativeLayouts = new Set(['title', 'content', 'bullets', 'section', 'titleonly', 'blank', 'two', 'compare']);
  const validateBox = (box, label) => {
    if (!isRecord(box)) return `${label} must be an object`;
    let fields = 0;
    for (const key of ['x', 'y', 'w', 'h']) {
      if (box[key] === undefined) continue;
      fields++;
      const number = box[key];
      if (typeof number !== 'number' || !Number.isFinite(number)) return `${label}.${key} must be finite`;
      if ((key === 'w' || key === 'h') && number <= 0) return `${label}.${key} must be positive`;
    }
    if (!fields) return `${label} must contain geometry`;
    return null;
  };
  const validateGeneratedBox = (box, label) => {
    if (!isRecord(box)) return `${label} must be an object`;
    for (const key of ['x', 'y', 'w', 'h']) {
      const number = box[key];
      if (typeof number !== 'number' || !Number.isFinite(number)) {
        return `${label}.${key} must be a finite number`;
      }
      if (number < 0 || number > 1) return `${label}.${key} must be between 0 and 1`;
      if ((key === 'w' || key === 'h') && number <= 0) return `${label}.${key} must be positive`;
    }
    if (box.x + box.w > 1 || box.y + box.h > 1) return `${label} must fit within the slide`;
    return null;
  };
  const validateStyle = (style, label) => {
    if (!isRecord(style)) return `${label} must be an object`;
    for (const key of ['color', 'fill', 'outline']) {
      if (style[key] !== undefined &&
          (typeof style[key] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(style[key]))) {
        return `${label}.${key} must be a #RRGGBB color`;
      }
    }
    if (style.bold !== undefined && typeof style.bold !== 'boolean') return `${label}.bold must be a boolean`;
    if (style.size !== undefined &&
        (typeof style.size !== 'number' || !Number.isFinite(style.size) || style.size <= 0 || style.size > 400)) {
      return `${label}.size must be greater than 0 and no more than 400`;
    }
    if (style.align !== undefined && !['left', 'center', 'right', 'justify'].includes(style.align)) {
      return `${label}.align is invalid`;
    }
    if (style.font !== undefined &&
        (typeof style.font !== 'string' || !/^[A-Za-z0-9 \-]{1,60}$/.test(style.font))) {
      return `${label}.font is invalid`;
    }
    return null;
  };
  for (let i = 0; i < value.slides.length; i++) {
    const slide = value.slides[i];
    if (!isRecord(slide)) return `slides[${i}] must be an object`;
    if (typeof slide.id !== 'string' || !slide.id) return `slides[${i}].id must be a non-empty string`;
    if (slideIds.has(slide.id)) return `duplicate slide id "${slide.id}"`;
    slideIds.add(slide.id);
    if (typeof slide.layout !== 'string') return `slide "${slide.id}" needs a string layout`;
    if (slide.src === undefined && !validNativeLayouts.has(slide.layout)) {
      return `native slide "${slide.id}" has an unknown layout "${slide.layout}"`;
    }
    if (slide.notes !== undefined && typeof slide.notes !== 'string') return `slide "${slide.id}".notes must be a string`;
    if (slide.transition !== undefined) {
      const transition = slide.transition;
      if (!isRecord(transition)) return `slide "${slide.id}".transition must be an object`;
      const unknownTransitionFields = Object.keys(transition)
        .filter((key) => !['effect', 'duration'].includes(key))
        .sort();
      if (unknownTransitionFields.length) {
        return `slide "${slide.id}".transition has unknown field: ${unknownTransitionFields[0]}`;
      }
      if (!['fade', 'none'].includes(transition.effect)) {
        return `slide "${slide.id}".transition.effect must be fade or none`;
      }
      if (transition.effect === 'fade') {
        if (typeof transition.duration !== 'number' || !Number.isFinite(transition.duration) ||
            transition.duration < 0.1 || transition.duration > 10) {
          return `slide "${slide.id}".transition.duration must be a finite number from 0.1 to 10 seconds`;
        }
      } else if (transition.duration !== undefined) {
        return `slide "${slide.id}".transition.duration is only valid for fade`;
      }
    }
    if (!Array.isArray(slide.elements)) return `slide "${slide.id}" needs an elements array`;
    if (slide.decor !== undefined && !Array.isArray(slide.decor)) return `slide "${slide.id}".decor must be an array`;
    if (slide.animations !== undefined && !Array.isArray(slide.animations)) {
      return `slide "${slide.id}".animations must be an array`;
    }
    if (slide.src !== undefined) {
      if (!Number.isInteger(slide.src) || slide.src < 0) return `slide "${slide.id}".src must be a non-negative integer`;
      if (sources.has(slide.src)) return `duplicate imported slide source ${slide.src}`;
      sources.add(slide.src);
    }
    for (let j = 0; j < slide.elements.length; j++) {
      const element = slide.elements[j];
      if (!isRecord(element)) return `slide "${slide.id}" element ${j} must be an object`;
      if (typeof element.id !== 'string' || !element.id) return `slide "${slide.id}" element ${j} needs an id`;
      if (objectIds.has(element.id)) return `duplicate object id "${element.id}"`;
      objectIds.add(element.id);
      if (typeof element.type !== 'string' || !element.type) return `element "${element.id}" needs a type`;
      if (element.text !== undefined && typeof element.text !== 'string') return `element "${element.id}".text must be a string`;
      if (element.items !== undefined &&
          (!Array.isArray(element.items) || !element.items.every((item) => typeof item === 'string'))) {
        return `element "${element.id}".items must be an array of strings`;
      }
      if (element.style !== undefined) {
        const invalidStyle = validateStyle(element.style, `element "${element.id}".style`);
        if (invalidStyle) return invalidStyle;
      }
      if (element.ref !== undefined) {
        if (!isRecord(element.ref) || !Number.isInteger(element.ref.s) || !Number.isInteger(element.ref.sid)) {
          return `element "${element.id}".ref must contain integer s and sid`;
        }
        if (slide.src !== undefined && element.ref.s !== slide.src) {
          return `element "${element.id}".ref.s must match its slide source`;
        }
        const refKey = `${element.ref.s}:${element.ref.sid}`;
        if (shapeRefs.has(refKey)) return `duplicate backing shape ref ${refKey}`;
        shapeRefs.add(refKey);
      } else if (value.mode === 'overlay' && slide.src !== undefined && !element.readonly) {
        return `imported element "${element.id}" needs a backing shape ref`;
      }
      if (element.sourcePreset !== undefined) {
        if (!BOX_SHAPE_PRESETS.has(element.sourcePreset)) {
          return `element "${element.id}".sourcePreset is not an eligible box/card preset`;
        }
        if (value.mode !== 'overlay' || slide.src === undefined || !element.ref || element.readonly) {
          return `element "${element.id}".sourcePreset is valid only for an editable imported AutoShape`;
        }
      }
      if (element.corners !== undefined) {
        if (element.corners !== 'sharp') return `element "${element.id}".corners must be sharp`;
        if (!BOX_SHAPE_PRESETS.has(element.sourcePreset)) {
          return `element "${element.id}".corners needs eligible imported sourcePreset metadata`;
        }
      }
      if (element.box !== undefined) {
        // Imported shapes may legitimately extend beyond a slide, but a box
        // authored for native text is an explicit normalized placement and
        // must be complete, finite, positive, and fully on-slide.
        const invalidBox = slide.src === undefined
          ? validateGeneratedBox(element.box, `element "${element.id}".box`)
          : validateBox(element.box, `element "${element.id}".box`);
        if (invalidBox) return invalidBox;
      }
    }
    for (let j = 0; j < (slide.decor || []).length; j++) {
      const decor = slide.decor[j];
      if (!isRecord(decor)) return `slide "${slide.id}" decor ${j} must be an object`;
      if (decor.id === undefined && !requireDecorIds) {
        // assignDecorLocalIds() is the boot migration for this legacy shape.
      } else {
        if (typeof decor.id !== 'string' || !decor.id) return `slide "${slide.id}" decor ${j} needs an id`;
        if (objectIds.has(decor.id)) return `duplicate object id "${decor.id}"`;
        objectIds.add(decor.id);
      }
      if (!['shape', 'pic', 'media'].includes(decor.kind)) return `decor "${decor.id}" has an unknown kind`;
      if (decor.sid !== undefined && decor.sid !== null &&
          (!Number.isInteger(decor.sid) || decor.sid < 0)) return `decor "${decor.id}".sid must be a non-negative integer or null`;
      if (decor.generated !== undefined && decor.generated !== true) {
        return `decor "${decor.id}".generated must be true when present`;
      }
      if (decor.sourcePreset !== undefined) {
        if (!BOX_SHAPE_PRESETS.has(decor.sourcePreset)) {
          return `decor "${decor.id}".sourcePreset is not an eligible box/card preset`;
        }
        if (value.mode !== 'overlay' || slide.src === undefined ||
            decor.generated === true || decor.kind !== 'shape' || !Number.isInteger(decor.sid)) {
          return `decor "${decor.id}".sourcePreset is valid only for an imported AutoShape`;
        }
      }
      if (decor.corners !== undefined) {
        if (decor.corners !== 'sharp') return `decor "${decor.id}".corners must be sharp`;
        if (!BOX_SHAPE_PRESETS.has(decor.sourcePreset)) {
          return `decor "${decor.id}".corners needs eligible imported sourcePreset metadata`;
        }
      }
      if (decor.shapeType !== undefined && decor.shapeType !== 'rect') {
        return `decor "${decor.id}" has an unknown shapeType`;
      }
      if (decor.generated === true) {
        const isNativeSlide = slide.src === undefined;
        const isImportedOverlaySlide =
          (value.mode || 'native') === 'overlay' && Number.isInteger(slide.src);
        if (!isNativeSlide && !isImportedOverlaySlide) {
          return `generated decor "${decor.id}" is allowed only on suite-native or imported overlay slides`;
        }
        if (decor.sid !== null) return `generated decor "${decor.id}".sid must be null`;
        const invalidGeneratedBox = validateGeneratedBox(decor.box, `decor "${decor.id}".box`);
        if (invalidGeneratedBox) return invalidGeneratedBox;
        if (decor.kind === 'shape') {
          if (decor.shapeType !== 'rect') return `generated decor "${decor.id}".shapeType must be rect`;
          if (typeof decor.fill !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(decor.fill)) {
            return `generated decor "${decor.id}".fill must be a #RRGGBB color`;
          }
          if (decor.source !== undefined) return `generated shape "${decor.id}" cannot have a source`;
        } else if (decor.kind === 'pic') {
          if (decor.shapeType !== undefined) return `generated picture "${decor.id}" cannot have shapeType`;
          if (decor.fill !== undefined) return `generated picture "${decor.id}" cannot have fill`;
          const invalidSource = storedImageSourceError(decor.source);
          if (invalidSource) return `generated picture "${decor.id}".${invalidSource}`;
        } else if (decor.kind === 'media') {
          if (decor.shapeType !== undefined) return `generated media "${decor.id}" cannot have shapeType`;
          if (decor.fill !== undefined) return `generated media "${decor.id}" cannot have fill`;
          const invalidSource = storedVideoSourceError(decor.source);
          if (invalidSource) return `generated media "${decor.id}".${invalidSource}`;
          if (typeof decor.autoplay !== 'boolean') {
            return `generated media "${decor.id}".autoplay must be a boolean`;
          }
          if (typeof decor.loop !== 'boolean') {
            return `generated media "${decor.id}".loop must be a boolean`;
          }
        } else {
          return `generated decor "${decor.id}" must have kind shape, pic, or media`;
        }
      } else {
        if (decor.kind === 'media') {
          return `decor "${decor.id}" media is valid only for generated decor`;
        }
        if (decor.shapeType !== undefined) {
          return `decor "${decor.id}".shapeType is valid only for generated decor`;
        }
        const invalidBox = validateBox(decor.box, `decor "${decor.id}".box`);
        if (invalidBox) return invalidBox;
      }
      if (decor.fill !== undefined &&
          (typeof decor.fill !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(decor.fill))) {
        return `decor "${decor.id}".fill must be a #RRGGBB color`;
      }
    }
    const localIds = new Set([
      ...slide.elements.map((element) => element.id),
      ...(slide.decor || []).map((decor) => decor.id),
    ]);
    const mediaIds = new Set(
      (slide.decor || [])
        .filter((decor) => decor.kind === 'media')
        .map((decor) => decor.id)
    );
    const animatedIds = new Set();
    for (let j = 0; j < (slide.animations || []).length; j++) {
      const animation = slide.animations[j];
      const label = `slide "${slide.id}" animation ${j}`;
      if (!isRecord(animation)) return `${label} must be an object`;
      const unknown = Object.keys(animation)
        .filter((key) => !['targetId', 'effect', 'trigger', 'duration', 'delay'].includes(key))
        .sort();
      if (unknown.length) return `${label} has unknown field: ${unknown[0]}`;
      if (typeof animation.targetId !== 'string' || !localIds.has(animation.targetId)) {
        return `${label}.targetId must name an element or decor item on the same slide`;
      }
      if (mediaIds.has(animation.targetId)) {
        return `${label}.targetId cannot name a media item`;
      }
      if (animatedIds.has(animation.targetId)) return `${label}.targetId is duplicated`;
      animatedIds.add(animation.targetId);
      if (!['appear', 'fade', 'wipe', 'rise-up'].includes(animation.effect)) {
        return `${label}.effect must be appear, fade, wipe, or rise-up`;
      }
      if (!['click', 'with-previous', 'after-previous'].includes(animation.trigger)) {
        return `${label}.trigger must be click, with-previous, or after-previous`;
      }
      if (j === 0 && animation.trigger !== 'click') {
        return `${label}.trigger must be click for the first animation`;
      }
      if (typeof animation.duration !== 'number' || !Number.isFinite(animation.duration) ||
          animation.duration < 0.1 || animation.duration > 10) {
        return `${label}.duration must be a finite number from 0.1 to 10 seconds`;
      }
      if (typeof animation.delay !== 'number' || !Number.isFinite(animation.delay) ||
          animation.delay < 0 || animation.delay > 30) {
        return `${label}.delay must be a finite number from 0 to 30 seconds`;
      }
    }
  }
  return null;
}

function protectionKey(protection) {
  return protection.kind === 'slide'
    ? `slide:${protection.slideId}`
    : `object:${protection.slideId}:${protection.objectKind}:${protection.objectId}`;
}

function validateProtectionRecords(protections) {
  if (!Array.isArray(protections)) return 'protections must be an array';
  const seen = new Set();
  for (let i = 0; i < protections.length; i++) {
    const protection = protections[i];
    const label = `protections[${i}]`;
    if (!isRecord(protection)) return `${label} must be an object`;
    const allowed = protection.kind === 'slide'
      ? new Set(['kind', 'slideId', 'by', 'createdAt'])
      : new Set(['kind', 'slideId', 'objectId', 'objectKind', 'by', 'createdAt']);
    const unknown = Object.keys(protection).filter((key) => !allowed.has(key)).sort();
    if (unknown.length) return `${label} has unknown field: ${unknown[0]}`;
    if (!['slide', 'object'].includes(protection.kind)) {
      return `${label}.kind must be slide or object`;
    }
    if (typeof protection.slideId !== 'string' || !protection.slideId.trim()) {
      return `${label}.slideId must be a non-empty string`;
    }
    if (protection.kind === 'slide') {
      if (protection.objectId !== undefined || protection.objectKind !== undefined) {
        return `${label} slide protection cannot contain objectId or objectKind`;
      }
    } else {
      if (typeof protection.objectId !== 'string' || !protection.objectId.trim()) {
        return `${label}.objectId must be a non-empty string`;
      }
      if (!['element', 'decor'].includes(protection.objectKind)) {
        return `${label}.objectKind must be element or decor`;
      }
    }
    if (protection.by !== undefined &&
        (typeof protection.by !== 'string' || !protection.by.trim() || protection.by.length > 60)) {
      return `${label}.by must be a non-empty string no longer than 60 characters`;
    }
    if (protection.createdAt !== undefined &&
        (!Number.isSafeInteger(protection.createdAt) || protection.createdAt < 0)) {
      return `${label}.createdAt must be a non-negative safe integer`;
    }
    const key = protectionKey(protection);
    if (seen.has(key)) return `${label} duplicates ${key}`;
    seen.add(key);
  }
  return null;
}

// An exception is the inverse branch of a slide lock: the parent slide stays
// locked, while this stable child identity remains editable. Keeping these in
// their own array makes the two user workflows unambiguous and preserves the
// legacy meaning of `protections` (every row in that array is a lock).
function validateProtectionExceptionRecords(exceptions) {
  if (!Array.isArray(exceptions)) return 'protectionExceptions must be an array';
  const seen = new Set();
  for (let i = 0; i < exceptions.length; i++) {
    const exception = exceptions[i];
    const label = `protectionExceptions[${i}]`;
    if (!isRecord(exception)) return `${label} must be an object`;
    const allowed = new Set(['kind', 'slideId', 'objectId', 'objectKind', 'by', 'createdAt']);
    const unknown = Object.keys(exception).filter((key) => !allowed.has(key)).sort();
    if (unknown.length) return `${label} has unknown field: ${unknown[0]}`;
    if (exception.kind !== 'object') return `${label}.kind must be object`;
    if (typeof exception.slideId !== 'string' || !exception.slideId.trim()) {
      return `${label}.slideId must be a non-empty string`;
    }
    if (typeof exception.objectId !== 'string' || !exception.objectId.trim()) {
      return `${label}.objectId must be a non-empty string`;
    }
    if (!['element', 'decor'].includes(exception.objectKind)) {
      return `${label}.objectKind must be element or decor`;
    }
    if (typeof exception.by !== 'string' || !exception.by.trim() || exception.by.length > 60) {
      return `${label}.by must be a non-empty string no longer than 60 characters`;
    }
    if (!Number.isSafeInteger(exception.createdAt) || exception.createdAt < 0) {
      return `${label}.createdAt must be a non-negative safe integer`;
    }
    const key = protectionKey(exception);
    if (seen.has(key)) return `${label} duplicates ${key}`;
    seen.add(key);
  }
  return null;
}

function validateProtectionHistory(records) {
  if (!Array.isArray(records)) return 'protectionHistory must be an array';
  if (records.length > PROTECTION_HISTORY_LIMIT) {
    return `protectionHistory cannot exceed ${PROTECTION_HISTORY_LIMIT} entries`;
  }
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const label = `protectionHistory[${i}]`;
    if (!isRecord(record)) return `${label} must be an object`;
    const allowed = record.kind === 'slide'
      ? new Set(['action', 'kind', 'slideId', 'by', 'ts', 'taskId', 'authorizedBy', 'authorizedAt'])
      : new Set([
          'action', 'kind', 'slideId', 'objectId', 'objectKind', 'by', 'ts',
          'taskId', 'authorizedBy', 'authorizedAt'
        ]);
    const unknown = Object.keys(record).filter((key) => !allowed.has(key)).sort();
    if (unknown.length) return `${label} has unknown field: ${unknown[0]}`;
    if (!['lock', 'unlock'].includes(record.action)) {
      return `${label}.action must be lock or unlock`;
    }
    if (!['slide', 'object'].includes(record.kind)) {
      return `${label}.kind must be slide or object`;
    }
    if (typeof record.slideId !== 'string' || !record.slideId.trim()) {
      return `${label}.slideId must be a non-empty string`;
    }
    if (record.kind === 'slide') {
      if (record.objectId !== undefined || record.objectKind !== undefined) {
        return `${label} slide event cannot contain objectId or objectKind`;
      }
    } else {
      if (typeof record.objectId !== 'string' || !record.objectId.trim()) {
        return `${label}.objectId must be a non-empty string`;
      }
      if (!['element', 'decor'].includes(record.objectKind)) {
        return `${label}.objectKind must be element or decor`;
      }
    }
    if (typeof record.by !== 'string' || !record.by.trim() || record.by.length > 60) {
      return `${label}.by must be a non-empty string no longer than 60 characters`;
    }
    if (!Number.isSafeInteger(record.ts) || record.ts < 0) {
      return `${label}.ts must be a non-negative safe integer`;
    }
    const delegatedFields = ['taskId', 'authorizedBy', 'authorizedAt'];
    const delegatedCount = delegatedFields.filter((field) => record[field] !== undefined).length;
    if (delegatedCount !== 0 && delegatedCount !== delegatedFields.length) {
      return `${label} delegated audit fields must appear together`;
    }
    if (delegatedCount) {
      if (typeof record.taskId !== 'string' || !record.taskId.trim() || record.taskId.length > 120) {
        return `${label}.taskId must be a non-empty string no longer than 120 characters`;
      }
      if (typeof record.authorizedBy !== 'string' || !record.authorizedBy.trim() ||
          record.authorizedBy.length > 60 || isSuiteAgentActor(record.authorizedBy)) {
        return `${label}.authorizedBy must name a non-agent authorizer`;
      }
      if (!Number.isSafeInteger(record.authorizedAt) || record.authorizedAt < 0 ||
          record.authorizedAt > record.ts) {
        return `${label}.authorizedAt must be a safe integer no later than ts`;
      }
    }
  }
  return null;
}

function validateStateDocument(value) {
  if (!isRecord(value)) return 'root must be an object';
  if (typeof value.paused !== 'boolean') return 'paused must be a boolean';
  if (value.log !== undefined && !Array.isArray(value.log)) return 'log must be an array';
  if (value.protections !== undefined) {
    const invalidProtections = validateProtectionRecords(value.protections);
    if (invalidProtections) return invalidProtections;
  }
  if (value.protectionExceptions !== undefined) {
    const invalidExceptions = validateProtectionExceptionRecords(value.protectionExceptions);
    if (invalidExceptions) return invalidExceptions;
    const protections = Array.isArray(value.protections) ? value.protections : [];
    for (let i = 0; i < value.protectionExceptions.length; i++) {
      const exception = value.protectionExceptions[i];
      if (!protections.some((item) => item.kind === 'slide' && item.slideId === exception.slideId)) {
        return `protectionExceptions[${i}] requires a slide protection for ${exception.slideId}`;
      }
    }
  }
  if (value.protectionHistory !== undefined) {
    const invalidProtectionHistory = validateProtectionHistory(value.protectionHistory);
    if (invalidProtectionHistory) return invalidProtectionHistory;
  }
  if (value.pdfRev !== undefined && value.pdfRev !== null &&
      (!Number.isInteger(value.pdfRev) || value.pdfRev < 0)) return 'pdfRev must be null or a non-negative integer';
  if (value.loopRunner !== undefined && typeof value.loopRunner !== 'boolean') return 'loopRunner must be a boolean';
  if (value.usageProfile !== undefined && !PROFILES[value.usageProfile]) return 'usageProfile is not recognized';
  if (value.agentProvider !== undefined && !PROVIDER_MODELS[value.agentProvider]) return 'agentProvider is not recognized';
  if (value.agentFastMode !== undefined && typeof value.agentFastMode !== 'boolean') {
    return 'agentFastMode must be a boolean';
  }
  if (value.spend !== undefined && value.spend !== null) {
    if (!isRecord(value.spend)) return 'spend must be an object or null';
    const spend = value.spend;
    for (const key of ['totalUsd', 'turns']) {
      if (spend[key] !== undefined &&
          (typeof spend[key] !== 'number' || !Number.isFinite(spend[key]) || spend[key] < 0)) {
        return `spend.${key} must be a non-negative number`;
      }
    }
    if (spend.tokens !== undefined) {
      if (!isRecord(spend.tokens)) return 'spend.tokens must be an object';
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
        if (spend.tokens[key] !== undefined &&
            (typeof spend.tokens[key] !== 'number' || !Number.isFinite(spend.tokens[key]) || spend.tokens[key] < 0)) {
          return `spend.tokens.${key} must be a non-negative number`;
        }
      }
    }
    const validateRollups = (rollups, label, fields) => {
      if (rollups === undefined) return null;
      if (!isRecord(rollups)) return `${label} must be an object`;
      for (const [name, entry] of Object.entries(rollups)) {
        if (!isRecord(entry)) return `${label}.${name} must be an object`;
        for (const field of fields) {
          if (entry[field] !== undefined &&
              (typeof entry[field] !== 'number' || !Number.isFinite(entry[field]) || entry[field] < 0)) {
            return `${label}.${name}.${field} must be a non-negative number`;
          }
        }
      }
      return null;
    };
    const invalidModels = validateRollups(
      spend.byModel, 'spend.byModel', ['usd', 'turns', 'promptTokens', 'outputTokens']
    );
    if (invalidModels) return invalidModels;
    const invalidRoles = validateRollups(spend.byRole, 'spend.byRole', ['usd', 'turns']);
    if (invalidRoles) return invalidRoles;
    if (spend.recent !== undefined) {
      if (!Array.isArray(spend.recent)) return 'spend.recent must be an array';
      for (let i = 0; i < spend.recent.length; i++) {
        const entry = spend.recent[i];
        if (!isRecord(entry)) return `spend.recent[${i}] must be an object`;
        for (const field of ['ts', 'usd', 'promptTokens', 'outTokens']) {
          if (entry[field] !== undefined &&
              (typeof entry[field] !== 'number' || !Number.isFinite(entry[field]) || entry[field] < 0)) {
            return `spend.recent[${i}].${field} must be a non-negative number`;
          }
        }
      }
    }
  }
  return null;
}

function validateTaskProtectionGrant(grant, label) {
  if (!isRecord(grant)) return `${label} must be an object`;
  const allowed = new Set([
    'version', 'slideIds', 'editOps', 'protectionModes', 'grantedTo',
    'grantedBy', 'grantedAt', 'expiresAt', 'revokedAt', 'revokedBy'
  ]);
  const unknown = Object.keys(grant).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) return `${label} has unknown field: ${unknown[0]}`;
  if (grant.version !== 1) return `${label}.version must be 1`;
  if (!Array.isArray(grant.slideIds) || !grant.slideIds.length ||
      grant.slideIds.some((item) => typeof item !== 'string' || !item.trim()) ||
      new Set(grant.slideIds).size !== grant.slideIds.length) {
    return `${label}.slideIds must be a non-empty unique string array`;
  }
  if (!Array.isArray(grant.editOps) ||
      grant.editOps.some((item) => item !== 'add-image') ||
      new Set(grant.editOps).size !== grant.editOps.length) {
    return `${label}.editOps may contain add-image once`;
  }
  const allowedModes = new Set(['direct-generated-decor']);
  if (!Array.isArray(grant.protectionModes) ||
      grant.protectionModes.some((item) => !allowedModes.has(item)) ||
      new Set(grant.protectionModes).size !== grant.protectionModes.length) {
    return `${label}.protectionModes contains an invalid or duplicate mode`;
  }
  for (const field of ['grantedTo', 'grantedBy']) {
    if (typeof grant[field] !== 'string' || !grant[field].trim() || grant[field].length > 60) {
      return `${label}.${field} must be a non-empty string no longer than 60 characters`;
    }
  }
  for (const field of ['grantedAt', 'expiresAt']) {
    if (!Number.isSafeInteger(grant[field]) || grant[field] < 0) {
      return `${label}.${field} must be a non-negative safe integer`;
    }
  }
  if (grant.expiresAt <= grant.grantedAt) return `${label}.expiresAt must follow grantedAt`;
  if (grant.revokedAt !== undefined) {
    if (!Number.isSafeInteger(grant.revokedAt) || grant.revokedAt < grant.grantedAt) {
      return `${label}.revokedAt must be a safe integer at or after grantedAt`;
    }
    if (typeof grant.revokedBy !== 'string' || !grant.revokedBy.trim() || grant.revokedBy.length > 60) {
      return `${label}.revokedBy must accompany revokedAt`;
    }
  } else if (grant.revokedBy !== undefined) {
    return `${label}.revokedBy requires revokedAt`;
  }
  return null;
}

function validateBoardDocument(value) {
  if (!isRecord(value)) return 'root must be an object';
  if (!Array.isArray(value.notes)) return 'notes must be an array';
  if (value.tasks !== undefined && !Array.isArray(value.tasks)) return 'tasks must be an array';
  if (value.loops !== undefined && !Array.isArray(value.loops)) return 'loops must be an array';
  for (let i = 0; i < value.notes.length; i++) {
    if (!isRecord(value.notes[i])) return `notes[${i}] must be an object`;
  }
  for (let i = 0; i < (value.tasks || []).length; i++) {
    if (!isRecord(value.tasks[i])) return `tasks[${i}] must be an object`;
    if (value.tasks[i].protectionGrant !== undefined) {
      const invalidGrant = validateTaskProtectionGrant(
        value.tasks[i].protectionGrant,
        `tasks[${i}].protectionGrant`
      );
      if (invalidGrant) return invalidGrant;
    }
  }
  for (let i = 0; i < (value.loops || []).length; i++) {
    if (!isRecord(value.loops[i])) return `loops[${i}] must be an object`;
  }
  return null;
}

// Missing files are a supported first-run case. Existing files are not:
// silently replacing malformed or structurally invalid persisted data with a
// default can unlock a paused project and then overwrite the only recoverable
// copy. Refuse to boot and name the exact file instead.
function loadJSON(file, fallback, validate) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read ${path.basename(file)}: ${error && (error.code || error.message)}`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot start with malformed ${path.basename(file)}: ${error.message}`);
  }
  const invalid = validate && validate(value);
  if (invalid) throw new Error(`Cannot start with invalid ${path.basename(file)}: ${invalid}`);
  return value;
}

function persistFailure(file, err) {
  const error = err && (err.code || err.message) || 'unknown error';
  console.error('saveJSONAtomic FAILED, disk is stale:', file, error);
  broadcast({ type: 'persist', ok: false, file: path.basename(file), error, ts: Date.now() });
  return false;
}

function saveJSONAtomic(file, obj) {
  let data;
  try { data = JSON.stringify(obj, null, 2); }
  catch (e) { return persistFailure(file, e); }
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
  try { fs.writeFileSync(tmp, data); }
  catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return persistFailure(file, e);
  }
  // On Windows, rename-over-existing can transiently fail (EPERM/EBUSY) if the
  // destination is briefly held open (AV, indexer, a reader). Retry, but never
  // fall back to an in-place overwrite: a crash/short write there can destroy
  // the last valid authoritative model/state/board.
  let lastErr = null;
  for (let i = 0; i < 8; i++) {
    try { fs.renameSync(tmp, file); return true; }
    catch (e) { lastErr = e; sleepMs(15 * (i + 1)); }
  }
  console.error('saveJSONAtomic preserved the old file; staged replacement remains at:', tmp);
  return persistFailure(file, lastErr || new Error('atomic rename failed'));
}

// A hard kill/crash, or an exhausted atomic rename, can leave a staged .tmp.
// Boot-time only, same safety window as sweepStaleComHost/Agents.sweepStale:
// nothing should be mid-write to these files the instant this process
// starts, since nothing else was running yet to be writing them.
function sweepStaleTmpFiles() {
  let entries;
  try { entries = fs.readdirSync(DATA); } catch (_) { return; }
  const bases = [
    'model.json', 'state.json', 'board.json', 'render-state.json',
    'element-history.json', 'element-history.pending.json', 'com_host.pid.json',
  ];
  for (const name of entries) {
    if (!name.endsWith('.tmp')) continue;
    if (!bases.some((b) => name.startsWith(b + '.'))) continue;
    try { fs.unlinkSync(path.join(DATA, name)); console.log('swept stale atomic-write temp file:', name); } catch (_) {}
  }
  let rootEntries;
  try { rootEntries = fs.readdirSync(ROOT); } catch (_) { return; }
  for (const name of rootEntries) {
    if (!/^\.presentation-\d+-\d+-[0-9a-f]{8}\.pptx$/i.test(name)) continue;
    try {
      fs.unlinkSync(path.join(ROOT, name));
      console.log('swept stale staged presentation:', name);
    } catch (_) {}
  }
}

function sleepMs(ms) {
  // synchronous, tiny — used only for the rare rename-retry backoff
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin briefly */ }
}

function validatePptxFile(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size < 22) throw new Error('renderer produced an empty PPTX');
  const bytes = fs.readFileSync(file);
  if (bytes.subarray(0, 2).toString('ascii') !== 'PK') throw new Error('renderer output is not a PPTX ZIP container');
  // A leading PK alone accepts a truncated or arbitrary ZIP. Require the ZIP
  // end record and the two package members every valid PowerPoint deck needs.
  if (bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) < 0 ||
      bytes.indexOf(Buffer.from('[Content_Types].xml')) < 0 ||
      bytes.indexOf(Buffer.from('ppt/presentation.xml')) < 0) {
    throw new Error('renderer output is an incomplete PowerPoint package');
  }
  return stat;
}

// The renderer writes a private same-volume file and only a validated result
// reaches presentation.pptx. Never fall back to an in-place overwrite here:
// preserving the last good deck is safer than replacing it with a partial file
// when antivirus, PowerPoint, or another reader holds the destination.
function commitStagedPptx(staged) {
  validatePptxFile(staged);
  let lastError = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.renameSync(staged, PPTX_PATH);
      return;
    } catch (error) {
      lastError = error;
      sleepMs(20 * (attempt + 1));
    }
  }
  throw lastError || new Error('could not replace presentation.pptx');
}

function persistRenderMarker(rev) {
  const bytes = fs.readFileSync(PPTX_PATH);
  return saveJSONAtomic(RENDER_STATE_PATH, {
    rev,
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    renderedAt: new Date().toISOString()
  });
}

function presentationFreshness() {
  try {
    const stat = validatePptxFile(PPTX_PATH);
    let marker = null;
    try {
      marker = JSON.parse(fs.readFileSync(RENDER_STATE_PATH, 'utf8'));
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        return { current: false, error: 'render-state.json is malformed or unreadable' };
      }
    }
    if (marker) {
      if (!Number.isInteger(marker.rev) || typeof marker.sha256 !== 'string') {
        return { current: false, error: 'render-state.json is invalid' };
      }
      if (marker.rev !== model.rev) {
        return { current: false, error: `presentation.pptx is at rev ${marker.rev}, model is rev ${model.rev}` };
      }
      const hash = crypto.createHash('sha256').update(fs.readFileSync(PPTX_PATH)).digest('hex');
      if (hash !== marker.sha256 || (marker.size != null && marker.size !== stat.size)) {
        return { current: false, error: 'presentation.pptx does not match its render marker' };
      }
      return { current: true, error: null, rev: marker.rev };
    }
    return {
      current: false,
      error: 'presentation.pptx has no exact revision marker; a verification render is required',
      rev: null,
      legacy: true
    };
  } catch (error) {
    return { current: false, error: error.message || String(error) };
  }
}

function shortId(prefix) {
  return prefix + crypto.randomBytes(4).toString('hex');
}

function setReadOnly(file, on) {
  return new Promise((resolve) => {
    // A missing output is already "not read-only" and can be created by the
    // next render. It cannot satisfy a pause lock, however.
    if (!fs.existsSync(file)) return resolve(!on);
    if (IS_WIN) {
      execFile('attrib', [on ? '+R' : '-R', file], (err) => resolve(!err));
    } else {
      try { fs.chmodSync(file, on ? 0o444 : 0o644); resolve(true); }
      catch (_) { resolve(false); }
    }
  });
}

// THUMBS_SRC is a disposable copy of the deck, but Windows preserves the
// source PPTX's read-only bit when copying it. A paused deck therefore left
// the next thumbnail refresh unable to overwrite its own derived snapshot.
// Clear only that derived file immediately before every copy; the deck/model
// pause lock is never weakened.
async function refreshThumbsFromDeck(capturedRev, failurePrefix) {
  try {
    await setReadOnly(THUMBS_SRC, false);
    if (fs.existsSync(PPTX_PATH)) fs.copyFileSync(PPTX_PATH, THUMBS_SRC);
    runThumbs(capturedRev);
    return true;
  } catch (e) {
    console.error(failurePrefix, e.code || e.message);
    return false;
  }
}

// -------------------------------------------------------------------- state
let model = loadJSON(MODEL_PATH, defaultModel(), validateModelDocument);
let state = loadJSON(STATE_PATH, {
  paused: false, pausedBy: null, pausedAt: null, pdfRev: null, agentFastMode: false
}, validateStateDocument);
// `protections` was added after state.json had already shipped. An absent
// field is the one supported legacy shape and means "none"; a present field
// was validated strictly above and is never silently repaired or discarded.
// Also validate every stable reference against the loaded model. A stale or
// mistyped persisted row must stop the server instead of booting with content
// unexpectedly unlocked.
if (state.protections === undefined) state.protections = [];
// Supported legacy state has no exception field. Exceptions are meaningful
// only beneath an active slide lock and are validated fail-closed when present.
if (state.protectionExceptions === undefined) state.protectionExceptions = [];
// This dedicated bounded ledger was added after protections themselves. Unlike
// active protection rows, historical targets may legitimately have been
// unlocked and later deleted, so only their strict schema is validated.
if (state.protectionHistory === undefined) state.protectionHistory = [];
for (let i = 0; i < state.protections.length; i++) {
  const protection = state.protections[i];
  const slide = model.slides.find((item) => item.id === protection.slideId);
  if (!slide) {
    throw new Error(`Cannot start with invalid state.json: protections[${i}] names missing slide "${protection.slideId}"`);
  }
  if (protection.kind !== 'object') continue;
  const objects = protection.objectKind === 'element' ? slide.elements : (slide.decor || []);
  if (!objects.some((item) => item.id === protection.objectId)) {
    throw new Error(
      `Cannot start with invalid state.json: protections[${i}] names missing ` +
      `${protection.objectKind} "${protection.objectId}" on slide "${protection.slideId}"`
    );
  }
}
for (let i = 0; i < state.protectionExceptions.length; i++) {
  const exception = state.protectionExceptions[i];
  const slide = model.slides.find((item) => item.id === exception.slideId);
  if (!slide) {
    throw new Error(`Cannot start with invalid state.json: protectionExceptions[${i}] names missing slide "${exception.slideId}"`);
  }
  const objects = exception.objectKind === 'element' ? slide.elements : (slide.decor || []);
  if (!objects.some((item) => item.id === exception.objectId)) {
    throw new Error(
      `Cannot start with invalid state.json: protectionExceptions[${i}] names missing ` +
      `${exception.objectKind} "${exception.objectId}" on slide "${exception.slideId}"`
    );
  }
}
// Pause/resume each change two operating-system locks across awaits. Keep the
// complete transition (including its state guard and response snapshot) in one
// FIFO lane so opposite clicks cannot interleave those locks.
let pauseTransitionTail = Promise.resolve();
function queuePauseTransition(work) {
  const job = pauseTransitionTail.then(work);
  // A failed transition must not leave every later pause/resume request stuck
  // behind a rejected promise. The initiating request still receives its own
  // failure; this catch only repairs the queue tail for the next request.
  pauseTransitionTail = job.catch((err) => {
    console.error('pause/resume transition failed:', err && (err.stack || err));
  });
  return job;
}
if (!Array.isArray(state.log)) state.log = [];
if (state.pdfRev === undefined) state.pdfRev = null; // an existing state.json from before this field existed
// Usage profile. Validated on load because state.json is a plain file a human
// can hand-edit, and an invalid value here would flow straight into --model,
// where the child dies at startup with no signal anywhere.
if (!PROFILES[state.usageProfile]) state.usageProfile = DEFAULT_PROFILE;
// Fast is its own saved next-spawn switch, independent of the usage profile.
// Legacy state files predate the field and intentionally start with it OFF.
if (typeof state.agentFastMode !== 'boolean') state.agentFastMode = false;
// The loop runner is ON by default. It is safe to leave on because it refuses to
// run while paused and refuses to run with no viewer present, so it cannot burn
// tokens in the background the way an unconditional timer would.
if (typeof state.loopRunner !== 'boolean') state.loopRunner = true;
// Which CLI backs the agents: 'claude' or 'codex'. Validated on load for the
// same reason the profile is: state.json is hand-editable and a bad value here
// would pick a transport that does not exist.
if (!PROVIDER_MODELS[state.agentProvider]) state.agentProvider = DEFAULT_PROVIDER;
// Persisted spend rollup. Lives here rather than on the AgentProcs because
// stop()/dismiss deletes those and every counter on them with it, which is
// exactly when you most want to know what the team cost.
if (!state.spend || typeof state.spend !== 'object') state.spend = null;
state.spend = Object.assign({
  sinceTs: Date.now(), totalUsd: 0, turns: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  byModel: {}, byRole: {}, recent: [],
}, state.spend || {});
state.spend.tokens = Object.assign(
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  state.spend.tokens || {}
);
state.spend.byModel = state.spend.byModel || {};
for (const [name, entry] of Object.entries(state.spend.byModel)) {
  state.spend.byModel[name] = Object.assign(
    { usd: 0, turns: 0, promptTokens: 0, outputTokens: 0 },
    entry
  );
}
state.spend.byRole = state.spend.byRole || {};
for (const [name, entry] of Object.entries(state.spend.byRole)) {
  state.spend.byRole[name] = Object.assign({ usd: 0, turns: 0 }, entry);
}
if (!Array.isArray(state.spend.recent)) state.spend.recent = [];
let board = loadJSON(BOARD_PATH, defaultBoard(), validateBoardDocument);
if (!board || !Array.isArray(board.notes)) board = defaultBoard();
if (!Array.isArray(board.tasks)) board.tasks = [];   // free/busy task list lives alongside the notes
if (!Array.isArray(board.loops)) board.loops = [];   // standing recurring check prompts (see loopView)
const editors = new Map();           // id -> { id, name, lastSeen, joinedAt }
const locks = new Map();             // slideId -> { slideId, by, ts, note }
const sseClients = new Set();        // res objects

// Linear undo/redo: a stack of full model snapshots taken right before each
// successful edit, so every op type (add-slide, set-style, whatever) is
// undoable with zero per-op reverse logic. In-memory only, like `editors`/
// `locks` — a restart is already a natural history boundary in this suite.
let undoStack = [];   // [{ model, editor, opType, detail, rev, ts }], model = snapshot BEFORE that op
let redoStack = [];   // same shape, populated by undo; cleared by any new forward edit
// Durable, stable-ID histories are intentionally separate from the global
// in-memory undo stack. They survive coordinator restarts and remain small:
// ten visible versions and three restore checkpoints per object.
let elementHistory = null;
const elementHistoryAssetCache = new Map();

function protectionView(sourceState) {
  return (sourceState || state).protections.map((protection) => Object.assign({}, protection));
}

function protectionExceptionView(sourceState) {
  return (sourceState || state).protectionExceptions.map((exception) => Object.assign({}, exception));
}

function protectionHistoryView(sourceState) {
  return (sourceState || state).protectionHistory.map((entry) => Object.assign({}, entry));
}

function protectionFromToggleBody(body) {
  if (!isRecord(body)) return { ok: false, error: 'body must be an object' };
  const unknown = Object.keys(body)
    .filter((key) => ![
      'kind', 'slideId', 'objectId', 'objectKind', 'protected', 'by',
      'taskId', 'delegatedMode'
    ].includes(key))
    .sort();
  if (unknown.length) return { ok: false, error: `unknown field: ${unknown[0]}` };
  if (!['slide', 'object'].includes(body.kind)) {
    return { ok: false, error: 'kind must be slide or object' };
  }
  if (typeof body.protected !== 'boolean') {
    return { ok: false, error: 'protected must be a boolean' };
  }
  if (typeof body.slideId !== 'string' || !body.slideId.trim()) {
    return { ok: false, error: 'slideId must be a non-empty string' };
  }
  const by = typeof body.by === 'string' ? body.by.trim() : '';
  if (!by || by.length > 60) {
    return { ok: false, error: 'by must be a non-empty string no longer than 60 characters' };
  }
  const slideId = body.slideId.trim();
  const slide = model.slides.find((item) => item.id === slideId);
  if (!slide) return { ok: false, error: `no such slide: ${slideId}` };
  if (body.kind === 'slide') {
    if (body.objectId !== undefined || body.objectKind !== undefined) {
      return { ok: false, error: 'slide protection cannot contain objectId or objectKind' };
    }
    return { ok: true, protected: body.protected, by, protection: { kind: 'slide', slideId } };
  }
  if (typeof body.objectId !== 'string' || !body.objectId.trim()) {
    return { ok: false, error: 'objectId must be a non-empty string' };
  }
  if (!['element', 'decor'].includes(body.objectKind)) {
    return { ok: false, error: 'objectKind must be element or decor' };
  }
  const objectId = body.objectId.trim();
  if (!protectionObject(slide, body.objectKind, objectId)) {
    return {
      ok: false,
      error: `no such ${body.objectKind}: ${objectId} on slide ${slideId}`
    };
  }
  return {
    ok: true,
    protected: body.protected,
    by,
    protection: {
      kind: 'object', slideId, objectId, objectKind: body.objectKind
    }
  };
}

function protectionObject(slide, objectKind, objectId) {
  if (!slide) return null;
  const collection = objectKind === 'element' ? slide.elements : (slide.decor || []);
  return collection.find((item) => item.id === objectId) || null;
}

function addScopeObject(objects, slideId, objectKind, objectId) {
  if (!objectId) return;
  objects.set(`${slideId}:${objectKind}:${objectId}`, { slideId, objectId, objectKind });
}

function addSlideObjectsToScope(objects, slide) {
  if (!slide) return;
  for (const element of slide.elements || []) addScopeObject(objects, slide.id, 'element', element.id);
  for (const decor of slide.decor || []) addScopeObject(objects, slide.id, 'decor', decor.id);
}

// Build the stable identity scope changed by a model transition. Slide rows
// intentionally cover every child edit as well as slide metadata, because a
// whole-slide protection freezes all of it. Object rows cover only the
// element/decor whose own model or animation changed, preserving unrelated
// edits on the same slide. Slide order is part of each stable target's scope:
// adding, deleting, or moving some other slide can otherwise shift a protected
// slide (and every protected child on it) without ever naming that target.
function protectionScopeBetween(beforeModel, afterModel, op) {
  const slides = new Set();
  const wholeSlides = new Set();
  const objects = new Map();
  const beforeSlides = new Map((beforeModel.slides || []).map((slide) => [slide.id, slide]));
  const afterSlides = new Map((afterModel.slides || []).map((slide) => [slide.id, slide]));
  const ids = new Set([...beforeSlides.keys(), ...afterSlides.keys()]);

  for (const slideId of ids) {
    const beforeSlide = beforeSlides.get(slideId);
    const afterSlide = afterSlides.get(slideId);
    if (!beforeSlide || !afterSlide) {
      slides.add(slideId);
      wholeSlides.add(slideId);
      addSlideObjectsToScope(objects, beforeSlide);
      addSlideObjectsToScope(objects, afterSlide);
      continue;
    }
    if (JSON.stringify(beforeSlide) !== JSON.stringify(afterSlide)) slides.add(slideId);

    // Child JSON and child animations can be carved out by an explicit object
    // exception. Every other slide property (notes, layout, transition, source,
    // etc.) remains a whole-slide change and cannot escape through one child.
    const slideWideState = (slide) => {
      const { elements, decor, animations, ...wide } = slide;
      return wide;
    };
    if (JSON.stringify(slideWideState(beforeSlide)) !== JSON.stringify(slideWideState(afterSlide))) {
      wholeSlides.add(slideId);
    }

    for (const objectKind of ['element', 'decor']) {
      const beforeItems = objectKind === 'element' ? beforeSlide.elements : (beforeSlide.decor || []);
      const afterItems = objectKind === 'element' ? afterSlide.elements : (afterSlide.decor || []);
      if (JSON.stringify(beforeItems.map((item) => item.id)) !==
          JSON.stringify(afterItems.map((item) => item.id))) {
        // Adding, deleting, or reordering children changes the parent structure.
        // Unlock the slide for structural work; object exceptions are for edits
        // to existing stable items.
        wholeSlides.add(slideId);
      }
      const beforeObjects = new Map(beforeItems.map((item) => [item.id, item]));
      const afterObjects = new Map(afterItems.map((item) => [item.id, item]));
      for (const objectId of new Set([...beforeObjects.keys(), ...afterObjects.keys()])) {
        if (JSON.stringify(beforeObjects.get(objectId)) !== JSON.stringify(afterObjects.get(objectId))) {
          addScopeObject(objects, slideId, objectKind, objectId);
        }
      }
    }

    // Native elements are assigned to layout placeholders in array order.
    // Adding/deleting a different element before a protected one can therefore
    // move the protected element without changing its own JSON.
    if (beforeSlide.src === undefined && afterSlide.src === undefined) {
      const beforeElementOrder = new Map(
        (beforeSlide.elements || []).map((element, index) => [element.id, index])
      );
      const afterElementOrder = new Map(
        (afterSlide.elements || []).map((element, index) => [element.id, index])
      );
      for (const objectId of new Set([...beforeElementOrder.keys(), ...afterElementOrder.keys()])) {
        if (!beforeElementOrder.has(objectId) || !afterElementOrder.has(objectId) ||
            beforeElementOrder.get(objectId) === afterElementOrder.get(objectId)) continue;
        addScopeObject(objects, slideId, 'element', objectId);
      }
      if (beforeSlide.layout !== afterSlide.layout) {
        for (const element of [...(beforeSlide.elements || []), ...(afterSlide.elements || [])]) {
          addScopeObject(objects, slideId, 'element', element.id);
        }
      }
    }

    // A slide transition is a visual effect applied to every child, not inert
    // metadata like speaker notes. Include all stable children so an object
    // lock cannot be bypassed by changing its parent transition.
    if (JSON.stringify(beforeSlide.transition) !== JSON.stringify(afterSlide.transition)) {
      addSlideObjectsToScope(objects, beforeSlide);
      addSlideObjectsToScope(objects, afterSlide);
    }

    // Animations live on the slide, but semantically change their named
    // element/decor. Include index as well as value so an animation reorder
    // cannot move a protected target around the build sequence.
    const animationState = (slide) => new Map((slide.animations || []).map((animation, index) => [
      animation.targetId, { index, animation }
    ]));
    const beforeAnimations = animationState(beforeSlide);
    const afterAnimations = animationState(afterSlide);
    for (const objectId of new Set([...beforeAnimations.keys(), ...afterAnimations.keys()])) {
      if (JSON.stringify(beforeAnimations.get(objectId)) === JSON.stringify(afterAnimations.get(objectId))) continue;
      const element = protectionObject(beforeSlide, 'element', objectId) ||
        protectionObject(afterSlide, 'element', objectId);
      addScopeObject(objects, slideId, element ? 'element' : 'decor', objectId);
    }
  }

  // Theme accents are global model state, but the renderer applies them only
  // to suite-native slides/elements. Treat those concrete targets as changed
  // so a global set-theme (and its undo/redo) cannot visually rewrite a
  // protected native target without naming it. Imported content and generated
  // decor keep their own backing/fill and remain outside this exact scope.
  if (JSON.stringify(beforeModel.theme || {}) !== JSON.stringify(afterModel.theme || {})) {
    for (const slideId of ids) {
      const slide = afterSlides.get(slideId) || beforeSlides.get(slideId);
      if (!slide || slide.src !== undefined) continue;
      slides.add(slideId);
      wholeSlides.add(slideId);
      for (const element of slide.elements || []) {
        addScopeObject(objects, slideId, 'element', element.id);
      }
    }
  }

  if (op && op.type === 'move-slide' && typeof op.slideId === 'string') {
    slides.add(op.slideId);
    wholeSlides.add(op.slideId);
    addSlideObjectsToScope(objects, beforeSlides.get(op.slideId) || afterSlides.get(op.slideId));
  }

  // Compare every surviving slide's absolute position, not only op.slideId.
  // This covers insert/delete shifts and also makes the stored history scope
  // exact enough that undo/redo cannot repeat an indirect reorder later.
  const beforeOrder = new Map((beforeModel.slides || []).map((slide, index) => [slide.id, index]));
  const afterOrder = new Map((afterModel.slides || []).map((slide, index) => [slide.id, index]));
  for (const slideId of ids) {
    if (!beforeOrder.has(slideId) || !afterOrder.has(slideId) ||
        beforeOrder.get(slideId) === afterOrder.get(slideId)) continue;
    slides.add(slideId);
    wholeSlides.add(slideId);
    addSlideObjectsToScope(objects, beforeSlides.get(slideId) || afterSlides.get(slideId));
  }

  return {
    slides: [...slides].sort(),
    wholeSlides: [...wholeSlides].sort(),
    objects: [...objects.values()].sort((a, b) =>
      `${a.slideId}:${a.objectKind}:${a.objectId}`.localeCompare(
        `${b.slideId}:${b.objectKind}:${b.objectId}`
      ))
  };
}

function protectionConflictForScope(scope) {
  const slideIds = new Set((scope && scope.slides) || []);
  const wholeSlideIds = new Set((scope && scope.wholeSlides) || []);
  const scopedObjects = (scope && scope.objects) || [];
  const objectKeys = new Set(scopedObjects.map((item) =>
    `${item.slideId}:${item.objectKind}:${item.objectId}`
  ));
  const exceptionKeys = new Set(state.protectionExceptions.map((item) =>
    `${item.slideId}:${item.objectKind}:${item.objectId}`
  ));

  // A direct object lock is overridden only while that same object is an
  // explicit editable exception beneath its locked parent slide.
  const objectConflict = state.protections.find((protection) => {
    if (protection.kind !== 'object') return false;
    const key = `${protection.slideId}:${protection.objectKind}:${protection.objectId}`;
    return objectKeys.has(key) && !exceptionKeys.has(key);
  });
  if (objectConflict) return objectConflict;

  return state.protections.find((protection) => {
    if (protection.kind !== 'slide' || !slideIds.has(protection.slideId)) return false;
    if (wholeSlideIds.has(protection.slideId)) return true;
    const children = scopedObjects.filter((item) => item.slideId === protection.slideId);
    // A slide-level delta with no attributable child stays fail-closed.
    if (!children.length) return true;
    return children.some((item) =>
      !exceptionKeys.has(`${item.slideId}:${item.objectKind}:${item.objectId}`)
    );
  }) || null;
}

function protectionDenial(protection, action) {
  const target = protection.kind === 'slide'
    ? `slide ${protection.slideId}`
    : `${protection.objectKind} ${protection.objectId} on slide ${protection.slideId}`;
  return {
    ok: false,
    error: 'protected',
    message: `${action || 'edit'} refused: ${target} is protected` +
      `${protection.by ? ` by ${protection.by}` : ''}; a human must unprotect it first`,
    protection: Object.assign({}, protection)
  };
}

function historyProtectionScope(entry, currentModel, candidateModel) {
  const scope = entry && entry.protectionScope;
  if (scope && Array.isArray(scope.slides) && Array.isArray(scope.wholeSlides) &&
      Array.isArray(scope.objects)) return scope;
  return protectionScopeBetween(currentModel, candidateModel, null);
}

function pushUndo(beforeModel, meta) {
  undoStack.push(Object.assign({ model: beforeModel }, meta));
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}
function historySummary(entry) {
  return { editor: entry.editor, opType: entry.opType, detail: entry.detail, rev: entry.rev, ts: entry.ts };
}

function defaultModel() {
  return {
    title: 'Untitled Presentation',
    theme: { accent: '#2563eb' },
    rev: 0,
    updatedAt: null,
    slides: [{
      id: 's1', layout: 'title', notes: '',
      elements: [
        { id: 'e1', type: 'title', text: '' },
        { id: 'e2', type: 'subtitle', text: '' }
      ]
    }]
  };
}

function persistModel(nextModel) {
  const target = nextModel || model;
  target.updatedAt = new Date().toISOString();
  return saveJSONAtomic(MODEL_PATH, target);
}
function persistState(nextState) { return saveJSONAtomic(STATE_PATH, nextState || state); }

// ----------------------------------------------------- per-object history
// The global undo stack deliberately dies with the process. Object histories
// do not: they are the user's durable, visual "past ten" for one stable item.
// A second, staged document couples each history change to the model revision
// so a crash between the two atomic renames can be recovered on next boot.
function emptyElementHistory(modelRev) {
  return { schemaVersion: 1, modelRev: Number.isInteger(modelRev) ? modelRev : 0, entries: {} };
}

function elementHistoryKey(ref) {
  // JSON tuple encoding is injective for arbitrary valid ids. A colon-joined
  // key lets different identities collide when an imported stable id itself
  // contains ':'.
  return JSON.stringify([ref.slideId, ref.objectKind, ref.objectId]);
}

function validateElementHistoryDocument(value) {
  if (!isRecord(value)) return 'root must be an object';
  if (value.schemaVersion !== 1) return 'schemaVersion must be 1';
  if (!Number.isInteger(value.modelRev) || value.modelRev < 0) return 'modelRev must be a non-negative integer';
  if (!isRecord(value.entries)) return 'entries must be an object';
  const entryRows = Object.entries(value.entries);
  if (entryRows.length > 10000) return 'entries exceeds the safety limit';
  for (const [key, entry] of entryRows) {
    if (!isRecord(entry) || !isRecord(entry.target)) return `entries.${key} must contain a target`;
    const target = entry.target;
    if (typeof target.slideId !== 'string' || !target.slideId ||
        !['element', 'decor'].includes(target.objectKind) ||
        typeof target.objectId !== 'string' || !target.objectId) {
      return `entries.${key}.target is invalid`;
    }
    if (elementHistoryKey(target) !== key) return `entries.${key}.target does not match its key`;
    if (!isRecord(entry.versions)) return `entries.${key}.versions must be an object`;
    const versionRows = Object.entries(entry.versions);
    if (versionRows.length > ELEMENT_HISTORY_ARCHIVE_LIMIT) {
      return `entries.${key}.versions exceeds the safety limit`;
    }
    for (const [versionId, version] of versionRows) {
      if (!isRecord(version) || version.id !== versionId || !/^v_[0-9a-f]{16,64}$/i.test(versionId)) {
        return `entries.${key}.versions.${versionId} has an invalid id`;
      }
      if (!Number.isInteger(version.createdAt) || version.createdAt < 0 ||
          typeof version.by !== 'string' || version.by.length > 60 ||
          typeof version.summary !== 'string' || version.summary.length > 240 ||
          !isRecord(version.state) || !isRecord(version.state.object) ||
          version.state.object.id !== target.objectId || !Array.isArray(version.state.animations)) {
        return `entries.${key}.versions.${versionId} is invalid`;
      }
      for (const row of version.state.animations) {
        if (!isRecord(row) || !Number.isInteger(row.index) || row.index < 0 ||
            !isRecord(row.animation) || row.animation.targetId !== target.objectId) {
          return `entries.${key}.versions.${versionId}.state.animations is invalid`;
        }
      }
    }
    if (!Array.isArray(entry.timeline) || !entry.timeline.length ||
        entry.timeline.length > ELEMENT_HISTORY_VISIBLE_LIMIT ||
        new Set(entry.timeline).size !== entry.timeline.length ||
        entry.timeline.some((id) => typeof id !== 'string' || !entry.versions[id])) {
      return `entries.${key}.timeline is invalid`;
    }
    if (!Array.isArray(entry.restoreUndos) ||
        entry.restoreUndos.length > ELEMENT_HISTORY_RESTORE_UNDO_LIMIT) {
      return `entries.${key}.restoreUndos is invalid`;
    }
    const checkpointTokens = new Set();
    for (const checkpoint of entry.restoreUndos) {
      if (!isRecord(checkpoint) || !/^r_[0-9a-f]{16,64}$/i.test(checkpoint.token || '') ||
          checkpointTokens.has(checkpoint.token) ||
          !Number.isInteger(checkpoint.createdAt) || checkpoint.createdAt < 0 ||
          !Array.isArray(checkpoint.timeline) || !checkpoint.timeline.length ||
          checkpoint.timeline.length > ELEMENT_HISTORY_VISIBLE_LIMIT ||
          new Set(checkpoint.timeline).size !== checkpoint.timeline.length ||
          checkpoint.timeline.some((id) => typeof id !== 'string' || !entry.versions[id])) {
        return `entries.${key}.restoreUndos contains an invalid checkpoint`;
      }
      checkpointTokens.add(checkpoint.token);
    }
  }
  return null;
}

function validateElementHistoryPendingDocument(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
      !Number.isInteger(value.modelRev) || value.modelRev < 0) {
    return 'pending transaction header is invalid';
  }
  if (!isRecord(value.history)) return 'history must be an object';
  const invalid = validateElementHistoryDocument(value.history);
  if (invalid) return `history: ${invalid}`;
  if (value.history.modelRev !== value.modelRev) return 'history.modelRev does not match modelRev';
  return null;
}

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

function elementHistoryRef(slideId, objectKind, objectId) {
  return { slideId: String(slideId || ''), objectKind: String(objectKind || ''), objectId: String(objectId || '') };
}

function findHistoryObject(sourceModel, ref) {
  const slide = (sourceModel.slides || []).find((item) => item.id === ref.slideId);
  if (!slide || !['element', 'decor'].includes(ref.objectKind)) return null;
  const collection = ref.objectKind === 'element' ? (slide.elements || []) : (slide.decor || []);
  const index = collection.findIndex((item) => item.id === ref.objectId);
  return index < 0 ? null : { slide, collection, index, object: collection[index] };
}

function sameFilesystemPath(a, b) {
  return IS_WIN
    ? String(a).toLowerCase() === String(b).toLowerCase()
    : String(a) === String(b);
}

function verifiedElementHistoryArchiveDir() {
  const dir = path.join(PROJECT_ASSETS, '.element-history');
  fs.mkdirSync(dir, { recursive: true });
  const realAssets = fs.realpathSync(PROJECT_ASSETS);
  const realDir = fs.realpathSync(dir);
  const expectedDir = path.join(realAssets, '.element-history');
  const insideAssets = realDir === realAssets || realDir.startsWith(realAssets + path.sep);
  if (!insideAssets || !sameFilesystemPath(realDir, expectedDir) || fs.lstatSync(dir).isSymbolicLink()) {
    throw new Error('element-history archive directory must be a real folder inside project assets');
  }
  return realDir;
}

function archiveElementHistoryAsset(object) {
  const copy = cloneJSON(object);
  if (!copy.generated || !['pic', 'media'].includes(copy.kind) || typeof copy.source !== 'string') return copy;
  const resolved = copy.kind === 'media'
    ? resolveProjectVideoSource(copy.source)
    : resolveProjectImageSource(copy.source);
  // A legacy/missing source should not prevent the coordinator from booting or
  // preserving text/geometry. The restore route revalidates it and refuses a
  // broken media restore instead of producing a deck with a dead link.
  if (!resolved.ok) return copy;
  const realDir = verifiedElementHistoryArchiveDir();
  const sourceStat = fs.statSync(resolved.absolute);
  const cached = elementHistoryAssetCache.get(resolved.absolute);
  if (cached && cached.size === sourceStat.size && cached.mtimeMs === sourceStat.mtimeMs &&
      cached.ctimeMs === sourceStat.ctimeMs) {
    const cachedResolved = copy.kind === 'media'
      ? resolveProjectVideoSource(cached.source)
      : resolveProjectImageSource(cached.source);
    if (cachedResolved.ok && sameFilesystemPath(cachedResolved.absolute, cached.absolute) &&
        sameFilesystemPath(path.dirname(cachedResolved.absolute), realDir)) {
      const archiveStat = fs.lstatSync(cachedResolved.absolute);
      if (archiveStat.isFile() && !archiveStat.isSymbolicLink() &&
          archiveStat.size === cached.archiveSize &&
          archiveStat.mtimeMs === cached.archiveMtimeMs &&
          archiveStat.ctimeMs === cached.archiveCtimeMs) {
        copy.source = cached.source;
        return copy;
      }
    }
  }
  const bytes = fs.readFileSync(resolved.absolute);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const ext = path.extname(resolved.absolute).toLowerCase();
  const absolute = path.join(realDir, `${hash}${ext}`);
  if (!fs.existsSync(absolute)) {
    const staged = path.join(realDir, `.${hash}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(staged, bytes, { flag: 'wx' });
      fs.renameSync(staged, absolute);
    } catch (error) {
      try { fs.unlinkSync(staged); } catch (_) {}
      // Content addressing makes an EEXIST winner equivalent to our staged
      // bytes. Any other error means this version could not be made durable.
      if (!fs.existsSync(absolute)) throw error;
    }
  } else {
    const storedStat = fs.lstatSync(absolute);
    if (!storedStat.isFile() || storedStat.isSymbolicLink() ||
        !sameFilesystemPath(path.dirname(fs.realpathSync(absolute)), realDir)) {
      throw new Error('element-history archive file is not a real file inside its archive directory');
    }
    // Do not trust a pre-created hash-named file. A wrong payload under the
    // right name would silently restore different artwork than the card shows.
    const storedHash = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    if (storedHash !== hash) throw new Error('element-history archive hash mismatch');
  }
  copy.source = path.relative(ROOT, absolute).split(path.sep).join('/');
  const archiveStat = fs.lstatSync(absolute);
  elementHistoryAssetCache.set(resolved.absolute, {
    size: sourceStat.size,
    mtimeMs: sourceStat.mtimeMs,
    ctimeMs: sourceStat.ctimeMs,
    absolute,
    source: copy.source,
    archiveSize: archiveStat.size,
    archiveMtimeMs: archiveStat.mtimeMs,
    archiveCtimeMs: archiveStat.ctimeMs
  });
  return copy;
}

function captureElementHistoryState(sourceModel, ref) {
  const found = findHistoryObject(sourceModel, ref);
  if (!found) return null;
  const animations = [];
  for (let i = 0; i < (found.slide.animations || []).length; i++) {
    const animation = found.slide.animations[i];
    if (animation && animation.targetId === ref.objectId) {
      animations.push({ index: i, animation: cloneJSON(animation) });
    }
  }
  return { object: archiveElementHistoryAsset(found.object), animations };
}

// Raw capture is deliberately side-effect free and cheap. It is used only to
// discover which stable targets actually changed. Archiving every picture and
// video while scanning an unrelated one-word edit would synchronously hash the
// whole deck twice and stall every request.
function captureRawElementHistoryState(sourceModel, ref) {
  const found = findHistoryObject(sourceModel, ref);
  if (!found) return null;
  const animations = [];
  for (let i = 0; i < (found.slide.animations || []).length; i++) {
    const animation = found.slide.animations[i];
    if (animation && animation.targetId === ref.objectId) {
      animations.push({ index: i, animation: cloneJSON(animation) });
    }
  }
  return { object: cloneJSON(found.object), animations };
}

function sameElementHistoryState(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function historyChangeSummary(beforeState, afterState, fallback) {
  if (!beforeState) return fallback || 'Initial version';
  const changed = [];
  const beforeObject = beforeState.object || {};
  const afterObject = afterState.object || {};
  for (const key of new Set([...Object.keys(beforeObject), ...Object.keys(afterObject)])) {
    if (JSON.stringify(beforeObject[key]) !== JSON.stringify(afterObject[key])) changed.push(key);
  }
  if (JSON.stringify(beforeState.animations) !== JSON.stringify(afterState.animations)) changed.push('animation');
  if (!changed.length) return fallback || 'Saved version';
  const concise = changed.slice(0, 4).join(', ');
  return `Changed ${concise}${changed.length > 4 ? ` +${changed.length - 4}` : ''}`.slice(0, 240);
}

function makeElementHistoryVersion(stateSnapshot, by, summary, createdAt) {
  return {
    id: `v_${crypto.randomBytes(12).toString('hex')}`,
    createdAt: createdAt || Date.now(),
    by: String(by || 'system').slice(0, 60),
    summary: String(summary || 'Saved version').slice(0, 240),
    state: cloneJSON(stateSnapshot)
  };
}

function pruneElementHistoryVersions(entry) {
  const required = new Set(entry.timeline);
  for (const checkpoint of entry.restoreUndos) {
    for (const id of checkpoint.timeline) required.add(id);
  }
  const ordered = Object.values(entry.versions).sort((a, b) => b.createdAt - a.createdAt);
  for (const version of ordered) {
    if (required.size >= ELEMENT_HISTORY_ARCHIVE_LIMIT) break;
    required.add(version.id);
  }
  for (const id of Object.keys(entry.versions)) {
    if (!required.has(id)) delete entry.versions[id];
  }
}

function ensureElementHistoryEntry(doc, sourceModel, ref, by, summary) {
  const stateSnapshot = captureElementHistoryState(sourceModel, ref);
  if (!stateSnapshot) return null;
  const key = elementHistoryKey(ref);
  let entry = doc.entries[key];
  if (!entry) {
    const version = makeElementHistoryVersion(stateSnapshot, by || 'system', summary || 'Initial version');
    entry = {
      target: cloneJSON(ref),
      versions: { [version.id]: version },
      timeline: [version.id],
      restoreUndos: []
    };
    doc.entries[key] = entry;
    return { entry, changed: true };
  }
  const head = entry.versions[entry.timeline[entry.timeline.length - 1]];
  if (!head || !sameElementHistoryState(head.state, stateSnapshot)) {
    const version = makeElementHistoryVersion(
      stateSnapshot, by || 'system', historyChangeSummary(head && head.state, stateSnapshot, summary)
    );
    entry.versions[version.id] = version;
    entry.timeline.push(version.id);
    if (entry.timeline.length > ELEMENT_HISTORY_VISIBLE_LIMIT) entry.timeline.shift();
    entry.restoreUndos = [];
    pruneElementHistoryVersions(entry);
    return { entry, changed: true };
  }
  return { entry, changed: false };
}

function allElementHistoryRefs(sourceModel) {
  const refs = [];
  for (const slide of sourceModel.slides || []) {
    for (const object of slide.elements || []) refs.push(elementHistoryRef(slide.id, 'element', object.id));
    for (const object of slide.decor || []) refs.push(elementHistoryRef(slide.id, 'decor', object.id));
  }
  return refs;
}

function reconcileElementHistory(doc, sourceModel, by, summary) {
  let changed = false;
  const refs = allElementHistoryRefs(sourceModel);
  const liveKeys = new Set(refs.map(elementHistoryKey));
  for (const ref of refs) {
    const result = ensureElementHistoryEntry(doc, sourceModel, ref, by, summary);
    if (result && result.changed) changed = true;
  }
  // Histories for deleted stable objects have no selectable/API target. The
  // in-memory global undo patch preserves them until a delete is undone; after
  // restart global undo is gone, so retaining orphans only creates unbounded
  // clone/write cost and can eventually hit the strict entry cap.
  for (const key of Object.keys(doc.entries)) {
    if (!liveKeys.has(key)) {
      delete doc.entries[key];
      changed = true;
    }
  }
  doc.modelRev = sourceModel.rev || 0;
  return changed;
}

function initializeElementHistory() {
  let committed = loadJSON(
    ELEMENT_HISTORY_PATH,
    emptyElementHistory(model.rev || 0),
    validateElementHistoryDocument
  );
  let pending = null;
  let recoveredPending = false;
  try {
    pending = loadJSON(ELEMENT_HISTORY_PENDING_PATH, null, validateElementHistoryPendingDocument);
  } catch (error) {
    // A malformed transaction marker is ambiguous and must not be silently
    // discarded: it may be the only complete side of a committed model edit.
    throw error;
  }
  if (pending) {
    if (pending.modelRev <= (model.rev || 0) && pending.modelRev >= committed.modelRev) {
      committed = pending.history;
      recoveredPending = true;
    }
  }
  const historyModelRevBeforeReconcile = committed.modelRev;
  const changed = reconcileElementHistory(committed, model, 'system', 'Recovered current deck');
  const invalid = validateElementHistoryDocument(committed);
  if (invalid) throw new Error(`Cannot initialize element-history.json: ${invalid}`);
  if (changed || recoveredPending || !fs.existsSync(ELEMENT_HISTORY_PATH) ||
      historyModelRevBeforeReconcile !== model.rev) {
    committed.modelRev = model.rev || 0;
    if (!saveJSONAtomic(ELEMENT_HISTORY_PATH, committed)) {
      throw new Error('Cannot initialize durable element history');
    }
  }
  if (pending) {
    // Delete a committed marker only after its history has been promoted. A
    // future/ahead marker (model write never landed) is safe to discard too.
    try { fs.unlinkSync(ELEMENT_HISTORY_PENDING_PATH); } catch (error) {
      if (error && error.code !== 'ENOENT') throw error;
    }
  }
  elementHistory = committed;
}

function historyPatchForEntries(beforeDoc, afterDoc, keys) {
  const beforeEntries = {};
  const afterEntries = {};
  for (const key of keys) {
    beforeEntries[key] = beforeDoc.entries[key] ? cloneJSON(beforeDoc.entries[key]) : null;
    afterEntries[key] = afterDoc.entries[key] ? cloneJSON(afterDoc.entries[key]) : null;
  }
  return { beforeEntries, afterEntries };
}

function historyCandidateForTransition(beforeModel, afterModel, by, summary) {
  const beforeDoc = elementHistory;
  const afterDoc = cloneJSON(elementHistory);
  const keys = new Set();
  const beforeRefs = new Map(allElementHistoryRefs(beforeModel).map((ref) => [elementHistoryKey(ref), ref]));
  const afterRefs = new Map(allElementHistoryRefs(afterModel).map((ref) => [elementHistoryKey(ref), ref]));
  for (const [key, ref] of afterRefs) {
    const beforeState = beforeRefs.has(key) ? captureRawElementHistoryState(beforeModel, ref) : null;
    const afterState = captureRawElementHistoryState(afterModel, ref);
    if (beforeState && sameElementHistoryState(beforeState, afterState) && afterDoc.entries[key]) continue;
    const oldEntry = afterDoc.entries[key] ? cloneJSON(afterDoc.entries[key]) : null;
    const ensured = ensureElementHistoryEntry(afterDoc, afterModel, ref, by, summary);
    if (ensured && (!oldEntry || JSON.stringify(oldEntry) !== JSON.stringify(afterDoc.entries[key]))) keys.add(key);
  }
  for (const key of beforeRefs.keys()) {
    if (afterRefs.has(key) || !afterDoc.entries[key]) continue;
    delete afterDoc.entries[key];
    keys.add(key);
  }
  afterDoc.modelRev = afterModel.rev || 0;
  return { history: afterDoc, patch: historyPatchForEntries(beforeDoc, afterDoc, keys) };
}

function applyElementHistoryPatch(baseDoc, patch, side, modelRev) {
  const candidate = cloneJSON(baseDoc);
  const rows = side === 'before' ? patch.beforeEntries : patch.afterEntries;
  for (const [key, entry] of Object.entries(rows || {})) {
    if (entry) candidate.entries[key] = cloneJSON(entry);
    else delete candidate.entries[key];
  }
  candidate.modelRev = modelRev;
  return candidate;
}

function persistModelAndElementHistory(candidateModel, candidateHistory) {
  candidateHistory.modelRev = candidateModel.rev || 0;
  const invalid = validateElementHistoryDocument(candidateHistory);
  if (invalid) return { ok: false, error: `invalid history candidate: ${invalid}` };
  // A prior transaction may have committed model.json while antivirus held
  // the history destination rename. Its pending file is then the only durable
  // copy of the current history. Promote the authoritative in-memory document
  // before replacing that marker with a newer transaction; otherwise a later
  // model-write failure could unlink the new marker and lose both revisions.
  if (fs.existsSync(ELEMENT_HISTORY_PENDING_PATH)) {
    if (!saveJSONAtomic(ELEMENT_HISTORY_PATH, elementHistory)) {
      return { ok: false, error: 'prior history promotion is still pending' };
    }
    try { fs.unlinkSync(ELEMENT_HISTORY_PENDING_PATH); }
    catch (error) {
      if (!error || error.code !== 'ENOENT') {
        return { ok: false, error: 'could not clear prior history transaction' };
      }
    }
  }
  const pending = {
    schemaVersion: 1,
    modelRev: candidateModel.rev || 0,
    history: candidateHistory
  };
  if (!saveJSONAtomic(ELEMENT_HISTORY_PENDING_PATH, pending)) {
    return { ok: false, error: 'history staging failed' };
  }
  if (!persistModel(candidateModel)) {
    try { fs.unlinkSync(ELEMENT_HISTORY_PENDING_PATH); } catch (_) {}
    return { ok: false, error: 'persist failed' };
  }
  const promoted = saveJSONAtomic(ELEMENT_HISTORY_PATH, candidateHistory);
  if (promoted) {
    try { fs.unlinkSync(ELEMENT_HISTORY_PENDING_PATH); } catch (_) {}
  }
  // Once model.json commits, the staged history is authoritative even if its
  // promotion rename was briefly blocked. Keep serving it in memory; boot
  // promotes the pending copy after a crash/restart.
  return { ok: true, promotionPending: !promoted };
}

function applyElementHistoryState(candidateModel, ref, stateSnapshot) {
  const found = findHistoryObject(candidateModel, ref);
  if (!found) return { ok: false, error: 'object no longer exists' };
  const replacement = cloneJSON(stateSnapshot.object);
  if (replacement.id !== ref.objectId) return { ok: false, error: 'history object id mismatch' };
  if (replacement.generated && replacement.kind === 'pic') {
    const resolved = resolveProjectImageSource(replacement.source);
    if (!resolved.ok) return { ok: false, error: `historical image unavailable: ${resolved.error}` };
  }
  if (replacement.generated && replacement.kind === 'media') {
    const resolved = resolveProjectVideoSource(replacement.source);
    if (!resolved.ok) return { ok: false, error: `historical video unavailable: ${resolved.error}` };
  }
  found.collection[found.index] = replacement;
  const retained = (found.slide.animations || []).filter((animation) =>
    !animation || animation.targetId !== ref.objectId
  );
  for (const row of [...stateSnapshot.animations].sort((a, b) => a.index - b.index)) {
    retained.splice(Math.min(row.index, retained.length), 0, cloneJSON(row.animation));
  }
  if (retained.length) found.slide.animations = retained;
  else delete found.slide.animations;
  return { ok: true };
}

function objectHistoryResponse(ref) {
  const entry = elementHistory.entries[elementHistoryKey(ref)];
  if (!entry) return null;
  const top = entry.restoreUndos[entry.restoreUndos.length - 1] || null;
  const found = findHistoryObject(model, ref);
  const labelObject = found && found.object;
  const label = labelObject && (labelObject.text || labelObject.name || labelObject.kind || labelObject.type) || ref.objectId;
  const conflict = protectionConflictForScope({ slides: [ref.slideId], wholeSlides: [], objects: [ref] });
  return {
    ok: true,
    target: Object.assign({}, ref, { label: trunc(label) }),
    versions: entry.timeline.map((id) => cloneJSON(entry.versions[id])),
    headId: entry.timeline[entry.timeline.length - 1],
    undoDepth: entry.restoreUndos.length,
    maxUndo: ELEMENT_HISTORY_RESTORE_UNDO_LIMIT,
    topCheckpointToken: top ? top.token : null,
    locked: !!conflict,
    paused: !!state.paused,
    totalSaved: Object.keys(entry.versions).length
  };
}

function parseObjectHistoryTarget(values) {
  const ref = elementHistoryRef(values.slideId, values.objectKind, values.objectId);
  if (!ref.slideId || !['element', 'decor'].includes(ref.objectKind) || !ref.objectId) {
    return { ok: false, error: 'slideId, objectKind (element|decor), and objectId are required' };
  }
  if (!findHistoryObject(model, ref)) return { ok: false, error: 'object not found' };
  const entry = elementHistory.entries[elementHistoryKey(ref)];
  if (!entry) return { ok: false, error: 'object history not found' };
  return { ok: true, ref, entry };
}

function isSuiteAgentActor(name) {
  const actor = String(name == null ? '' : name).trim();
  return actor === 'lead' || actor === 'root' || /^(?:codex|claude)-root$/.test(actor) ||
    isWorkerAgentName(actor) || Agents.isAgent(actor);
}

function isObjectHistoryAgentActor(name) { return isSuiteAgentActor(name); }

// ------------------------------------------------------------- model migration
// Overlay decor[] entries (colored bars, bullet-marker squares, callout boxes)
// predate shape-id tracking: they carry {kind, box, fill} but nothing to find
// the real shape again at render time, so they were read-only. This assigns
// each decor entry a stable id (so /api/edit can address it) and, for
// "shape" decor, backfills the real base.pptx shape id (so the renderer can
// recolor it) by asking tools_decor_sids.py to re-derive them in the same
// order import_pptx.py originally appended them. Runs once at boot; a no-op
// once every decor entry already has an id.
function assignDecorLocalIds() {
  let changed = false;
  for (const s of model.slides) {
    if (!Array.isArray(s.decor)) continue;
    s.decor.forEach((d, i) => {
      if (!d.id) { d.id = `${s.id}_d${i}`; changed = true; }
    });
  }
  return changed;
}

// model.base (the overlay's pristine source .pptx, written once by
// import_pptx.py) is an ABSOLUTE path baked into model.json at import time.
// Every other spawn-time path in this project is resolved at runtime instead
// (see agents.js's ensureGuardSettings(), same class of fix); this one
// wasn't. base.pptx always lives at DATA/base.pptx by construction, nothing
// in this codebase ever writes it anywhere else, so if the stored value
// doesn't match that (stale after the project folder was renamed/moved) but
// the real file IS sitting where it's always supposed to be, self-heal
// in-memory before anything reads model.base. This matters well beyond the
// migration below: runRender() pipes this SAME in-memory model to
// render_pptx.py on every single render, so a stale base silently breaks
// the entire render pipeline (pptx export, thumbnails, PDF) the moment the
// project moves, not just this one-time backfill step.
function normalizeModelBase() {
  if ((model.mode || 'native') !== 'overlay' || !model.base) return false;
  const expected = path.join(DATA, 'base.pptx');
  if (model.base === expected) return false;
  if (fs.existsSync(model.base)) return false;   // stored path still valid, leave it alone
  if (!fs.existsSync(expected)) return false;    // nothing to self-heal to either
  console.error(`model.base was stale (${model.base}), correcting to ${expected}`);
  model.base = expected;
  return true;
}

function backfillDecorSids() {
  return new Promise((resolve) => {
    if ((model.mode || 'native') !== 'overlay' || !model.base || !fs.existsSync(model.base)) return resolve(false);
    const needsSids = model.slides.some((s) => (s.decor || []).some(
      (d) => d.generated !== true && d.kind === 'shape' && d.sid == null
    ));
    if (!needsSids) return resolve(false);
    // timeout: this runs inside migrateModel(), awaited by boot() BEFORE
    // server.listen(). A hung python process here (no timeout previously)
    // would mean the whole suite silently never starts, not just this one
    // migration step; the existing err handler below already resolves
    // false and logs, so a timeout just needs to reach that same path.
    execFile(PY, [path.join(HERE, 'tools_decor_sids.py'), model.base], { cwd: HERE, maxBuffer: 10 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
      if (err) { console.error('decor sid backfill skipped:', err.message); return resolve(false); }
      let map;
      try { map = JSON.parse(stdout); } catch (e) { console.error('decor sid backfill: bad JSON from helper'); return resolve(false); }
      let changed = false;
      for (const s of model.slides) {
        if (!Number.isInteger(s.src) || !Array.isArray(s.decor)) continue;
        const importedDecor = s.decor.filter((d) => d.generated !== true);
        const sids = map[String(s.src)];
        if (!Array.isArray(sids) || sids.length !== importedDecor.length) continue;
        importedDecor.forEach((d, i) => {
          if (d.kind === 'shape' && d.sid == null && sids[i] != null) { d.sid = sids[i]; changed = true; }
        });
      }
      resolve(changed);
    });
  });
}

function backfillShapePresets() {
  return new Promise((resolve, reject) => {
    if ((model.mode || 'native') !== 'overlay' ||
        !model.base || !fs.existsSync(model.base)) return resolve(false);
    const requiresAudit = model.shapePresetSchema === 1 || model.slides.some((slide) =>
      [...(slide.elements || []), ...(slide.decor || [])].some((item) =>
        item.sourcePreset !== undefined || item.corners !== undefined
      )
    );
    const failed = (message) => {
      if (requiresAudit) {
        reject(new Error(`shape preset audit failed: ${message}`));
      } else {
        console.error(`shape preset backfill skipped: ${message}`);
        resolve(false);
      }
    };
    execFile(
      PY,
      [path.join(HERE, 'tools_shape_presets.py'), model.base],
      { cwd: HERE, maxBuffer: 10 * 1024 * 1024, timeout: 30000 },
      (err, stdout) => {
        if (err) {
          return failed(err.message);
        }
        let map;
        try {
          map = JSON.parse(stdout);
        } catch (_) {
          return failed('helper returned invalid JSON');
        }
        if (!isRecord(map)) {
          return failed('helper returned a non-object');
        }
        for (const slide of model.slides) {
          if (!Number.isInteger(slide.src)) continue;
          const byShapeId = map[String(slide.src)];
          if (!isRecord(byShapeId)) {
            return failed(`no source slide ${slide.src}`);
          }
          for (const object of [...(slide.elements || []), ...(slide.decor || [])]) {
            const sid = object.ref && object.ref.sid !== undefined
              ? object.ref.sid
              : object.sid;
            if (!Number.isInteger(sid)) continue;
            const expected = byShapeId[String(sid)];
            if (expected !== undefined && !BOX_SHAPE_PRESETS.has(expected)) {
              return failed(`invalid preset for ${slide.src}:${sid}`);
            }
            if (object.sourcePreset !== undefined && object.sourcePreset !== expected) {
              return failed(
                `source mismatch for ${slide.src}:${sid}: ` +
                `model=${object.sourcePreset}, base=${expected || 'ineligible'}`
              );
            }
          }
        }
        let changed = model.shapePresetSchema !== 1;
        for (const slide of model.slides) {
          if (!Number.isInteger(slide.src)) continue;
          const byShapeId = map[String(slide.src)];
          for (const object of [...(slide.elements || []), ...(slide.decor || [])]) {
            const sid = object.ref && object.ref.sid !== undefined
              ? object.ref.sid
              : object.sid;
            const preset = Number.isInteger(sid) ? byShapeId[String(sid)] : undefined;
            if (preset && object.sourcePreset !== preset) {
              object.sourcePreset = preset;
              changed = true;
            }
          }
        }
        model.shapePresetSchema = 1;
        resolve(changed);
      }
    );
  });
}

async function migrateModel() {
  const base = normalizeModelBase();
  if ((model.mode || 'native') === 'overlay') {
    let validBase = false;
    try { validBase = fs.statSync(model.base).isFile(); } catch (_) {}
    if (!validBase) throw new Error(`overlay base PowerPoint is unavailable: ${model.base}`);
  }
  const a = assignDecorLocalIds();
  const b = await backfillDecorSids();
  const c = await backfillShapePresets();
  const invalid = validateModelDocument(model, true);
  if (invalid) throw new Error(`model migration did not produce a valid model: ${invalid}`);
  if (base || a || b || c) {
    if (!persistModel()) {
      throw new Error('model migration could not be saved; refusing to serve an in-memory-only model');
    }
    console.log(
      `migrated model.json: ${base ? 'base path corrected, ' : ''}` +
      `decor ids${b ? ' + sids' : ''}${c ? ' + box/card presets' : ''} backfilled`
    );
  }
}

function appendStateLog(target, entry) {
  const e = Object.assign({ ts: Date.now() }, entry);
  if (!Array.isArray(target.log)) target.log = [];
  target.log.push(e);
  if (target.log.length > 300) target.log = target.log.slice(-300);
  return e;
}

function appendProtectionHistory(target, entry) {
  if (!Array.isArray(target.protectionHistory)) target.protectionHistory = [];
  const event = Object.assign({}, entry);
  target.protectionHistory.push(event);
  if (target.protectionHistory.length > PROTECTION_HISTORY_LIMIT) {
    target.protectionHistory = target.protectionHistory.slice(-PROTECTION_HISTORY_LIMIT);
  }
  return event;
}

function copyState() {
  return JSON.parse(JSON.stringify(state));
}

function addLog(entry) {
  const e = appendStateLog(state, entry);
  persistState();
  return e;
}

// ------------------------------------------------------------------- spend
// Accumulate in memory, flush on a timer. saveJSONAtomic's rename-retry loop
// spins synchronously, and state.json is already ~66KB, so writing it on every
// agent turn would put that spin on the hot path of a live edit session.
function spendDelayMs(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value >= 25 ? value : fallback;
}
const SPEND_FLUSH_MS = spendDelayMs('SUITE_SPEND_FLUSH_MS', 10000);
const SPEND_RETRY_MS = spendDelayMs('SUITE_SPEND_RETRY_MS', 1000);
let spendDirty = false;
let spendTimer = null;
function scheduleSpendPersist(delayMs) {
  if (spendTimer) return;
  spendTimer = setTimeout(() => {
    spendTimer = null;
    if (!spendDirty) return;
    if (persistState()) {
      spendDirty = false;
      return;
    }
    // The turn is already visible to the human, so never discard it simply
    // because an antivirus/indexer lock made one atomic write miss. Keep the
    // dirty bit through a bounded retry instead of silently losing it on the
    // next restart.
    console.error('could not save spend; retaining pending usage for retry');
    scheduleSpendPersist(SPEND_RETRY_MS);
  }, delayMs);
  if (spendTimer.unref) spendTimer.unref();
}
function persistSpendSoon() {
  spendDirty = true;
  scheduleSpendPersist(SPEND_FLUSH_MS);
}
function flushSpend() {
  if (spendTimer) { clearTimeout(spendTimer); spendTimer = null; }
  if (spendDirty && persistState()) spendDirty = false;
}

function recordTurnCost(c) {
  const s = state.spend;
  const u = c.usage || {};
  s.totalUsd += c.costUsd || 0;
  s.turns += 1;
  s.tokens.input += u.input || 0;
  s.tokens.output += u.output || 0;
  s.tokens.cacheRead += u.cacheRead || 0;
  s.tokens.cacheWrite += u.cacheWrite || 0;
  // byModel is the only thing that can ever answer "did switching profiles
  // actually reduce spend", which is the whole point of the toggle.
  const bm = s.byModel[c.model] || (s.byModel[c.model] = { usd: 0, turns: 0, promptTokens: 0, outputTokens: 0 });
  bm.usd += c.costUsd || 0; bm.turns += 1;
  bm.promptTokens += u.promptTokens || 0; bm.outputTokens += u.output || 0;
  const br = s.byRole[c.role] || (s.byRole[c.role] = { usd: 0, turns: 0 });
  br.usd += c.costUsd || 0; br.turns += 1;
  s.recent.push({ ts: c.ts, name: c.name, role: c.role, model: c.model,
                  usd: c.costUsd || 0, promptTokens: u.promptTokens || 0, outTokens: u.output || 0,
                  isError: !!c.isError, subtype: c.subtype || null });
  if (s.recent.length > 100) s.recent = s.recent.slice(-100);
  persistSpendSoon();
}

function spendView() {
  const s = state.spend;
  return {
    sinceTs: s.sinceTs, totalUsd: s.totalUsd, turns: s.turns,
    tokens: s.tokens, byModel: s.byModel, byRole: s.byRole,
    recent: s.recent.slice(-20),
    rateLimit: Agents.rateLimit || null,
  };
}

// ----------------------------------------------------- idle agent reaper
// Agents must not stay alive just because the server is up. Once their work is
// drained, aliveness is tied to a human actually being present: a viewer page
// open AND touched recently. Never kill an in-flight or queued turn merely
// because the viewer clock expired; doing so loses work at exactly the moment
// the human is least likely to notice.
//
// Presence has two independent signals, deliberately:
//   1. an open ?viewer= SSE connection  -> catches "the tab was closed" instantly
//      (plus a pagehide beacon, so we do not wait for the TCP close to be noticed)
//   2. a recent interaction timestamp   -> catches "the tab is open but abandoned"
// Either failing is enough to reap. `ppt watch` opens the same SSE stream and is
// excluded on purpose: a terminal left on watch is not a human watching.
// Floor is 5s, not 60s: a higher floor silently clamps any override, which made
// the reaper test's short window unreachable and hid a real regression. The
// floor only exists to stop a 1ms value thrashing the interval.
const VIEWER_IDLE_MS = Math.max(5000, parseInt(process.env.SUITE_VIEWER_IDLE_MS || String(10 * 60 * 1000), 10) || 10 * 60 * 1000);
// a reload drops the SSE briefly; do not reap on that. Configurable so the
// reaper test can exercise the real path in seconds instead of minutes.
const VIEWER_GONE_GRACE_MS = Math.max(1000, parseInt(process.env.SUITE_VIEWER_GRACE_MS || '60000', 10) || 60000);
const PRESENCE_TICK_MS = Math.max(500, parseInt(process.env.SUITE_PRESENCE_TICK_MS || '20000', 10) || 20000);
const viewerClients = new Set();
let lastViewerActivity = 0;           // 0 = nobody has ever been seen watching
let lastViewerGoneAt = null;

function touchViewer() {
  lastViewerActivity = Date.now();
  lastViewerGoneAt = null;
  // Restart recovery never wakes costly workers in the background. The first
  // real Studio presence (and later heartbeats) is the safe retry trigger.
  dispatchTaskRecovery();
}

function agentHasPendingWork(proc) {
  if (!proc) return false;
  try {
    if (proc.inflight || proc.status === 'thinking') return true;
    if (Array.isArray(proc.queue) && proc.queue.length > 0) return true;
    return Number(proc.depth) > 0;
  } catch (_) {
    // A provider adapter with an unreadable lifecycle state is not safe to
    // kill automatically. Explicit dismiss/interrupt remains available.
    return true;
  }
}

function reapIdleAgents(why) {
  if (!Agents.procs || Agents.procs.size === 0) return false;
  const idleNames = [];
  const protectedNames = [];
  for (const [name, proc] of Agents.procs) {
    (agentHasPendingWork(proc) ? protectedNames : idleNames).push(name);
  }
  if (!idleNames.length) return false;

  // stdin is only a wake signal. A successfully delivered task is removed
  // from the volatile recovery set while its durable record remains open.
  // Before reaping an idle worker, restore every still-open wake assignment so
  // the next real viewer can retry it instead of leaving it stranded forever.
  const requeuedTaskIds = [];
  for (const task of board.tasks) {
    if (!idleNames.includes(task.assignee) || !taskWantsWorkerWake(task)) continue;
    if (queueTaskRecovery(task)) requeuedTaskIds.push(task.id);
  }

  const names = idleNames.filter((name) => Agents.stop(name));
  if (!names.length) return false;
  // Release whatever the stopped idle agents still had claimed. A worker can
  // finish its turn without reaching its own unlock step, and a stranded lock
  // would otherwise sit for the full 20 minute TTL.
  let freed = 0;
  for (const [id, l] of [...locks.entries()]) {
    if (names.includes(l.by)) { locks.delete(id); freed++; }
  }
  addLog({
    kind: 'agents-reaped',
    why,
    agents: names.join(', '),
    protected: protectedNames.join(', '),
    tasksRequeued: requeuedTaskIds.join(', '),
    locksFreed: freed,
  });
  broadcast({ type: 'agents', agents: Agents.agentsView(), profile: profileView(), ts: Date.now() });
  if (freed) broadcast({ type: 'locks', locks: lockView(), ts: Date.now() });
  broadcast({
    type: 'reaped',
    why,
    agents: names,
    protected: protectedNames,
    tasksRequeued: requeuedTaskIds,
    ts: Date.now(),
  });
  console.log(
    `[reaper] stopped ${names.length} idle agent(s) (${why}): ${names.join(', ')}` +
    (protectedNames.length ? `; protected busy: ${protectedNames.join(', ')}` : '') +
    (requeuedTaskIds.length ? `; requeued tasks: ${requeuedTaskIds.join(', ')}` : '')
  );
  return true;
}

function presenceState() {
  const now = Date.now();
  const watching = viewerClients.size > 0;
  const idleMs = lastViewerActivity ? now - lastViewerActivity : null;
  return {
    viewers: viewerClients.size,
    idleMs,
    idleLimitMs: VIEWER_IDLE_MS,
    // "would agents be allowed to run right now"
    present: watching && idleMs != null && idleMs < VIEWER_IDLE_MS,
  };
}

function checkPresence() {
  if (!Agents.procs || Agents.procs.size === 0) return;
  const now = Date.now();
  if (viewerClients.size === 0) {
    // Grace window so a page reload (SSE drops, reconnects ~1s later) does not
    // look like the human leaving.
    if (lastViewerGoneAt == null) { lastViewerGoneAt = now; return; }
    if (now - lastViewerGoneAt >= VIEWER_GONE_GRACE_MS) reapIdleAgents('no viewer open');
    return;
  }
  lastViewerGoneAt = null;
  if (!lastViewerActivity || now - lastViewerActivity >= VIEWER_IDLE_MS) {
    reapIdleAgents(`viewer idle over ${Math.round(VIEWER_IDLE_MS / 60000)}m`);
  }
}
const presenceTimer = setInterval(checkPresence, PRESENCE_TICK_MS);
if (presenceTimer.unref) presenceTimer.unref();

// ------------------------------------------------------------ loop runner
// Standing loops used to be a registry with nothing behind it: adding one made
// a row appear and then nothing ever happened, which is worse than not having
// the feature, because the row implies recurrence. This actually runs them.
//
// Gated on the SAME presence signal as the reaper, which is the load-bearing
// part: without it a loop would respawn the lead minutes after the reaper killed
// it, with nobody watching, and quietly undo the whole point of the reaper.
const LOOP_TICK_MS = Math.max(5000, parseInt(process.env.SUITE_LOOP_TICK_MS || '15000', 10) || 15000);
// Floor, so "every 1s" cannot melt the token budget. Configurable ONLY so the
// loop-runner test can exercise the real scheduling path in seconds; a lower
// floor in production would let one loop spawn a lead turn every tick.
const LOOP_MIN_CADENCE_MS = Math.max(1000, parseInt(process.env.SUITE_LOOP_MIN_CADENCE_MS || '60000', 10) || 60000);

// Only a machine-readable cadence can be scheduled. Anything else ("each edit",
// "continuously") stays manual, and the UI says so rather than implying a timer.
function parseCadence(c) {
  if (!c) return null;
  const m = String(c).trim().match(/^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  const ms = unit.startsWith('s') ? n * 1000 : unit.startsWith('m') ? n * 60000 : n * 3600000;
  return Math.max(LOOP_MIN_CADENCE_MS, ms);
}

function loopDueAt(l) {
  const every = parseCadence(l.cadence);
  if (!every || !l.enabled) return null;
  return (l.lastRun || l.createdTs || Date.now()) + every;
}

function loopRunnerView() {
  const now = Date.now();
  const due = board.loops.map(loopDueAt).filter((t) => t != null);
  const schedulable = board.loops.filter((l) => l.enabled && parseCadence(l.cadence)).length;
  return {
    enabled: !!state.loopRunner,
    schedulable,
    // how many enabled loops have a cadence nothing can schedule
    manualOnly: board.loops.filter((l) => l.enabled && !parseCadence(l.cadence)).length,
    nextDueMs: due.length ? Math.max(0, Math.min(...due) - now) : null,
    presenceRequired: true,
    present: presenceState().present,
  };
}

function tickLoops() {
  if (!state.loopRunner) return;
  if (state.paused) return;                       // pause is a hard stop, loops included
  if (!presenceState().present) return;           // never resurrect agents with nobody watching
  if (!agentSweepReady) return;                   // do not race children orphaned by the prior server
  const lead = Agents.procs && Agents.procs.get('lead');
  // Do not pile ticks onto a lead that is already backed up: one queued message
  // is fine, a growing queue means every tick is compounding spend.
  if (lead && lead.depth > 1) return;
  const now = Date.now();
  for (const l of board.loops) {
    const due = loopDueAt(l);
    if (due == null || now < due) continue;
    // Stamp before dispatching. A failed board write must never enqueue a lead
    // turn whose durable cadence marker would vanish on restart.
    const prior = { lastRun: l.lastRun, lastBy: l.lastBy, lastResult: l.lastResult };
    const tx = transactBoard((target) => {
      const loop = findLoop(l.id, target);
      loop.lastRun = now; loop.lastBy = 'loop-runner';
      return { loop };
    });
    if (!tx.ok) {
      console.error('loop runner skipped an undurable dispatch:', tx.error);
      return;
    }
    let r;
    try { r = Agents.ensureLead(`[loop ${l.id}] ${l.text}`); }
    catch (e) { console.error('loop runner dispatch threw:', e && (e.stack || e)); }
    if (!r || r.ok === false) {
      // A refusal is not a completed run. Restore the old stamp when possible
      // so the next eligible tick can retry without pretending it succeeded.
      const rollback = transactBoard((target) => {
        const loop = findLoop(l.id, target);
        loop.lastRun = prior.lastRun; loop.lastBy = prior.lastBy; loop.lastResult = prior.lastResult;
        return { loop };
      });
      if (!rollback.ok) console.error('loop runner could not roll back a refused dispatch:', rollback.error);
      return;
    }
    addLog({ kind: 'loop-run', loopId: l.id, detail: String(l.text).slice(0, 120) });
    broadcast({ type: 'loops', action: 'run', loops: loopView(), loop: tx.loop, ts: now });
    break;   // one loop per tick: they serialise through the lead's queue anyway
  }
}
const loopTimer = setInterval(tickLoops, LOOP_TICK_MS);
if (loopTimer.unref) loopTimer.unref();

function fastModeView(running, provider) {
  const selectedProvider = provider || Agents.providerName;
  const enabled = state.agentFastMode === true;
  const available = selectedProvider === 'codex';
  const appliedToNextSpawn = enabled && available;
  const active = Array.isArray(running) ? running : [];
  const pending = active.some((agent) => !!agent.fastMode !== appliedToNextSpawn);
  let reason;
  if (!available) {
    reason = enabled
      ? 'Fast is saved ON but is unavailable and not applied on Claude. The next Claude spawn stays on standard service; the next Codex spawn will use Fast.'
      : 'Fast is unavailable and not applied on Claude. The next Claude spawn stays on standard service.';
  } else if (enabled) {
    reason = 'Fast is ON for the next Codex spawn. Running agents keep the service they started with.';
  } else {
    reason = 'Fast is OFF for the next Codex spawn. Running agents keep the service they started with.';
  }
  return {
    enabled,
    available,
    appliedToNextSpawn,
    pending,
    provider: selectedProvider,
    appliesTo: 'next spawn',
    reason,
  };
}

function profileView() {
  const running = [...Agents.agentsView()].map((a) => ({
    name: a.name,
    role: a.role,
    pool: a.pool || (a.role === 'worker' ? agentPoolForName(a.name) : 'lead'),
    model: a.model,
    provider: a.provider || null,
    reasoningEffort: a.reasoningEffort || 'medium',
    serviceTier: a.serviceTier || 'standard',
    fastMode: !!a.fastMode,
    fullAccess: !!a.fullAccess,
  }));
  const profile = PROFILES[state.usageProfile];
  const provider = Agents.providerName;
  const poolCaps = Agents.poolCaps;
  const nextModels = {
    lead: Agents.modelFor('lead', provider),
    worker: Agents.modelFor('worker', provider),
  };
  const nextExecution = {
    provider,
    models: nextModels,
    reasoningEffort: Agents.reasoningEffort,
    serviceTier: Agents.serviceTier,
    fastMode: Agents.fastMode,
    fullAccess: Agents.fullAccess,
  };
  const fastMode = fastModeView(running, provider);
  return {
    profile: state.usageProfile,
    known: PROFILE_NAMES,
    profiles: PROFILES,
    provider,
    configuredProvider: state.agentProvider,
    forcedProvider: profile.forcedProvider || null,
    providers: PROVIDER_NAMES,
    providerModels: PROVIDER_MODELS,
    // What the NEXT spawn would actually use, resolved through the provider.
    nextModels,
    nextExecution,
    fastMode,
    providerHealth: PROVIDER_NAMES.reduce((acc, n) => { acc[n] = Agents.providerHealth(n); return acc; }, {}),
    // Codex reports tokens but no dollar figure, so the UI must not render $0.00
    // for it as though that were a measured cost.
    costMeasured: provider === 'claude',
    maxWorkers: poolCaps.general,
    maxMediaWorkers: poolCaps.media,
    poolCaps,
    appliesTo: 'next spawn',
    running,
    // True when a running agent is on a different model than the current
    // profile+provider would spawn. Compared against the RESOLVED model, so
    // switching provider (sonnet -> gpt-5.6-terra) correctly reads as pending.
    pending: running.some((r) =>
      r.model !== Agents.modelFor(r.role, provider)
      || (r.provider || 'claude') !== provider
      || r.reasoningEffort !== nextExecution.reasoningEffort
      || r.serviceTier !== nextExecution.serviceTier
      || r.fastMode !== nextExecution.fastMode
      || r.fullAccess !== nextExecution.fullAccess),
  };
}

// -------------------------------------------------------- the message board
// A shared, human-and-Claude note board that lives alongside the deck. Pinned
// notes are the human's standing "house rules" (e.g. "no em dashes anywhere");
// unpinned notes are a running chat between the Claude sessions. The board is
// deliberately NOT gated by pause — communication must work even while editing
// is frozen.
function defaultBoard() {
  const now = Date.now();
  return {
    notes: [
      { id: 'rule-no-emdash', text: 'Do not use em dashes (—) anywhere in the deck. Use a comma, a period, a colon, or parentheses instead. This applies to every slide, bullet, and speaker note.',
        author: 'human', pinned: true, ts: now }
    ],
    tasks: [],
    loops: []
  };
}

function persistBoard(nextBoard) { return saveJSONAtomic(BOARD_PATH, nextBoard || board); }

function copyBoard(source) {
  return JSON.parse(JSON.stringify(source || board));
}

// All board mutations share one short synchronous transaction: nothing can
// interleave Node's clone/mutate/write/commit sequence, and a failed write
// leaves the live collaboration view exactly where it was before the request.
function transactBoard(mutator) {
  let candidate, result;
  try {
    candidate = copyBoard();
    result = mutator(candidate);
  } catch (e) {
    console.error('board mutation rejected:', e && (e.stack || e));
    return { ok: false, error: 'board mutation failed' };
  }
  if (!result || result.ok === false) return result || { ok: false, error: 'board mutation failed' };
  if (!persistBoard(candidate)) return { ok: false, error: 'could not save board' };
  board = candidate;
  return Object.assign({ ok: true }, result);
}

// pinned house rules first (stable, oldest-first), then messages newest-first
function boardView(source) {
  const current = source || board;
  const pinned = current.notes.filter((n) => n.pinned).sort((a, b) => a.ts - b.ts);
  const rest = current.notes.filter((n) => !n.pinned).sort((a, b) => b.ts - a.ts);
  return pinned.concat(rest);
}

function addNoteTo(target, { text, author, pinned }) {
  const note = {
    id: shortId('n'),
    text: String(text == null ? '' : text).slice(0, 4000),
    author: String(author == null || author === '' ? 'anonymous' : author).slice(0, 60),
    pinned: !!pinned,
    ts: Date.now()
  };
  target.notes.push(note);
  // Cap growth: keep every pinned rule plus the newest 400 messages.
  const nonPinned = target.notes.filter((n) => !n.pinned);
  if (nonPinned.length > 400) {
    const keep = new Set(nonPinned.slice(-400).map((n) => n.id));
    target.notes = target.notes.filter((n) => n.pinned || keep.has(n.id));
  }
  return note;
}

function addNote(input) { return transactBoard((target) => ({ note: addNoteTo(target, input) })); }

// ---------------------------------------------------------------- task list
// A lightweight shared to-do queue that rides alongside the board (same file,
// also ungated by pause). A busy session posts a task, optionally aimed at a
// named session; a free session claims it, does the work, and marks it done.
// Every explicit worker/media assignment carries durable wake intent, no
// matter which trusted UI/CLI identity authored it. Unassigned tasks stay
// passive and are picked up only when a session reads the queue.
function tasksView(source) {
  const current = source || board;
  const active = current.tasks.filter((t) => t.status !== 'done').sort((a, b) => a.ts - b.ts);
  const done = current.tasks.filter((t) => t.status === 'done').sort((a, b) => (b.doneTs || 0) - (a.doneTs || 0));
  return active.concat(done);
}

const TASK_REVISION_LIMIT = 50;
const TASK_RECOVERY_RETRY_MS = Math.max(
  1000,
  Number.parseInt(process.env.SUITE_TASK_RECOVERY_RETRY_MS || '30000', 10) || 30000
);
const taskRecoveryIds = new Set();
const taskRecoveryRetryAt = new Map();
let agentSweepReady = false;
let taskRecoveryReady = false;

function taskWakeIntent(task) {
  return !!task && (
    task.wakeWorker === true ||
    (task.wakeWorker === undefined && task.by === 'lead')
  );
}

function taskWantsWorkerWake(task) {
  if (!task || task.status !== 'open' || !isWorkerAgentName(task.assignee)) return false;
  // New records carry the explicit durable intent. `by === lead` preserves
  // recovery for board.json files written before wakeWorker was introduced.
  return taskWakeIntent(task);
}

function taskWakeMessage(task, recovered) {
  const recovery = recovered
    ? ' [recovered task retry] Inspect current state first. If the requested result is already present, verify it and mark this task done without applying it again.'
    : '';
  return `[task ${task.id}]${recovery} ${task.text}`;
}

function clearTaskRecovery(id) {
  taskRecoveryIds.delete(id);
  taskRecoveryRetryAt.delete(id);
}

function queueTaskRecovery(task, retryDelayMs = 0) {
  if (!taskWantsWorkerWake(task)) return false;
  taskRecoveryIds.add(task.id);
  if (retryDelayMs > 0) taskRecoveryRetryAt.set(task.id, Date.now() + retryDelayMs);
  else taskRecoveryRetryAt.delete(task.id);
  return true;
}

// The board is the durable queue; stdin is only a wake signal. After a server
// restart no old in-process claim can still be valid, so reset claimed work in
// one atomic board transaction, then rebuild the volatile wake set exclusively
// from unfinished tasks that were explicitly intended for workers.
function initializeTaskRecovery() {
  const claimedIds = board.tasks.filter((task) => task.status === 'claimed').map((task) => task.id);
  if (claimedIds.length) {
    const claimedSet = new Set(claimedIds);
    const tx = transactBoard((target) => {
      const recovered = [];
      for (const task of target.tasks) {
        if (!claimedSet.has(task.id) || task.status !== 'claimed') continue;
        task.status = 'open';
        task.claimedBy = '';
        recovered.push(task.id);
      }
      return { recovered };
    });
    if (!tx.ok) {
      console.error('task restart recovery could not durably requeue claimed work:', tx.error);
      return { ok: false, error: tx.error };
    }
    if (tx.recovered.length) {
      broadcast({ type: 'tasks', action: 'recover', recovered: tx.recovered, tasks: tasksView(), ts: Date.now() });
    }
  }
  for (const task of board.tasks) {
    if (taskWantsWorkerWake(task)) taskRecoveryIds.add(task.id);
  }
  taskRecoveryReady = true;
  return { ok: true, queued: taskRecoveryIds.size, requeued: claimedIds.length };
}

function taskRecoveryBlockReason() {
  if (!agentSweepReady) return 'agent restart cleanup in progress';
  if (!taskRecoveryReady) return 'task recovery is not ready';
  if (state.paused) return 'paused';
  if (!presenceState().present) return 'no viewer present';
  return null;
}

function dispatchTaskRecovery({ force = false, taskId = null, recovered = true } = {}) {
  const blocked = taskRecoveryBlockReason();
  if (blocked) {
    const result = taskId ? { ok: false, reason: blocked, queued: taskRecoveryIds.has(taskId) } : undefined;
    return { attempted: 0, dispatched: 0, pending: taskRecoveryIds.size, blocked, result };
  }
  let attempted = 0;
  let dispatched = 0;
  let requestedResult = null;
  const now = Date.now();
  const pendingIds = taskId ? (taskRecoveryIds.has(taskId) ? [taskId] : []) : [...taskRecoveryIds];
  const pending = pendingIds
    .map((id) => findTask(id))
    .filter(Boolean)
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  for (const task of pending) {
    if (!taskWantsWorkerWake(task)) {
      clearTaskRecovery(task.id);
      if (task.id === taskId) requestedResult = { ok: false, reason: 'task is not eligible for worker wake', queued: false };
      continue;
    }
    if (!force && (taskRecoveryRetryAt.get(task.id) || 0) > now) continue;
    attempted++;
    let result;
    try {
      result = Agents.spawnOrWrite(task.assignee, 'worker', taskWakeMessage(task, recovered));
    } catch (error) {
      console.error('recovered task worker dispatch threw:', error && (error.stack || error));
      result = { ok: false, reason: 'worker dispatch threw' };
    }
    if (result && result.ok) {
      clearTaskRecovery(task.id);
      dispatched++;
      if (task.id === taskId) requestedResult = Object.assign({}, result, { queued: false });
    } else {
      taskRecoveryRetryAt.set(task.id, Date.now() + TASK_RECOVERY_RETRY_MS);
      if (task.id === taskId) {
        requestedResult = Object.assign(
          { ok: false, reason: 'worker dispatch failed' },
          result || {},
          { queued: true }
        );
      }
    }
  }
  if (taskId && !requestedResult) {
    requestedResult = {
      ok: false,
      reason: taskRecoveryIds.has(taskId) ? 'worker wake is waiting for retry' : 'task is not queued for worker wake',
      queued: taskRecoveryIds.has(taskId),
    };
  }
  return { attempted, dispatched, pending: taskRecoveryIds.size, result: requestedResult };
}

function addTaskTo(target, { text, by, assignee, route }) {
  const author = String(by == null || by === '' ? 'anonymous' : by).slice(0, 60);
  const requestedAssignee = String(assignee == null ? '' : assignee).slice(0, 60);
  const assigned = String(route && route.assignee != null ? route.assignee : requestedAssignee).slice(0, 60);
  const task = {
    id: shortId('t'),
    text: String(text == null ? '' : text).slice(0, 2000),
    by: author,
    assignee: assigned,                                                // '' = anyone
    // An explicit worker/media assignment is active dispatch, independent of
    // the caller's display label. Unassigned tasks remain passive. task-hold
    // can still turn this durable bit off after creation.
    wakeWorker: isWorkerAgentName(assigned),
    // Frozen routing metadata makes retries deterministic. Legacy tasks may
    // lack these fields; their stored assignee remains the source of truth.
    pool: route ? route.pool : (agentPoolForName(assigned) || null),
    classifiedPool: route ? route.classifiedPool : null,
    requestedAssignee: route && requestedAssignee !== assigned ? requestedAssignee : null,
    routeFallback: route ? !!route.fallback : false,
    routeReason: route ? route.reason : null,
    status: 'open',                                                     // open | claimed | done
    claimedBy: '',
    ts: Date.now(),
    doneTs: null
  };
  target.tasks.push(task);
  // Cap growth: keep every open/claimed task plus the newest 200 completed ones.
  const done = target.tasks.filter((t) => t.status === 'done');
  if (done.length > 200) {
    const keep = new Set(done.slice(-200).map((t) => t.id));
    target.tasks = target.tasks.filter((t) => t.status !== 'done' || keep.has(t.id));
  }
  return task;
}

function addTask(input) {
  const rawAssignee = input ? input.assignee : null;
  const requested = String(rawAssignee == null ? '' : rawAssignee).slice(0, 60);
  const route = isWorkerAgentName(requested)
    ? Agents.routeTask(input && input.text, requested)
    : null;
  return transactBoard((target) => ({ task: addTaskTo(target, Object.assign({}, input, { route })) }));
}

function findTask(id, source) { return (source || board).tasks.find((t) => t.id === id); }

function delegatedProtectionGrant(actor, taskId, slideId, now) {
  const id = typeof taskId === 'string' ? taskId.trim() : '';
  if (!id) {
    return {
      ok: false,
      error: 'agents may not create or remove content protections without a human-granted task id'
    };
  }
  const task = findTask(id);
  if (!task) return { ok: false, error: 'no such delegated protection task' };
  if (!['open', 'claimed'].includes(task.status)) {
    return { ok: false, error: `delegated protection task is ${task.status}` };
  }
  const assignedToActor = task.assignee === actor || (!task.assignee && task.claimedBy === actor);
  if (!assignedToActor || (task.claimedBy && task.claimedBy !== actor)) {
    return { ok: false, error: 'delegated protection task is assigned to another editor' };
  }
  const grant = task.protectionGrant;
  if (!isRecord(grant) || !Array.isArray(grant.slideIds)) {
    return { ok: false, error: 'task has no human protection grant' };
  }
  if (grant.version !== 1 || grant.grantedTo !== actor) {
    return { ok: false, error: 'task protection grant belongs to another editor' };
  }
  if (grant.revokedAt) return { ok: false, error: 'task protection grant was revoked' };
  const at = Number.isSafeInteger(now) ? now : Date.now();
  if (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= at) {
    return { ok: false, error: 'task protection grant expired' };
  }
  if (typeof grant.grantedBy !== 'string' || !grant.grantedBy.trim() ||
      isSuiteAgentActor(grant.grantedBy)) {
    return { ok: false, error: 'task protection grant has no valid human authorizer' };
  }
  if (!grant.slideIds.includes(slideId)) {
    return { ok: false, error: `task protection grant does not include slide ${slideId}` };
  }
  return { ok: true, task, grant };
}

function delegatedProtectionMode(actor, taskId, protection, protectedValue, mode, now) {
  const delegated = delegatedProtectionGrant(actor, taskId, protection.slideId, now);
  if (!delegated.ok) return delegated;
  if (!delegated.grant.protectionModes.includes(mode)) {
    return { ok: false, error: `task protection grant does not allow ${mode}` };
  }
  if (protectedValue !== true) {
    return { ok: false, error: 'delegated protection control may only add protections' };
  }
  if (mode !== 'direct-generated-decor' ||
      protection.kind !== 'object' || protection.objectKind !== 'decor') {
    return { ok: false, error: 'direct-generated-decor requires a decor target' };
  }
  return delegated;
}

function delegatedProtectedEdit(actor, taskId, op, now) {
  if (!isSuiteAgentActor(actor)) {
    return { ok: false, error: 'taskId is only valid for an agent edit' };
  }
  const slideId = op && typeof op.slideId === 'string' ? op.slideId : '';
  const delegated = delegatedProtectionGrant(actor, taskId, slideId, now);
  if (!delegated.ok) return delegated;
  if (!delegated.grant.editOps.includes(op.type)) {
    return { ok: false, error: `task protection grant does not allow edit ${op.type || '(missing)'}` };
  }
  if (op.type !== 'add-image' || typeof op.source !== 'string') {
    return { ok: false, error: 'delegated add-image requires an image source' };
  }
  return delegated;
}

function taskAssigneeError(assignee) {
  if (!assignee) return null;
  const error = agentIdentityError(
    assignee,
    'worker',
    Agents.maxWorkers,
    Agents.maxMediaWorkers
  );
  if (!error) return null;
  const media = Agents.maxMediaWorkers > 0
    ? ` or media-1 through media-${Agents.maxMediaWorkers}`
    : '';
  return `assignee must be empty or worker-1 through worker-${Agents.maxWorkers}${media}`;
}

// ------------------------------------------------------------ standing loops
// "Loops" are the human's standing, recurring CHECK prompts, e.g. "continuously
// check that every box's text is formatted neatly". Unlike pinned house rules
// (passive constraints) or tasks (one-shot to-dos), a loop is an ACTIVE, never
// finished directive that a session re-runs on a cadence. See the /loop runner
// in the README. Loops ride in board.json next to the notes and tasks, and are
// also ungated by pause: you can add, toggle, or remove one at any time. Acting
// on a loop still edits the deck through the gated /api/edit path, so any fixes
// simply wait until resume.
function loopView(source) {
  return (source || board).loops.slice().sort((a, b) => (a.createdTs || 0) - (b.createdTs || 0));
}

function addLoopTo(target, { text, author, cadence }) {
  const loop = {
    id: shortId('loop'),
    text: String(text == null ? '' : text).slice(0, 4000),
    author: String(author == null || author === '' ? 'anonymous' : author).slice(0, 60),
    cadence: cadence == null || cadence === '' ? null : String(cadence).slice(0, 40),  // free-form hint, e.g. "each edit" or "10m"
    enabled: true,
    createdTs: Date.now(),
    lastRun: null,     // when a session last ran this loop
    lastBy: '',        // who ran it
    lastResult: null   // short summary of the last run
  };
  target.loops.push(loop);
  if (target.loops.length > 200) target.loops = target.loops.slice(-200);
  return loop;
}

function addLoop(input) { return transactBoard((target) => ({ loop: addLoopTo(target, input) })); }

function findLoop(id, source) { return (source || board).loops.find((l) => l.id === id); }

// --------------------------------------------------------------------- SSE
function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { /* dropped on next tick */ }
  }
}

function editorList() {
  // Attach each editor's agent color+ink (a pure function of name), so the
  // /studio chips and per-agent region indicators resolve colors from the
  // same authoritative source. Humans/pseudo-editors get null (no chip).
  return [...editors.values()]
    .map((ed) => Object.assign({}, ed, agentColor(ed.name) || {}))
    .sort((a, b) => a.joinedAt - b.joinedAt);
}

function pruneEditors() {
  const now = Date.now();
  let changed = false;
  for (const [id, ed] of editors) {
    if (now - ed.lastSeen > EDITOR_TTL) { editors.delete(id); changed = true; }
  }
  if (changed) broadcast({ type: 'editors', editors: editorList(), ts: now });
}
setInterval(pruneEditors, 5000).unref();
setInterval(() => broadcast({ type: 'ping', ts: Date.now() }), 20000).unref();

// ------------------------------------------------------------- slide locks
// Advisory (not enforced) per-slide claims: a session marks which slide ids
// it's actively working on, so other sessions/agents see a heads-up instead
// of silently colliding. Nothing here blocks an edit — the pause flag is the
// only hard gate — but /api/edit attaches a `warning` when the target slide
// is held by someone else, and `ppt show`/the dashboard surface who holds
// what. In-memory only (like `editors`): a server restart clears them, which
// is fine since a restart is already a natural checkpoint between passes.
function lockView() {
  return [...locks.values()].sort((a, b) => a.ts - b.ts);
}

function pruneLocks() {
  const now = Date.now();
  let changed = false;
  for (const [id, l] of locks) {
    if (now - l.ts > LOCK_TTL) { locks.delete(id); changed = true; }
  }
  if (changed) broadcast({ type: 'locks', locks: lockView(), ts: now });
}
setInterval(pruneLocks, 30000).unref();

function releaseLocksFor(by, slideIds) {
  if (!by) return false;
  let changed = false;
  const only = Array.isArray(slideIds) ? new Set(slideIds) : null;
  for (const [id, l] of locks) {
    if (l.by !== by) continue;
    if (only && !only.has(id)) continue;
    locks.delete(id);
    changed = true;
  }
  return changed;
}

// ------------------------------------------------------------ COM host
// A single long-lived PowerShell process holding one PowerPoint COM instance
// for the server's lifetime (see com_host.ps1), instead of the old pattern
// of spawning a fresh powershell + fresh COM instance on every render (each
// costing ~2.6s just to acquire PowerPoint). Falls back to the old per-call
// spawn (legacyExportThumbs, below) if the host never starts or a job fails,
// so a COM host problem makes thumbnails slow again, never broken outright.
const COM_HOST_READY_TIMEOUT_MS = 10000;
const COM_HOST_JOB_TIMEOUT_MS = 15000;
const COM_HOST_STOP_TIMEOUT_MS = 4000;
const COM_HOST_KILL_SETTLE_MS = 5000;
const COM_HOST_STDOUT_FRAME_LIMIT = 256 * 1024;
const COM_HOST_STDERR_LIMIT = 64 * 1024;
let comHostSession = null;
let comHostStartPromise = null;
let comHostSweepPromise = null;
let comHostBlockedError = null;
let comHostGeneration = 0;
let comHostNextId = 1;
let comHostShuttingDown = false;

function validComHostPid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function taskkillComHostPid(pid, includeTree) {
  if (!IS_WIN || !validComHostPid(pid)) return Promise.resolve(false);
  const args = ['/PID', String(pid)];
  if (includeTree) args.push('/T');
  args.push('/F');
  return new Promise((resolve) => {
    try {
      execFile('taskkill', args, { windowsHide: true }, (error) => resolve(!error));
    } catch (_) {
      resolve(false);
    }
  });
}

function queryWindowsProcess(pid) {
  if (!IS_WIN || !validComHostPid(pid)) return Promise.resolve({ exists: false });
  const command = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
    "if ($null -eq $p) { [Console]::Out.Write('{\"exists\":false}'); exit 0 }",
    "$result = @{ exists = $true; name = [string]$p.Name; commandLine = [string]$p.CommandLine; startedAt = $p.CreationDate.ToUniversalTime().ToString('o') }",
    '[Console]::Out.Write(($result | ConvertTo-Json -Compress))',
  ].join('; ');
  return new Promise((resolve, reject) => {
    try {
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', command],
        { windowsHide: true, timeout: 2000, maxBuffer: 32 * 1024 }, (error, stdout) => {
          if (error) { reject(error); return; }
          let result;
          try { result = JSON.parse(String(stdout || '')); }
          catch (_) { reject(new Error('process identity query returned malformed JSON')); return; }
          if (result && result.exists === false) { resolve({ exists: false }); return; }
          const startedAt = Date.parse(result && result.startedAt);
          if (!result || result.exists !== true || typeof result.name !== 'string' ||
              typeof result.commandLine !== 'string' || !Number.isFinite(startedAt)) {
            reject(new Error('process identity query returned incomplete data'));
            return;
          }
          resolve({
            exists: true,
            name: result.name,
            commandLine: result.commandLine,
            startedAt,
          });
        });
    } catch (error) {
      reject(error);
    }
  });
}

async function staleComHostIdentity(stale) {
  if (!validComHostPid(stale.psPid)) return null;
  // Query failures are not identity mismatches. Let them abort the sweep so a
  // transient CIM failure can never remove the marker and overlap an old host.
  const processInfo = await queryWindowsProcess(stale.psPid);
  if (!processInfo.exists || !/^(powershell|pwsh)\.exe$/i.test(processInfo.name)) return null;
  const commandLine = processInfo.commandLine.toLowerCase();
  if (!commandLine.includes(String(COM_HOST_PS1).toLowerCase())) return null;
  if (typeof stale.token === 'string' && /^[a-f0-9]{32}$/.test(stale.token)) {
    if (!commandLine.includes(stale.token)) return null;
  } else {
    const approximateStart =
      typeof stale.startedAt === 'number' && Number.isFinite(stale.startedAt)
        ? stale.startedAt : NaN;
    if (!Number.isFinite(approximateStart) ||
        Math.abs(processInfo.startedAt - approximateStart) > 2 * 60 * 1000) return null;
  }
  return processInfo;
}

async function recordedPowerPointStart(pid, approximateStart) {
  let processInfo;
  try { processInfo = await queryWindowsProcess(pid); }
  catch (_) { return null; }
  if (!processInfo.exists || !/^powerpnt\.exe$/i.test(processInfo.name)) return null;
  if (Number.isFinite(approximateStart) &&
      Math.abs(processInfo.startedAt - approximateStart) > 2 * 60 * 1000) return null;
  return processInfo.startedAt;
}

async function terminateRecordedPowerPoint(pid, expectedStart) {
  if (!validComHostPid(pid)) return true;
  let before;
  try { before = await queryWindowsProcess(pid); }
  catch (_) { return false; }
  // Missing or reused means the exact recorded PowerPoint process is already
  // gone. Never kill the different process now occupying its old PID.
  if (!before.exists || !/^powerpnt\.exe$/i.test(before.name)) return true;
  if (!Number.isFinite(expectedStart)) return false;
  if (Math.abs(before.startedAt - expectedStart) > 1500) return true;

  await taskkillComHostPid(pid, false);
  for (let attempt = 0; attempt < 4; attempt++) {
    let after;
    try { after = await queryWindowsProcess(pid); }
    catch (_) { return false; }
    if (!after.exists || !/^powerpnt\.exe$/i.test(after.name) ||
        Math.abs(after.startedAt - expectedStart) > 1500) return true;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return false;
}

async function terminateRecordedPowerShell(pid, expectedIdentity) {
  if (!validComHostPid(pid) || !expectedIdentity || !expectedIdentity.exists) return false;
  await taskkillComHostPid(pid, true);
  for (let attempt = 0; attempt < 4; attempt++) {
    let after;
    try { after = await queryWindowsProcess(pid); }
    catch (_) { return false; }
    if (!after.exists || !/^(powershell|pwsh)\.exe$/i.test(after.name) ||
        after.startedAt !== expectedIdentity.startedAt ||
        after.commandLine !== expectedIdentity.commandLine) return true;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return false;
}

async function sweepStaleComHost() {
  // Boot-time safety net: our own restart routine hard-kills the old node
  // process (Stop-Process -Force), which on Windows skips SIGTERM handlers
  // and PowerShell's finally block alike, orphaning the old host + its
  // PowerPoint. Clean up ONLY the pids we ourselves recorded on a prior run,
  // never a blanket POWERPNT kill (a real PowerPoint window the human has
  // open must never be touched by this).
  let stale;
  try { stale = JSON.parse(fs.readFileSync(COM_HOST_PID_PATH, 'utf8')); } catch (_) { return; }
  if (!stale || !IS_WIN) return;
  const powerShellIdentity = await staleComHostIdentity(stale);
  let powerpointStartedAt =
    typeof stale.powerpointStartedAt === 'number' && Number.isFinite(stale.powerpointStartedAt)
      ? stale.powerpointStartedAt : NaN;
  const markerStartedAt =
    typeof stale.startedAt === 'number' && Number.isFinite(stale.startedAt)
      ? stale.startedAt : NaN;
  // A tentative/legacy marker has no exact PowerPoint creation time. A new
  // tokenized marker can use its persisted startup window directly; a legacy
  // marker additionally needs the still-running, script-matched PowerShell
  // process to authenticate it.
  const tokenizedMarker =
    typeof stale.token === 'string' && /^[a-f0-9]{32}$/.test(stale.token);
  if (!Number.isFinite(powerpointStartedAt) &&
      (powerShellIdentity || (tokenizedMarker && Number.isFinite(markerStartedAt))) &&
      validComHostPid(stale.powerpointPid)) {
    powerpointStartedAt = await recordedPowerPointStart(
      stale.powerpointPid, markerStartedAt
    );
  }
  if (powerShellIdentity) {
    if (!await terminateRecordedPowerShell(stale.psPid, powerShellIdentity)) {
      throw new Error('Could not confirm stale COM host PowerShell cleanup');
    }
  } else if (validComHostPid(stale.psPid)) {
    console.error('Skipped stale COM host cleanup because its PID identity no longer matches');
  }
  const powerpointClean = await terminateRecordedPowerPoint(
    stale.powerpointPid, powerpointStartedAt
  );
  if (!powerpointClean) {
    throw new Error('Could not confirm stale COM host PowerPoint cleanup');
  }
  try { fs.unlinkSync(COM_HOST_PID_PATH); } catch (_) {}
}

function boundedComHostText(current, chunk, limit) {
  const combined = current + String(chunk);
  return combined.length <= limit ? combined : combined.slice(combined.length - limit);
}

function comHostMarker(session) {
  return {
    psPid: validComHostPid(session.psPid) ? session.psPid : session.proc.pid,
    powerpointPid: validComHostPid(session.powerpointPid) ? session.powerpointPid : null,
    powerpointStartedAt: Number.isFinite(session.powerpointStartedAt)
      ? session.powerpointStartedAt : null,
    startedAt: session.startedAt,
    token: session.token,
  };
}

function saveComHostMarker(session) {
  try { return saveJSONAtomic(COM_HOST_PID_PATH, comHostMarker(session)) !== false; }
  catch (_) { return false; }
}

function removeComHostMarker(session) {
  // A late exit from generation N must never delete generation N+1's marker.
  let marker;
  try { marker = JSON.parse(fs.readFileSync(COM_HOST_PID_PATH, 'utf8')); } catch (_) { return; }
  if (!marker || marker.token !== session.token) return;
  try { fs.unlinkSync(COM_HOST_PID_PATH); } catch (_) {}
}

function settleComHostReady(session, error) {
  if (session.readySettled) return;
  session.readySettled = true;
  clearTimeout(session.readyTimer);
  if (error) session.rejectReady(error);
  else {
    session.wasReady = true;
    session.resolveReady(session);
  }
}

function rejectComHostPending(session, error) {
  for (const [, pending] of session.pending) pending.reject(error);
  session.pending.clear();
}

function killComHostSession(session) {
  if (session.killIssued) return;
  session.killIssued = true;
  const psPid = validComHostPid(session.psPid) ? session.psPid : session.proc.pid;
  if (IS_WIN && validComHostPid(psPid)) {
    taskkillComHostPid(psPid, true);
  } else {
    try { session.proc.kill('SIGKILL'); } catch (_) {}
  }
}

function finalizeComHostSession(session, error, terminationConfirmed) {
  if (!session.active) return;
  session.active = false;
  clearTimeout(session.readyTimer);
  clearTimeout(session.killSettleTimer);
  rejectComHostPending(session, error);
  settleComHostReady(session, error);
  if (comHostSession === session) comHostSession = null;
  if (terminationConfirmed) removeComHostMarker(session);
  else {
    // Do not overlap a new PowerPoint owner with a process the OS never
    // confirmed dead. A server restart will re-run the token-checked sweep.
    comHostBlockedError = new Error('COM host termination was not confirmed; restart the suite before retrying');
  }
  session.resolveRetired();
}

function beginComHostRetirement(session, error, kill) {
  if (!session.active) return session.retiredPromise;
  if (!session.retiring) {
    session.retiring = true;
    session.retireReason = error;
    rejectComHostPending(session, error);
  }
  if (kill) {
    killComHostSession(session);
    if (!session.killSettleTimer) {
      session.killSettleTimer = setTimeout(
        () => finalizeComHostSession(session, session.retireReason || error, false),
        COM_HOST_KILL_SETTLE_MS
      );
    }
  }
  return session.retiredPromise;
}

function failComHostProtocol(session, error) {
  if (!session.active || session.retiring) return;
  session.stderr = boundedComHostText(session.stderr, '\n' + error.message, COM_HOST_STDERR_LIMIT);
  beginComHostRetirement(session, error, true);
}

function handleComHostLine(session, rawLine) {
  if (!session.active || session.retiring) return;
  const line = rawLine.trim();
  if (!line) return;
  if (line.length > COM_HOST_STDOUT_FRAME_LIMIT) {
    failComHostProtocol(session, new Error('COM host stdout frame exceeded limit'));
    return;
  }
  let msg;
  try { msg = JSON.parse(line); }
  catch (_) {
    failComHostProtocol(session, new Error('COM host emitted malformed JSON'));
    return;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || !Number.isSafeInteger(msg.id)) {
    failComHostProtocol(session, new Error('COM host emitted an invalid protocol message'));
    return;
  }
  if (msg.id === 0) {
    if (session.readyMessageReceived || session.readySettled || session.wasReady) {
      failComHostProtocol(session, new Error('COM host emitted a duplicate ready message'));
      return;
    }
    if (msg.ok !== true) {
      beginComHostRetirement(session, new Error(msg.error || 'COM host failed to start'), true);
      return;
    }
    if (!validComHostPid(msg.psPid) ||
        (validComHostPid(session.proc.pid) && msg.psPid !== session.proc.pid) ||
        (msg.powerpointPid !== null && msg.powerpointPid !== undefined &&
         (!validComHostPid(msg.powerpointPid) || msg.powerpointPid === msg.psPid))) {
      failComHostProtocol(session, new Error('COM host reported invalid process identity'));
      return;
    }
    session.readyMessageReceived = true;
    session.psPid = msg.psPid;
    session.powerpointPid = msg.powerpointPid || null;
    // Persist the tentative secondary PID before the asynchronous CIM lookup.
    // If this server is hard-killed during that lookup, the next boot can
    // validate its executable and creation window instead of losing the only
    // record of a PowerPoint process this generation may own.
    if (!saveComHostMarker(session)) {
      beginComHostRetirement(session, new Error('Could not persist COM host process identity'), true);
      return;
    }
    session.readyIdentityPromise = (async () => {
      if (validComHostPid(session.powerpointPid)) {
        const identity = await queryWindowsProcess(session.powerpointPid);
        if (!identity.exists || !/^powerpnt\.exe$/i.test(identity.name) ||
            Math.abs(identity.startedAt - session.startedAt) > 2 * 60 * 1000) {
          throw new Error('COM host reported a PowerPoint PID with the wrong process identity');
        }
        session.powerpointStartedAt = identity.startedAt;
      }
    })();
    session.readyIdentityPromise.then(() => {
      if (!session.active || session.retiring) return;
      if (!saveComHostMarker(session)) {
        beginComHostRetirement(session, new Error('Could not persist COM host process identity'), true);
        return;
      }
      settleComHostReady(session, null);
    }, (error) => {
      if (session.active && !session.retiring) {
        beginComHostRetirement(session, error, true);
      }
    });
    return;
  }
  if (!session.wasReady || msg.id <= 0 || typeof msg.ok !== 'boolean') {
    failComHostProtocol(session, new Error('COM host emitted an out-of-sequence job message'));
    return;
  }
  const pending = session.pending.get(msg.id);
  if (!pending) {
    failComHostProtocol(session, new Error('COM host emitted a reply for an unknown job'));
    return;
  }
  session.pending.delete(msg.id);
  msg.ok ? pending.resolve(msg) : pending.reject(new Error(msg.error || 'job failed'));
}

function launchComHostSession() {
  const token = crypto.randomBytes(16).toString('hex');
  let proc;
  try {
    proc = spawn('powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', COM_HOST_PS1,
       '--suite-com-host-token', token],
      { cwd: HERE, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    return Promise.reject(error);
  }

  const session = {
    generation: ++comHostGeneration,
    token,
    proc,
    psPid: validComHostPid(proc.pid) ? proc.pid : null,
    powerpointPid: null,
    powerpointStartedAt: null,
    startedAt: Date.now(),
    stdout: '',
    stderr: '',
    pending: new Map(),
    active: true,
    retiring: false,
    retireReason: null,
    readySettled: false,
    readyMessageReceived: false,
    wasReady: false,
    killIssued: false,
    exitHandling: false,
    readyTimer: null,
    killSettleTimer: null,
    resolveReady: null,
    rejectReady: null,
    resolveRetired: null,
    readyIdentityPromise: null,
  };
  session.readyPromise = new Promise((resolve, reject) => {
    session.resolveReady = resolve;
    session.rejectReady = reject;
  });
  session.retiredPromise = new Promise((resolve) => { session.resolveRetired = resolve; });
  comHostSession = session;

  const streamError = (label) => (error) => {
    failComHostProtocol(session, new Error(`COM host ${label} error: ${error && error.message ? error.message : error}`));
  };

  if (!proc.stdout || !proc.stderr || !proc.stdin) {
    beginComHostRetirement(session, new Error('COM host did not provide all stdio streams'), true);
  } else {
    proc.stdout.on('data', (chunk) => {
      if (!session.active || session.retiring) return;
      session.stdout += chunk.toString();
      let newline;
      while ((newline = session.stdout.indexOf('\n')) >= 0) {
        const line = session.stdout.slice(0, newline);
        session.stdout = session.stdout.slice(newline + 1);
        handleComHostLine(session, line);
        if (!session.active || session.retiring) return;
      }
      if (session.stdout.length > COM_HOST_STDOUT_FRAME_LIMIT) {
        failComHostProtocol(session, new Error('COM host stdout frame exceeded limit'));
      }
    });
    proc.stderr.on('data', (chunk) => {
      if (!session.active) return;
      session.stderr = boundedComHostText(session.stderr, chunk, COM_HOST_STDERR_LIMIT);
    });
    proc.stdout.on('error', streamError('stdout'));
    proc.stderr.on('error', streamError('stderr'));
    proc.stdin.on('error', streamError('stdin'));
  }

  proc.on('error', streamError('process'));
  const exited = () => {
    if (!session.active || session.exitHandling) return;
    session.exitHandling = true;
    const wasReady = session.wasReady;
    const unexpected = !session.retiring && !comHostShuttingDown;
    const error = session.retireReason ||
      new Error(`COM host exited${wasReady ? '' : ' before ready'}: ${session.stderr.slice(-300)}`);
    session.retiring = true;
    session.retireReason = error;
    rejectComHostPending(session, error);
    clearTimeout(session.killSettleTimer);
    session.killSettleTimer = setTimeout(
      () => finalizeComHostSession(session, error, false),
      COM_HOST_KILL_SETTLE_MS
    );
    (async () => {
      if (session.readyIdentityPromise) {
        try { await session.readyIdentityPromise; } catch (_) {}
      }
      const powerpointClean = await terminateRecordedPowerPoint(
        session.powerpointPid, session.powerpointStartedAt
      );
      if (!session.active) return; // stale async completion cannot touch N+1
      finalizeComHostSession(session, error, powerpointClean);
      if (unexpected && wasReady && powerpointClean) {
        console.error('COM host exited unexpectedly, will restart lazily on next thumbs job');
      }
    })().catch(() => {
      if (session.active) finalizeComHostSession(session, error, false);
    });
  };
  proc.once('exit', exited);
  proc.once('close', exited);

  // Record the PowerShell PID immediately, not only after COM is ready. A
  // startup hang followed by a hard server kill is otherwise unsweepable.
  if (validComHostPid(proc.pid) && !saveComHostMarker(session)) {
    beginComHostRetirement(session, new Error('Could not persist COM host process identity'), true);
  }
  session.readyTimer = setTimeout(() => {
    if (!session.active || session.readySettled) return;
    const detail = session.stderr.slice(-300);
    beginComHostRetirement(session,
      new Error(`COM host ready timeout (${COM_HOST_READY_TIMEOUT_MS}ms): ${detail}`), true);
  }, COM_HOST_READY_TIMEOUT_MS);
  return session.readyPromise;
}

function startComHost() {
  if (!IS_WIN) return Promise.reject(new Error('COM host needs Windows'));
  if (comHostShuttingDown) return Promise.reject(new Error('COM host is shutting down'));
  if (comHostBlockedError) return Promise.reject(comHostBlockedError);
  if (comHostSession) {
    if (comHostSession.retiring) {
      return comHostSession.retiredPromise.then(() => startComHost());
    }
    return comHostSession.readyPromise;
  }
  if (comHostStartPromise) return comHostStartPromise;

  if (!comHostSweepPromise) comHostSweepPromise = Promise.resolve().then(sweepStaleComHost);
  const starting = comHostSweepPromise.then(() => {
    if (comHostShuttingDown) throw new Error('COM host is shutting down');
    if (comHostBlockedError) throw comHostBlockedError;
    return comHostSession ? startComHost() : launchComHostSession();
  });
  comHostStartPromise = starting;
  starting.then(
    () => { if (comHostStartPromise === starting) comHostStartPromise = null; },
    () => { if (comHostStartPromise === starting) comHostStartPromise = null; }
  );
  return starting;
}

async function comHostJob(src, outDir, width, slideNumbers) {
  const session = await startComHost();
  if (!session.active || session.retiring || comHostSession !== session ||
      !session.proc.stdin || !session.proc.stdin.writable) {
    const error = new Error('COM host not writable');
    await beginComHostRetirement(session, error, true);
    throw error;
  }
  return new Promise((resolve, reject) => {
    const id = comHostNextId++;
    const pending = {
      settled: false,
      timer: null,
      resolve: (msg) => {
        if (pending.settled) return;
        pending.settled = true;
        clearTimeout(pending.timer);
        resolve(msg);
      },
      reject: (error) => {
        if (pending.settled) return;
        pending.settled = true;
        clearTimeout(pending.timer);
        reject(error);
      },
    };
    pending.timer = setTimeout(() => {
      if (pending.settled) return;
      session.pending.delete(id);
      const error = new Error(`COM host job timeout (${COM_HOST_JOB_TIMEOUT_MS}ms)`);
      // A timed-out PowerPoint call can leave the single-threaded host
      // permanently wedged. Retire it before any later job is allowed to retry.
      beginComHostRetirement(session, error, true).then(() => pending.reject(error));
    }, COM_HOST_JOB_TIMEOUT_MS);
    session.pending.set(id, pending);
    const payload = JSON.stringify({
      id, cmd: 'thumbs', src, outDir, width, slides: slideNumbers,
    }) + '\n';
    try {
      session.proc.stdin.write(payload, (error) => {
        if (!error || pending.settled) return;
        session.pending.delete(id);
        beginComHostRetirement(
          session, new Error(`COM host stdin write failed: ${error.message}`), true
        ).then(() => pending.reject(error));
      });
    } catch (error) {
      session.pending.delete(id);
      beginComHostRetirement(
        session, new Error(`COM host stdin write failed: ${error.message}`), true
      ).then(() => pending.reject(error));
    }
  });
}

async function stopComHost() {
  comHostShuttingDown = true;
  if (!comHostSession && comHostStartPromise) {
    try { await comHostStartPromise; } catch (_) {}
  }
  const session = comHostSession;
  if (!session) return;
  const shutdownError = new Error('COM host is shutting down');
  session.retiring = true;
  session.retireReason = shutdownError;
  rejectComHostPending(session, shutdownError);
  try {
    if (!session.proc.stdin || !session.proc.stdin.writable) throw new Error('stdin is not writable');
    session.proc.stdin.write('quit\n', (error) => {
      if (error) beginComHostRetirement(session, shutdownError, true);
    });
  } catch (_) {
    beginComHostRetirement(session, shutdownError, true);
  }
  await Promise.race([
    session.retiredPromise,
    new Promise((resolve) => setTimeout(resolve, COM_HOST_STOP_TIMEOUT_MS)),
  ]);
  if (session.active) {
    // Graceful quit did not land in time: target this generation's exact
    // process tree and uniquely identified PowerPoint PID.
    beginComHostRetirement(session, shutdownError, true);
    await session.retiredPromise;
  }
}

// ------------------------------------------------------------------- render
let renderTimer = null;
let rendering = false;
let renderAgain = false;
// dirtySlides / dirtyAll track which slides actually changed since the last
// successful thumbnail export, so the COM host can export just those instead
// of the whole deck. Structural ops (slide added/removed/reordered/relaid
// out) and undo/redo can shift what slide N even means, so those mark
// dirtyAll instead of trying to diff two arbitrary snapshots.
let dirtySlides = new Set();
let dirtyAll = true; // first render after boot always exports everything
// add-slide DOES carry affected.slideId (the new slide), but inserting or
// removing a slide shifts the PNG numbering of every slide after it, so
// these ops must force dirtyAll regardless of what `affected` says.
const STRUCTURAL_OPS = new Set(['add-slide', 'delete-slide', 'move-slide', 'set-layout', 'set-theme', 'set-presentation-title']);
function markDirty(opType, affected) {
  if (STRUCTURAL_OPS.has(opType)) { dirtyAll = true; return; }
  if (affected && affected.slideId) { dirtySlides.add(affected.slideId); return; }
  dirtyAll = true; // unrecognized op or unknown affected shape: stay conservative
}
// firstDirtyAt anchors a hard ceiling on top of the trailing debounce below:
// under a steady stream of edits (multiple agents editing faster than the
// 600ms debounce settles) the debounce alone would reset on every edit and
// never fire, freezing the view indefinitely. RENDER_MAX_WAIT_MS guarantees
// a render happens at least that often even while edits keep arriving.
let firstDirtyAt = null;
const RENDER_DEBOUNCE_MS = 600;
const RENDER_MAX_WAIT_MS = 2000;

function scheduleRender() {
  if (state.paused) return;
  if (renderTimer) clearTimeout(renderTimer);
  const now = Date.now();
  if (firstDirtyAt === null) firstDirtyAt = now;
  const delay = Math.max(0, Math.min(RENDER_DEBOUNCE_MS, RENDER_MAX_WAIT_MS - (now - firstDirtyAt)));
  renderTimer = setTimeout(runRender, delay);
}

async function runRender() {
  renderTimer = null;
  if (state.paused) return;
  if (rendering) { renderAgain = true; return; }
  rendering = true;
  firstDirtyAt = null;
  const capturedRev = model.rev; // the rev THIS render's pixels will represent, even if edits keep arriving during it
  const stagedPptx = path.join(
    ROOT,
    `.presentation-${process.pid}-${capturedRev}-${crypto.randomBytes(4).toString('hex')}.pptx`
  );
  // Pipe the model through stdin ('-') so python never opens model.json.
  // PYTHONUTF8=1 guarantees the pipe is decoded as UTF-8 on Windows.
  const snapshotJson = JSON.stringify(model);
  const rendered = await runCapturedProcess(
    PY, [RENDER_PY, '-', stagedPptx],
    { cwd: HERE, env: Object.assign({}, process.env, { PYTHONUTF8: '1' }), windowsHide: true },
    snapshotJson, 60000
  );
  let ok = rendered.ok;
  let error = rendered.error || '';
  let published = false;
  let superseded = false;
  if (ok) {
    if (state.paused) {
      ok = false;
      error = 'pause completed before this render could be published';
    } else if (capturedRev !== model.rev) {
      // A newer edit committed while Python worked. Publishing this stage
      // gives old content a new mtime and can fool crash recovery, so discard
      // it and immediately render the newest snapshot.
      superseded = true;
      renderAgain = true;
    } else {
      try {
        await queuePauseTransition(async () => {
          // Rendering happens entirely in a private file, so there is no reason
          // to weaken the pause lock while Python is working. Publication uses
          // the exact same FIFO as pause/resume: this prevents a late re-lock
          // from racing a queued resume, and prevents a pause from interleaving
          // between the final gate check and the synchronous artifact commits.
          if (state.paused) throw new Error('pause completed before this render could be published');
          if (capturedRev !== model.rev) {
            superseded = true;
            renderAgain = true;
            return;
          }
          const deckExisted = fs.existsSync(PPTX_PATH);
          const unlocked = await setReadOnly(PPTX_PATH, false);
          if (deckExisted && !unlocked) {
            throw new Error('could not unlock presentation.pptx for atomic publication');
          }
          if (state.paused) throw new Error('pause completed before this render could be published');
          if (capturedRev !== model.rev) {
            superseded = true;
            renderAgain = true;
            return;
          }
          commitStagedPptx(stagedPptx);
          if (!persistRenderMarker(capturedRev)) throw new Error('could not save the render revision marker');
          published = true;
        });
      } catch (commitError) {
        ok = false;
        error = String(commitError && (commitError.message || commitError));
      }
    }
  }
  try { fs.unlinkSync(stagedPptx); } catch (_) {}
  rendering = false;
  if (superseded) {
    broadcast({ type: 'render-superseded', rev: capturedRev, currentRev: model.rev, ts: Date.now() });
  } else {
    if (!ok) console.error('render failed:', error.slice(0, 600));
    broadcast({ type: 'render', ok, rev: capturedRev, error: ok ? null : error.slice(0, 600), ts: Date.now() });
  }
  if (published) {
    // Snapshot into THUMBS_SRC before exporting: the COM host may still be
    // mid-export from a previous render and PowerPoint must see stable bytes.
    await refreshThumbsFromDeck(capturedRev, 'thumbs snapshot copy failed, skipping this thumbs pass:');
  }
  if (renderAgain) {
    renderAgain = false;
    runRender(); // direct: don't re-open a starvable debounce window
  }
}

// ---- true slide thumbnails via PowerPoint COM (best-effort; dashboard falls
// ---- back to the positioned CSS view when thumbnails are unavailable)
let thumbsVer = 0;
let thumbsRunning = false;
let thumbsAgain = false;
let thumbsAgainRev = null;
// PDF export (below) spawns its OWN separate powershell+PowerPoint against
// the same live presentation.pptx, entirely independent of the persistent
// COM host and its snapshot-copy protection. Two PowerPoint processes
// opening the same file at once is a real race (0x80CB4001), the exact
// failure the thumbs snapshot-copy exists to avoid, which PDF export never
// got since it opens PPTX_PATH directly. pdfRunning lets the two paths defer
// to each other symmetrically, reusing the retry mechanism already proven
// correct for thumbsRunning below rather than inventing a new one.
let pdfRunning = false;

function slideIdToNumber(id) {
  const i = model.slides.findIndex((s) => s.id === id);
  return i < 0 ? null : i + 1; // PNG numbering follows model.slides array order, 1-indexed
}

// Legacy path: spawn a fresh powershell + fresh COM instance, full deck only
// (ignores dirty-slide targeting). This is the pre-COM-host behavior, kept
// as a fallback so a COM host problem makes thumbnails slow again instead of
// broken outright.
function legacyExportThumbs() {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', THUMBS_PS1,
      '-Path', THUMBS_SRC, '-OutDir', THUMBS_DIR, '-Width', '1100', '-KeepAlive'
    ], { cwd: HERE, windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { err += String(e); });
    // Same fix as runRender's spawn: no built-in timeout on spawn(), and a
    // hung child here leaves thumbsRunning stuck true forever (runThumbs's
    // own re-entrancy guard), permanently blocking every future thumbs
    // export, not just this one.
    const killTimer = setTimeout(() => { try { child.kill(); } catch (_) {} }, 60000);
    child.on('close', (code) => {
      clearTimeout(killTimer);
      code === 0 ? resolve() : reject(new Error(err.slice(0, 400) || `exit ${code}`));
    });
  });
}

// Both export paths (the persistent COM host and the legacy PowerShell
// fallback) write slide-1.png .. slide-N.png for N = the CURRENT slide
// count, overwriting in place; neither ever deletes anything. delete-slide
// shrinking the deck from, say, 20 slides to 16 leaves slide-17..20.png
// sitting in data/thumbs forever: nothing ever reads them again (the
// dashboard only ever requests indices up to the current model.slides
// .length), so this is pure disk-space cruft, not a display bug, but
// unbounded and permanent for as long as the folder exists.
function cleanupOrphanedThumbs() {
  let entries;
  try { entries = fs.readdirSync(THUMBS_DIR); } catch (_) { return; }
  const maxSlide = model.slides.length;
  for (const name of entries) {
    const m = /^slide-(\d+)\.png$/.exec(name);
    if (m && Number(m[1]) > maxSlide) {
      try { fs.unlinkSync(path.join(THUMBS_DIR, name)); } catch (_) {}
    }
  }
}

function runThumbs(capturedRev) {
  if (IS_WIN !== true) return;
  if (thumbsRunning || pdfRunning) { thumbsAgain = true; thumbsAgainRev = capturedRev; return; }
  thumbsRunning = true;

  // A deferred newer render can share an id with the pass already running;
  // that first pass clears the id before this one starts. In that case the COM
  // host already treats [] as a full export, so the SSE event must use the
  // same full-deck meaning or viewers will never refresh their image URLs.
  const exportAll = dirtyAll || dirtySlides.size === 0;
  const attemptedIds = exportAll ? null : new Set(dirtySlides);
  const slideNumbers = exportAll ? [] : Array.from(attemptedIds).map(slideIdToNumber).filter((n) => n !== null);

  const finish = (ok, error) => {
    thumbsRunning = false;
    if (ok) {
      thumbsVer++;
      cleanupOrphanedThumbs();
      if (exportAll) dirtyAll = false; else attemptedIds.forEach((id) => dirtySlides.delete(id));
      broadcast({ type: 'thumbs', ok: true, ver: thumbsVer, rev: capturedRev, slides: exportAll ? null : Array.from(attemptedIds), ts: Date.now() });
    } else {
      // Loud on purpose: this used to be console.error-only with no
      // broadcast, so a failed export left stale thumbnails with nothing
      // telling anyone. Deliberately do NOT clear dirty tracking here, so
      // whatever just failed to export stays marked dirty for the retry.
      console.error('thumbnail export failed:', error);
      broadcast({ type: 'thumbs', ok: false, rev: capturedRev, error: String(error).slice(0, 400), ts: Date.now() });
    }
    if (thumbsAgain) { thumbsAgain = false; const r = thumbsAgainRev; thumbsAgainRev = null; runThumbs(r); }
  };

  comHostJob(THUMBS_SRC, THUMBS_DIR, 1100, slideNumbers)
    .then(() => finish(true))
    .catch((hostErr) => {
      console.error('COM host thumbs failed, falling back to a fresh PowerPoint instance for this pass:', hostErr && hostErr.message);
      legacyExportThumbs()
        .then(() => finish(true))
        .catch((legacyErr) => finish(false, (legacyErr && legacyErr.message) || legacyErr));
    });
}

// ---- on-demand PDF export via the same PowerPoint COM approach as thumbs.
// Each request captures the model revision and renders a private source PPTX
// first. Opening presentation.pptx used to race the normal renderer, and one
// global promise let rev N+1 incorrectly reuse and label rev N's export.
// PowerPoint jobs are serialized; only requests for the exact same revision
// share an in-flight job.
let pdfVer = 0;
let pdfExportTail = Promise.resolve();
const pdfExportsByRev = new Map();

function runCapturedProcess(command, args, options, stdinText, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    let stderr = '';
    let settled = false;
    let timer = null;
    let terminationTimer = null;
    let timedOut = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (terminationTimer) clearTimeout(terminationTimer);
      resolve(result);
    };
    // Always drain both streams. An unread stdout pipe can fill and deadlock
    // even when the parent only cares about the exit code.
    if (child.stdout) child.stdout.on('data', () => {});
    if (child.stderr) child.stderr.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString().slice(0, 64 * 1024 - stderr.length);
    });
    child.on('error', (error) => finish({ ok: false, error: String(error) }));
    child.on('close', (code, signal) => {
      const suffix = signal ? ` (signal ${signal})` : '';
      finish({
        ok: !timedOut && code === 0,
        error: timedOut ? stderr.trim() : (code === 0 ? '' : (stderr || `exit ${code}${suffix}`))
      });
    });
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(stdinText === undefined ? undefined : stdinText);
    }
    timer = setTimeout(() => {
      timedOut = true;
      stderr = (stderr + `\nprocess timed out after ${timeoutMs}ms`).slice(0, 64 * 1024);
      if (IS_WIN && child.pid) {
        // Kill the exact process tree, never a blanket python/PowerPoint kill.
        // A COM-created PowerPoint process may be a child of PowerShell.
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      } else {
        try { child.kill('SIGKILL'); } catch (_) {}
      }
      // close is the normal completion signal. Keep a bounded final escape
      // hatch for a broken OS process table; PDF jobs use unique output paths,
      // so even this worst case can never overwrite the canonical PDF later.
      terminationTimer = setTimeout(
        () => finish({ ok: false, error: stderr.trim() + '\nchild did not confirm termination' }),
        10000
      );
    }, timeoutMs);
  });
}

async function exportPdfSnapshot(snapshotJson, capturedRev) {
  const token = `${process.pid}-${capturedRev}-${crypto.randomBytes(5).toString('hex')}`;
  const snapshotPptx = path.join(DATA, `.pdf-source-${token}.pptx`);
  const snapshotPdf = path.join(DATA, `.pdf-output-${token}.pdf`);
  let result = { ok: false, error: 'PDF export failed', rev: capturedRev };
  try {
    pdfRunning = true;
    const deadline = Date.now() + 15000;
    while (thumbsRunning && Date.now() < deadline) await new Promise((r) => setTimeout(r, 150));

    const rendered = await runCapturedProcess(
      PY, [RENDER_PY, '-', snapshotPptx],
      { cwd: HERE, env: Object.assign({}, process.env, { PYTHONUTF8: '1' }), windowsHide: true },
      snapshotJson, 60000
    );
    if (!rendered.ok) throw new Error(`snapshot render failed: ${rendered.error}`);
    const pptxHead = Buffer.alloc(2);
    const pptxFd = fs.openSync(snapshotPptx, 'r');
    try { fs.readSync(pptxFd, pptxHead, 0, 2, 0); } finally { fs.closeSync(pptxFd); }
    if (pptxHead.toString('ascii') !== 'PK') throw new Error('snapshot renderer did not produce a valid PPTX container');

    // The PowerShell helper stages and atomically replaces its destination.
    const exported = await runCapturedProcess(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PDF_PS1,
       '-Path', snapshotPptx, '-OutPath', snapshotPdf],
      { cwd: HERE, windowsHide: true },
      undefined, 60000
    );
    if (!exported.ok) throw new Error(exported.error || 'PowerPoint PDF export failed');
    const pdfHead = Buffer.alloc(5);
    const pdfFd = fs.openSync(snapshotPdf, 'r');
    try { fs.readSync(pdfFd, pdfHead, 0, 5, 0); } finally { fs.closeSync(pdfFd); }
    if (pdfHead.toString('ascii') !== '%PDF-') throw new Error('PowerPoint did not produce a valid PDF');
    let publishError = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      try { fs.renameSync(snapshotPdf, PDF_PATH); publishError = null; break; }
      catch (error) { publishError = error; sleepMs(20 * (attempt + 1)); }
    }
    if (publishError) throw publishError;

    // Mark the file current only after the matching revision is durable. A
    // failed state write deliberately leaves the old pdfRev visible as stale.
    const next = copyState();
    next.pdfRev = capturedRev;
    if (!persistState(next)) throw new Error('PDF was written but its revision could not be saved');
    state = next;
    pdfVer++;
    result = { ok: true, error: null, rev: capturedRev };
  } catch (error) {
    const message = String(error && (error.message || error)).slice(0, 400);
    console.error('pdf export failed:', message);
    result = { ok: false, error: message, rev: capturedRev };
  } finally {
    try { fs.unlinkSync(snapshotPptx); } catch (_) {}
    try { fs.unlinkSync(snapshotPdf); } catch (_) {}
    pdfRunning = false;
    broadcast({
      type: 'pdf', ok: result.ok, ver: pdfVer, rev: state.pdfRev,
      error: result.ok ? null : result.error, ts: Date.now()
    });
    if (thumbsAgain) {
      thumbsAgain = false;
      const rev = thumbsAgainRev;
      thumbsAgainRev = null;
      runThumbs(rev);
    }
  }
  return result;
}

function runPdfExport() {
  if (!IS_WIN) return Promise.resolve({ ok: false, error: 'PDF export needs Windows + PowerPoint (PowerShell/COM)' });
  const capturedRev = model.rev;
  const existing = pdfExportsByRev.get(capturedRev);
  if (existing) return existing;
  const snapshotJson = JSON.stringify(model);
  const job = pdfExportTail.then(() => exportPdfSnapshot(snapshotJson, capturedRev));
  pdfExportTail = job.catch(() => {});
  pdfExportsByRev.set(capturedRev, job);
  job.finally(() => {
    if (pdfExportsByRev.get(capturedRev) === job) pdfExportsByRev.delete(capturedRev);
  });
  return job;
}

// -------------------------------------------------------------- edit engine
function findSlide(id) { return model.slides.find((s) => s.id === id); }
function findElement(slide, id) { return slide && slide.elements.find((e) => e.id === id); }

// ---------------------------------------------------------- house-rule lint
// A deterministic scan of the live model against the four structural house
// rules that recur on the board every pass (no em/en dashes, 20pt floor,
// headers aligned to one side, no speaker notes). Agents used to re-derive
// this by hand from rendered XML; this makes it one command. Not exhaustive
// (color/branding and wording rules still need human judgment), but it
// catches the mechanical violations that were being caught by eye.
const DASH_RE = /[–—]/; // en dash, em dash
const LINT_MIN_SIZE = 20;

function lintModel(m) {
  const issues = [];
  const flagDash = (slideId, elementId, field, text) => {
    const s = String(text == null ? '' : text);
    const hit = s.match(DASH_RE);
    if (hit) issues.push({ type: 'dash', slideId, elementId, field, detail: `contains "${hit[0]}"`, text: trunc(s) });
  };

  const headers = []; // size>=28, non-centered text — the slide-title convention
  for (const slide of m.slides) {
    if (String(slide.notes || '').trim()) {
      issues.push({ type: 'speaker-notes', slideId: slide.id, elementId: null, field: 'notes',
        detail: 'non-empty speaker notes (house rule: no speaker notes)', text: trunc(slide.notes) });
    }
    flagDash(slide.id, null, 'notes', slide.notes);
    for (const el of (slide.elements || [])) {
      const texts = Array.isArray(el.items) ? el.items : [el.text];
      texts.forEach((t, i) => flagDash(slide.id, el.id, Array.isArray(el.items) ? `items[${i}]` : 'text', t));
      const st = el.style || {};
      if (typeof st.size === 'number' && st.size < LINT_MIN_SIZE) {
        issues.push({ type: 'min-size', slideId: slide.id, elementId: el.id, field: 'style.size',
          detail: `${st.size}pt is under the ${LINT_MIN_SIZE}pt floor` });
      }
      if (typeof st.size === 'number' && st.size >= 28 && st.align !== 'center') {
        headers.push({ slideId: slide.id, elementId: el.id, align: st.align || 'left' });
      }
    }
  }

  if (headers.length > 1) {
    const counts = {};
    for (const h of headers) counts[h.align] = (counts[h.align] || 0) + 1;
    const majority = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    for (const h of headers) {
      if (h.align !== majority) {
        issues.push({ type: 'header-align', slideId: h.slideId, elementId: h.elementId, field: 'style.align',
          detail: `header aligned "${h.align}", ${counts[majority]}/${headers.length} other headers are "${majority}"` });
      }
    }
  }

  return { rev: m.rev, ok: issues.length === 0, count: issues.length, issues };
}

// Font-family half of the lint sweep. Split out from lintModel() because it
// needs the actual rendered presentation.pptx, not just the model: imported
// overlay elements do not carry every inherited run font (an explicit
// set-font edit is the exception), so "one font family across the deck"
// cannot be proven from model.json. Reads effective runs via lint_fonts.py
// and flags whichever runs use a minority font, same majority-wins pattern
// as the header-align check above. Operational failures are returned as lint
// issues: reporting a clean deck when the checker never ran is dangerously
// indistinguishable from a real pass.
function lintFonts(m) {
  return new Promise((resolve) => {
    const failure = (detail) => [{
      type: 'font-lint-error', slideId: null, elementId: null,
      field: 'font', detail: String(detail).slice(0, 400)
    }];
    if (!fs.existsSync(PPTX_PATH)) return resolve(failure('presentation.pptx is missing; font lint did not run'));
    // timeout: matches backfillDecorSids' fix. Without it a hung python
    // process here doesn't just fail this call (already handled below, per
    // this function's own "never throws" comment), it hangs the whole
    // GET /api/lint request forever with no response, the callback that
    // would resolve this promise simply never fires.
    execFile(PY, [LINT_FONTS_PY, PPTX_PATH], { cwd: HERE, maxBuffer: 20 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
      if (err) {
        console.error('font lint failed:', err.message);
        return resolve(failure(`font lint failed: ${err.message}`));
      }
      let data;
      try { data = JSON.parse(stdout); }
      catch (e) {
        console.error('font lint: bad JSON from helper');
        return resolve(failure('font lint returned malformed output'));
      }
      if (!data || !Array.isArray(data.runs)) return resolve(failure('font lint returned an invalid result'));
      const runs = Array.isArray(data.runs) ? data.runs : [];
      const coverageIssues = [];
      if (data.coverage && data.coverage.complete === false) {
        const unresolved = Number(data.coverage.unresolved) || 0;
        const total = Number(data.coverage.total) || (runs.length + unresolved);
        const sample = Array.isArray(data.coverage.unresolvedRuns) && data.coverage.unresolvedRuns[0];
        coverageIssues.push({
          type: 'font-lint-coverage',
          slideId: sample && m.slides[sample.slide] ? m.slides[sample.slide].id : null,
          elementId: null,
          field: 'font',
          detail: `${unresolved}/${total} text runs inherit a font the checker could not resolve; font lint is incomplete`
        });
      }
      if (!runs.length) return resolve(coverageIssues);
      // Map, not a plain object: unlike header-align's own counts a few lines
      // up (keyed only by 'left'/'center'/'right'/'justify', already
      // validated at set-align's own boundary), r.font here is whatever
      // string python-pptx read out of the real pptx XML, completely
      // unconstrained. A font literally named "constructor" would silently
      // corrupt the count into a string via Object.prototype.constructor
      // (counts[b]-counts[a] then compares NaN, majority becomes
      // unpredictable), and "__proto__" would vanish entirely (the accessor
      // setter silently no-ops on a non-object assignment, so it never
      // becomes an own, enumerable key Object.keys() can see). Map.set/.get
      // only ever sees exactly what was stored, immune to the whole class.
      const counts = new Map();
      for (const r of runs) counts.set(r.font, (counts.get(r.font) || 0) + 1);
      const majority = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a))[0];
      const issues = [];
      for (const r of runs) {
        if (r.font === majority) continue;
        const slide = m.slides[r.slide];
        issues.push({
          type: 'font-family', slideId: slide ? slide.id : `pptx-slide-${r.slide + 1}`, elementId: null,
          field: 'font', detail: `uses "${r.font}", ${counts.get(majority)}/${runs.length} other runs use "${majority}"`,
          text: r.text,
        });
      }
      resolve(coverageIssues.concat(issues));
    });
  });
}

async function fullLint(m) {
  const base = lintModel(m);
  const fontIssues = await lintFonts(m);
  if (!fontIssues.length) return base;
  const issues = base.issues.concat(fontIssues);
  return { rev: base.rev, ok: issues.length === 0, count: issues.length, issues };
}

// Scoped version of the same checks for exactly the element/notes an op just
// touched, so /api/edit can hand back instant feedback on the edit that just
// happened instead of waiting for the next full `ppt lint` pass. Returns short
// detail strings (not full issue objects) meant to fold into the existing
// advisory `warning` field alongside the lock-collision warning.
function lintAffected(affected) {
  const msgs = [];
  if (!affected || !affected.slideId) return msgs;
  const slide = findSlide(affected.slideId);
  if (!slide) return msgs;
  if (affected.elementId) {
    const el = findElement(slide, affected.elementId);
    if (el) {
      const texts = Array.isArray(el.items) ? el.items : [el.text];
      for (const t of texts) {
        const hit = String(t == null ? '' : t).match(DASH_RE);
        if (hit) { msgs.push(`contains "${hit[0]}" (house rule: no em/en dashes)`); break; }
      }
      const st = el.style || {};
      if (typeof st.size === 'number' && st.size < LINT_MIN_SIZE) {
        msgs.push(`${st.size}pt is under the ${LINT_MIN_SIZE}pt floor`);
      }
    }
  }
  if (affected.notes) {
    const s = String(slide.notes || '');
    if (s.trim()) msgs.push('non-empty speaker notes (house rule: no speaker notes)');
    if (DASH_RE.test(s)) msgs.push('notes contain an em/en dash');
  }
  return msgs;
}

// ------------------------------------------------------------ timing estimate
// The 12-minute hard cap is a pinned house rule, but the old tooling for it
// (summing [~Ns] tags in speaker notes) went dead the moment "no speaker
// notes" emptied every note. This is a rough replacement proxy: count words
// in each slide's visible text (title/body/bullets) and estimate seconds at a
// conservative conference pace. It is NOT a substitute for a real rehearsal
// (a speaker elaborates well beyond what's printed on the slide), just a
// sanity check against wild overflow.
const TIMING_WPM = 135;
const TIMING_TARGET_S = 11 * 60;   // house rule: keep near 11:00 for headroom
const TIMING_CAP_S = 12 * 60;      // house rule: hard 12-minute cap

function estimateTiming(m) {
  const perSlide = m.slides.map((slide) => {
    let words = 0;
    for (const el of (slide.elements || [])) {
      const texts = Array.isArray(el.items) ? el.items : [el.text];
      for (const t of texts) {
        const s = String(t == null ? '' : t).trim();
        if (s) words += s.split(/\s+/).length;
      }
    }
    return { slideId: slide.id, words, seconds: Math.round(words / TIMING_WPM * 60) };
  });
  const totalWords = perSlide.reduce((n, s) => n + s.words, 0);
  const totalSeconds = perSlide.reduce((n, s) => n + s.seconds, 0);
  return {
    wpm: TIMING_WPM, targetSeconds: TIMING_TARGET_S, capSeconds: TIMING_CAP_S,
    totalWords, totalSeconds, perSlide,
    overTarget: totalSeconds > TIMING_TARGET_S, overCap: totalSeconds > TIMING_CAP_S
  };
}

function defaultElements(layout) {
  switch (layout) {
    case 'title':    return [{ id: shortId('e'), type: 'title', text: '' },
                             { id: shortId('e'), type: 'subtitle', text: '' }];
    case 'section':  return [{ id: shortId('e'), type: 'title', text: '' }];
    case 'titleonly':return [{ id: shortId('e'), type: 'title', text: '' }];
    case 'blank':    return [];
    case 'content':
    case 'bullets':
    default:         return [{ id: shortId('e'), type: 'title', text: '' },
                             { id: shortId('e'), type: 'bullets', items: [] }];
  }
}

const NATIVE_LAYOUTS = new Set(['title', 'content', 'bullets', 'section', 'titleonly', 'blank', 'two', 'compare']);
const ELEMENT_TYPES = new Set(['title', 'subtitle', 'heading', 'body', 'bullets']);

function generatedBoxError(box) {
  if (!isRecord(box)) return 'box must be an object';
  for (const key of ['x', 'y', 'w', 'h']) {
    const value = box[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return `${key} must be a finite number`;
    }
    if (value < 0 || value > 1) return `${key} must be between 0 and 1`;
    if ((key === 'w' || key === 'h') && value <= 0) return `${key} must be greater than 0`;
  }
  if (box.x + box.w > 1 || box.y + box.h > 1) {
    return 'the generated object must fit within the slide';
  }
  return null;
}

function uneditableElementReason(slide, element) {
  if (!element) return 'no such element';
  if (element.readonly) return 'that element is read-only';
  if ((model.mode || 'native') === 'overlay' && Number.isInteger(slide && slide.src) && !element.ref) {
    return 'that imported-slide element has no backing PowerPoint shape';
  }
  return null;
}

// Returns { ok, error?, affected }. Mutates `model` on success.
function applyOp(op) {
  if (!op || typeof op.type !== 'string') return { ok: false, error: 'missing op.type' };
  const t = op.type;

  if (t === 'set-presentation-title') {
    if (typeof op.text !== 'string') return { ok: false, error: 'text must be a string' };
    model.title = op.text;
    return { ok: true, affected: { scope: 'presentation' } };
  }

  if (t === 'add-slide') {
    // Same non-hashable-crashes-the-whole-render risk set-layout already
    // guards against (op.layout flows into the identical `key in LAYOUT_MAP`
    // Python dict-membership test in render_pptx.py's _layout_for()):
    // verified directly that an array/object layout here is silently
    // accepted, stored, and then blows up the ENTIRE render (not just this
    // slide) with `TypeError: unhashable type: 'list'`. Reject it here too,
    // unreachable via the CLI (which only ever sends strings) but not via a
    // raw POST /api/edit.
    if (op.layout !== undefined && typeof op.layout !== 'string') return { ok: false, error: 'layout must be a string' };
    const layout = op.layout || 'content';
    if (!NATIVE_LAYOUTS.has(layout)) return { ok: false, error: `unknown layout "${layout}"` };
    if (op.title !== undefined && typeof op.title !== 'string') return { ok: false, error: 'title must be a string' };
    const slide = { id: shortId('s'), layout, notes: '', elements: defaultElements(layout) };
    if (typeof op.title === 'string' && slide.elements[0] && slide.elements[0].type === 'title') {
      slide.elements[0].text = op.title;
    }
    // index/after are both optional (a bare add-slide correctly appends at
    // the end), but when EITHER is explicitly given it must resolve to
    // somewhere real: this used to silently fall through to the same
    // append-at-the-end default a bare add-slide gets, printing a clean
    // "added slide" success message with zero indication the target was
    // ignored (verified directly: add-slide --index abc, a mistyped
    // non-integer, and add-slide --after <a nonexistent slide id> both
    // silently landed the new slide at the very end of a 16-slide deck,
    // same as move-slide's own index field already errors clearly on).
    let idx = model.slides.length;
    if (op.index !== undefined) {
      if (!Number.isInteger(op.index)) return { ok: false, error: 'index must be an integer' };
      idx = Math.max(0, Math.min(op.index, model.slides.length));
    } else if (op.after !== undefined) {
      const a = model.slides.findIndex((s) => s.id === op.after);
      if (a < 0) return { ok: false, error: 'no such slide: ' + op.after };
      idx = a + 1;
    }
    model.slides.splice(idx, 0, slide);
    return { ok: true, affected: { slideId: slide.id }, newSlide: slide, index: idx };
  }

  if (t === 'delete-slide') {
    const i = model.slides.findIndex((s) => s.id === op.slideId);
    if (i < 0) return { ok: false, error: 'no such slide' };
    // A zero-slide deck isn't just an edge case nothing happens to render
    // cleanly: render_pptx.py genuinely produces a .pptx with zero slides
    // (verified directly, no exception either from render_pptx.py or from
    // python-pptx re-opening the result), a technically-valid but
    // completely degenerate file nothing downstream expects or can present.
    // Reject at the boundary instead, same as every other applyOp
    // validation gap closed this project (ppt undo would also roll a single
    // accidental delete straight back, this is about never landing in the
    // degenerate state at all, not about having no way out of it).
    if (model.slides.length <= 1) return { ok: false, error: 'cannot delete the last remaining slide' };
    model.slides.splice(i, 1);
    // The HTTP edit route deletes this lock only after the candidate model has
    // made it to disk. A failed persistence must leave both the old slide and
    // its advisory claim intact.
    const lockReleased = locks.has(op.slideId);
    return { ok: true, affected: { removedSlideId: op.slideId }, lockReleased };
  }

  if (t === 'move-slide') {
    const i = model.slides.findIndex((s) => s.id === op.slideId);
    if (i < 0) return { ok: false, error: 'no such slide' };
    if (!Number.isInteger(op.index)) return { ok: false, error: 'index must be an integer' };
    let j = Math.max(0, Math.min(op.index, model.slides.length - 1));
    const [s] = model.slides.splice(i, 1);
    model.slides.splice(j, 0, s);
    return { ok: true, affected: { slideId: op.slideId } };
  }

  if (t === 'set-layout') {
    const s = findSlide(op.slideId);
    if (!s) return { ok: false, error: 'no such slide' };
    // render_pptx.py's _layout_for() does `key in LAYOUT_MAP`, a dict
    // membership test: an unrecognized STRING falls through to a safe
    // default layout, but a non-string (e.g. an object/array from a raw
    // /api/edit call, unreachable via the CLI which only ever sends strings)
    // is unhashable in Python and raises TypeError, crashing every render
    // until the bad value is undone.
    if (typeof op.layout !== 'string') return { ok: false, error: 'layout must be a string' };
    if (!NATIVE_LAYOUTS.has(op.layout)) return { ok: false, error: `unknown layout "${op.layout}"` };
    if ((model.mode || 'native') === 'overlay' && Number.isInteger(s.src)) {
      return { ok: false, error: 'cannot change the layout of an imported slide; its layout comes from base.pptx' };
    }
    s.layout = op.layout;
    return { ok: true, affected: { slideId: s.id } };
  }

  if (t === 'set-transition') {
    const s = findSlide(op.slideId);
    if (!s) return { ok: false, error: 'no such slide' };
    if (!['fade', 'none'].includes(op.effect)) {
      return { ok: false, error: 'effect must be fade or none' };
    }
    if (op.effect === 'none') {
      if (op.duration !== undefined) {
        return { ok: false, error: 'duration is only valid for fade' };
      }
      s.transition = { effect: 'none' };
      return { ok: true, affected: { slideId: s.id } };
    }
    const duration = op.duration === undefined ? 0.35 : op.duration;
    if (typeof duration !== 'number' || !Number.isFinite(duration) ||
        duration < 0.1 || duration > 10) {
      return { ok: false, error: 'duration must be a finite number from 0.1 to 10 seconds' };
    }
    s.transition = { effect: 'fade', duration };
    return { ok: true, affected: { slideId: s.id } };
  }

  if (t === 'set-notes') {
    const s = findSlide(op.slideId);
    if (!s) return { ok: false, error: 'no such slide' };
    if (typeof op.text !== 'string') return { ok: false, error: 'text must be a string' };
    s.notes = op.text;
    return { ok: true, affected: { slideId: s.id, notes: true } };
  }

  if (t === 'add-element') {
    const s = findSlide(op.slideId);
    if (!s) return { ok: false, error: 'no such slide' };
    if ((model.mode || 'native') === 'overlay' && Number.isInteger(s.src)) {
      return { ok: false, error: 'cannot add an element to an imported slide because it has no backing PowerPoint shape; add a new slide or edit an existing element' };
    }
    const elementType = op.elementType === undefined ? 'body' : op.elementType;
    if (typeof elementType !== 'string' || !ELEMENT_TYPES.has(elementType)) {
      return { ok: false, error: `elementType must be one of: ${Array.from(ELEMENT_TYPES).join(', ')}` };
    }
    if (op.index !== undefined && !Number.isInteger(op.index)) return { ok: false, error: 'index must be an integer' };
    const el = { id: shortId('e'), type: elementType };
    if (op.items !== undefined) {
      if (!Array.isArray(op.items) || !op.items.every((item) => typeof item === 'string')) {
        return { ok: false, error: 'items must be an array of strings' };
      }
      el.items = op.items.slice();
    } else {
      if (op.text !== undefined && typeof op.text !== 'string') return { ok: false, error: 'text must be a string' };
      el.text = op.text || '';
    }
    if (op.index !== undefined) s.elements.splice(Math.max(0, Math.min(op.index, s.elements.length)), 0, el);
    else s.elements.push(el);
    return { ok: true, affected: { slideId: s.id, elementId: el.id } };
  }

  if (t === 'add-shape') {
    const s = findSlide(op.slideId);
    if (!s) return { ok: false, error: 'no such slide' };
    const isNativeSlide = s.src === undefined;
    const isImportedOverlaySlide =
      (model.mode || 'native') === 'overlay' && Number.isInteger(s.src);
    if (!isNativeSlide && !isImportedOverlaySlide) {
      return { ok: false, error: 'generated shapes require a suite-native or imported overlay slide' };
    }
    const shapeType = op.shapeType === undefined ? 'rect' : op.shapeType;
    if (shapeType !== 'rect') return { ok: false, error: 'shapeType must be rect' };
    if (typeof op.fill !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(op.fill)) {
      return { ok: false, error: 'fill must be a #RRGGBB hex string' };
    }
    const box = { x: op.x, y: op.y, w: op.w, h: op.h };
    const invalidBox = generatedBoxError(box);
    if (invalidBox) return { ok: false, error: invalidBox };
    const decor = {
      id: shortId('d'),
      kind: 'shape',
      sid: null,
      generated: true,
      shapeType: 'rect',
      box,
      fill: op.fill
    };
    s.decor = s.decor || [];
    s.decor.push(decor);
    return { ok: true, affected: { slideId: s.id, decorId: decor.id } };
  }

  if (t === 'add-image') {
    const s = findSlide(op.slideId);
    if (!s) return { ok: false, error: 'no such slide' };
    const isNativeSlide = s.src === undefined;
    const isImportedOverlaySlide =
      (model.mode || 'native') === 'overlay' && Number.isInteger(s.src);
    if (!isNativeSlide && !isImportedOverlaySlide) {
      return { ok: false, error: 'generated images require a suite-native or imported overlay slide' };
    }
    const resolved = resolveProjectImageSource(op.source);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const box = { x: op.x, y: op.y, w: op.w, h: op.h };
    const invalidBox = generatedBoxError(box);
    if (invalidBox) return { ok: false, error: invalidBox };
    const decor = {
      id: shortId('d'),
      kind: 'pic',
      sid: null,
      generated: true,
      source: resolved.source,
      box,
    };
    s.decor = s.decor || [];
    s.decor.push(decor);
    return { ok: true, affected: { slideId: s.id, decorId: decor.id } };
  }

  if (t === 'add-video') {
    const s = findSlide(op.slideId);
    if (!s) return { ok: false, error: 'no such slide' };
    const isNativeSlide = s.src === undefined;
    const isImportedOverlaySlide =
      (model.mode || 'native') === 'overlay' && Number.isInteger(s.src);
    if (!isNativeSlide && !isImportedOverlaySlide) {
      return { ok: false, error: 'generated videos require a suite-native or imported overlay slide' };
    }
    const resolved = resolveProjectVideoSource(op.source);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const box = { x: op.x, y: op.y, w: op.w, h: op.h };
    const invalidBox = generatedBoxError(box);
    if (invalidBox) return { ok: false, error: invalidBox };
    const autoplay = op.autoplay === undefined ? true : op.autoplay;
    const loop = op.loop === undefined ? true : op.loop;
    if (typeof autoplay !== 'boolean') return { ok: false, error: 'autoplay must be a boolean' };
    if (typeof loop !== 'boolean') return { ok: false, error: 'loop must be a boolean' };
    const decor = {
      id: shortId('d'),
      kind: 'media',
      sid: null,
      generated: true,
      source: resolved.source,
      box,
      autoplay,
      loop,
    };
    s.decor = s.decor || [];
    s.decor.push(decor);
    return { ok: true, affected: { slideId: s.id, decorId: decor.id } };
  }

  if (t === 'set-media') {
    const s = findSlide(op.slideId);
    if (!s) return { ok: false, error: 'no such slide' };
    if (typeof op.decorId !== 'string' || !op.decorId) {
      return { ok: false, error: 'decorId must name an existing generated media item' };
    }
    const media = (s.decor || []).find((item) => item.id === op.decorId);
    if (!media) return { ok: false, error: 'no such decor id: ' + op.decorId };
    if (media.generated !== true || media.kind !== 'media') {
      return { ok: false, error: 'set-media requires an existing generated media decor' };
    }

    const hasSource = op.source !== undefined;
    const hasAutoplay = op.autoplay !== undefined;
    const hasLoop = op.loop !== undefined;
    if (!hasSource && !hasAutoplay && !hasLoop) {
      return { ok: false, error: 'set-media needs at least one of source, autoplay, or loop' };
    }

    let source;
    if (hasSource) {
      const resolved = resolveProjectVideoSource(op.source);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      source = resolved.source;
    }
    if (hasAutoplay && typeof op.autoplay !== 'boolean') {
      return { ok: false, error: 'autoplay must be a boolean' };
    }
    if (hasLoop && typeof op.loop !== 'boolean') {
      return { ok: false, error: 'loop must be a boolean' };
    }

    // Update only the requested media properties. Stable identity, geometry,
    // z-order, and every unrelated field deliberately remain untouched so the
    // same object history entry continues across source/playback revisions.
    if (hasSource) media.source = source;
    if (hasAutoplay) media.autoplay = op.autoplay;
    if (hasLoop) media.loop = op.loop;
    return { ok: true, affected: { slideId: s.id, decorId: media.id, media: true } };
  }

  if (t === 'set-image') {
    const s = findSlide(op.slideId);
    if (!s) return { ok: false, error: 'no such slide' };
    if (typeof op.decorId !== 'string' || !op.decorId) {
      return { ok: false, error: 'decorId must name an existing generated picture item' };
    }
    const pic = (s.decor || []).find((item) => item.id === op.decorId);
    if (!pic) return { ok: false, error: 'no such decor id: ' + op.decorId };
    if (pic.generated !== true || pic.kind !== 'pic') {
      return { ok: false, error: 'set-image requires an existing generated picture decor' };
    }
    const resolved = resolveProjectImageSource(op.source);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    // Update only the source. Stable identity, geometry, z-order, and every
    // unrelated field deliberately remain untouched so the same object history
    // entry continues across source swaps, mirroring set-media for pictures.
    pic.source = resolved.source;
    return { ok: true, affected: { slideId: s.id, decorId: pic.id, pic: true } };
  }

  if (t === 'set-animation') {
    const s = findSlide(op.slideId);
    if (!s) return { ok: false, error: 'no such slide' };
    if (typeof op.targetId !== 'string' || !op.targetId) {
      return { ok: false, error: 'targetId must name an element or decor item' };
    }
    const element = findElement(s, op.targetId);
    const decor = (s.decor || []).find((item) => item.id === op.targetId);
    if (!element && !decor) return { ok: false, error: 'no such element or decor id: ' + op.targetId };
    if (decor && decor.kind === 'media') {
      return { ok: false, error: 'media playback is configured by add-video and cannot use object animations' };
    }
    if ((model.mode || 'native') === 'overlay' && Number.isInteger(s.src)) {
      if (element && !element.ref) {
        return { ok: false, error: 'that imported element has no backing PowerPoint shape to animate' };
      }
      if (decor && decor.generated !== true && decor.sid == null) {
        return { ok: false, error: 'that decor item has no backing PowerPoint shape to animate' };
      }
    }
    s.animations = Array.isArray(s.animations) ? s.animations : [];
    const existingIndex = s.animations.findIndex((animation) => animation.targetId === op.targetId);
    if (op.effect === 'none') {
      if (op.trigger !== undefined || op.duration !== undefined || op.delay !== undefined ||
          op.index !== undefined) {
        return { ok: false, error: 'trigger, duration, delay, and index are not valid when effect is none' };
      }
      if (existingIndex >= 0) s.animations.splice(existingIndex, 1);
      if (!s.animations.length) delete s.animations;
      else if (s.animations[0].trigger !== 'click') s.animations[0].trigger = 'click';
      return { ok: true, affected: { slideId: s.id, targetId: op.targetId, animation: true } };
    }
    if (!['appear', 'fade', 'wipe', 'rise-up'].includes(op.effect)) {
      return { ok: false, error: 'effect must be appear, fade, wipe, rise-up, or none' };
    }
    const trigger = op.trigger === undefined ? 'click' : op.trigger;
    if (!['click', 'with-previous', 'after-previous'].includes(trigger)) {
      return { ok: false, error: 'trigger must be click, with-previous, or after-previous' };
    }
    const duration = op.duration === undefined ? (op.effect === 'appear' ? 0.1 : 0.5) : op.duration;
    if (typeof duration !== 'number' || !Number.isFinite(duration) ||
        duration < 0.1 || duration > 10) {
      return { ok: false, error: 'duration must be a finite number from 0.1 to 10 seconds' };
    }
    const delay = op.delay === undefined ? 0 : op.delay;
    if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0 || delay > 30) {
      return { ok: false, error: 'delay must be a finite number from 0 to 30 seconds' };
    }
    if (op.index !== undefined && (!Number.isInteger(op.index) || op.index < 0)) {
      return { ok: false, error: 'index must be a non-negative integer' };
    }
    const animation = { targetId: op.targetId, effect: op.effect, trigger, duration, delay };
    let insertAt;
    if (existingIndex >= 0) {
      s.animations.splice(existingIndex, 1);
      insertAt = op.index === undefined ? existingIndex : op.index;
    } else {
      insertAt = op.index === undefined ? s.animations.length : op.index;
    }
    insertAt = Math.min(insertAt, s.animations.length);
    if (insertAt === 0 && trigger !== 'click') {
      return { ok: false, error: 'the first animation on a slide must trigger on click' };
    }
    s.animations.splice(insertAt, 0, animation);
    return { ok: true, affected: { slideId: s.id, targetId: op.targetId, animation: true } };
  }

  if (t === 'delete-element') {
    const s = findSlide(op.slideId);
    if (!s) return { ok: false, error: 'no such slide' };
    const i = s.elements.findIndex((e) => e.id === op.elementId);
    if (i < 0) return { ok: false, error: 'no such element' };
    const reason = uneditableElementReason(s, s.elements[i]);
    if (reason) return { ok: false, error: reason };
    const removedId = s.elements[i].id;
    s.elements.splice(i, 1);
    if (Array.isArray(s.animations)) {
      s.animations = s.animations.filter((animation) => animation.targetId !== removedId);
      if (!s.animations.length) delete s.animations;
      else if (s.animations[0].trigger !== 'click') s.animations[0].trigger = 'click';
    }
    return { ok: true, affected: { slideId: s.id } };
  }

  if (t === 'delete-decor') {
    const s = findSlide(op.slideId);
    if (!s) return { ok: false, error: 'no such slide' };
    const index = (s.decor || []).findIndex((decor) => decor.id === op.decorId);
    if (index < 0) return { ok: false, error: 'no such decor item' };
    if (s.decor[index].generated !== true) {
      return { ok: false, error: 'imported decor cannot be deleted' };
    }
    const removedId = s.decor[index].id;
    s.decor.splice(index, 1);
    if (Array.isArray(s.animations)) {
      s.animations = s.animations.filter((animation) => animation.targetId !== removedId);
      if (!s.animations.length) delete s.animations;
      else if (s.animations[0].trigger !== 'click') s.animations[0].trigger = 'click';
    }
    return { ok: true, affected: { slideId: s.id, removedDecorId: op.decorId } };
  }

  if (t === 'set-text') {
    const s = findSlide(op.slideId);
    const e = findElement(s, op.elementId);
    const reason = uneditableElementReason(s, e);
    if (reason) return { ok: false, error: reason };
    if (typeof op.text !== 'string') return { ok: false, error: 'text must be a string' };
    e.text = op.text;
    delete e.items;
    return { ok: true, affected: { slideId: s.id, elementId: e.id } };
  }

  if (t === 'set-bullets') {
    const s = findSlide(op.slideId);
    const e = findElement(s, op.elementId);
    const reason = uneditableElementReason(s, e);
    if (reason) return { ok: false, error: reason };
    if (!Array.isArray(op.items) || !op.items.every((item) => typeof item === 'string')) {
      return { ok: false, error: 'items must be an array of strings' };
    }
    e.items = op.items.slice();
    delete e.text;
    return { ok: true, affected: { slideId: s.id, elementId: e.id } };
  }

  // Text run styling (color / bold / size / align) on a text element. The
  // renderer applies this to every run in the shape each time it renders, so
  // it's the one way to change color/weight/size without touching base.pptx.
  if (t === 'set-style') {
    const s = findSlide(op.slideId);
    const e = findElement(s, op.elementId);
    const reason = uneditableElementReason(s, e);
    if (reason) return { ok: false, error: reason };
    const styleFields = ['color', 'bold', 'size', 'align', 'font'];
    if (!styleFields.some((field) => op[field] !== undefined)) {
      return { ok: false, error: 'set-style needs at least one of color/bold/size/align/font' };
    }
    e.style = e.style || {};
    if (op.color !== undefined) {
      const c = String(op.color || '');
      // Same #RRGGBB-only rule set-fill already enforces, and for the same
      // reason font is charset-restricted below: app.js's elPosHtml
      // interpolates style.color straight into an HTML style="..." attribute
      // with no escaping, so an unvalidated string here (e.g. containing a
      // ") could break out of the attribute and inject markup for every
      // dashboard viewer. A validated hex string can't do that.
      if (!/^#[0-9a-fA-F]{6}$/.test(c)) return { ok: false, error: 'color must be a #RRGGBB hex string' };
      e.style.color = c;
    }
    if (op.bold !== undefined) {
      if (typeof op.bold !== 'boolean') return { ok: false, error: 'bold must be a boolean' };
      e.style.bold = op.bold;
    }
    if (op.size !== undefined) {
      const n = op.size;
      if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > 400) {
        return { ok: false, error: 'size must be a number greater than 0 and no more than 400' };
      }
      e.style.size = n;
    }
    if (op.align !== undefined) {
      if (!['left', 'center', 'right', 'justify'].includes(op.align)) return { ok: false, error: 'align must be left/center/right/justify' };
      e.style.align = op.align;
    }
    if (op.font !== undefined) {
      const f = String(op.font || '').trim();
      // Restricted to a safe charset (letters/digits/spaces/hyphens) so a font
      // name can never break out of the dashboard's inline style="..." attribute
      // (elPosHtml interpolates style.font unescaped, same as color/fill do,
      // which are safe only because they're already regex-validated hex).
      if (!/^[A-Za-z0-9 \-]{1,60}$/.test(f)) return { ok: false, error: 'font must be 1-60 characters, letters/digits/spaces/hyphens only' };
      e.style.font = f;
    }
    return { ok: true, affected: { slideId: s.id, elementId: e.id, style: true } };
  }

  // Solid fill color, on either a text element's background box or a decor
  // shape (colored bars, bullet-marker squares, callout panels). Tries the
  // element namespace first, then decor, since callers pass one target id.
  if (t === 'set-fill') {
    const s = findSlide(op.slideId);
    if (!s) return { ok: false, error: 'no such slide' };
    const color = String(op.color || '');
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return { ok: false, error: 'color must be a #RRGGBB hex string' };
    if (op.elementId) {
      const e = findElement(s, op.elementId);
      if (e) {
        const reason = uneditableElementReason(s, e);
        if (reason) return { ok: false, error: reason };
        e.style = e.style || {}; e.style.fill = color;
        return { ok: true, affected: { slideId: s.id, elementId: e.id, fill: true } };
      }
    }
    if (op.decorId) {
      const d = (s.decor || []).find((x) => x.id === op.decorId);
      if (d) {
        if (d.kind !== 'shape' || (d.generated !== true && d.sid == null)) {
          return { ok: false, error: 'that decor item is not colorable' };
        }
        d.fill = color; return { ok: true, affected: { slideId: s.id, decorId: d.id, fill: true } };
      }
    }
    return { ok: false, error: 'no such element or decor id: ' + (op.elementId || op.decorId) };
  }

  // Explicit outline color for text-backed cards. Imported cards can retain
  // a stale source border even after their fill moves onto the deck palette.
  if (t === 'set-outline') {
    const s = findSlide(op.slideId);
    const e = findElement(s, op.elementId);
    const reason = uneditableElementReason(s, e);
    if (reason) return { ok: false, error: reason };
    const color = String(op.color || '');
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
      return { ok: false, error: 'color must be a #RRGGBB hex string' };
    }
    e.style = e.style || {};
    e.style.outline = color;
    return { ok: true, affected: { slideId: s.id, elementId: e.id, outline: true } };
  }

  // Convert only a known imported rectangle-family AutoShape to true square
  // corners. sourcePreset is derived from the immutable base.pptx at import
  // (or by the one-time legacy migration), so a target id alone can never
  // make a picture, placeholder, text box, connector, group, icon, circle, or
  // generated object eligible. The renderer re-verifies the real backing
  // OOXML before changing only p:spPr/a:prstGeom in place.
  if (t === 'set-corners') {
    const s = findSlide(op.slideId);
    if (!s) return { ok: false, error: 'no such slide' };
    if (op.corners !== 'sharp') return { ok: false, error: 'corners must be sharp' };
    if (typeof op.targetId !== 'string' || !op.targetId) {
      return { ok: false, error: 'targetId must name an imported box/card element or decor item' };
    }
    if ((model.mode || 'native') !== 'overlay' || !Number.isInteger(s.src)) {
      return { ok: false, error: 'set-corners is supported only on imported overlay slides' };
    }
    const element = findElement(s, op.targetId);
    if (element) {
      const reason = uneditableElementReason(s, element);
      if (reason) return { ok: false, error: reason };
      if (!element.ref || !BOX_SHAPE_PRESETS.has(element.sourcePreset)) {
        return { ok: false, error: 'that element is not an eligible imported box/card AutoShape' };
      }
      element.corners = 'sharp';
      return {
        ok: true,
        affected: { slideId: s.id, elementId: element.id, corners: true }
      };
    }
    const decor = (s.decor || []).find((item) => item.id === op.targetId);
    if (!decor) {
      return { ok: false, error: 'no such element or decor id: ' + op.targetId };
    }
    if (decor.generated === true) {
      return { ok: false, error: 'generated objects cannot use set-corners; generated rectangles are already sharp' };
    }
    if (decor.kind !== 'shape' || !Number.isInteger(decor.sid) ||
        !BOX_SHAPE_PRESETS.has(decor.sourcePreset)) {
      return { ok: false, error: 'that decor item is not an eligible imported box/card AutoShape' };
    }
    decor.corners = 'sharp';
    return {
      ok: true,
      affected: { slideId: s.id, decorId: decor.id, corners: true }
    };
  }

  // Reposition/resize a text element's or decor shape's bounding box. Box
  // coordinates are fractions of slide width/height (0..1), the same units
  // import_pptx.py's geom() captured at import, so ppt show's printed box
  // can be read back directly as set-box input. This is the lever the board
  // flagged repeatedly during polish passes: a box too short for its text
  // was only fixable by shortening the text forever, never by growing the
  // box, since geometry was read-only metadata with no op to change it.
  // Imported backing shapes and generated decor have explicit geometry.
  // Native text remains auto-laid-out until its first complete explicit box;
  // after that, partial patches use the same normalized geometry contract.
  if (t === 'set-box') {
    const s = findSlide(op.slideId);
    if (!s) return { ok: false, error: 'no such slide' };
    const isNativeSlide = s.src === undefined;
    const isImportedOverlaySlide =
      (model.mode || 'native') === 'overlay' && Number.isInteger(s.src);
    if (!isNativeSlide && !isImportedOverlaySlide) {
      return { ok: false, error: 'box geometry requires a suite-native or imported overlay slide' };
    }
    const patch = {};
    for (const k of ['x', 'y', 'w', 'h']) {
      if (op[k] === undefined) continue;
      // Number(op[k]) used to coerce here, and Number(null) is 0, a value
      // that's actually IN the legal 0..1 range: ppt.js's set-box builds
      // op[k] via parseFloat(flags[k]), so a garbage CLI value (--x abc)
      // becomes NaN, which JSON.stringify silently serializes as null on
      // the wire. The result: "set-box s1 e1 --x abc" reported success and
      // silently snapped the element to the far-left edge (verified
      // directly against a sandbox). Requiring a genuine number up front
      // rejects null/strings/etc instead of coercing them into a
      // deceptively "valid" 0.
      const n = op[k];
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) return { ok: false, error: `${k} must be a number between 0 and 1 (a fraction of slide width/height)` };
      if ((k === 'w' || k === 'h') && n === 0) return { ok: false, error: `${k} must be greater than 0` };
      patch[k] = n;
    }
    if (!Object.keys(patch).length) return { ok: false, error: 'need at least one of x/y/w/h' };
    if (op.elementId) {
      const e = findElement(s, op.elementId);
      if (e) {
        const reason = uneditableElementReason(s, e);
        if (reason) return { ok: false, error: reason };
        if (isNativeSlide) {
          const nextBox = Object.assign({}, e.box, patch);
          const invalidBox = generatedBoxError(nextBox);
          if (invalidBox) {
            return {
              ok: false,
              error: e.box
                ? invalidBox
                : `native text needs x, y, w, and h for its first explicit box: ${invalidBox}`
            };
          }
          e.box = nextBox;
          return { ok: true, affected: { slideId: s.id, elementId: e.id, box: true } };
        }
        e.box = Object.assign({}, e.box, patch);
        return { ok: true, affected: { slideId: s.id, elementId: e.id, box: true } };
      }
    }
    if (op.decorId) {
      const d = (s.decor || []).find((x) => x.id === op.decorId);
      if (d) {
        if (isNativeSlide && d.generated !== true) {
          return { ok: false, error: 'set-box is supported only for generated decor on a native slide' };
        }
        if (d.generated !== true && d.sid == null) {
          return { ok: false, error: 'that decor item has no backing PowerPoint shape' };
        }
        const nextBox = Object.assign({}, d.box, patch);
        if (d.generated === true) {
          const invalidBox = generatedBoxError(nextBox);
          if (invalidBox) return { ok: false, error: invalidBox };
        }
        d.box = nextBox;
        return { ok: true, affected: { slideId: s.id, decorId: d.id, box: true } };
      }
    }
    return { ok: false, error: 'no such element or decor id: ' + (op.elementId || op.decorId) };
  }

  // Theme accent colors. Only affects slides/elements added natively inside
  // the suite (overlay-mode shapes keep whatever base.pptx + set-style give
  // them) — see fill_native() in render_pptx.py.
  if (t === 'set-theme') {
    // Not an XSS concern the way set-fill/set-style's color is (that one's
    // strict hex requirement exists specifically because app.js interpolates
    // it into a raw HTML style="..." string; --accent only ever flows
    // through element.style.setProperty() into an actual CSS custom
    // property, consumed exclusively via var(--accent) inside already-
    // parsed static stylesheet rules, never re-parsed as markup). But
    // verified directly: an invalid value is still silently ACCEPTED
    // (custom properties don't validate at set time) and stored, then
    // silently fails to apply anywhere var(--accent) is actually consumed,
    // falling back to an unrelated inherited color with zero error anywhere
    // in the chain, "success" that visibly does nothing. Validate for that
    // reason: a clear rejection beats a theme change that quietly no-ops.
    if (op.accent !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(op.accent))) {
      return { ok: false, error: 'accent must be a #RRGGBB hex string' };
    }
    if (op.accent === undefined && op.accent2 === undefined) return { ok: false, error: 'set-theme needs an accent color' };
    if (op.accent2 !== undefined) return { ok: false, error: 'accent2 is not supported by the renderer' };
    model.theme = model.theme || {};
    if (op.accent !== undefined) model.theme.accent = String(op.accent);
    return { ok: true, affected: { scope: 'theme' } };
  }

  return { ok: false, error: 'unknown op.type: ' + t };
}

// ----------------------------------------------------------- pause / resume
async function lockPauseFiles() {
  const pptxLocked = await setReadOnly(PPTX_PATH, true);
  const modelLocked = await setReadOnly(MODEL_PATH, true);
  return pptxLocked && modelLocked;
}

async function verifyPauseFiles() {
  if (await lockPauseFiles()) return true;
  return lockPauseFiles();
}

async function doPause(by) {
  if (state.paused) {
    const verified = await verifyPauseFiles();
    if (!verified) return { ok: false, error: 'presentation is paused, but its read-only locks could not be verified' };
    return { ok: true };
  }
  // Persist the complete future state before exposing the in-memory edit gate.
  // A failed write must leave both the current gate and the OS locks untouched.
  const next = copyState();
  next.paused = true;
  next.pausedBy = by || 'dashboard';
  next.pausedAt = Date.now();
  appendStateLog(next, { kind: 'pause', by: next.pausedBy });
  if (!persistState(next)) return { ok: false, error: 'could not save pause state; editing is unchanged' };

  state = next;                              // set the gate before any awaits
  if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
  const verified = await verifyPauseFiles();
  // The durable edit gate is already closed, so every viewer must learn about
  // the pause even when an OS-level defence-in-depth lock is incomplete.
  broadcast({
    type: 'pause', by: state.pausedBy, at: state.pausedAt,
    locksVerified: verified, ts: Date.now()
  });
  if (!verified) {
    // Once a pause has committed, never reopen the gate just because an OS
    // lock was flaky.
    console.error('pause committed but could not verify both read-only locks');
    return { ok: false, error: 'pause was saved, but presentation locks could not be verified; editing remains paused' };
  }
  return { ok: true };
}

async function doResume(by) {
  if (!state.paused) {
    // Idempotent resume is also a repair operation. A crash can persist the
    // unpaused gate after clearing only one read-only attribute (or vice
    // versa); claiming success without checking leaves edits unable to save.
    const modelUnlocked = await setReadOnly(MODEL_PATH, false);
    const pptxUnlocked = await setReadOnly(PPTX_PATH, false);
    return modelUnlocked && pptxUnlocked
      ? { ok: true }
      : { ok: false, error: 'presentation is unpaused, but its writable file state could not be verified' };
  }
  // Keep the in-memory gate closed until BOTH OS locks are clear and the
  // unpaused state is durable. A failed save must immediately fail closed.
  const modelUnlocked = await setReadOnly(MODEL_PATH, false);
  const pptxUnlocked = await setReadOnly(PPTX_PATH, false);
  if (!modelUnlocked || !pptxUnlocked) {
    const restored = await lockPauseFiles();
    console.error('resume could not verify both writable files; relock result:', restored);
    return { ok: false, error: 'could not unlock the presentation; editing remains paused' };
  }

  // Copy only after the awaits so incidental state activity during them (for
  // example an agent exit log) is retained rather than overwritten.
  const next = copyState();
  next.paused = false;
  next.pausedBy = null;
  next.pausedAt = null;
  appendStateLog(next, { kind: 'resume', by: by || 'dashboard' });
  if (!persistState(next)) {
    const restored = await lockPauseFiles();
    console.error('resume state did not persist; relock result:', restored);
    return { ok: false, error: 'could not save resume state; editing remains paused' };
  }

  state = next;
  broadcast({ type: 'resume', by: by || 'dashboard', ts: Date.now() });
  scheduleRender();
  return { ok: true };
}

// --------------------------------------------------------------- http layer
class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
  }
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REQUEST_BODY_TIMEOUT_MS = Math.max(
  25,
  Number.parseInt(process.env.SUITE_REQUEST_BODY_TIMEOUT_MS || '15000', 10) || 15000
);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    let done = false;
    let timer = null;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    const declared = Number.parseInt(req.headers['content-length'] || '', 10);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      req.resume();
      finish(reject, new RequestError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`));
      return;
    }
    timer = setTimeout(() => {
      req.resume();
      finish(reject, new RequestError(408, `request body was not completed within ${REQUEST_BODY_TIMEOUT_MS}ms`));
    }, REQUEST_BODY_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    req.on('data', (chunk) => {
      if (done) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BODY_BYTES) {
        data = '';
        // Drain rather than destroy the socket: destroying it prevents the
        // caller from receiving the structured 413 response.
        req.resume();
        finish(reject, new RequestError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (done) return;
      if (!data) return finish(resolve, {});
      let parsed;
      try { parsed = JSON.parse(data); }
      catch (_) { return finish(reject, new RequestError(400, 'request body must be valid JSON')); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return finish(reject, new RequestError(400, 'request body must be a JSON object'));
      }
      finish(resolve, parsed);
    });
    req.on('error', (error) => finish(reject, new RequestError(400, `request body error: ${error.message}`)));
  });
}

// Sensitive control-plane choices have no login token because this is a local
// viewer, so do not accept a browser's CORS-safelisted form/text POST as if it
// came from our UI. The Studio, dashboard, CLI, and MCP clients already send
// JSON. A cross-origin script cannot send that header without a preflight, and
// an explicit foreign Origin is rejected as defence in depth. CLI calls carry
// no Origin and remain valid local automation.
function requireControlJson(req, res) {
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    json(res, 415, { ok: false, error: 'control requests must use Content-Type: application/json' });
    return false;
  }
  const origin = String(req.headers.origin || '');
  const configured = new Set([
    `http://${HOST}:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    `http://localhost:${PORT}`,
  ]);
  for (const item of String(process.env.SUITE_ALLOWED_ORIGINS || '').split(',')) {
    if (item.trim()) configured.add(item.trim());
  }
  // Do not compare Origin with Host: Host is supplied by the requester and a
  // DNS-rebinding request can make both attacker-controlled values agree.
  if (origin && !configured.has(origin)) {
    json(res, 403, { ok: false, error: 'cross-origin control request refused' });
    return false;
  }
  return true;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  // These replies deliberately carry no CORS header. That alone does not stop
  // a browser from sending a simple cross-origin POST, so sensitive controls
  // additionally enforce JSON plus same-origin above.
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

// '/' is deliberately ABSENT: it now 302s to /studio, which is the single
// surface. index.html / app.js / styles.css stay served so the old dashboard
// remains reachable directly as a rollback path; it costs nothing to keep and
// removing it would strand anyone mid-session on a bookmarked tab.
const STATIC = {
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/studio': ['studio.html', 'text/html; charset=utf-8'],
  '/studio.html': ['studio.html', 'text/html; charset=utf-8'],
  '/studio.js': ['studio.js', 'text/javascript; charset=utf-8'],
  '/studio.css': ['studio.css', 'text/css; charset=utf-8'],
  '/animation-preview.js': ['animation-preview.js', 'text/javascript; charset=utf-8'],
  '/animation-preview.css': ['animation-preview.css', 'text/css; charset=utf-8']
};

function serveStatic(res, file, type) {
  fs.readFile(path.join(PUBLIC, file), (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

// Read-only and model-bound: the browser may request only a picture already
// named by a current slide/decor id. This gives the approximate entrance-build
// preview its source pixels without exposing an arbitrary filesystem path.
function serveAnimationPreviewAsset(res, url) {
  const slideId = String(url.searchParams.get('slideId') || '');
  const objectId = String(url.searchParams.get('objectId') || '');
  const slide = (model.slides || []).find((item) => item.id === slideId);
  const object = slide && (slide.decor || []).find((item) => item.id === objectId);
  if (!object || object.kind !== 'pic' || storedImageSourceError(object.source)) {
    json(res, 404, { ok: false, error: 'preview artwork not found' });
    return;
  }
  const resolved = resolveProjectImageSource(object.source);
  if (!resolved.ok) {
    json(res, 404, { ok: false, error: 'preview artwork not found' });
    return;
  }
  const types = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
  };
  fs.readFile(resolved.absolute, (error, body) => {
    if (error) {
      json(res, 404, { ok: false, error: 'preview artwork not found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': types[path.extname(resolved.absolute).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  });
}

function parseSingleByteRange(value, size) {
  if (value === undefined) return { ok: true, range: null };
  if (typeof value !== 'string' || value.includes(',')) return { ok: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return { ok: false };
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { ok: false };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || start >= size || end < start) return { ok: false };
    end = Math.min(end, size - 1);
  }
  return { ok: true, range: { start, end } };
}

// Read-only, model-bound streaming for generated MP4 decor. The URL accepts
// stable slide/object ids only; the source path always comes back out of the
// validated live model and is re-resolved beneath the real assets directory.
function serveMediaPreviewAsset(req, res, url) {
  const slideId = String(url.searchParams.get('slideId') || '');
  const objectId = String(url.searchParams.get('objectId') || '');
  const slide = (model.slides || []).find((item) => item.id === slideId);
  const object = slide && (slide.decor || []).find((item) => item.id === objectId);
  if (!object || object.kind !== 'media' || object.generated !== true
      || storedVideoSourceError(object.source)) {
    json(res, 404, { ok: false, error: 'preview video not found' });
    return;
  }
  const resolved = resolveProjectVideoSource(object.source);
  if (!resolved.ok) {
    json(res, 404, { ok: false, error: 'preview video not found' });
    return;
  }
  fs.stat(resolved.absolute, (statError, stat) => {
    if (statError || !stat || !stat.isFile()) {
      json(res, 404, { ok: false, error: 'preview video not found' });
      return;
    }
    const rangeResult = parseSingleByteRange(req.headers.range, stat.size);
    const baseHeaders = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Disposition': 'inline',
    };
    if (!rangeResult.ok) {
      res.writeHead(416, Object.assign(baseHeaders, {
        'Content-Range': `bytes */${stat.size}`,
        'Content-Length': 0,
      }));
      res.end();
      return;
    }
    const range = rangeResult.range;
    const start = range ? range.start : 0;
    const end = range ? range.end : Math.max(0, stat.size - 1);
    const length = stat.size === 0 ? 0 : end - start + 1;
    const headers = Object.assign(baseHeaders, { 'Content-Length': length });
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD' || length === 0) {
      res.end();
      return;
    }
    const stream = fs.createReadStream(resolved.absolute, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

// Read-only, history-bound artwork. The browser supplies stable identities and
// a version id, never a path; the path comes only from the validated durable
// snapshot and is then realpath-checked beneath assets. Only versions still in
// the visible ten-card branch are exposed.
function serveObjectHistoryAsset(req, res, url) {
  const ref = elementHistoryRef(
    url.searchParams.get('slideId'),
    url.searchParams.get('objectKind'),
    url.searchParams.get('objectId')
  );
  const entry = elementHistory && elementHistory.entries[elementHistoryKey(ref)];
  const versionId = String(url.searchParams.get('versionId') || '');
  const version = entry && entry.timeline.includes(versionId) && entry.versions[versionId];
  const object = version && version.state && version.state.object;
  if (!findHistoryObject(model, ref) || !object || !object.generated ||
      !['pic', 'media'].includes(object.kind)) {
    json(res, 404, { ok: false, error: 'saved preview asset not found' });
    return;
  }
  const resolved = object.kind === 'media'
    ? resolveProjectVideoSource(object.source)
    : resolveProjectImageSource(object.source);
  if (!resolved.ok) {
    json(res, 404, { ok: false, error: 'saved preview asset not found' });
    return;
  }
  if (object.kind === 'pic') {
    const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' };
    fs.stat(resolved.absolute, (statError, stat) => {
      if (statError || !stat || !stat.isFile()) {
        json(res, 404, { ok: false, error: 'saved preview asset not found' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': types[path.extname(resolved.absolute).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Content-Disposition': 'inline',
      });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(resolved.absolute);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    });
    return;
  }
  fs.stat(resolved.absolute, (statError, stat) => {
    if (statError || !stat || !stat.isFile()) {
      json(res, 404, { ok: false, error: 'saved preview asset not found' });
      return;
    }
    const rangeResult = parseSingleByteRange(req.headers.range, stat.size);
    const baseHeaders = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Disposition': 'inline',
    };
    if (!rangeResult.ok) {
      res.writeHead(416, Object.assign(baseHeaders, {
        'Content-Range': `bytes */${stat.size}`,
        'Content-Length': 0,
      }));
      return res.end();
    }
    const range = rangeResult.range;
    const start = range ? range.start : 0;
    const end = range ? range.end : Math.max(0, stat.size - 1);
    const length = stat.size === 0 ? 0 : end - start + 1;
    const headers = Object.assign(baseHeaders, { 'Content-Length': length });
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD' || length === 0) return res.end();
    const stream = fs.createReadStream(resolved.absolute, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

function snapshot(extra) {
  return Object.assign({
    model,
    paused: state.paused,
    pausedBy: state.pausedBy,
    pausedAt: state.pausedAt,
    rev: model.rev,
    editors: editorList(),
    thumbs: thumbsVer,
    board: boardView(),
    tasks: tasksView(),
    loops: loopView(),
    locks: lockView(),
    protections: protectionView(),
    protectionExceptions: protectionExceptionView(),
    protectionHistory: protectionHistoryView(),
    pdfVer, pdfRev: state.pdfRev,
    presentation: presentationFreshness(),
    undoCount: undoStack.length,
    redoCount: redoStack.length,
    agents: Agents.agentsView(),
    profile: profileView(),
    spend: spendView(),
    presence: presenceState(),
    loopRunner: loopRunnerView(),
    port: PORT,
    bootedAt: BOOTED_AT
  }, extra || {});
}

async function handleRequest(req, res) {
  // A fixed parse base makes routing independent of an invalid or malicious
  // Host header. The configured Host is used only for listen(), never trusted
  // as parser input.
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;

  if (req.method === 'OPTIONS') { json(res, 204, {}); return; }
  if (req.method === 'GET' && p === '/api/animation-preview-asset') {
    serveAnimationPreviewAsset(res, url);
    return;
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && p === '/api/media-preview-asset') {
    serveMediaPreviewAsset(req, res, url);
    return;
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && p === '/api/object-history/asset') {
    serveObjectHistoryAsset(req, res, url);
    return;
  }
  if (req.method === 'POST' && p.startsWith('/api/') && !requireControlJson(req, res)) return;

  // ---- static
  // The root is now the studio. 302 (not 301) on purpose: a permanent redirect
  // is cached by the browser and would survive a rollback, leaving no way back
  // to the dashboard without clearing site data.
  if (req.method === 'GET' && p === '/') {
    res.writeHead(302, { Location: '/studio', 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (req.method === 'GET' && STATIC[p]) { const [f, t] = STATIC[p]; return serveStatic(res, f, t); }
  if (req.method === 'GET' && p === '/favicon.ico') { res.writeHead(204); return res.end(); }

  // ---- true slide thumbnails (slide-1.png … slide-N.png)
  if (req.method === 'GET' && /^\/thumbs\/slide-\d+\.png$/.test(p)) {
    fs.readFile(path.join(THUMBS_DIR, path.basename(p)), (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }

  // ---- SSE stream
  if (req.method === 'GET' && p === '/api/events') {
    // Same reasoning as json()'s comment: no cross-origin header, so a page
    // on any other origin can't read this stream (full deck/board state)
    // just because the user happened to have it open locally.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write('retry: 2000\n\n');
    res.write(`data: ${JSON.stringify(Object.assign({ type: 'snapshot' }, snapshot()))}\n\n`);
    sseClients.add(res);
    // A browser viewer identifies itself (?viewer=studio). `ppt watch` opens this
    // same stream and must NOT count: a terminal left on watch overnight is
    // exactly the case the idle reaper exists to catch.
    const isViewer = /(^|[?&])viewer=/.test(req.url || '');
    if (isViewer) { viewerClients.add(res); touchViewer(); }
    req.on('close', () => { sseClients.delete(res); viewerClients.delete(res); });
    return;
  }

  // ---- viewer presence: the heartbeat that keeps agents alive (see reapIdleAgents)
  if (req.method === 'POST' && p === '/api/presence') {
    const b = await readBody(req);
    if (b && b.leaving) {
      // A pagehide beacon has no viewer identity. If another Studio tab still
      // holds an SSE stream, clearing this shared clock would make that live
      // tab look absent and reap its agents. When the departing stream is the
      // last one, its close event (plus the existing grace window) handles the
      // safe fallback; only reap immediately if that close already landed.
      if (viewerClients.size === 0) {
        lastViewerActivity = 0;
        return json(res, 200, { ok: true, reaped: reapIdleAgents('viewer closed') });
      }
      return json(res, 200, { ok: true, reaped: false });
    }
    touchViewer();
    return json(res, 200, { ok: true, idleLimitMs: VIEWER_IDLE_MS, lastActivity: lastViewerActivity });
  }

  // ---- health + state
  if (req.method === 'GET' && p === '/api/health') {
    return json(res, 200, { ok: true, presentation: presentationFreshness() });
  }
  if (req.method === 'GET' && p === '/api/state') {
    return json(res, 200, Object.assign(snapshot(), { log: state.log.slice(-80) }));
  }

  // ---- house-rule lint (read-only; not gated by pause, like the board)
  if (req.method === 'GET' && p === '/api/lint') {
    return json(res, 200, await fullLint(model));
  }

  // ---- speaking-time estimate (read-only; not gated by pause, like the board)
  if (req.method === 'GET' && p === '/api/timing') {
    return json(res, 200, estimateTiming(model));
  }

  // ---- download the rendered pptx
  if (req.method === 'GET' && p === '/api/pptx') {
    const expectedRev = model.rev;
    const freshness = presentationFreshness();
    if (!freshness.current) {
      return json(res, 409, { ok: false, error: `presentation is not current: ${freshness.error}` });
    }
    try {
      const buf = fs.readFileSync(PPTX_PATH);
      if (model.rev !== expectedRev) {
        return json(res, 409, { ok: false, error: 'the deck changed while the download was being prepared; retry' });
      }
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'Content-Disposition': 'attachment; filename="presentation.pptx"'
      });
      res.end(buf);
    } catch (error) {
      return json(res, 404, { ok: false, error: 'not rendered yet' });
    }
    return;
  }

  // ---- on-demand PDF export + download (not gated by pause; read-only against
  // whatever presentation.pptx currently holds, same spirit as /api/pptx)
  if (req.method === 'POST' && p === '/api/pdf/export') {
    const result = await runPdfExport();
    return json(res, result.ok ? 200 : 500, Object.assign({ ver: pdfVer }, result));
  }
  if (req.method === 'GET' && p === '/api/pdf') {
    fs.readFile(PDF_PATH, (err, buf) => {
      if (err) return json(res, 404, { error: 'not exported yet: POST /api/pdf/export first' });
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="presentation.pdf"'
      });
      res.end(buf);
    });
    return;
  }

  // ---- editor registration / heartbeat
  // (a separate /api/register used to exist here: same job as heartbeat
  // below, minus the caller already knowing its own id, but every real
  // caller in this codebase always supplies one (ppt.js's EDITOR is
  // self-assigned, app.js/studio.js use fixed names), so the one thing that
  // set it apart, generating a fresh id server-side, was never exercised.
  // heartbeat's own wasNew handling already covers first-contact
  // registration. Confirmed zero callers anywhere before removing it.)
  if (req.method === 'POST' && p === '/api/heartbeat') {
    const b = await readBody(req);
    const now = Date.now();
    if (b.id) {
      const wasNew = !editors.has(b.id);
      const ed = editors.get(b.id) || { id: b.id, name: b.name || 'editor', joinedAt: now, status: null, task: '' };
      ed.lastSeen = now; if (b.name) ed.name = b.name;
      // A plain heartbeat leaves status untouched, so `ppt watch` keeps a
      // session visible without clobbering a free/busy state set elsewhere.
      let statusChanged = false;
      if (b.status === 'free' || b.status === 'busy') {
        statusChanged = ed.status !== b.status;
        ed.status = b.status;
        ed.task = b.status === 'free' ? '' : (b.task != null ? String(b.task).slice(0, 200) : ed.task || '');
      }
      editors.set(b.id, ed);
      if (wasNew || statusChanged) broadcast({ type: 'editors', editors: editorList(), ts: now });
      // Marking free implies "done editing" — drop this session's slide locks too.
      if (statusChanged && b.status === 'free' && releaseLocksFor(b.id)) {
        broadcast({ type: 'locks', locks: lockView(), ts: now });
      }
    }
    return json(res, 200, { paused: state.paused, pausedBy: state.pausedBy, rev: model.rev });
  }
  if (req.method === 'POST' && p === '/api/leave') {
    const b = await readBody(req);
    if (b.id) {
      const hadLocks = releaseLocksFor(b.id);
      if (editors.delete(b.id) || hadLocks) broadcast({ type: 'editors', editors: editorList(), ts: Date.now() });
      if (hadLocks) broadcast({ type: 'locks', locks: lockView(), ts: Date.now() });
    }
    return json(res, 200, { ok: true });
  }
  // ---- set a session's free/busy status (id = the SUITE_EDITOR name)
  if (req.method === 'POST' && p === '/api/status') {
    const b = await readBody(req);
    const now = Date.now();
    const id = typeof b.id === 'string' ? b.id.trim().slice(0, 60) : '';
    if (!id) return json(res, 400, { ok: false, error: 'missing id' });
    if (!['free', 'busy'].includes(b.status)) {
      return json(res, 400, { ok: false, error: 'status must be free or busy' });
    }
    const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 60) : id;
    const ed = editors.get(id) || { id, name, joinedAt: now, status: null, task: '' };
    ed.lastSeen = now; ed.name = name;
    const wasBusy = ed.status === 'busy';
    ed.status = b.status;
    ed.task = ed.status === 'free' ? '' : (b.task != null ? String(b.task).slice(0, 200) : ed.task || '');
    editors.set(id, ed);
    broadcast({ type: 'editors', editors: editorList(), ts: now });
    if (wasBusy && ed.status === 'free' && releaseLocksFor(id)) {
      broadcast({ type: 'locks', locks: lockView(), ts: now });
    }
    return json(res, 200, { ok: true, status: ed.status, task: ed.task });
  }

  // ---- message board (NOT gated by pause — communication always works)
  if (req.method === 'GET' && p === '/api/board') {
    return json(res, 200, { notes: boardView() });
  }
  if (req.method === 'POST' && p === '/api/board') {
    const b = await readBody(req);
    const text = String(b.text == null ? '' : b.text).trim();
    if (!text) return json(res, 400, { ok: false, error: 'empty note' });
    if (b.pinned !== undefined && typeof b.pinned !== 'boolean') {
      return json(res, 400, { ok: false, error: 'pinned must be a boolean' });
    }
    const tx = addNote({ text, author: b.author, pinned: b.pinned });
    if (!tx.ok) return json(res, 500, { ok: false, error: tx.error });
    const note = tx.note;
    broadcast({ type: 'board', action: 'add', note, notes: boardView(), ts: Date.now() });
    return json(res, 200, { ok: true, note });
  }
  if (req.method === 'POST' && p === '/api/board/pin') {
    const b = await readBody(req);
    if (typeof b.pinned !== 'boolean') {
      return json(res, 400, { ok: false, error: 'pinned must be a boolean' });
    }
    const n = board.notes.find((x) => x.id === b.id);
    if (!n) return json(res, 404, { ok: false, error: 'no such note' });
    const tx = transactBoard((target) => {
      const note = target.notes.find((x) => x.id === b.id);
      note.pinned = b.pinned;
      return { note };
    });
    if (!tx.ok) return json(res, 500, { ok: false, error: tx.error });
    broadcast({ type: 'board', action: 'pin', note: tx.note, notes: boardView(), ts: Date.now() });
    return json(res, 200, { ok: true, note: tx.note });
  }
  if (req.method === 'POST' && p === '/api/board/delete') {
    const b = await readBody(req);
    const i = board.notes.findIndex((x) => x.id === b.id);
    if (i < 0) return json(res, 404, { ok: false, error: 'no such note' });
    const tx = transactBoard((target) => ({ removed: target.notes.splice(target.notes.findIndex((x) => x.id === b.id), 1)[0] }));
    if (!tx.ok) return json(res, 500, { ok: false, error: tx.error });
    broadcast({ type: 'board', action: 'delete', note: tx.removed, notes: boardView(), ts: Date.now() });
    return json(res, 200, { ok: true });
  }

  // ---- shared task list (also ungated by pause, like the board)
  if (req.method === 'GET' && p === '/api/tasks') {
    return json(res, 200, { tasks: tasksView() });
  }
  if (req.method === 'POST' && p === '/api/tasks') {
    const b = await readBody(req);
    const text = String(b.text == null ? '' : b.text).trim();
    if (!text) return json(res, 400, { ok: false, error: 'empty task' });
    const requestedAssignee = String(b.assignee == null ? '' : b.assignee).slice(0, 60);
    const workerAssignee = /^(?:worker|media)-/i.test(requestedAssignee);
    if (workerAssignee) {
      const invalid = taskAssigneeError(requestedAssignee);
      if (invalid) return json(res, 400, { ok: false, error: invalid });
    }
    if (Object.prototype.hasOwnProperty.call(b, 'wakeWorker')) {
      if (typeof b.wakeWorker !== 'boolean') {
        return json(res, 400, { ok: false, error: 'wakeWorker must be a boolean' });
      }
      const assignedWake = workerAssignee;
      if (b.wakeWorker !== assignedWake) {
        return json(res, 400, {
          ok: false,
          error: assignedWake
            ? 'an explicitly assigned task must wake its worker; create it, then use task-hold to disable retries'
            : 'wakeWorker=true requires an assigned worker'
        });
      }
    }
    const tx = addTask({ text, by: b.by, assignee: b.assignee });
    if (!tx.ok) return json(res, 500, { ok: false, error: tx.error });
    const task = tx.task;
    broadcast({ type: 'tasks', action: 'add', task, tasks: tasksView(), ts: Date.now() });
    // Dispatch tee: an explicit assignment wakes (or spawns) that worker,
    // independent of the caller's display/author label.
    // The durable record is the task in board.json above; the worker's stdin is
    // only the wake mechanism. Never spawns while paused; leaves the task queued.
    // The [task <id>] tag is how the worker later calls `ppt done <id>` on
    // exactly this task; without it a completed task stayed "open" forever
    // (verified live: two tasks from an earlier test sat open with no way for
    // the worker that finished them to ever say so).
    let dispatch = null;
    if (task.wakeWorker) {
      if (!agentSweepReady) {
        // The task is already durable. Hold only its wake signal until stale
        // children from the prior server have finished shutting down.
        dispatch = { ok: false, reason: 'agent restart cleanup in progress' };
      } else if (state.paused) {
        // Do not even write to an already-live worker while paused. Letting it
        // consume the task only to hit the edit gate would turn a durable retry
        // into an idle open record with no later wake signal.
        dispatch = { ok: false, reason: 'paused' };
      } else {
        try { dispatch = Agents.spawnOrWrite(task.assignee, 'worker', taskWakeMessage(task, false)); }
        catch (e) {
          console.error('task committed but worker dispatch failed:', e && (e.stack || e));
          dispatch = { ok: false, reason: 'worker dispatch failed' };
        }
      }
      if (!dispatch || dispatch.ok === false) {
        const retryDelay = dispatch && (
          dispatch.reason === 'paused' ||
          dispatch.reason === 'agent restart cleanup in progress'
        ) ? 0 : TASK_RECOVERY_RETRY_MS;
        queueTaskRecovery(task, retryDelay);
      }
    }
    return json(res, 200, { ok: true, task, dispatch });
  }
  if (req.method === 'POST' && p === '/api/tasks/protection-grant') {
    const b = await readBody(req);
    if (!isRecord(b)) return json(res, 400, { ok: false, error: 'protection grant must be an object' });
    const allowed = new Set(['id', 'slideIds', 'minutes', 'revoke', 'by']);
    const unknown = Object.keys(b).find((key) => !allowed.has(key));
    if (unknown) return json(res, 400, { ok: false, error: `unsupported protection grant field "${unknown}"` });

    const id = typeof b.id === 'string' ? b.id.trim() : '';
    const who = typeof b.by === 'string' ? b.by.trim() : '';
    if (!id) return json(res, 400, { ok: false, error: 'missing task id' });
    if (!who) return json(res, 400, { ok: false, error: 'missing by' });
    if (id.length > 120) return json(res, 400, { ok: false, error: 'task id is too long' });
    if (who.length > 60) return json(res, 400, { ok: false, error: 'by is too long' });
    if (isSuiteAgentActor(who)) {
      return json(res, 403, { ok: false, error: 'only a human may grant delegated protection control' });
    }
    if (b.revoke !== undefined && typeof b.revoke !== 'boolean') {
      return json(res, 400, { ok: false, error: 'revoke must be a boolean' });
    }

    const current = findTask(id);
    if (!current) return json(res, 404, { ok: false, error: 'no such task' });
    if (!['open', 'claimed'].includes(current.status)) {
      return json(res, 409, { ok: false, error: `only active tasks may receive a protection grant (task is ${current.status})` });
    }
    const taskActor = String(current.assignee || current.claimedBy || '');
    if (!isWorkerAgentName(taskActor)) {
      return json(res, 409, { ok: false, error: 'task must be assigned to a worker or media agent' });
    }
    if (current.claimedBy && current.claimedBy !== taskActor) {
      return json(res, 409, { ok: false, error: 'task is claimed by a different editor' });
    }

    const revoke = b.revoke === true;
    let slideIds = [];
    let minutes = 60;
    if (!revoke) {
      if (!Array.isArray(b.slideIds) || !b.slideIds.length) {
        return json(res, 400, { ok: false, error: 'slideIds must be a non-empty array' });
      }
      slideIds = Array.from(new Set(b.slideIds.map((value) =>
        typeof value === 'string' ? value.trim() : '')));
      if (slideIds.some((value) => !value)) {
        return json(res, 400, { ok: false, error: 'slideIds must contain non-empty strings' });
      }
      const unknownSlide = slideIds.find((slideId) => !findSlide(slideId));
      if (unknownSlide) return json(res, 400, { ok: false, error: `no such slide: ${unknownSlide}` });
      if (slideIds.length > 64) return json(res, 400, { ok: false, error: 'too many delegated slides' });
      if (b.minutes !== undefined) {
        if (!Number.isSafeInteger(b.minutes) || b.minutes < 1 || b.minutes > 240) {
          return json(res, 400, { ok: false, error: 'minutes must be an integer from 1 to 240' });
        }
        minutes = b.minutes;
      }
    } else if (b.slideIds !== undefined || b.minutes !== undefined) {
      return json(res, 400, { ok: false, error: 'revoke cannot include slideIds or minutes' });
    }

    const changedAt = Date.now();
    if (!revoke && isRecord(current.protectionGrant)) {
      return json(res, 409, {
        ok: false,
        error: 'task already has a protection grant; revoke it and use a new task for a new grant'
      });
    }
    const tx = transactBoard((target) => {
      const task = findTask(id, target);
      if (revoke) {
        if (!isRecord(task.protectionGrant) || task.protectionGrant.revokedAt) {
          return { task, changed: false };
        }
        task.protectionGrant = Object.assign({}, task.protectionGrant, {
          revokedAt: changedAt,
          revokedBy: who
        });
      } else {
        task.protectionGrant = {
          version: 1,
          slideIds,
          editOps: ['add-image'],
          // Delegation never transfers whole-slide protection control. The
          // protected add-image bypass leaves the human's existing slide lock
          // untouched; the agent may only add a direct lock to the exact
          // generated picture it just inserted.
          protectionModes: ['direct-generated-decor'],
          grantedTo: taskActor,
          grantedBy: who,
          grantedAt: changedAt,
          expiresAt: changedAt + minutes * 60 * 1000
        };
      }
      task.updatedAt = changedAt;
      task.updatedBy = who;
      return { task, changed: true };
    });
    if (!tx.ok) return json(res, 500, { ok: false, error: tx.error });
    broadcast({
      type: 'tasks',
      action: revoke ? 'protection-revoke' : 'protection-grant',
      task: tx.task,
      tasks: tasksView(),
      ts: changedAt
    });
    return json(res, 200, { ok: true, changed: tx.changed, task: tx.task });
  }
  if (req.method === 'POST' && p === '/api/tasks/update') {
    const b = await readBody(req);
    if (!isRecord(b)) return json(res, 400, { ok: false, error: 'task update must be an object' });
    const allowed = new Set(['id', 'text', 'assignee', 'wakeWorker', 'by']);
    const unknown = Object.keys(b).find((key) => !allowed.has(key));
    if (unknown) return json(res, 400, { ok: false, error: `unsupported task update field "${unknown}"` });

    const id = typeof b.id === 'string' ? b.id.trim() : '';
    const who = typeof b.by === 'string' ? b.by.trim() : '';
    if (!id) return json(res, 400, { ok: false, error: 'missing task id' });
    if (!who) return json(res, 400, { ok: false, error: 'missing by' });
    if (id.length > 120) return json(res, 400, { ok: false, error: 'task id is too long' });
    if (who.length > 60) return json(res, 400, { ok: false, error: 'by is too long' });
    if (isWorkerAgentName(who)) {
      return json(res, 403, { ok: false, error: 'workers may not update task instructions or assignments' });
    }

    const hasText = Object.prototype.hasOwnProperty.call(b, 'text');
    const hasAssignee = Object.prototype.hasOwnProperty.call(b, 'assignee');
    const hasWake = Object.prototype.hasOwnProperty.call(b, 'wakeWorker');
    if (!hasText && !hasAssignee && !hasWake) {
      return json(res, 400, { ok: false, error: 'task update needs text, assignee, or wakeWorker' });
    }
    let textValue;
    if (hasText) {
      if (typeof b.text !== 'string') return json(res, 400, { ok: false, error: 'text must be a string' });
      textValue = b.text.trim();
      if (!textValue) return json(res, 400, { ok: false, error: 'empty task text' });
      if (textValue.length > 2000) return json(res, 400, { ok: false, error: 'task text is too long (max 2000)' });
    }
    let assigneeValue;
    if (hasAssignee) {
      if (typeof b.assignee !== 'string') return json(res, 400, { ok: false, error: 'assignee must be a string' });
      assigneeValue = b.assignee.trim();
      if (assigneeValue.length > 60) return json(res, 400, { ok: false, error: 'assignee is too long' });
      const invalid = taskAssigneeError(assigneeValue);
      if (invalid) return json(res, 400, { ok: false, error: invalid });
    }
    if (hasWake && typeof b.wakeWorker !== 'boolean') {
      return json(res, 400, { ok: false, error: 'wakeWorker must be a boolean' });
    }

    const current = findTask(id);
    if (!current) return json(res, 404, { ok: false, error: 'no such task' });
    if (current.status !== 'open') {
      return json(res, 409, { ok: false, error: `only open tasks may be updated (task is ${current.status})` });
    }
    const requestedNextAssignee = hasAssignee ? assigneeValue : String(current.assignee || '');
    const nextText = hasText ? textValue : String(current.text || '');
    const nextWake = hasWake
      ? b.wakeWorker
      : (hasAssignee ? isWorkerAgentName(assigneeValue) : taskWakeIntent(current));
    let route = null;
    let nextAssignee = requestedNextAssignee;
    if (nextWake) {
      if (!nextAssignee) {
        return json(res, 400, { ok: false, error: 'wakeWorker=true requires an assigned worker' });
      }
      const invalid = taskAssigneeError(nextAssignee);
      if (invalid) return json(res, 400, { ok: false, error: invalid });
      route = Agents.routeTask(nextText, nextAssignee);
      nextAssignee = route.assignee;
      if (!nextAssignee) {
        return json(res, 409, { ok: false, error: `${route.pool} worker pool has no available route` });
      }
    }

    const updatedAt = Date.now();
    const tx = transactBoard((target) => {
      const task = findTask(id, target);
      const textChanged = hasText && textValue !== task.text;
      const assigneeChanged = nextAssignee !== String(task.assignee || '');
      if (textChanged || assigneeChanged) {
        const revision = { ts: updatedAt, by: who };
        if (textChanged) revision.text = task.text;
        if (assigneeChanged) revision.assignee = String(task.assignee || '');
        const revisions = Array.isArray(task.revisions) ? task.revisions.slice(-(TASK_REVISION_LIMIT - 1)) : [];
        task.revisions = revisions.concat(revision);
      }
      if (hasText) task.text = textValue;
      if (hasAssignee || assigneeChanged) task.assignee = nextAssignee;
      if (hasWake || hasAssignee) task.wakeWorker = nextWake;
      if (route) {
        task.pool = route.pool;
        task.classifiedPool = route.classifiedPool;
        task.requestedAssignee = requestedNextAssignee !== nextAssignee ? requestedNextAssignee : null;
        task.routeFallback = !!route.fallback;
        task.routeReason = route.reason;
      } else if (hasAssignee) {
        task.pool = agentPoolForName(nextAssignee) || null;
      }
      task.updatedAt = updatedAt;
      task.updatedBy = who;
      return { task };
    });
    if (!tx.ok) return json(res, 500, { ok: false, error: tx.error });

    let dispatch = null;
    if (!taskWantsWorkerWake(tx.task)) {
      clearTaskRecovery(tx.task.id);
    } else {
      queueTaskRecovery(tx.task);
      dispatch = dispatchTaskRecovery({ force: true, taskId: tx.task.id, recovered: false }).result;
    }
    broadcast({ type: 'tasks', action: 'update', task: tx.task, tasks: tasksView(), ts: Date.now() });
    return json(res, 200, { ok: true, task: tx.task, dispatch });
  }
  if (req.method === 'POST' && p === '/api/tasks/claim') {
    const b = await readBody(req);
    const t = findTask(b.id);
    if (!t) return json(res, 404, { ok: false, error: 'no such task' });
    if (t.status === 'done') return json(res, 400, { ok: false, error: 'task already done' });
    const who = typeof b.by === 'string' ? b.by.trim().slice(0, 60) : '';
    if (!who) return json(res, 400, { ok: false, error: 'missing by' });
    if (t.assignee && t.assignee !== who) {
      return json(res, 409, { ok: false, error: `task is assigned to ${t.assignee}` });
    }
    if (t.status === 'claimed') {
      if (t.claimedBy === who) return json(res, 200, { ok: true, task: t, alreadyClaimed: true });
      return json(res, 409, { ok: false, error: `task is already claimed by ${t.claimedBy || 'another editor'}` });
    }
    const tx = transactBoard((target) => {
      const task = findTask(b.id, target);
      task.status = 'claimed'; task.claimedBy = who;
      return { task };
    });
    if (!tx.ok) return json(res, 500, { ok: false, error: tx.error });
    broadcast({ type: 'tasks', action: 'claim', task: tx.task, tasks: tasksView(), ts: Date.now() });
    return json(res, 200, { ok: true, task: tx.task });
  }
  if (req.method === 'POST' && p === '/api/tasks/done') {
    const b = await readBody(req);
    const t = findTask(b.id);
    if (!t) return json(res, 404, { ok: false, error: 'no such task' });
    const who = typeof b.by === 'string' ? b.by.trim().slice(0, 60) : '';
    if (!who) return json(res, 400, { ok: false, error: 'missing by' });
    // The lead and human surfaces can close a task as oversight. A worker,
    // however, may only close work assigned or claimed by itself; otherwise a
    // stale/mistyped task id lets one child silently complete another's work.
    if (isWorkerAgentName(who)) {
      if (t.assignee && t.assignee !== who) {
        return json(res, 409, { ok: false, error: `task is assigned to ${t.assignee}` });
      }
      if (t.claimedBy && t.claimedBy !== who) {
        return json(res, 409, { ok: false, error: `task is claimed by ${t.claimedBy}` });
      }
    }
    // Completion is idempotent. A recovered worker may verify that an earlier
    // attempt already finished and repeat `done`; rewriting doneTs and emitting
    // another completion event would make completed work look duplicated.
    if (t.status === 'done') {
      clearTaskRecovery(t.id);
      return json(res, 200, { ok: true, task: t, alreadyDone: true });
    }
    const tx = transactBoard((target) => {
      const task = findTask(b.id, target);
      task.status = 'done'; task.doneTs = Date.now();
      if (!task.claimedBy) task.claimedBy = who;
      return { task };
    });
    if (!tx.ok) return json(res, 500, { ok: false, error: tx.error });
    clearTaskRecovery(tx.task.id);
    broadcast({ type: 'tasks', action: 'done', task: tx.task, tasks: tasksView(), ts: Date.now() });
    return json(res, 200, { ok: true, task: tx.task });
  }
  if (req.method === 'POST' && p === '/api/tasks/delete') {
    const b = await readBody(req);
    const i = board.tasks.findIndex((x) => x.id === b.id);
    if (i < 0) return json(res, 404, { ok: false, error: 'no such task' });
    const tx = transactBoard((target) => ({ removed: target.tasks.splice(target.tasks.findIndex((x) => x.id === b.id), 1)[0] }));
    if (!tx.ok) return json(res, 500, { ok: false, error: tx.error });
    clearTaskRecovery(tx.removed.id);
    broadcast({ type: 'tasks', action: 'delete', task: tx.removed, tasks: tasksView(), ts: Date.now() });
    return json(res, 200, { ok: true });
  }
  // Return (and optionally claim) the next task for a session: one aimed at
  // that session first, else an unassigned one. This is the primitive a
  // self-polling `/loop` worker calls each tick; the human/relay path ignores it.
  if (req.method === 'POST' && p === '/api/tasks/next') {
    const b = await readBody(req);
    const who = typeof b.by === 'string' ? b.by.trim().slice(0, 60) : '';
    if (b.claim === true && !who) return json(res, 400, { ok: false, error: 'missing by' });
    const open = board.tasks.filter((t) => t.status === 'open').sort((a, b) => a.ts - b.ts);
    const mine = who ? open.find((t) => t.assignee === who) : null;
    const any = (b.includeUnassigned === false) ? null : open.find((t) => !t.assignee);
    const t = mine || any || null;
    if (t && b.claim) {
      const tx = transactBoard((target) => {
        const task = findTask(t.id, target);
        task.status = 'claimed'; task.claimedBy = who;
        return { task };
      });
      if (!tx.ok) return json(res, 500, { ok: false, error: tx.error });
      broadcast({ type: 'tasks', action: 'claim', task: tx.task, tasks: tasksView(), ts: Date.now() });
      return json(res, 200, { ok: true, task: tx.task });
    }
    return json(res, 200, { ok: true, task: t });
  }

  // ---- standing loops (recurring check prompts; also ungated by pause)
  if (req.method === 'GET' && p === '/api/loops') {
    return json(res, 200, { loops: loopView() });
  }
  if (req.method === 'POST' && p === '/api/loops') {
    const b = await readBody(req);
    const text = String(b.text == null ? '' : b.text).trim();
    if (!text) return json(res, 400, { ok: false, error: 'empty loop' });
    const tx = addLoop({ text, author: b.author, cadence: b.cadence });
    if (!tx.ok) return json(res, 500, { ok: false, error: tx.error });
    const loop = tx.loop;
    broadcast({ type: 'loops', action: 'add', loop, loops: loopView(), ts: Date.now() });
    return json(res, 200, { ok: true, loop });
  }
  if (req.method === 'POST' && p === '/api/loops/toggle') {
    const b = await readBody(req);
    if (typeof b.enabled !== 'boolean') {
      return json(res, 400, { ok: false, error: 'enabled must be a boolean' });
    }
    const l = findLoop(b.id);
    if (!l) return json(res, 404, { ok: false, error: 'no such loop' });
    const tx = transactBoard((target) => {
      const loop = findLoop(b.id, target);
      loop.enabled = b.enabled;
      return { loop };
    });
    if (!tx.ok) return json(res, 500, { ok: false, error: tx.error });
    broadcast({ type: 'loops', action: 'toggle', loop: tx.loop, loops: loopView(), ts: Date.now() });
    return json(res, 200, { ok: true, loop: tx.loop });
  }
  if (req.method === 'POST' && p === '/api/loops/delete') {
    const b = await readBody(req);
    const i = board.loops.findIndex((x) => x.id === b.id);
    if (i < 0) return json(res, 404, { ok: false, error: 'no such loop' });
    const tx = transactBoard((target) => ({ removed: target.loops.splice(target.loops.findIndex((x) => x.id === b.id), 1)[0] }));
    if (!tx.ok) return json(res, 500, { ok: false, error: tx.error });
    broadcast({ type: 'loops', action: 'delete', loop: tx.removed, loops: loopView(), ts: Date.now() });
    return json(res, 200, { ok: true });
  }
  // Record that a session just ran this loop, so the dashboard shows a heartbeat
  // ("last checked 2m ago by …"). Called by the /loop runner after each pass.
  if (req.method === 'POST' && p === '/api/loops/ran') {
    const b = await readBody(req);
    const l = findLoop(b.id);
    if (!l) return json(res, 404, { ok: false, error: 'no such loop' });
    const tx = transactBoard((target) => {
      const loop = findLoop(b.id, target);
      loop.lastRun = Date.now();
      loop.lastBy = String(b.by == null ? '' : b.by).slice(0, 60);
      loop.lastResult = b.result == null ? null : String(b.result).slice(0, 400);
      return { loop };
    });
    if (!tx.ok) return json(res, 500, { ok: false, error: tx.error });
    broadcast({ type: 'loops', action: 'ran', loop: tx.loop, loops: loopView(), ts: Date.now() });
    return json(res, 200, { ok: true, loop: tx.loop });
  }
  // Master switch for the scheduler. Not pause-gated: turning recurrence OFF
  // must work while frozen, same reasoning as the usage profile.
  if (req.method === 'POST' && p === '/api/loops/runner') {
    const b = await readBody(req);
    if (Agents.isAgent(b.by)) {
      return json(res, 403, { ok: false, error: 'agents may not toggle the loop runner' });
    }
    if (typeof b.enabled !== 'boolean') {
      return json(res, 400, { ok: false, error: 'enabled must be a boolean' });
    }
    const next = copyState();
    next.loopRunner = b.enabled;
    appendStateLog(next, { kind: 'loop-runner', by: b.by || 'human', enabled: next.loopRunner });
    if (!persistState(next)) {
      return json(res, 500, { ok: false, error: 'could not save loop-runner state' });
    }
    state = next;
    broadcast({ type: 'loops', action: 'runner', loops: loopView(), loopRunner: loopRunnerView(), ts: Date.now() });
    return json(res, 200, { ok: true, loopRunner: loopRunnerView() });
  }

  // ---- durable human-controlled content protections. These are distinct
  // from advisory slide claims: they survive restarts and are a hard edit /
  // history gate for every editor. Protection controls remain available while
  // paused so the human can prepare or release a target without reopening the
  // deck to agents.
  if (req.method === 'GET' && p === '/api/protections') {
    return json(res, 200, {
      protections: protectionView(),
      protectionExceptions: protectionExceptionView(),
      protectionHistory: protectionHistoryView()
    });
  }
  if (req.method === 'POST' && p === '/api/protections/toggle') {
    const b = await readBody(req);
    const parsed = protectionFromToggleBody(b);
    if (!parsed.ok) return json(res, 400, parsed);
    let delegation = null;
    if (isSuiteAgentActor(parsed.by)) {
      if (state.paused) {
        return json(res, 423, {
          ok: false, error: 'paused', pausedBy: state.pausedBy, pausedAt: state.pausedAt
        });
      }
      if (b.delegatedMode !== 'direct-generated-decor') {
        return json(res, 403, {
          ok: false,
          error: 'agents may only protect a generated picture through an explicit delegated mode'
        });
      }
      const delegated = delegatedProtectionMode(
        parsed.by, b.taskId, parsed.protection, parsed.protected, b.delegatedMode, Date.now()
      );
      if (!delegated.ok) return json(res, 403, { ok: false, error: delegated.error });
      delegation = delegated;
      if (b.delegatedMode === 'direct-generated-decor') {
        const slide = model.slides.find((item) => item.id === parsed.protection.slideId);
        const decor = protectionObject(slide, 'decor', parsed.protection.objectId);
        if (!decor || decor.generated !== true || decor.kind !== 'pic') {
          return json(res, 403, {
            ok: false,
            error: 'delegated direct decor protection is limited to generated pictures'
          });
        }
      }
    } else if (b.taskId !== undefined || b.delegatedMode !== undefined) {
      return json(res, 400, {
        ok: false,
        error: 'taskId and delegatedMode are only valid for a delegated agent protection update'
      });
    }

    const key = protectionKey(parsed.protection);
    const existing = state.protections.find((protection) => protectionKey(protection) === key) || null;
    const existingException = parsed.protection.kind === 'object'
      ? state.protectionExceptions.find((exception) => protectionKey(exception) === key) || null
      : null;
    const parentSlideLock = parsed.protection.kind === 'object'
      ? state.protections.find((protection) =>
          protection.kind === 'slide' && protection.slideId === parsed.protection.slideId) || null
      : null;
    const slideScopedObjectLocks = parsed.protection.kind === 'slide'
      ? state.protections.filter((protection) =>
          protection.kind === 'object' && protection.slideId === parsed.protection.slideId)
      : [];
    const slideScopedExceptions = parsed.protection.kind === 'slide'
      ? state.protectionExceptions.filter((exception) =>
          exception.slideId === parsed.protection.slideId)
      : [];
    // Under a slide lock, an object toggle controls the inverse branch: unlock
    // adds an editable exception, lock removes it. With no parent lock, the same
    // endpoint controls a direct object lock. This is the complete two-path UI
    // model and keeps the request contract intentionally tiny.
    // A slide toggle is recursive and canonical: either one slide row exists
    // with no child overrides, or no row on that slide exists at all. This also
    // cleans valid legacy mixtures of slide locks, direct child locks, and
    // inverse exceptions without touching model/object history.
    const changed = delegation
      ? !existing
      : (parsed.protection.kind === 'slide'
          ? (parsed.protected
              ? (!existing || slideScopedObjectLocks.length > 0 || slideScopedExceptions.length > 0)
              : (!!existing || slideScopedObjectLocks.length > 0 || slideScopedExceptions.length > 0))
          : (parentSlideLock
              ? (parsed.protected
                  ? !!existingException || !!existing
                  : !existingException || !!existing)
              : (parsed.protected ? !existing : !!existing)));
    if (!changed) {
      return json(res, 200, {
        ok: true,
        changed: false,
        protected: parsed.protected,
        protection: existingException || existing || parsed.protection,
        protections: protectionView(),
        protectionExceptions: protectionExceptionView(),
        protectionHistory: protectionHistoryView(),
        delegation: delegation ? {
          taskId: delegation.task.id,
          authorizedBy: delegation.grant.grantedBy
        } : undefined
      });
    }

    const next = copyState();
    const changedAt = Date.now();
    let changedProtection;
    if (delegation) {
      changedProtection = Object.assign({}, parsed.protection, {
        by: parsed.by,
        createdAt: changedAt
      });
      next.protections.push(changedProtection);
    } else if (parsed.protection.kind === 'slide') {
      changedProtection = existing || Object.assign({}, parsed.protection, {
        by: parsed.by,
        createdAt: changedAt
      });
      next.protections = next.protections.filter(
        (protection) => protection.slideId !== parsed.protection.slideId
      );
      next.protectionExceptions = next.protectionExceptions.filter(
        (exception) => exception.slideId !== parsed.protection.slideId
      );
      if (parsed.protected) next.protections.push(changedProtection);
    } else if (parentSlideLock) {
      // Direct child rows beneath a slide lock are a supported legacy shape but
      // redundant. Whichever inverse object action the human chooses, collapse
      // that stale row while applying the exception branch.
      next.protections = next.protections.filter(
        (protection) => protectionKey(protection) !== key
      );
      if (parsed.protected) {
        changedProtection = existingException || existing || Object.assign({}, parsed.protection, {
          by: parsed.by,
          createdAt: changedAt
        });
        next.protectionExceptions = next.protectionExceptions.filter(
          (exception) => protectionKey(exception) !== key
        );
      } else {
        changedProtection = existingException || Object.assign({}, parsed.protection, {
          by: parsed.by,
          createdAt: changedAt
        });
        if (!existingException) next.protectionExceptions.push(changedProtection);
      }
    } else if (parsed.protected) {
        changedProtection = Object.assign({}, parsed.protection, {
          by: parsed.by,
          createdAt: changedAt
        });
        next.protections.push(changedProtection);
    } else {
      changedProtection = existing;
      next.protections = next.protections.filter((protection) => protectionKey(protection) !== key);
    }
    const historyEntry = appendProtectionHistory(next, Object.assign({
      action: parsed.protected ? 'lock' : 'unlock',
      kind: parsed.protection.kind,
      slideId: parsed.protection.slideId,
      by: parsed.by,
      ts: changedAt,
      taskId: delegation ? delegation.task.id : undefined,
      authorizedBy: delegation ? delegation.grant.grantedBy : undefined,
      authorizedAt: delegation ? delegation.grant.grantedAt : undefined
    }, parsed.protection.kind === 'object'
      ? {
          objectId: parsed.protection.objectId,
          objectKind: parsed.protection.objectKind
        }
      : {}));
    appendStateLog(next, {
      ts: changedAt,
      kind: parsed.protected ? 'protect' : 'unprotect',
      by: parsed.by,
      protection: Object.assign({}, changedProtection),
      authorizationTaskId: delegation ? delegation.task.id : undefined,
      authorizedBy: delegation ? delegation.grant.grantedBy : undefined
    });
    if (!persistState(next)) {
      return json(res, 500, {
        ok: false,
        error: `could not ${parsed.protected ? 'save' : 'remove'} content protection`
      });
    }
    state = next;
    const protections = protectionView();
    const protectionExceptions = protectionExceptionView();
    const protectionHistory = protectionHistoryView();
    broadcast({
      type: 'protections',
      protections,
      protectionExceptions,
      protectionHistory,
      change: Object.assign({}, historyEntry),
      delegation: delegation ? {
        taskId: delegation.task.id,
        authorizedBy: delegation.grant.grantedBy
      } : undefined,
      ts: changedAt
    });
    return json(res, 200, {
      ok: true,
      changed: true,
      protected: parsed.protected,
      protection: Object.assign({}, changedProtection),
      protections,
      protectionExceptions,
      protectionHistory,
      change: Object.assign({}, historyEntry),
      delegation: delegation ? {
        taskId: delegation.task.id,
        authorizedBy: delegation.grant.grantedBy
      } : undefined
    });
  }

  // ---- advisory slide locks (also ungated by pause; see the `locks` block above)
  if (req.method === 'GET' && p === '/api/locks') {
    return json(res, 200, { locks: lockView() });
  }
  if (req.method === 'POST' && p === '/api/locks') {
    const b = await readBody(req);
    const by = String(b.by == null ? '' : b.by).trim().slice(0, 60);
    if (!by) return json(res, 400, { ok: false, error: 'missing by' });
    const ids = Array.isArray(b.slideIds) ? b.slideIds : (b.slideId ? [b.slideId] : []);
    if (!ids.length) return json(res, 400, { ok: false, error: 'missing slideIds' });
    const note = b.note == null ? '' : String(b.note).slice(0, 200);
    const force = b.force === true;
    const now = Date.now();
    const locked = [], conflicts = [], unknown = [];
    for (const id of ids) {
      if (!findSlide(id)) { unknown.push(id); continue; }
      const existing = locks.get(id);
      const live = !!existing && (now - existing.ts <= LOCK_TTL); // an expired lock is free to reclaim
      if (live && existing.by !== by && !force) {
        // Refuse: don't overwrite someone else's live claim. This used to
        // take it anyway (locks.set ran unconditionally below), which meant
        // the SECOND claimant silently stole the lock and the ORIGINAL
        // owner's next edit got warned it was locked by the thief.
        conflicts.push({ slideId: id, heldBy: existing.by, heldForMs: now - existing.ts, refused: true });
        continue;
      }
      locks.set(id, { slideId: id, by, ts: now, note });
      locked.push(id);
    }
    if (locked.length) broadcast({ type: 'locks', locks: lockView(), ts: now });
    return json(res, 200, { ok: true, locked, conflicts, unknown });
  }
  if (req.method === 'POST' && p === '/api/locks/release') {
    const b = await readBody(req);
    const by = String(b.by == null ? '' : b.by).trim().slice(0, 60);
    if (!by) return json(res, 400, { ok: false, error: 'missing by' });
    const all = b.slideIds === 'all';
    if (!all && (!Array.isArray(b.slideIds) || b.slideIds.length === 0 ||
        !b.slideIds.every((id) => typeof id === 'string' && id.trim()))) {
      return json(res, 400, { ok: false, error: 'slideIds must be "all" or a non-empty array of slide ids' });
    }
    const ids = all ? null : [...new Set(b.slideIds)];
    const notMine = [];
    if (!all) {
      for (const id of ids) {
        const existing = locks.get(id);
        if (existing && existing.by !== by) notMine.push(id);
      }
    }
    const changed = releaseLocksFor(by, ids);
    if (changed) broadcast({ type: 'locks', locks: lockView(), ts: Date.now() });
    return json(res, 200, { ok: true, released: changed, notMine });
  }

  // ---- pause / resume
  if (req.method === 'POST' && p === '/api/pause') {
    const b = await readBody(req);
    const response = await queuePauseTransition(async () => {
      const outcome = await doPause(b.by);
      const body = snapshot();
      return outcome.ok
        ? { status: 200, body }
        : { status: 500, body: Object.assign({ ok: false, error: outcome.error }, body) };
    });
    return json(res, response.status, response.body);
  }
  if (req.method === 'POST' && p === '/api/resume') {
    const b = await readBody(req);
    // Pause is the human's hard stop. Undo/redo already bar agents in code on
    // the principle that a prompt is not an access control; resume was the
    // inverse hole, letting an agent lift the very freeze that exists to stop it.
    if (Agents.isAgent(b.by)) {
      return json(res, 403, { ok: false, error: 'agents may not resume: pause is the human\'s hard stop' });
    }
    const response = await queuePauseTransition(async () => {
      const outcome = await doResume(b.by);
      if (outcome.ok) dispatchTaskRecovery({ force: true });
      const body = snapshot();
      return outcome.ok
        ? { status: 200, body }
        : { status: 500, body: Object.assign({ ok: false, error: outcome.error }, body) };
    });
    return json(res, response.status, response.body);
  }

  // ---- non-mutating forced re-render. Unlike every /api/edit-backed command,
  // this changes NO model state: it re-runs the debounced render pipeline
  // against the CURRENT model so a caller can refresh presentation.pptx and the
  // thumbnails without bumping model.rev, rewriting the title, or pushing an
  // entry onto the undo/redo stacks. Pause is a hard stop: runRender() itself
  // refuses to publish while paused, so answering 423 here (instead of a hollow
  // 200) keeps the CLI's documented "a 423 means stop" contract intact rather
  // than claiming success for a render that could never run.
  if (req.method === 'POST' && p === '/api/render') {
    await readBody(req);
    if (state.paused) {
      return json(res, 423, { ok: false, error: 'paused', pausedBy: state.pausedBy, pausedAt: state.pausedAt });
    }
    // A forced render refreshes every derived thumbnail, matching the old
    // structural title-edit behavior without changing presentation state.
    dirtyAll = true;
    scheduleRender();
    return json(res, 200, { ok: true, rev: model.rev });
  }

  // ---- durable per-object version history. Reads are always safe. Restores
  // are human-only, pause-gated, stale-head checked, and pass through the same
  // protection scope used by every ordinary edit.
  if (req.method === 'GET' && p === '/api/object-history') {
    const target = parseObjectHistoryTarget({
      slideId: url.searchParams.get('slideId'),
      objectKind: url.searchParams.get('objectKind'),
      objectId: url.searchParams.get('objectId')
    });
    if (!target.ok) return json(res, 404, { ok: false, error: target.error });
    return json(res, 200, objectHistoryResponse(target.ref));
  }

  if (req.method === 'POST' && p === '/api/object-history/restore') {
    const b = await readBody(req);
    if (state.paused) {
      return json(res, 423, { ok: false, error: 'paused', pausedBy: state.pausedBy, pausedAt: state.pausedAt });
    }
    const by = typeof b.by === 'string' ? b.by.trim() : '';
    if (!by || by.length > 60) return json(res, 400, { ok: false, error: 'by is required and must be at most 60 characters' });
    if (isObjectHistoryAgentActor(by)) return json(res, 403, { ok: false, error: 'agents may not restore object history' });
    const target = parseObjectHistoryTarget(b);
    if (!target.ok) return json(res, 404, { ok: false, error: target.error });
    const entry = target.entry;
    const currentHead = entry.timeline[entry.timeline.length - 1];
    if (typeof b.expectedHeadId !== 'string' || b.expectedHeadId !== currentHead) {
      return json(res, 409, { ok: false, error: 'object history changed; refresh and try again', headId: currentHead });
    }
    const versionIndex = entry.timeline.indexOf(b.versionId);
    if (versionIndex < 0) return json(res, 400, { ok: false, error: 'versionId is not in the active history list' });
    if (versionIndex === entry.timeline.length - 1) {
      return json(res, 400, { ok: false, error: 'that version is already current' });
    }
    const targetProtectionConflict = protectionConflictForScope({
      slides: [target.ref.slideId], wholeSlides: [], objects: [target.ref]
    });
    if (targetProtectionConflict) {
      return json(res, 423, protectionDenial(targetProtectionConflict, 'restore'));
    }

    const beforeModel = cloneJSON(model);
    const candidate = cloneJSON(model);
    const selected = entry.versions[b.versionId];
    const applied = applyElementHistoryState(candidate, target.ref, selected.state);
    if (!applied.ok) return json(res, 409, { ok: false, error: applied.error });
    const invalidModel = validateModelDocument(candidate, true);
    if (invalidModel) return json(res, 409, { ok: false, error: `historical version is invalid: ${invalidModel}` });
    const protectionScope = protectionScopeBetween(beforeModel, candidate, { type: 'object-history-restore' });
    const protectionConflict = protectionConflictForScope(protectionScope);
    if (protectionConflict) return json(res, 423, protectionDenial(protectionConflict, 'restore'));

    candidate.rev = (model.rev || 0) + 1;
    const beforeHistory = elementHistory;
    const candidateHistory = cloneJSON(elementHistory);
    const key = elementHistoryKey(target.ref);
    const nextEntry = candidateHistory.entries[key];
    nextEntry.restoreUndos.push({
      token: `r_${crypto.randomBytes(12).toString('hex')}`,
      createdAt: Date.now(),
      timeline: [...nextEntry.timeline]
    });
    if (nextEntry.restoreUndos.length > ELEMENT_HISTORY_RESTORE_UNDO_LIMIT) nextEntry.restoreUndos.shift();
    nextEntry.timeline = nextEntry.timeline.slice(0, versionIndex + 1);
    pruneElementHistoryVersions(nextEntry);
    candidateHistory.modelRev = candidate.rev;
    const patch = historyPatchForEntries(beforeHistory, candidateHistory, new Set([key]));
    const committed = persistModelAndElementHistory(candidate, candidateHistory);
    if (!committed.ok) return json(res, 500, { ok: false, error: committed.error });

    model = candidate;
    elementHistory = candidateHistory;
    const detail = `restored ${target.ref.objectKind} ${target.ref.objectId} to ${selected.summary}`;
    pushUndo(beforeModel, {
      editor: by, opType: 'object-history-restore', detail, rev: model.rev, ts: Date.now(),
      protectionScope, elementHistoryPatch: patch
    });
    redoStack = [];
    const affected = {
      slideId: target.ref.slideId,
      objectKind: target.ref.objectKind,
      objectId: target.ref.objectId,
      ...(target.ref.objectKind === 'element'
        ? { elementId: target.ref.objectId }
        : { decorId: target.ref.objectId })
    };
    markDirty('object-history-restore', affected);
    addLog({ kind: 'object-history-restore', editor: by, detail, rev: model.rev, affected });
    broadcast({
      type: 'edit', editor: by, opType: 'object-history-restore', detail, affected,
      rev: model.rev, model, undoCount: undoStack.length, redoCount: redoStack.length, ts: Date.now()
    });
    broadcast({ type: 'object-history', target: target.ref, rev: model.rev, ts: Date.now() });
    scheduleRender();
    return json(res, 200, Object.assign(objectHistoryResponse(target.ref), {
      rev: model.rev,
      historyPromotionPending: !!committed.promotionPending
    }));
  }

  if (req.method === 'POST' && p === '/api/object-history/undo-restore') {
    const b = await readBody(req);
    if (state.paused) {
      return json(res, 423, { ok: false, error: 'paused', pausedBy: state.pausedBy, pausedAt: state.pausedAt });
    }
    const by = typeof b.by === 'string' ? b.by.trim() : '';
    if (!by || by.length > 60) return json(res, 400, { ok: false, error: 'by is required and must be at most 60 characters' });
    if (isObjectHistoryAgentActor(by)) return json(res, 403, { ok: false, error: 'agents may not undo an object-history restore' });
    const target = parseObjectHistoryTarget(b);
    if (!target.ok) return json(res, 404, { ok: false, error: target.error });
    const entry = target.entry;
    const currentHead = entry.timeline[entry.timeline.length - 1];
    if (typeof b.expectedHeadId !== 'string' || b.expectedHeadId !== currentHead) {
      return json(res, 409, { ok: false, error: 'object history changed; refresh and try again', headId: currentHead });
    }
    const checkpoint = entry.restoreUndos[entry.restoreUndos.length - 1];
    if (!checkpoint) return json(res, 400, { ok: false, error: 'no restore to undo' });
    if (typeof b.checkpointToken !== 'string' || b.checkpointToken !== checkpoint.token) {
      return json(res, 409, { ok: false, error: 'restore undo changed; refresh and try again', topCheckpointToken: checkpoint.token });
    }
    const restoreHeadId = checkpoint.timeline[checkpoint.timeline.length - 1];
    const restoreVersion = entry.versions[restoreHeadId];
    if (!restoreVersion) return json(res, 409, { ok: false, error: 'restore checkpoint version is unavailable' });
    const targetProtectionConflict = protectionConflictForScope({
      slides: [target.ref.slideId], wholeSlides: [], objects: [target.ref]
    });
    if (targetProtectionConflict) {
      return json(res, 423, protectionDenial(targetProtectionConflict, 'undo restore'));
    }

    const beforeModel = cloneJSON(model);
    const candidate = cloneJSON(model);
    const applied = applyElementHistoryState(candidate, target.ref, restoreVersion.state);
    if (!applied.ok) return json(res, 409, { ok: false, error: applied.error });
    const invalidModel = validateModelDocument(candidate, true);
    if (invalidModel) return json(res, 409, { ok: false, error: `restore checkpoint is invalid: ${invalidModel}` });
    const protectionScope = protectionScopeBetween(beforeModel, candidate, { type: 'object-history-undo-restore' });
    const protectionConflict = protectionConflictForScope(protectionScope);
    if (protectionConflict) return json(res, 423, protectionDenial(protectionConflict, 'undo restore'));

    candidate.rev = (model.rev || 0) + 1;
    const beforeHistory = elementHistory;
    const candidateHistory = cloneJSON(elementHistory);
    const key = elementHistoryKey(target.ref);
    const nextEntry = candidateHistory.entries[key];
    nextEntry.restoreUndos.pop();
    nextEntry.timeline = [...checkpoint.timeline];
    pruneElementHistoryVersions(nextEntry);
    candidateHistory.modelRev = candidate.rev;
    const patch = historyPatchForEntries(beforeHistory, candidateHistory, new Set([key]));
    const committed = persistModelAndElementHistory(candidate, candidateHistory);
    if (!committed.ok) return json(res, 500, { ok: false, error: committed.error });

    model = candidate;
    elementHistory = candidateHistory;
    const detail = `undid history restore for ${target.ref.objectKind} ${target.ref.objectId}`;
    pushUndo(beforeModel, {
      editor: by, opType: 'object-history-undo-restore', detail, rev: model.rev, ts: Date.now(),
      protectionScope, elementHistoryPatch: patch
    });
    redoStack = [];
    const affected = {
      slideId: target.ref.slideId,
      objectKind: target.ref.objectKind,
      objectId: target.ref.objectId,
      ...(target.ref.objectKind === 'element'
        ? { elementId: target.ref.objectId }
        : { decorId: target.ref.objectId })
    };
    markDirty('object-history-undo-restore', affected);
    addLog({ kind: 'object-history-undo-restore', editor: by, detail, rev: model.rev, affected });
    broadcast({
      type: 'edit', editor: by, opType: 'object-history-undo-restore', detail, affected,
      rev: model.rev, model, undoCount: undoStack.length, redoCount: redoStack.length, ts: Date.now()
    });
    broadcast({ type: 'object-history', target: target.ref, rev: model.rev, ts: Date.now() });
    scheduleRender();
    return json(res, 200, Object.assign(objectHistoryResponse(target.ref), {
      rev: model.rev,
      historyPromotionPending: !!committed.promotionPending
    }));
  }

  // ---- the GATED edit endpoint
  if (req.method === 'POST' && p === '/api/edit') {
    const b = await readBody(req);
    if (state.paused) {
      return json(res, 423, { ok: false, error: 'paused', pausedBy: state.pausedBy, pausedAt: state.pausedAt });
    }
    const editor = (b.editor && String(b.editor).slice(0, 60)) || 'anonymous';
    const op = b.op || b;                 // allow either {op:{...}} or the op inline
    let editDelegation = null;
    if (b.taskId !== undefined) {
      const delegated = delegatedProtectedEdit(editor, b.taskId, op, Date.now());
      if (!delegated.ok) return json(res, 403, { ok: false, error: delegated.error });
      editDelegation = delegated;
    }
    const beforeSnapshot = JSON.parse(JSON.stringify(model));   // cheap at this deck's scale; enables undo for every op type with no reverse-logic per op
    // Captured before applyOp so a delete-slide that also releases its own
    // lock (see applyOp's 'delete-slide' branch) doesn't erase the evidence
    // this warning needs.
    const heldBeforeOp = op.slideId ? locks.get(op.slideId) : null;
    // Apply to an isolated candidate. Besides making a failed disk write
    // harmless, this also prevents a validation failure halfway through an
    // op (for example set-style's later fields) from leaking partial state.
    const candidate = JSON.parse(JSON.stringify(model));
    const liveModel = model;
    let result;
    try {
      model = candidate;
      result = applyOp(op);
    } finally {
      model = liveModel;
    }
    if (!result.ok) return json(res, 400, result);
    const protectionScope = protectionScopeBetween(beforeSnapshot, candidate, op);
    const protectionConflict = protectionConflictForScope(protectionScope);
    if (protectionConflict && !editDelegation) {
      // `applyOp` ran only against the detached candidate above. Refuse before
      // the authoritative model, model.json, history, log, locks, render
      // scheduler, or SSE stream sees any part of the attempted change.
      return json(res, 423, protectionDenial(protectionConflict, op.type));
    }

    candidate.rev = (candidate.rev || 0) + 1;
    const detail = describeOp(op, result);
    let historyTx;
    try {
      historyTx = historyCandidateForTransition(beforeSnapshot, candidate, editor, detail);
    } catch (error) {
      return json(res, 500, { ok: false, error: `could not capture object history: ${error.message || error}` });
    }
    const committed = persistModelAndElementHistory(candidate, historyTx.history);
    if (!committed.ok) return json(res, 500, { ok: false, error: committed.error });
    model = candidate;
    elementHistory = historyTx.history;
    markDirty(op.type, result.affected);
    if (result.lockReleased) locks.delete(op.slideId);
    pushUndo(beforeSnapshot, {
      editor, opType: op.type, detail, rev: model.rev, ts: Date.now(),
      protectionScope, elementHistoryPatch: historyTx.patch,
      authorizationTaskId: editDelegation ? editDelegation.task.id : undefined,
      authorizedBy: editDelegation ? editDelegation.grant.grantedBy : undefined
    });
    redoStack = [];   // a new forward edit invalidates whatever redo history existed
    addLog({
      kind: 'edit', editor, opType: op.type, detail, rev: model.rev, affected: result.affected,
      authorizationTaskId: editDelegation ? editDelegation.task.id : undefined,
      authorizedBy: editDelegation ? editDelegation.grant.grantedBy : undefined
    });
    broadcast({
      type: 'edit', editor, opType: op.type, detail, affected: result.affected,
      authorizationTaskId: editDelegation ? editDelegation.task.id : undefined,
      authorizedBy: editDelegation ? editDelegation.grant.grantedBy : undefined,
      rev: model.rev, model, undoCount: undoStack.length, redoCount: redoStack.length, ts: Date.now()
    });
    if (result.lockReleased) broadcast({ type: 'locks', locks: lockView(), ts: Date.now() });
    scheduleRender();
    // Advisory-only heads-up: this slide is claimed by a different session.
    // Never blocks the edit — only `paused` does that — just surfaces the
    // collision risk right where the editor will actually see it.
    let warning;
    if (heldBeforeOp && heldBeforeOp.by !== editor) {
      warning = `slide ${op.slideId} is locked by ${heldBeforeOp.by} (claimed ${Math.round((Date.now() - heldBeforeOp.ts) / 60000)}m ago), edit applied anyway: coordinate on the board if this collides`;
    }
    const lintMsgs = lintAffected(result.affected);
    if (lintMsgs.length) {
      const lintWarning = `house-rule: ${lintMsgs.join('; ')}`;
      warning = warning ? `${warning} | ${lintWarning}` : lintWarning;
    }
    return json(res, 200, {
      ok: true, rev: model.rev, affected: result.affected, warning,
      historyPromotionPending: !!committed.promotionPending,
      delegation: editDelegation ? {
        taskId: editDelegation.task.id,
        authorizedBy: editDelegation.grant.grantedBy
      } : undefined
    });
  }

  // ---- chatbox: the human briefs the lead. The chatbox IS the board, so the
  // conversation itself is board notes; this endpoint only delivers the human's
  // text to the lead process (spawning it on first message). Ungated for
  // delivery to a LIVE lead (a mid-flight message queues, per Josh's "even if
  // it's not finished I can type more"), but refuses to SPAWN a new lead while
  // paused (no new process should start while editing is frozen).
  if (req.method === 'POST' && p === '/api/chat') {
    const b = await readBody(req);
    const text = String(b.text == null ? '' : b.text).trim();
    if (!text) return json(res, 400, { ok: false, error: 'empty message' });
    // Agents may not use this endpoint. ensureLead() writes to the lead, so a
    // lead that called `ppt chat` would enqueue a message to ITSELF: an
    // unbounded token burn with no natural stop. Workers would likewise inject
    // straight into the lead's queue, bypassing the task record. Enforced here
    // in code rather than in the prompts, matching undo and resume, because
    // ppt-guard whitelists the ppt.js script and never inspects the subcommand.
    if (Agents.isAgent(b.by)) {
      return json(res, 403, { ok: false, error: 'agents may not post to the lead; use `ppt task ... --for worker-N`' });
    }
    if (!agentSweepReady) {
      return json(res, 503, { ok: false, error: 'agent restart cleanup is still in progress; retry shortly' });
    }
    const r = Agents.ensureLead(text);
    if (!r.ok && r.reason === 'paused') {
      return json(res, 423, { ok: false, error: 'paused: cannot start the lead while editing is frozen' });
    }
    return json(res, 200, { ok: true, action: r.action });
  }

  // ---- dismiss agents: stop one (by name) or all live lead/worker processes.
  // Not gated by pause (stopping is always safe), and undoStack is untouched so
  // any edits an agent already made stay reversible via the dashboard.
  if (req.method === 'POST' && p === '/api/agents/stop') {
    const b = await readBody(req);
    const stopped = b.name ? Agents.stop(String(b.name)) : Agents.stopAll();
    return json(res, 200, { ok: true, stopped });
  }
  // Softer than /stop: cancels a running turn without killing the process,
  // so a worker sent the wrong way can be redirected instead of losing all
  // its context. Mirrors /stop's exact {ok, interrupted} shape.
  if (req.method === 'POST' && p === '/api/agents/interrupt') {
    const b = await readBody(req);
    const interrupted = b.name ? Agents.interrupt(String(b.name)) : Agents.interruptAll();
    return json(res, 200, { ok: true, interrupted });
  }
  // ---- usage profile: low | normal | extra | beast. Applies to the NEXT spawn only;
  // running agents keep the model they started with, because --model is a spawn
  // flag with no in-band override and killing a mid-turn agent can strand a
  // held lock and an open task. `dismiss` is the deliberate escape hatch.
  //
  // Deliberately NOT gated by pause, matching /api/agents/stop: you must be able
  // to LOWER spend while editing is frozen. And named /api/agents/profile, not
  // /api/model, because "model" already means the deck everywhere in this file.
  if (req.method === 'GET' && p === '/api/agents/profile') {
    return json(res, 200, Object.assign({ ok: true }, profileView(), { spend: spendView() }));
  }
  // ---- independent Fast execution override. This is a human-owned saved
  // preference for future Codex processes only. It never stops, interrupts,
  // wakes, or respawns an existing agent, and remains honest under Claude by
  // reporting the saved preference as unavailable rather than accelerated.
  if (req.method === 'GET' && p === '/api/agents/fast-mode') {
    return json(res, 200, Object.assign({ ok: true }, fastModeView(Agents.agentsView())));
  }
  if (req.method === 'POST' && p === '/api/agents/fast-mode') {
    const b = await readBody(req);
    const allowed = new Set(['enabled', 'by']);
    const unknown = Object.keys(b).find((key) => !allowed.has(key));
    if (unknown) return json(res, 400, { ok: false, error: `unsupported Fast mode field "${unknown}"` });
    const by = typeof b.by === 'string' ? b.by.trim() : '';
    if (!by) return json(res, 400, { ok: false, error: 'missing by' });
    if (by.length > 60) return json(res, 400, { ok: false, error: 'by is too long' });
    if (isSuiteAgentActor(by.toLowerCase())) {
      return json(res, 403, { ok: false, error: 'agents may not change Fast mode' });
    }
    if (typeof b.enabled !== 'boolean') {
      return json(res, 400, { ok: false, error: 'enabled must be a boolean' });
    }
    const previous = state.agentFastMode === true;
    if (previous === b.enabled) {
      return json(res, 200, Object.assign({ ok: true, changed: false }, fastModeView(Agents.agentsView())));
    }
    const next = copyState();
    next.agentFastMode = b.enabled;
    appendStateLog(next, {
      kind: 'agent-fast-mode', by, from: previous, to: b.enabled, appliesTo: 'next spawn'
    });
    if (!persistState(next)) {
      return json(res, 500, { ok: false, error: 'could not save Fast mode' });
    }
    state = next;
    const profile = profileView();
    broadcast({ type: 'agents', agents: Agents.agentsView(), profile, ts: Date.now() });
    return json(res, 200, Object.assign({ ok: true, changed: true }, profile.fastMode));
  }
  if (req.method === 'POST' && p === '/api/agents/profile') {
    if (!requireControlJson(req, res)) return;
    const b = await readBody(req);
    // Same principle as undo/resume: enforced in code, never only in a prompt.
    // ppt-guard whitelists the ppt.js SCRIPT and never inspects the subcommand,
    // so the moment `ppt profile` exists every agent can invoke it, and spend is
    // the human's decision, not the team's.
    if (Agents.isAgent(b.by)) {
      return json(res, 403, { ok: false, error: 'agents may not change the usage profile' });
    }
    const want = String(b.profile == null ? '' : b.profile).trim().toLowerCase();
    if (!PROFILES[want]) {
      return json(res, 400, { ok: false, error: `unknown profile "${want}". known: ${PROFILE_NAMES.join(', ')}` });
    }
    const selectedProfile = PROFILES[want];
    const forcedProvider = selectedProfile.forcedProvider || null;
    let forcedHealth = null;
    if (forcedProvider) {
      forcedHealth = Agents.providerHealth(forcedProvider, { refresh: true });
      if (!forcedHealth.ok) {
        return json(res, 409, {
          ok: false,
          error: `cannot select "${want}": required provider "${forcedProvider}" is unavailable: ${forcedHealth.detail}`,
          health: forcedHealth,
        });
      }
    }
    const prev = state.usageProfile;
    const prevProvider = state.agentProvider;
    const next = copyState();
    next.usageProfile = want;
    if (forcedProvider) next.agentProvider = forcedProvider;
    if (prev !== want) appendStateLog(next, { kind: 'usage-profile', by: b.by || 'human', from: prev, to: want });
    if (prevProvider !== next.agentProvider) {
      appendStateLog(next, {
        kind: 'agent-provider',
        by: b.by || 'human',
        from: prevProvider,
        to: next.agentProvider,
        forcedByProfile: want,
      });
    }
    if (!persistState(next)) {
      return json(res, 500, { ok: false, error: 'could not save usage profile' });
    }
    state = next;
    // A larger profile may make a durable worker-N assignment eligible now.
    dispatchTaskRecovery({ force: true });
    broadcast({ type: 'agents', agents: Agents.agentsView(), profile: profileView(), ts: Date.now() });
    return json(res, 200, Object.assign({
      ok: true,
      changed: prev !== want || prevProvider !== next.agentProvider,
    }, profileView()));
  }
  // ---- which CLI backs the agents: claude | codex. Same next-spawn-only
  // semantics as the usage profile, and the same agent bar: the provider is a
  // spend and containment decision, not the team's to make.
  if (req.method === 'POST' && p === '/api/agents/provider') {
    if (!requireControlJson(req, res)) return;
    const b = await readBody(req);
    if (Agents.isAgent(b.by)) {
      return json(res, 403, { ok: false, error: 'agents may not change the provider' });
    }
    const want = String(b.provider == null ? '' : b.provider).trim().toLowerCase();
    if (!PROVIDER_MODELS[want]) {
      return json(res, 400, { ok: false, error: `unknown provider "${want}". known: ${PROVIDER_NAMES.join(', ')}` });
    }
    const forcedProvider = PROFILES[state.usageProfile].forcedProvider || null;
    if (forcedProvider && want !== forcedProvider) {
      return json(res, 409, {
        ok: false,
        error: `usage profile "${state.usageProfile}" requires provider "${forcedProvider}"`,
        forcedProvider,
      });
    }
    // A deliberate provider change gets a fresh authentication check. Routine
    // snapshots use Agents' short cache so SSE/state reads never spawn a
    // synchronous `codex login status` process on every repaint.
    const health = Agents.providerHealth(want, { refresh: true });
    if (!health.ok) {
      // Refuse rather than accept a setting whose next spawn would fail with a
      // confusing error minutes later.
      return json(res, 409, { ok: false, error: `cannot switch to "${want}": ${health.detail}`, health });
    }
    const prev = state.agentProvider;
    const next = copyState();
    next.agentProvider = want;
    if (prev !== want) appendStateLog(next, { kind: 'agent-provider', by: b.by || 'human', from: prev, to: want });
    if (!persistState(next)) {
      return json(res, 500, { ok: false, error: 'could not save agent provider' });
    }
    state = next;
    // A provider repair/switch is an explicit signal to retry prior spawn
    // failures immediately instead of waiting out the normal backoff.
    dispatchTaskRecovery({ force: true });
    broadcast({ type: 'agents', agents: Agents.agentsView(), profile: profileView(), ts: Date.now() });
    return json(res, 200, Object.assign({ ok: true, changed: prev !== want }, profileView()));
  }
  if (req.method === 'GET' && p === '/api/spend') {
    return json(res, 200, { ok: true, spend: spendView() });
  }
  if (req.method === 'POST' && p === '/api/spend/reset') {
    if (!requireControlJson(req, res)) return;
    const b = await readBody(req);
    if (Agents.isAgent(b.by)) {
      return json(res, 403, { ok: false, error: 'agents may not reset session spend' });
    }
    const next = copyState();
    next.spend = { sinceTs: Date.now(), totalUsd: 0, turns: 0,
                   tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                   byModel: {}, byRole: {}, recent: [] };
    appendStateLog(next, { kind: 'spend-reset', by: b.by || 'human' });
    if (!persistState(next)) {
      return json(res, 500, { ok: false, error: 'could not save spend reset' });
    }
    state = next;
    broadcast({ type: 'spend', spend: spendView(), ts: Date.now() });
    return json(res, 200, { ok: true, spend: spendView() });
  }
  if (req.method === 'GET' && p === '/api/agents') {
    return json(res, 200, { agents: Agents.agentsView() });
  }
  // ---- the sandbox's audit trail (wired in Phase 3+4's follow-up: every
  // allow/deny decision ppt-guard.js makes for a spawned worker). Read-only,
  // not gated by pause, mirrors GET /api/lint's shape.
  if (req.method === 'GET' && p === '/api/guard-log') {
    const tail = Math.max(1, Math.min(500, parseInt(url.searchParams.get('tail'), 10) || 50));
    let lines = [];
    try { lines = fs.readFileSync(GUARD_LOG_PATH, 'utf8').split('\n').filter(Boolean); } catch (_) { /* no log yet */ }
    const entries = lines.slice(-tail).map((line) => {
      const m = /^(\S+) (\S+) -> (allow|deny) :: (.*)$/.exec(line);
      return m ? { ts: m[1], tool: m[2], decision: m[3], detail: m[4] } : { raw: line };
    });
    return json(res, 200, { entries, total: lines.length });
  }

  // ---- undo/redo: gated by pause exactly like /api/edit (they mutate the deck)
  if (req.method === 'POST' && p === '/api/undo') {
    // Read first, then evaluate the mutation gate and stack in one synchronous
    // section. A slow request body must not "reserve" an undo while unpaused
    // and apply it after a later pause, nor race another undo that consumed the
    // only entry while this request was awaiting bytes.
    const b = await readBody(req);
    if (state.paused) return json(res, 423, { ok: false, error: 'paused', pausedBy: state.pausedBy, pausedAt: state.pausedAt });
    if (!undoStack.length) return json(res, 400, { ok: false, error: 'nothing to undo' });
    const editor = (b.editor && String(b.editor).slice(0, 60)) || 'anonymous';
    // Agents may never undo/redo: undoStack.pop() takes the newest entry
    // regardless of author, so an agent undo is a blind global rewind. Barred
    // in code, not just in the worker prompt.
    if (Agents.isAgent(editor)) return json(res, 403, { ok: false, error: 'agents may not undo' });
    const entry = undoStack[undoStack.length - 1]; // persist before moving either history stack
    const candidate = JSON.parse(JSON.stringify(entry.model));
    const protectionScope = historyProtectionScope(entry, model, candidate);
    const protectionConflict = protectionConflictForScope(protectionScope);
    if (protectionConflict) {
      return json(res, 423, protectionDenial(protectionConflict, 'undo'));
    }
    candidate.rev = (model.rev || 0) + 1;
    let undoHistory;
    try {
      undoHistory = entry.elementHistoryPatch
        ? {
            history: applyElementHistoryPatch(elementHistory, entry.elementHistoryPatch, 'before', candidate.rev),
            patch: entry.elementHistoryPatch
          }
        : historyCandidateForTransition(model, candidate, editor, `Undo ${entry.detail}`);
    } catch (error) {
      return json(res, 500, { ok: false, error: `could not capture object history: ${error.message || error}` });
    }
    const committed = persistModelAndElementHistory(candidate, undoHistory.history);
    if (!committed.ok) return json(res, 500, { ok: false, error: committed.error });
    undoStack.pop();
    redoStack.push({
      model: JSON.parse(JSON.stringify(model)),
      editor: entry.editor,
      opType: entry.opType,
      detail: entry.detail,
      rev: model.rev,
      ts: Date.now(),
      protectionScope,
      elementHistoryPatch: undoHistory.patch
    });
    if (redoStack.length > UNDO_LIMIT) redoStack.shift();
    model = candidate;
    elementHistory = undoHistory.history;
    dirtyAll = true; // the whole model was swapped wholesale; diffing two arbitrary snapshots isn't worth it
    const detail = `undid ${entry.editor}: ${entry.detail}`;
    addLog({ kind: 'undo', editor, detail, rev: model.rev });
    broadcast({ type: 'edit', editor, opType: 'undo', detail, affected: {}, rev: model.rev, model, undoCount: undoStack.length, redoCount: redoStack.length, ts: Date.now() });
    scheduleRender();
    return json(res, 200, {
      ok: true, rev: model.rev, undone: historySummary(entry),
      historyPromotionPending: !!committed.promotionPending
    });
  }
  if (req.method === 'POST' && p === '/api/redo') {
    const b = await readBody(req);
    if (state.paused) return json(res, 423, { ok: false, error: 'paused', pausedBy: state.pausedBy, pausedAt: state.pausedAt });
    if (!redoStack.length) return json(res, 400, { ok: false, error: 'nothing to redo' });
    const editor = (b.editor && String(b.editor).slice(0, 60)) || 'anonymous';
    if (Agents.isAgent(editor)) return json(res, 403, { ok: false, error: 'agents may not redo' });
    const entry = redoStack[redoStack.length - 1]; // persist before moving either history stack
    const candidate = JSON.parse(JSON.stringify(entry.model));
    const protectionScope = historyProtectionScope(entry, model, candidate);
    const protectionConflict = protectionConflictForScope(protectionScope);
    if (protectionConflict) {
      return json(res, 423, protectionDenial(protectionConflict, 'redo'));
    }
    candidate.rev = (model.rev || 0) + 1;
    let redoHistory;
    try {
      redoHistory = entry.elementHistoryPatch
        ? {
            history: applyElementHistoryPatch(elementHistory, entry.elementHistoryPatch, 'after', candidate.rev),
            patch: entry.elementHistoryPatch
          }
        : historyCandidateForTransition(model, candidate, editor, `Redo ${entry.detail}`);
    } catch (error) {
      return json(res, 500, { ok: false, error: `could not capture object history: ${error.message || error}` });
    }
    const committed = persistModelAndElementHistory(candidate, redoHistory.history);
    if (!committed.ok) return json(res, 500, { ok: false, error: committed.error });
    redoStack.pop();
    pushUndo(JSON.parse(JSON.stringify(model)), {
      editor: entry.editor,
      opType: entry.opType,
      detail: entry.detail,
      rev: model.rev,
      ts: Date.now(),
      protectionScope,
      elementHistoryPatch: redoHistory.patch
    });
    model = candidate;
    elementHistory = redoHistory.history;
    dirtyAll = true; // same reasoning as undo: the whole model was swapped wholesale
    const detail = `redid ${entry.editor}: ${entry.detail}`;
    addLog({ kind: 'redo', editor, detail, rev: model.rev });
    broadcast({ type: 'edit', editor, opType: 'redo', detail, affected: {}, rev: model.rev, model, undoCount: undoStack.length, redoCount: redoStack.length, ts: Date.now() });
    scheduleRender();
    return json(res, 200, {
      ok: true, rev: model.rev, redone: historySummary(entry),
      historyPromotionPending: !!committed.promotionPending
    });
  }
  // Read-only preview of what's undoable/redoable, most-recent first. Not
  // gated by pause (like /api/lint) — looking never mutates anything.
  if (req.method === 'GET' && p === '/api/history') {
    return json(res, 200, {
      undo: undoStack.slice().reverse().map(historySummary),
      redo: redoStack.slice().reverse().map(historySummary)
    });
  }

  json(res, 404, { error: 'not found', path: p });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    const status = error instanceof RequestError ? error.status : 500;
    const message = error instanceof RequestError ? error.message : 'internal server error';
    if (!(error instanceof RequestError)) {
      console.error('request handler failed:', error && (error.stack || error));
    }
    if (!res.headersSent) {
      json(res, status, { ok: false, error: message });
    } else if (!res.writableEnded) {
      res.end();
    }
  });
});
// Bound slow headers and incomplete request bodies without putting a response
// timeout on SSE, whose connection is intentionally long-lived.
server.requestTimeout = REQUEST_BODY_TIMEOUT_MS;
server.headersTimeout = Math.max(
  25,
  Number.parseInt(process.env.SUITE_HEADERS_TIMEOUT_MS || '10000', 10) || 10000
);

function describeOp(op, result) {
  switch (op.type) {
    case 'set-presentation-title': return `title → "${trunc(op.text)}"`;
    case 'add-slide': return `add ${op.layout || 'content'} slide`;
    case 'delete-slide': return `delete slide`;
    case 'move-slide': return `move slide → ${op.index}`;
    case 'set-layout': return `layout → ${op.layout}`;
    case 'set-transition': return op.effect === 'fade'
      ? `transition → fade ${(op.duration === undefined ? 0.35 : op.duration)}s`
      : `transition → none`;
    case 'set-notes': return `edit notes`;
    case 'add-element': return `add ${op.elementType || 'body'}`;
    case 'add-shape': return `add ${op.shapeType || 'rect'} shape`;
    case 'add-image': return `add image ${path.basename(String(op.source || ''))}`;
    case 'add-video': return `add video ${path.basename(String(op.source || ''))}`;
    case 'set-media': {
      const changes = [];
      if (op.source !== undefined) changes.push(`source=${path.basename(String(op.source || ''))}`);
      if (op.autoplay !== undefined) changes.push(`autoplay=${op.autoplay ? 'on' : 'off'}`);
      if (op.loop !== undefined) changes.push(`loop=${op.loop ? 'on' : 'off'}`);
      return `update media ${op.decorId}: ${changes.join(', ')}`;
    }
    case 'set-image': return `update image ${op.decorId}: source=${path.basename(String(op.source || ''))}`;
    case 'set-animation': return op.effect === 'none'
      ? `remove animation from ${op.targetId}`
      : `animate ${op.targetId} with ${op.effect} (${op.trigger || 'click'})`;
    case 'delete-element': return `delete element`;
    case 'delete-decor': return `delete generated decor`;
    case 'set-text': return `text → "${trunc(op.text)}"`;
    case 'set-bullets': return `bullets (${(op.items || []).length})`;
    case 'set-style': return `style → ${JSON.stringify({ color: op.color, bold: op.bold, size: op.size, align: op.align, font: op.font })}`;
    case 'set-fill': return `fill → ${op.color}`;
    case 'set-corners': return `corners → ${op.corners} on ${op.targetId}`;
    case 'set-box': return `box → ${JSON.stringify({ x: op.x, y: op.y, w: op.w, h: op.h })}`;
    case 'set-theme': return `theme → ${JSON.stringify({ accent: op.accent })}`;
    case 'set-outline': return `outline color ${op.color}`;
    default: return op.type;
  }
}
function trunc(s) { s = String(s || ''); return s.length > 42 ? s.slice(0, 42) + '…' : s; }

// Wire the agents manager: it needs the live port for spawned children's
// SUITE_PORT, and a live view of the pause flag so it refuses new spawns while
// frozen. Its roster changes broadcast as a new {type:'agents'} SSE event that
// the /studio chips consume.
Agents.configure({
  livePort: PORT,
  isPaused: () => state.paused,
  // A live getter, not a value: the human can change the profile at runtime and
  // the very next spawn must see it, without agents.js requiring this file.
  usageProfile: () => state.usageProfile,
  agentProvider: () => state.agentProvider,
  fastMode: () => state.agentFastMode,
});
Agents.on('roster', (agents) => broadcast({ type: 'agents', agents, profile: profileView(), ts: Date.now() }));
// A stopped/crashed agent cannot keep an advisory slide claim.  The reaper
// already clears these, but ordinary stop, natural exit, and a child crash all
// arrive through this event too.
Agents.on('agent-exit', ({ name }) => {
  if (releaseLocksFor(name)) {
    broadcast({ type: 'locks', locks: lockView(), ts: Date.now() });
  }
});
Agents.on('turn-cost', (c) => { recordTurnCost(c); broadcast({ type: 'spend', spend: spendView(), ts: Date.now() }); });
Agents.on('rate-limit', (r) => {
  addLog({ kind: 'rate-limit', window: r.seven_day ? 'seven_day' : (r.window || 'unknown'), utilization: r.utilization });
  broadcast({ type: 'spend', spend: spendView(), ts: Date.now() });
});
// The lead's reply used to reach only a chip tooltip. Post it to the board so it
// lands in the chat log the human is already reading; the bubble picks up the
// agent's colour automatically from the author name.
Agents.on('agent-reply', (r) => {
  if (r.role !== 'lead') return;               // worker chatter would flood the board
  const text = String(r.text == null ? '' : r.text).replace(/\s+/g, ' ').trim();
  if (!text) return;
  const tx = addNote({ text: text.slice(0, 600), author: r.name, pinned: false });
  if (!tx.ok) {
    console.error('lead reply was not posted because board.json did not persist:', tx.error);
    return;
  }
  const note = tx.note;
  // boardView() is already the ordered array consumed by both viewers. Reading
  // a nonexistent `.notes` property quietly serialized this live update away,
  // so a lead reply appeared only after the next snapshot/reconnect.
  broadcast({ type: 'board', action: 'add', note, notes: boardView(), ts: Date.now() });
});
Agents.on('agent-failed', (f) => addLog({ kind: 'agent-failed', who: f.name }));

async function boot() {
  await migrateModel();
  initializeElementHistory();
  server.listen(PORT, HOST, () => {
    // Kill any agent children orphaned by a prior hard kill of this server
    // (mirrors sweepStaleComHost: only our recorded pids, never a blanket
    // claude.exe kill that would hit the human's VS Code sessions). MUST run
    // only after listen() actually succeeds, not before: this used to run
    // unconditionally ahead of listen(), so a doomed second `node server.js`
    // (started by accident while a real instance already holds the port)
    // fired an async, un-awaited taskkill at whatever real pids the FIRST
    // instance had recorded, then failed with EADDRINUSE and exited, often
    // fast enough to race its own taskkill child and happen to leave the
    // target alive, but that's luck, not a guarantee. Verified directly: the
    // exact same sweepStale() call, given the same time to actually
    // complete that a slower EADDRINUSE check would allow, genuinely kills a
    // real target process. Nesting the sweep here means a second instance
    // that can't bind the port never reaches it at all.
    // Do not wake recovered assignments until every stale child kill attempt
    // has finished. The server is already bound, but task recovery itself is
    // presence-gated, so this wait cannot create background agent spend.
    let sweepFailed = false;
    void Promise.resolve()
      .then(() => Agents.sweepStale())
      .catch((error) => {
        sweepFailed = true;
        console.error('stale agent sweep failed before task recovery:', error && (error.stack || error));
      })
      .then(() => {
        if (sweepFailed) return; // fail closed: never race a possibly-live orphan
        agentSweepReady = true;
        const recovery = initializeTaskRecovery();
        if (recovery.ok) dispatchTaskRecovery();
      });
    sweepStaleTmpFiles();
    // On boot, reconcile the OS read-only bits with the persisted pause state.
    setReadOnly(PPTX_PATH, state.paused);
    setReadOnly(MODEL_PATH, state.paused);
    // Warm the COM host now (its ~2.6-3.6s cold PowerPoint acquire) rather
    // than paying that latency on the first real edit after boot.
    if (IS_WIN) startComHost().catch((e) => console.error('COM host warm-start failed (will retry lazily on first thumbs job):', e.message));
    // A crash after model.json committed but before the debounced renderer
    // finished used to make the next boot bless and thumbnail an older deck.
    // Verify the artifact before serving it. An unpaused project self-heals;
    // a paused project stays frozen and exposes presentation.current=false
    // until the human resumes.
    const freshness = presentationFreshness();
    if (!freshness.current) {
      console.error('presentation needs a boot render:', freshness.error);
      if (!state.paused) scheduleRender();
    } else {
      void refreshThumbsFromDeck(model.rev, 'boot thumbs pass skipped:');
    }
    console.log(`\n  Presentation Suite`);
    console.log(`  ├─ dashboard : http://${HOST}:${PORT}/`);
    console.log(`  ├─ model     : ${MODEL_PATH}`);
    console.log(`  ├─ pptx      : ${PPTX_PATH}`);
    console.log(`  └─ paused    : ${state.paused}\n`);
  });
}
boot().catch((error) => {
  console.error('Presentation Suite startup failed:', error && (error.stack || error));
  process.exitCode = 1;
  // Startup never reached listen(); fail deterministically instead of leaving
  // scheduler timers alive in a headless, unusable process.
  setImmediate(() => process.exit(1));
});

// Best-effort graceful shutdown: only reliably reached via Ctrl+C on the
// process actually running `node server.js` (our own restart routine hard-
// kills by pid, which skips this — that path's safety net is the boot-time
// sweepStaleComHost() above, not this handler).
process.on('SIGINT', async () => { flushSpend(); Agents.stopAll(); await stopComHost(); process.exit(0); });

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — the suite server may already be running.`);
    process.exit(1);
  }
  throw e;
});

// Defense-in-depth: the coordinator is the single gatekeeper for every editor,
// so it must not die on a stray error. Log and keep serving.
process.on('uncaughtException', (e) => console.error('uncaughtException:', e && e.stack || e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e && e.stack || e));
