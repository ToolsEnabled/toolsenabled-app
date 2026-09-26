import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createNodeTranscriptStore } = require('../../shell/node-transcript-store.cjs')
const { createTranscriptRecoveryJournal } = require('../../shell/transcript-recovery-journal.cjs')
const binding = { computerId: 'recovery-computer', nodeId: 'recovery-node' }
const capacityBytes = 128 * 1024
const failure = code => Object.assign(new Error('Synthetic storage refusal'), { code })
const absent = () => failure('ENOENT')
const retainedIo = { ...fs, unlink: async () => { throw absent() },
  rm: async () => { throw new Error('Retained fixtures cannot be deleted') } }

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'te-transcript-recovery-integration-'))
  t.diagnostic('RETAINED_RECOVERY_INTEGRATION ' + directory)
  const open = (io = retainedIo, journalIo = fs) => {
    const recoveryJournal = createTranscriptRecoveryJournal({
      directory: path.join(directory, 'recovery'), io: journalIo, capacityBytes,
    })
    // The store owns the ready failure. Attach a handler while the baseline
    // has no integration, so that a refusal remains an assertion result.
    recoveryJournal.ready.catch(() => {})
    const store = createNodeTranscriptStore({ directory, io, recoveryJournal })
    return { store, recoveryJournal }
  }
  return { directory, open }
}

test('forced termination after a held save recovers exact accepted words and image descriptors', async t => {
  const f = await fixture(t)
  const storePath = require.resolve('../../shell/node-transcript-store.cjs')
  const journalPath = require.resolve('../../shell/transcript-recovery-journal.cjs')
  const words = 'Accepted synthetic words survive a forced exit.'
  const attachments = [{ name: 'synthetic-image.png', bytes: 17 }]
  const hostPath = require.resolve('../../shell/agent-host.cjs')
  const capturePath = require.resolve('../../shell/node-transcript-capture.cjs')
  const enginePath = require.resolve('./fixtures/dual-engine/src/lib/agent-engine/codex-process.js')
  const childSource = `
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const {createNodeTranscriptStore} = require(process.argv[2]);
    const {createTranscriptRecoveryJournal} = require(process.argv[3]);
    const {createAgentHost} = require(process.argv[4]);
    const {createNodeTranscriptCapture} = require(process.argv[5]);
    const directory = process.argv[1], enginePath = process.argv[6];
    process.env.MC_TEST_CONFINEMENT_PLAN = JSON.stringify({ok:true,tier:'unrestricted',isolated:false,threadOptions:{},env:{},servers:[]});
    const engine = require(enginePath);
    engine.startCodexSession = async () => ({
      threadId:'synthetic-recovery-thread',
      adapter:{transport:{child:{exitCode:null,signalCode:null}},sendTurn:async()=>({turnId:'accepted'}),interrupt:async()=>{},answerApproval:()=>{}},
      close:()=>{},
    });
    const recoveryJournal = createTranscriptRecoveryJournal({directory:path.join(directory,'recovery'),capacityBytes:131072});
    recoveryJournal.ready.catch(()=>{});
    const io = {...fs, writeFile:async()=>{throw Object.assign(new Error('synthetic full disk'),{code:'ENOSPC'})},
      unlink:async()=>{throw Object.assign(new Error('retained'),{code:'ENOENT'})}};
    (async()=>{
      const store=createNodeTranscriptStore({directory,io,recoveryJournal,onStorageError:()=>{
        if (store.getStorageStatus().recoverable) process.stdout.write('READY\\n');
      }});
      const capture=createNodeTranscriptCapture({store});
      capture.bind({sessionId:'recovery-session',computerId:'recovery-computer',nodeId:'recovery-node'});
      const host=createAgentHost({enginePath,defaultCwd:directory,startProviderProbe:()=> 'codex',
        providerCommandResolver:()=>path.join(directory,'not-launched'),freeMemory:()=>64*1024**3,
        assertTranscriptWritable:()=>store.assertWritable()});
      host.onAcceptedPrompt(request=>capture.recordAcceptedTranscriptSend(request).then(()=>store.waitForStorage()));
      const imagePath=path.join(directory,'synthetic-image.png');
      const image=await fs.open(imagePath,'wx',0o600);
      await image.writeFile(Buffer.alloc(17,7)); await image.sync(); await image.close();
      await host.startSession({sessionId:'recovery-session'});
      setInterval(()=>{},1000);
      await host.sendTurn({sessionId:'recovery-session',origin:'person',
        text:'Accepted synthetic words survive a forced exit.', images:[{path:imagePath}],
        acceptedAttachmentSummaries:[{name:'synthetic-image.png',bytes:17}]});
      throw new Error('An ENOSPC admission must remain held until explicit retry');
    })().catch(error=>{process.stderr.write(error.code || error.message);process.exitCode=1});
  `
  const child = spawn(process.execPath, ['-e', childSource, f.directory, storePath, journalPath, hostPath, capturePath, enginePath],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  await new Promise((resolve, reject) => {
    let output = ''
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('READY\n')) resolve() })
    child.once('error', reject)
    child.once('exit', code => reject(new Error('Fixture exited before READY: ' + code + ' ' + stderr)))
  })
  child.kill('SIGKILL')
  await closed
  const reopened = f.open()
  const page = await reopened.store.read(binding)
  assert.equal(page.entries[0]?.text, words)
  assert.deepEqual(page.entries[0]?.attachments, attachments)
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'synthetic-image.png')), Buffer.alloc(17, 7))
  assert.equal(page.recoverable, true)
  assert.equal(page.durable, false, 'recovery reserve is not yet the canonical transcript')
  assert.equal((await reopened.store.list(binding)).records[0].nodeId, binding.nodeId)
  await assert.rejects(async () => reopened.store.assertWritable(), { code: 'MC_TRANSCRIPT_DISK_FULL' })
  assert.equal((await reopened.store.retry()).durable, true)
  assert.equal((await reopened.recoveryJournal.load()).size, 0)
  const final = f.open()
  assert.equal((await final.store.read(binding)).entries[0].text, words)
})

