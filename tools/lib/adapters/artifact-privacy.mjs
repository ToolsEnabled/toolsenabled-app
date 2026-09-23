import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { blocked, plainPath, readJson, measureFile, measureTree, assertSameTree, digestRecord } from './artifact-files.mjs';

// Existing app privacy rules are not changed by this standalone implementation.
// These reproduce their builder-independent exclusions and narrow published
// attribution treatment, while streaming every byte (no large-binary skip).
const FIXED_LITERALS = ['AICalendar', 'AI Calendar', 'AI-Calendar', 'DigitalOcean', 'Digital Ocean', 'Digital-Ocean',
  'agent_mirror', 'joshuapinckard', 'toolsenabled-current'];
const FIXED_REGEX = [
  // Bound pathological path-prefix runs so a deliberately megabyte-long
  // escaped separator cannot hide a later account name across stream windows.
  /[\\/]{512,}/g,
  /C:\\[\\/]*Users[\\/]+[^\x00-\x20\\/"'`<>|?*:]+/gi,
  /C:\/[\\/]*Users[\\/]+[^\x00-\x20\\/"'`<>|?*:]+/gi,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z])[A-Za-z]:[\\/][^\r\n]{0,160}?[\\/]toolsenabled/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];
const ATTRIBUTION = 'Joshua Pinckard';
const CHUNK = 1024 * 1024;

function asciiLower(bytes) {
  const result = Buffer.from(bytes);
  for (let index = 0; index < result.length; index++) if (result[index] >= 65 && result[index] <= 90) result[index] += 32;
  return result;
}

function matches(buffer, needle) {
  const result = [];
  for (let offset = buffer.indexOf(needle); offset !== -1; offset = buffer.indexOf(needle, offset + 1)) result.push({ offset, length: needle.length });
  return result;
}

function checkAbort(signal) { if (signal?.aborted) { const error = new Error('artifact privacy verification cancelled'); error.name = 'AbortError'; throw error; } }

export async function measureStandalonePrivacy({ sourceRoot, stageRoot, expectedStage, signal }) {
  checkAbort(signal);
  const profilePath = path.join(plainPath(sourceRoot, { kind: 'directory' }), 'private', 'owner-data-patterns.owner.json');
  const profile = measureFile(profilePath), parsed = readJson(profilePath);
  if (!Array.isArray(parsed.patterns) || !parsed.patterns.length || parsed.patterns.length > 512) blocked('standalone privacy profile is missing/empty/excessive');
  const identity = parsed.patterns.map(entry => {
    const value = typeof entry === 'string' ? entry : entry?.value;
    if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 4096) blocked('invalid standalone owner-pattern entry');
    return { value, caseInsensitive: !(entry?.caseSensitive === true), identity: true };
  });
  const account = os.userInfo().username.trim().toLowerCase();
  if (!account || !identity.some(row => row.value.trim().toLowerCase().includes(account) || account.includes(row.value.trim().toLowerCase()))) blocked('standalone privacy profile does not describe the actual build account');
  const patterns = [...FIXED_LITERALS.map(value => ({ value, caseInsensitive: true, identity: false })), ...identity];
  const encoded = patterns.flatMap(row => ['utf8', 'utf16le'].map(encoding => {
    const bytes = Buffer.from(row.value, encoding);
    return { ...row, bytes: row.caseInsensitive ? asciiLower(bytes) : bytes };
  }));
  const attribution = ['utf8', 'utf16le'].map(encoding => asciiLower(Buffer.from(ATTRIBUTION, encoding)));
  const margin = Math.max(1024, ...encoded.map(row => row.bytes.length)) + 512;
  const stage = measureTree(stageRoot);
  if (expectedStage) assertSameTree(expectedStage, stage);
  let scannedBytes = 0, excusedAttribution = 0;
  for (const [name, identity] of Object.entries(stage.files)) {
    checkAbort(signal);
    if (/(?:^|\/)(?:\.git|\.env|vault|state|private|captures|logs)(?:\/|$)|(?:^|\/)(?:secrets|auth|credentials)\.json$|\.(?:pem|key|pfx|p12|sqlite3?|db)(?:-wal|-shm)?$/i.test(name)) blocked('private/runtime-state file is present in the standalone artifact');
    const file = plainPath(path.join(stageRoot, name), { kind: 'file' }), fd = fs.openSync(file, 'r');
    const hash = createHash('sha256'); let read = 0, verified = 0, tail = Buffer.alloc(0);
    try {
      for (;;) {
        checkAbort(signal);
        const fresh = Buffer.alloc(CHUNK), count = fs.readSync(fd, fresh, 0, fresh.length, null);
        if (count) { hash.update(fresh.subarray(0, count)); read += count; }
        const bytes = Buffer.concat([tail, fresh.subarray(0, count)]), lower = asciiLower(bytes), base = read - bytes.length;
        const until = count ? Math.max(0, read - margin) : read;
        const relevant = offset => base + offset >= verified && base + offset < until;
        const spans = attribution.flatMap(needle => matches(lower, needle));
        for (const pattern of encoded) for (const hit of matches(pattern.caseInsensitive ? lower : bytes, pattern.bytes)) {
          if (!relevant(hit.offset)) continue;
          if (pattern.identity && spans.some(span => hit.offset >= span.offset && hit.offset + hit.length <= span.offset + span.length)) excusedAttribution++;
          else blocked('private identity or forbidden metadata found in standalone artifact bytes');
        }
        // Scan both UTF-16 alignments; PE data may start at any byte offset.
        for (const [text, width, shift] of [[bytes.toString('latin1'), 1, 0], [bytes.toString('utf16le'), 2, 0], [bytes.subarray(1).toString('utf16le'), 2, 1]]) {
          for (const pattern of FIXED_REGEX) {
            pattern.lastIndex = 0;
            for (const hit of text.matchAll(pattern)) if (relevant(hit.index * width + shift)) blocked('credential/profile/check-out path found in standalone artifact bytes');
          }
        }
        verified = until;
        if (!count) break;
        tail = bytes.subarray(Math.max(0, bytes.length - 2 * margin));
        await setImmediate();
      }
      if (read !== identity.bytes || hash.digest('hex') !== identity.sha256) blocked('standalone artifact changed during its full privacy scan');
      scannedBytes += read;
    } finally { fs.closeSync(fd); }
  }
  if (measureFile(profilePath).sha256 !== profile.sha256) blocked('standalone privacy profile changed during scanning');
  assertSameTree(stage, measureTree(stageRoot));
  return { profile, policySha256: digestRecord({ literals: FIXED_LITERALS, regex: FIXED_REGEX.map(String), attribution: ATTRIBUTION }),
    scannedFiles: Object.keys(stage.files).length, scannedBytes, encodings: ['utf8-bytes', 'utf16le-both-alignments'], excusedAttribution };
}
