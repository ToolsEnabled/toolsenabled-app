import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { validateAgainstSchema } from './gen-projection-lib.mjs';

// TWO FILES, TWO OPPOSITE POLICIES -- and that is the whole point.
//
// `public/data/research-queue.json` is copied verbatim into the bundle by vite
// and rendered on first run. It used to hold 28 hand-authored engineering
// post-mortems that name the owner, describe his private fleet, and quote a
// credential env var. Every one of those reached a stranger's disk inside
// app.asar; tools/check-no-owner-data.mjs is what finally said so.
//
// The long-term answer is that this content becomes per-user account data. The
// shippable move now is to split it:
//
//   SHIPPED SEED   public/data/research-queue.json
//                  must be schema-valid AND must carry ZERO items. An empty
//                  seed is the product's correct out-of-box state (the view
//                  already renders "No research items are queued"), and the
//                  zero-item assertion is a positive guard: private content
//                  cannot creep back into the bundle without going red here.
//
//   AUTHORED SET   private/research-queue.authored.json
//                  the 28 items, byte-for-byte, outside `public/` so vite never
//                  copies them and outside build.files (`dist/**`, `shell/**`)
//                  so electron-builder never packs them. Must be schema-valid
//                  AND non-empty -- this is the anti-silent-emptying guard that
//                  used to live in the schema's `minItems: 1`, moved here
//                  because the two files now disagree about what an empty
//                  queue means. Nothing may quietly delete this file's contents
//                  and still pass.
//
// The schema therefore describes SHAPE only. Emptiness policy is per-file and
// lives here, where it can differ.
const shippedSeedPath = fileURLToPath(
  new URL('../public/data/research-queue.json', import.meta.url),
);
const authoredSetPath = fileURLToPath(
  new URL('../private/research-queue.authored.json', import.meta.url),
);
const schemaPath = fileURLToPath(
  new URL('../public/data/schema/research-queue.schema.json', import.meta.url),
);

function readJson(path, label) {
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`${label} is missing or unreadable at ${path}: ${error.message}`);
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is not valid JSON at ${path}: ${error.message}`);
  }
}

function describeError(error, queue) {
  const match = /^\$\.items\[(\d+)\]/.exec(error);
  if (!match) return `[queue] ${error}`;

  const index = Number(match[1]);
  const id = queue?.items?.[index]?.id;
  const identity = typeof id === 'string' && id.length > 0
    ? `index ${index}, id ${JSON.stringify(id)}`
    : `index ${index}, id unavailable`;
  return `[${identity}] ${error}`;
}

// `emptiness` is 'must-be-empty' for the shipped seed and 'must-not-be-empty'
// for the authored set. There is no third value, and no default: a caller that
// forgets to say which kind of file it is passing gets an error, not a pass.
function checkQueue({ path, label, emptiness }) {
  const schema = readJson(schemaPath, 'Research queue schema');
  const queue = readJson(path, label);
  const count = Array.isArray(queue?.items) ? queue.items.length : null;

  const errors = validateAgainstSchema(queue, schema, schema, '$');
  if (errors.length > 0) {
    process.stderr.write(
      `Research queue validation failed for ${path}:\n${errors.map(error => `- ${describeError(error, queue)}`).join('\n')}\n`,
    );
    return false;
  }

  if (emptiness === 'must-not-be-empty' && count === 0) {
    process.stderr.write(
      `${label} at ${path} contains zero items; refusing to pass. `
        + 'This file is the preserved authored set -- an empty one means the content was lost, not that there is nothing to say.\n',
    );
    return false;
  }

  if (emptiness === 'must-be-empty' && count !== 0) {
    process.stderr.write(
      `${label} at ${path} ships ${count} item(s); refusing to pass. `
        + 'The shipped seed must be empty. Authored research belongs in private/research-queue.authored.json, '
        + 'which is not copied into the bundle. See tools/check-no-owner-data.mjs for what shipping it costs.\n',
    );
    return false;
  }

  process.stdout.write(`${label} valid: validated ${count} items from ${path}\n`);
  return true;
}

function main() {
  // An explicit path keeps the single-file contract used by the suite and by
  // anyone validating a candidate file: schema-valid and non-empty, the rule
  // that applies to authored content.
  const explicitPath = process.argv[2];
  if (explicitPath) {
    return checkQueue({
      path: explicitPath,
      label: 'Research queue',
      emptiness: 'must-not-be-empty',
    });
  }

  const seedOk = checkQueue({
    path: shippedSeedPath,
    label: 'Shipped research queue seed',
    emptiness: 'must-be-empty',
  });
  // This release gate must not turn an absent authored set into a green build:
  // absence means it could not inspect the content it promises to preserve.
  const authoredOk = checkQueue({
    path: authoredSetPath,
    label: 'Preserved authored research queue',
    emptiness: 'must-not-be-empty',
  });
  return seedOk && authoredOk;
}

try {
  if (!main()) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`Research queue check failed: ${error.message}\n`);
  process.exitCode = 1;
}
