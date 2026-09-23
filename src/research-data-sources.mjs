import { relativeDataPath } from './research-data-package.mjs'

export function filesSource(files) {
  const supplied = [...files], folder = supplied[0]?.webkitRelativePath?.split('/')[0] || 'Selected files'
  const map = new Map(supplied.map(file => [relativeDataPath(file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name), file]))
  return {
    name: folder, kind: 'files',
    async list(directory = '') {
      const prefix = directory ? relativeDataPath(directory) + '/' : '', entries = new Map()
      for (const [path, file] of map) if (path.startsWith(prefix)) {
        const suffix = path.slice(prefix.length), name = suffix.split('/')[0]
        entries.set(name, { name, path: prefix + name, kind: suffix.includes('/') ? 'directory' : 'file', size: suffix.includes('/') ? null : file.size })
      }
      return [...entries.values()]
    },
    async stream(path) {
      const file = map.get(relativeDataPath(path)); if (!file) throw new Error(`The selected files do not include ${path}. Select the folder containing its data and schema.`)
      return file.stream()
    },
    async text(path, limit = 1024 * 1024) {
      const file = map.get(relativeDataPath(path)); if (!file) throw new Error(`File not selected: ${path}`)
      return { text: await file.slice(0, limit).text(), truncated: file.size > limit, size: file.size }
    },
    packagePaths: [...map.keys()].filter(path => /(^|\/)datapackage\.json$/.test(path)),
  }
}

export async function directorySource(handle) {
  const find = async path => {
    const parts = relativeDataPath(path).split('/'); let directory = handle
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part)
    return directory.getFileHandle(parts.at(-1)).then(item => item.getFile())
  }
  return {
    name: handle.name, kind: 'directory', handle,
    async list(path = '') {
      let directory = handle
      if (path) for (const part of relativeDataPath(path).split('/')) directory = await directory.getDirectoryHandle(part)
      const entries = []
      for await (const item of directory.values()) {
        if (item.name.startsWith('.')) continue
        entries.push({ name: item.name, path: path ? path + '/' + item.name : item.name, kind: item.kind })
      }
      return entries
    },
    async stream(path) { return (await find(path)).stream() },
    async text(path, limit = 1024 * 1024) { const file = await find(path); return { text: await file.slice(0, limit).text(), truncated: file.size > limit, size: file.size } },
    packagePaths: [],
  }
}

export async function connectedSource(url, { fetchImpl = fetch } = {}) {
  const base = new URL(url)
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password || base.search || base.hash) throw new Error('The folder connection must be a local loopback URL.')
  const request = async (endpoint, path, signal, limit) => {
    const target = new URL(endpoint, base)
    if (path) target.searchParams.set('path', relativeDataPath(path))
    if (limit) target.searchParams.set('limit', String(limit))
    const response = await fetchImpl(target, { signal, credentials: 'omit', cache: 'no-store', redirect: 'error' })
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Folder connection responded ${response.status}.`)
    return response
  }
  const metadata = await (await request('/workspace')).json()
  return {
    name: metadata.name, kind: 'connected', packagePaths: metadata.packages || [],
    async list(path = '') { return (await (await request('/entries', path)).json()).entries },
    async stream(path, signal) { return (await request('/file', path, signal)).body },
    async text(path, limit = 1024 * 1024) {
      return (await request('/preview', path, undefined, limit)).json()
    },
  }
}

export async function tableStream(source, path, signal) {
  const stream = await source.stream(path, signal)
  if (/\.gz$/i.test(path)) {
    if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot read gzip. Extract the CSV first.')
    return stream.pipeThrough(new DecompressionStream('gzip'))
  }
  return stream
}