test('interrupted primary retry is replayed without duplicating a partial streamed suffix', async t => {
  const f = await fixture(t)
  let full = false, interruptRetry = false
  const io = { ...retainedIo,
    writeFile: async (...args) => { if (full) throw failure('ENOSPC'); return fs.writeFile(...args) },
    open: async (...args) => {
      const h = await fs.open(...args)
      if (args[1] !== 'a') return h
      return { sync: () => h.sync(), close: () => h.close(), writeFile: async text => {
        if (!full) return h.writeFile(text)
        await h.writeFile(Buffer.from(text, 'utf8').subarray(0, 3))
        throw failure('ENOSPC')
      } }
    },
    rename: async (source, destination) => {
      await fs.rename(source, destination)
      if (interruptRetry && /[0-9]{16}-[a-f0-9]{64}\.json$/.test(destination)) {
        interruptRetry = false
        throw failure('EIO')
      }
    },
  }
  const initial = f.open(io)
  await initial.store.appendText({ ...binding, entryId: 'reply', text: 'Saved prefix 猫. ' })
  full = true
  await initial.store.appendText({ ...binding, entryId: 'reply', text: '🙂 Held suffix café.' })
  full = false; interruptRetry = true
  assert.equal((await initial.store.retry()).ok, false)
  const restarted = f.open()
  assert.equal((await restarted.store.read(binding)).entries[0].text, 'Saved prefix 猫. 🙂 Held suffix café.')
  assert.equal((await restarted.store.retry()).ok, true)
  assert.equal((await f.open().store.read(binding)).entries[0].text, 'Saved prefix 猫. 🙂 Held suffix café.')
})

test('failed reserve refuses admission before accepting any new transcript data', async t => {
  const f = await fixture(t)
  let writes = 0
  const { store } = f.open({ ...retainedIo, writeFile: async () => { writes++; throw failure('EIO') } },
    { ...fs, mkdir: async () => { throw failure('ENOSPC') } })
  await assert.rejects(async () => store.assertWritable(), { code: 'MC_TRANSCRIPT_DISK_FULL' })
  assert.equal(writes, 0)
  assert.equal(store.getStorageStatus().retainedBytes, 0)
})

test('a failed reserve update keeps words in memory and never claims forced-exit recovery', async t => {
  const f = await fixture(t)
  let refuseJournalWrite = false
  const journalIo = { ...fs, open: async (...args) => {
    const h = await fs.open(...args)
    return { sync: () => h.sync(), close: () => h.close(), write: async (...writeArgs) => {
      if (refuseJournalWrite) throw failure('EIO')
      return h.write(...writeArgs)
    } }
  } }
  const { store, recoveryJournal } = f.open({ ...retainedIo, writeFile: async () => { throw failure('ENOSPC') } }, journalIo)
  await recoveryJournal.ready
  refuseJournalWrite = true
  await store.append({ ...binding, entries: [{ id: 'memory-only', who: 'you', text: 'Unsaved synthetic words.' }] })
  const page = await store.read(binding)
  assert.equal(page.entries[0].text, 'Unsaved synthetic words.')
  assert.equal(page.recoverable, false)
  assert.match(page.storageError.message, /memory|keep.*open/i)
})

test('recovery records cannot substitute a different node identity or a path outside its transcript', async t => {
  const f = await fixture(t)
  let puts = 0
  const recoveryJournal = {
    ready: Promise.resolve(), load: async () => new Map([['not-the-derived-key', {
      version: 1, metadata: { ...binding }, retained: [['../../elsewhere', { id: 'entry', who: 'you', text: 'fixture' }]],
      revision: 1, sequence: 1, errorCode: 'ENOSPC',
    }]]),
    put: async () => { puts++ }, remove: async () => {},
  }
  const store = createNodeTranscriptStore({ directory: f.directory, io: retainedIo, recoveryJournal })
  await assert.rejects(async () => store.assertWritable(), { code: 'MC_TRANSCRIPT_STORAGE_FAILED' })
  assert.equal(puts, 0)
})
