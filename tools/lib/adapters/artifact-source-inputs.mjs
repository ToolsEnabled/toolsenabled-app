import fs from 'node:fs';
import path from 'node:path';
import { blocked, plainPath, contains, readBounded, digestRecord, ENTRY_LIMIT } from './artifact-files.mjs';

function inspectConfiguration(config, filters) {
  // Read config ourselves before Git can resolve a missing object. Git permits
  // inline keys after a section header, quoted values and value continuations;
  // a line-start search would miss valid promisor declarations. Values are not
  // interpreted or executed. Unsupported/malformed syntax fails closed here.
  // See the installed Git config syntax and repository partialClone docs.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(config)) blocked('malformed Git configuration');
  const lines = config.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').split('\n');
  let section = null, subsection = null;
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index].replace(/^[ \t]+/, '');
    if (!line || /^[#;]/.test(line)) continue;
    if (line.startsWith('[')) {
      const header = /^\[([a-z0-9.-]+)(?:[ \t]+"((?:[^"\\\r\n]|\\[^\r\n])*)")?[ \t]*\]/i.exec(line);
      if (!header) blocked('malformed Git configuration section');
      const parts = header[1].split('.');
      section = parts.shift().toLowerCase();
      subsection = header[2] ?? (parts.length ? parts.join('.').toLowerCase() : null);
      if (header[2] !== undefined && parts.length) blocked('malformed Git configuration section');
      if (/^include(?:if)?$/.test(section)) blocked('Git configuration includes are not qualification inputs');
      if (section === 'filter') {
        if (!/^[a-z0-9._-]+$/i.test(subsection || '')) blocked('unsupported Git filter name');
        filters.add(subsection);
      }
      line = line.slice(header[0].length).replace(/^[ \t]+/, '');
      if (!line || /^[#;]/.test(line)) continue;
    }
    const key = /^([a-z][a-z0-9-]*)([ \t]*)(.*)$/i.exec(line);
    if (!section || !key || key[3] && !/^[=#;]/.test(key[3])) blocked('malformed Git configuration variable');
    const name = key[1].toLowerCase();
    if ((section === 'extensions' && subsection === null && name === 'partialclone') ||
        (section === 'remote' && subsection !== null && name === 'promisor')) {
      // Refuse the declaration even when its current value is false, empty or
      // duplicated. Qualification requires ordinary local object storage.
      blocked('Git partial-clone configuration is not a qualification input');
    }
    if (!key[3].startsWith('=')) continue;
    let value = key[3].slice(1), quoted = false;
    for (;;) {
      let continued = false;
      for (let offset = 0; offset < value.length; offset++) {
        const character = value[offset];
        if (!quoted && /[#;]/.test(character)) break;
        if (character === '"') quoted = !quoted;
        else if (character === '\\') {
          if (offset + 1 === value.length) { continued = true; break; }
          if (!/[\\"ntb]/.test(value[++offset])) blocked('malformed Git configuration value escape');
        }
      }
      if (!continued && !quoted) break;
      if (++index >= lines.length) blocked('malformed Git configuration unfinished value');
      value = lines[index];
    }
  }
}

export function readSourceMetadata(root) {
  const observed = {};
  function observe(file) {
    const stat = fs.lstatSync(file, { bigint: true });
    observed[file] = Object.fromEntries(['dev','ino','mode','nlink','size','mtimeNs','ctimeNs'].map(key => [key, String(stat[key])]));
  }
  root = plainPath(root, { kind: 'directory' });
  observe(root);
  let metadata = plainPath(path.join(root, '.git'));
  observe(metadata);
  if (fs.lstatSync(metadata).isFile()) {
    const pointer = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(readBounded(metadata, 4096).toString('utf8'));
    if (!pointer) blocked('malformed Git worktree pointer');
    metadata = plainPath(path.resolve(root, pointer[1]), { kind: 'directory' });
  } else if (!fs.lstatSync(metadata).isDirectory()) blocked('invalid Git metadata');
  let common = metadata;
  const commonFile = plainPath(path.join(metadata, 'commondir'), { missingLeaf: true });
  if (fs.existsSync(commonFile)) common = plainPath(path.resolve(metadata, readBounded(commonFile, 4096).toString('utf8').trim()), { kind: 'directory' });
  const filters = new Set();
  for (const file of [path.join(common, 'config'), path.join(metadata, 'config.worktree')]) {
    plainPath(file, { missingLeaf: true });
    if (!fs.existsSync(file)) continue;
    const config = readBounded(file, 256 * 1024).toString('utf8');
    inspectConfiguration(config, filters);
  }
  for (const name of ['alternates', 'http-alternates']) {
    const file = plainPath(path.join(common, 'objects', 'info', name), { missingLeaf: true });
    if (fs.existsSync(file) && readBounded(file, 65536).toString('utf8').trim()) blocked('Git object alternates are not qualification inputs');
  }
  // Object/ref links must be refused before Git itself can follow them.
  let count = 0;
  function inspect(directory) {
    observe(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (++count > ENTRY_LIMIT) blocked('Git metadata entry budget exceeded');
      const file = plainPath(path.join(directory, entry.name));
      observe(file);
      // Pack markers retain promisor provenance even if config was removed.
      // Case-fold for Windows aliases; refuse before starting any Git command.
      if (path.relative(path.join(common, 'objects', 'pack'), directory) === '' && /\.promisor$/i.test(entry.name)) {
        blocked('Git partial-clone pack metadata is not a qualification input');
      }
      if (entry.isDirectory()) inspect(file);
      else if (!entry.isFile()) blocked('non-regular Git metadata');
    }
  }
  inspect(common);
  if (metadata !== common && !contains(common, metadata)) inspect(metadata);
  return { filters: [...filters].flatMap(name => ['-c', `filter.${name}.clean=`, '-c', `filter.${name}.smudge=`, '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=false`]), sha256: digestRecord(observed) };
}

