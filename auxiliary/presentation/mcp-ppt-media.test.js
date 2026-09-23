#!/usr/bin/env node
'use strict';
/*
 * Exercises the worker's image and animation MCP tools against an isolated
 * loopback suite API. No live presentation or suite data is read or changed.
 */
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { isDeepStrictEqual } = require('util');

const checks = [];
function check(description, condition) {
  checks.push({ description, ok: !!condition });
}

function schemaContract(schema) {
  const keys = [
    'type',
    'minLength',
    'pattern',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'enum',
  ];
  const properties = {};
  for (const [name, property] of Object.entries(schema.properties || {})) {
    properties[name] = {};
    for (const key of keys) {
      if (property[key] !== undefined) properties[name][key] = property[key];
    }
  }
  return {
    type: schema.type,
    additionalProperties: schema.additionalProperties,
    required: schema.required,
    properties,
  };
}

async function main() {
  const requests = [];
  const api = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) {}
      requests.push({ method: req.method, url: req.url, body });

      const op = body && body.op;
      let result;
      if (req.method === 'POST' && req.url === '/api/edit' && op && op.type === 'add-image') {
        result = { ok: true, rev: 810, affected: { slideId: op.slideId, decorId: 'd-media-1' } };
      } else if (req.method === 'POST' && req.url === '/api/edit' && op && op.type === 'add-video') {
        result = { ok: true, rev: 811, affected: { slideId: op.slideId, decorId: 'd-video-1' } };
      } else if (req.method === 'POST' && req.url === '/api/edit' && op && op.type === 'set-media') {
        result = { ok: true, rev: 812, affected: { slideId: op.slideId, decorId: op.decorId, media: true } };
      } else if (req.method === 'POST' && req.url === '/api/edit' && op && op.type === 'set-animation') {
        result = { ok: true, rev: 813, affected: { slideId: op.slideId, targetId: op.targetId } };
      } else if (req.method === 'POST' && req.url === '/api/edit' && op && op.type === 'set-outline') {
        result = { ok: true, rev: 814, affected: { slideId: op.slideId, elementId: op.elementId, outline: true } };
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unexpected fake API request' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const port = api.address().port;

  const child = spawn(process.execPath, [path.join(__dirname, 'mcp-ppt.js')], {
    cwd: __dirname,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, {
      SUITE_HOST: '127.0.0.1',
      SUITE_PORT: String(port),
      SUITE_EDITOR: 'worker-media-test',
      SUITE_MCP_ROLE: 'worker',
    }),
  });

  let stdout = '';
  let stderr = '';
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    let end;
    while ((end = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, end).trim();
      stdout = stdout.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        waiter.resolve(message);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  function rpc(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}: ${stderr}`));
      }, 5000);
      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
    check('MCP initializes in worker role',
      init.result &&
      init.result.protocolVersion === '2025-06-18' &&
      init.result.serverInfo &&
      init.result.serverInfo.name === 'suite-ppt-worker');

    const listed = await rpc('tools/list');
    const tools = listed.result && Array.isArray(listed.result.tools) ? listed.result.tools : [];
    const imageTool = tools.find((tool) => tool.name === 'ppt_add_image');
    const videoTool = tools.find((tool) => tool.name === 'ppt_add_video');
    const setMediaTool = tools.find((tool) => tool.name === 'ppt_set_media');
    const animationTool = tools.find((tool) => tool.name === 'ppt_set_animation');
    const outlineTool = tools.find((tool) => tool.name === 'ppt_set_outline');
    check('worker sees ppt_add_image exactly once',
      tools.filter((tool) => tool.name === 'ppt_add_image').length === 1);
    check('worker sees ppt_set_animation exactly once',
      tools.filter((tool) => tool.name === 'ppt_set_animation').length === 1);
    check('worker sees ppt_add_video exactly once',
      tools.filter((tool) => tool.name === 'ppt_add_video').length === 1);
    check('worker sees ppt_set_media exactly once',
      tools.filter((tool) => tool.name === 'ppt_set_media').length === 1);
    check('worker sees ppt_set_outline exactly once',
      tools.filter((tool) => tool.name === 'ppt_set_outline').length === 1);
    check('worker does not see the lead-only dispatch tool',
      !tools.some((tool) => tool.name === 'ppt_task'));
    check('worker does not see the lead-only task update tool',
      !tools.some((tool) => tool.name === 'ppt_task_update'));

    const expectedImageSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['slide_id', 'source', 'x', 'y', 'w', 'h'],
      properties: {
        slide_id: { type: 'string', minLength: 1 },
        source: { type: 'string', minLength: 1 },
        x: { type: 'number', minimum: 0, maximum: 1 },
        y: { type: 'number', minimum: 0, maximum: 1 },
        w: { type: 'number', maximum: 1, exclusiveMinimum: 0 },
        h: { type: 'number', maximum: 1, exclusiveMinimum: 0 },
        task_id: { type: 'string', minLength: 1 },
      },
    };
    check('ppt_add_image publishes the strict local-media schema',
      !!imageTool &&
      isDeepStrictEqual(schemaContract(imageTool.inputSchema), expectedImageSchema));

    const expectedVideoSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['slide_id', 'source', 'x', 'y', 'w', 'h'],
      properties: {
        slide_id: { type: 'string', minLength: 1 },
        source: { type: 'string', minLength: 1 },
        x: { type: 'number', minimum: 0, maximum: 1 },
        y: { type: 'number', minimum: 0, maximum: 1 },
        w: { type: 'number', maximum: 1, exclusiveMinimum: 0 },
        h: { type: 'number', maximum: 1, exclusiveMinimum: 0 },
        autoplay: { type: 'boolean' },
        loop: { type: 'boolean' },
      },
    };
    check('ppt_add_video publishes the strict embedded-MP4 schema and promise',
      !!videoTool &&
      /embed.*H\.264 MP4/i.test(videoTool.description) &&
      /never linked/i.test(videoTool.description) &&
      isDeepStrictEqual(schemaContract(videoTool.inputSchema), expectedVideoSchema));

    const expectedSetMediaSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['slide_id', 'decor_id'],
      properties: {
        slide_id: { type: 'string', minLength: 1 },
        decor_id: { type: 'string', minLength: 1 },
        source: { type: 'string', minLength: 1 },
        autoplay: { type: 'boolean' },
        loop: { type: 'boolean' },
      },
    };
    check('ppt_set_media publishes an in-place patch schema that requires a real update field',
      !!setMediaTool &&
      /preserves.*decor id, box, z-order, and object-history identity/i.test(setMediaTool.description) &&
      isDeepStrictEqual(schemaContract(setMediaTool.inputSchema), expectedSetMediaSchema) &&
      isDeepStrictEqual(setMediaTool.inputSchema.anyOf, [
        { required: ['source'] },
        { required: ['autoplay'] },
        { required: ['loop'] },
      ]));

    const expectedAnimationSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['slide_id', 'target_id', 'effect'],
      properties: {
        slide_id: { type: 'string', minLength: 1 },
        target_id: { type: 'string', minLength: 1 },
        effect: { type: 'string', enum: ['appear', 'fade', 'wipe', 'rise-up', 'none'] },
        trigger: { type: 'string', enum: ['click', 'with-previous', 'after-previous'] },
        duration: { type: 'number', minimum: 0.1, maximum: 10 },
        delay: { type: 'number', minimum: 0, maximum: 30 },
        index: { type: 'integer', minimum: 0 },
      },
    };
    check('ppt_set_animation publishes the native-build schema',
      !!animationTool &&
      isDeepStrictEqual(schemaContract(animationTool.inputSchema), expectedAnimationSchema));

    const expectedOutlineSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['slide_id', 'element_id', 'color'],
      properties: {
        slide_id: { type: 'string', minLength: 1 },
        element_id: { type: 'string', minLength: 1 },
        color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
      },
    };
    check('ppt_set_outline publishes a strict card-edge schema',
      !!outlineTool &&
      isDeepStrictEqual(schemaContract(outlineTool.inputSchema), expectedOutlineSchema));

    const added = await rpc('tools/call', {
      name: 'ppt_add_image',
      arguments: {
        slide_id: 's4',
        source: 'assets/nested-prompt-kaiju-v1.png',
        x: 0.12,
        y: 0.23,
        w: 0.34,
        h: 0.45,
      },
    });
    check('ppt_add_image returns the new decor id and revision readably',
      added.result &&
      added.result.isError !== true &&
      added.result.content &&
      added.result.content[0] &&
      added.result.content[0].text ===
        'Added local image d-media-1 to s4 (rev 810). Call ppt_show to verify its position before animating it.');

    const delegatedAdded = await rpc('tools/call', {
      name: 'ppt_add_image',
      arguments: {
        slide_id: 's4',
        source: 'assets/microheaders/header.png',
        x: 0.56,
        y: 0.006,
        w: 0.4,
        h: 0.045,
        task_id: 't-microheader',
      },
    });
    check('ppt_add_image forwards an explicit human-granted task id without widening the image op',
      delegatedAdded.result && delegatedAdded.result.isError !== true &&
      delegatedAdded.result.content && delegatedAdded.result.content[0] &&
      delegatedAdded.result.content[0].text ===
        'Added local image d-media-1 to s4 (rev 810). Call ppt_show to verify its position before animating it.');

    const addedVideo = await rpc('tools/call', {
      name: 'ppt_add_video',
      arguments: {
        slide_id: 's4',
        source: 'assets/demo.mp4',
        x: 0.18,
        y: 0.2,
        w: 0.5,
        h: 0.4,
      },
    });
    check('ppt_add_video reports embedding and the playback defaults readably',
      addedVideo.result &&
      addedVideo.result.isError !== true &&
      addedVideo.result.content &&
      addedVideo.result.content[0] &&
      addedVideo.result.content[0].text ===
        'Added embedded video d-video-1 to s4 (rev 811); autoplay=on loop=on. Call ppt_show to verify its box.');

    const updatedVideo = await rpc('tools/call', {
      name: 'ppt_set_media',
      arguments: {
        slide_id: 's4',
        decor_id: 'd-video-1',
        source: 'assets/demo-v2.mp4',
        autoplay: false,
      },
    });
    check('ppt_set_media reports the exact in-place patch and preservation promise',
      updatedVideo.result &&
      updatedVideo.result.isError !== true &&
      updatedVideo.result.content &&
      updatedVideo.result.content[0] &&
      updatedVideo.result.content[0].text ===
        'Updated embedded video d-video-1 on s4 (rev 812); source=assets/demo-v2.mp4 autoplay=off. Its id, box, order, and history were preserved.');

    const animated = await rpc('tools/call', {
      name: 'ppt_set_animation',
      arguments: {
        slide_id: 's4',
        target_id: 'd-media-1',
        effect: 'wipe',
        trigger: 'after-previous',
        duration: 0.75,
        delay: 0.2,
        index: 2,
      },
    });
    check('ppt_set_animation returns the applied build and revision readably',
      animated.result &&
      animated.result.isError !== true &&
      animated.result.content &&
      animated.result.content[0] &&
      animated.result.content[0].text ===
        'Animation wipe, after-previous trigger on s4 d-media-1 (rev 813). Render and open the PPTX in slide-show mode to verify playback.');

    const outlined = await rpc('tools/call', {
      name: 'ppt_set_outline',
      arguments: {
        slide_id: 's4',
        element_id: 'e4',
        color: '#2A78D6',
      },
    });
    check('ppt_set_outline returns the exact edge color and revision readably',
      outlined.result && outlined.result.isError !== true &&
      outlined.result.content && outlined.result.content[0] &&
      outlined.result.content[0].text ===
        'Outline #2A78D6 set on s4 e4 (rev 814).');

    check('media tools send the exact coordinator edit envelopes',
      isDeepStrictEqual(requests, [
        {
          method: 'POST',
          url: '/api/edit',
          body: {
            op: {
              type: 'add-image',
              slideId: 's4',
              source: 'assets/nested-prompt-kaiju-v1.png',
              x: 0.12,
              y: 0.23,
              w: 0.34,
              h: 0.45,
            },
            editor: 'worker-media-test',
          },
        },
        {
          method: 'POST',
          url: '/api/edit',
          body: {
            op: {
              type: 'add-image',
              slideId: 's4',
              source: 'assets/microheaders/header.png',
              x: 0.56,
              y: 0.006,
              w: 0.4,
              h: 0.045,
            },
            editor: 'worker-media-test',
            taskId: 't-microheader',
          },
        },
        {
          method: 'POST',
          url: '/api/edit',
          body: {
            op: {
              type: 'add-video',
              slideId: 's4',
              source: 'assets/demo.mp4',
              x: 0.18,
              y: 0.2,
              w: 0.5,
              h: 0.4,
              autoplay: true,
              loop: true,
            },
            editor: 'worker-media-test',
          },
        },
        {
          method: 'POST',
          url: '/api/edit',
          body: {
            op: {
              type: 'set-media',
              slideId: 's4',
              decorId: 'd-video-1',
              source: 'assets/demo-v2.mp4',
              autoplay: false,
            },
            editor: 'worker-media-test',
          },
        },
        {
          method: 'POST',
          url: '/api/edit',
          body: {
            op: {
              type: 'set-animation',
              slideId: 's4',
              targetId: 'd-media-1',
              effect: 'wipe',
              trigger: 'after-previous',
              duration: 0.75,
              delay: 0.2,
              index: 2,
            },
            editor: 'worker-media-test',
          },
        },
        {
          method: 'POST',
          url: '/api/edit',
          body: {
            op: {
              type: 'set-outline',
              slideId: 's4',
              elementId: 'e4',
              color: '#2A78D6',
            },
            editor: 'worker-media-test',
          },
        },
      ]));

    const requestCountBeforeMalformedCalls = requests.length;
    const blankSource = await rpc('tools/call', {
      name: 'ppt_add_image',
      arguments: {
        slide_id: 's4',
        source: '   ',
        x: 0.1,
        y: 0.1,
        w: 0.4,
        h: 0.4,
      },
    });
    check('blank image source fails as a readable tool error',
      blankSource.result &&
      blankSource.result.isError === true &&
      /existing PNG, JPEG, or GIF source inside Presentation\/assets/i.test(
        blankSource.result.content[0].text
      ));

    const zeroWidth = await rpc('tools/call', {
      name: 'ppt_add_image',
      arguments: {
        slide_id: 's4',
        source: 'assets/nested-prompt-kaiju-v1.png',
        x: 0.1,
        y: 0.1,
        w: 0,
        h: 0.4,
      },
    });
    check('zero-width image fails as a readable tool error',
      zeroWidth.result &&
      zeroWidth.result.isError === true &&
      /w must be a finite number greater than 0 and from 0 to 1/i.test(
        zeroWidth.result.content[0].text
      ));

    const blankTaskId = await rpc('tools/call', {
      name: 'ppt_add_image',
      arguments: {
        slide_id: 's4',
        source: 'assets/microheaders/header.png',
        x: 0.56,
        y: 0.006,
        w: 0.4,
        h: 0.045,
        task_id: '   ',
      },
    });
    check('blank delegated image task id fails before HTTP',
      blankTaskId.result && blankTaskId.result.isError === true &&
      /task_id must be a non-empty string/i.test(blankTaskId.result.content[0].text));

    const blankVideoSource = await rpc('tools/call', {
      name: 'ppt_add_video',
      arguments: {
        slide_id: 's4',
        source: '   ',
        x: 0.1,
        y: 0.1,
        w: 0.4,
        h: 0.4,
      },
    });
    check('blank video source fails as a readable tool error',
      blankVideoSource.result &&
      blankVideoSource.result.isError === true &&
      /existing H\.264 MP4 source inside Presentation\/assets/i.test(
        blankVideoSource.result.content[0].text
      ));

    const malformedVideoFlag = await rpc('tools/call', {
      name: 'ppt_add_video',
      arguments: {
        slide_id: 's4',
        source: 'assets/demo.mp4',
        x: 0.1,
        y: 0.1,
        w: 0.4,
        h: 0.4,
        autoplay: 'yes',
      },
    });
    check('non-boolean video playback flag fails before HTTP',
      malformedVideoFlag.result &&
      malformedVideoFlag.result.isError === true &&
      /autoplay must be true or false/i.test(
        malformedVideoFlag.result.content[0].text
      ));

    const emptyMediaPatch = await rpc('tools/call', {
      name: 'ppt_set_media',
      arguments: { slide_id: 's4', decor_id: 'd-video-1' },
    });
    check('an empty in-place media patch fails before HTTP',
      emptyMediaPatch.result &&
      emptyMediaPatch.result.isError === true &&
      /needs at least one of source, autoplay, or loop/i.test(
        emptyMediaPatch.result.content[0].text
      ));

    const blankMediaSource = await rpc('tools/call', {
      name: 'ppt_set_media',
      arguments: { slide_id: 's4', decor_id: 'd-video-1', source: '   ' },
    });
    check('a blank in-place media source fails before HTTP',
      blankMediaSource.result &&
      blankMediaSource.result.isError === true &&
      /source must be an existing MP4 inside Presentation\/assets/i.test(
        blankMediaSource.result.content[0].text
      ));

    const malformedMediaLoop = await rpc('tools/call', {
      name: 'ppt_set_media',
      arguments: { slide_id: 's4', decor_id: 'd-video-1', loop: 'yes' },
    });
    check('a non-boolean in-place media flag fails before HTTP',
      malformedMediaLoop.result &&
      malformedMediaLoop.result.isError === true &&
      /loop must be true or false/i.test(
        malformedMediaLoop.result.content[0].text
      ));

    const invalidEffect = await rpc('tools/call', {
      name: 'ppt_set_animation',
      arguments: {
        slide_id: 's4',
        target_id: 'd-media-1',
        effect: 'spin',
      },
    });
    check('unsupported animation effect fails as a readable tool error',
      invalidEffect.result &&
      invalidEffect.result.isError === true &&
      /effect must be appear, fade, wipe, rise-up, or none/i.test(
        invalidEffect.result.content[0].text
      ));

    const missingTarget = await rpc('tools/call', {
      name: 'ppt_set_animation',
      arguments: { slide_id: 's4', effect: 'fade' },
    });
    check('missing animation target fails as a readable tool error',
      missingTarget.result &&
      missingTarget.result.isError === true &&
      /needs slide_id and target_id from ppt_show/i.test(
        missingTarget.result.content[0].text
      ));
    check('all malformed media calls fail before any HTTP request',
      requests.length === requestCountBeforeMalformedCalls);
  } finally {
    try { child.stdin.end(); } catch (_) {}
    try { child.kill(); } catch (_) {}
    await new Promise((resolve) => api.close(resolve));
  }

  const passed = checks.filter((item) => item.ok).length;
  for (const item of checks) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.description}`);
  }
  console.log(`\n${passed}/${checks.length} passed`);
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
