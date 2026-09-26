// Custom adapter/grader isolation: the parent owns the process lifetime and
// records stdout/stderr. This worker does not share the runner's event loop.
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { canonical } from './prompts.mjs'
const chunks = []; let size = 0
for await (const chunk of process.stdin) {
  size += chunk.length
  if (size > 32 * 1024 * 1024) throw new Error('Module request exceeds 32 MiB.')
  chunks.push(chunk)
}
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
const module = await import(pathToFileURL(resolve(process.argv[2])).href)
const value = process.argv[3] === 'grade'
  ? { output: await module.grade(request.project, request.task, request.output) }
  : process.argv[3] === 'interpret' ? { output: await module.interpret(request.task, request.target, { signal: new AbortController().signal }) }
    : await module.run(request, { signal: new AbortController().signal })
try { process.stdout.write(canonical(value) + '\n') }
catch (error) {
  // A returned module value that cannot be represented is an extraction
  // failure. The owned host uses this reserved exit status to forbid redraws.
  process.stderr.write('Module response serialization failed: ' + error.message + '\n')
  process.exitCode = 65
}
