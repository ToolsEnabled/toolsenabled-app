import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import storageModule from '../../shell/hosted-session-storage.cjs'
import { platformKeystore } from '../../shell/os-keystore.cjs'
function fixture(t, storage) {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'hosted-session-storage-'))
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}))
 const key=crypto.randomBytes(32)
 const safeStorage=storage || {
  isEncryptionAvailable:()=>true,
  encryptString(text){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data])},
  decryptString(bytes){const decipher=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8')}
 }
 return {directory,store:storageModule.createHostedSessionStorage({directory,safeStorage})}
}
test('saved session round trips through encryption and is removed on sign out',t=>{
 const {directory,store}=fixture(t),record={cookie:'fixture-secret-cookie',accountId:'fixture-account'}
 assert.equal(store.write(record),true)
 assert.equal(fs.readFileSync(path.join(directory,'hosted-session.enc')).includes(Buffer.from(record.cookie)),false)
 assert.deepEqual(store.read(),record)
 assert.equal(store.clear(),true)
 assert.equal(store.read(),null)
})
test('unavailable OS encryption never writes a plaintext session',t=>{
 const {directory,store}=fixture(t,{isEncryptionAvailable:()=>false,encryptString(){throw Error('must not encrypt')}})
 assert.equal(store.write({cookie:'secret'}),false)
 assert.deepEqual(fs.readdirSync(directory),[])
})
test('Linux basic_text backend is refused by the actual platform keystore boundary',t=>{
 const unsafe=platformKeystore({isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'basic_text',encryptString(){throw Error('must not encrypt')}},{platform:'linux'})
 const {store}=fixture(t,unsafe)
 assert.equal(store.write({cookie:'secret'}),false)
})
test('corrupt saved ciphertext never restores a session',t=>{
 const {directory,store}=fixture(t)
 assert.equal(store.write({cookie:'fixture'}),true)
 fs.writeFileSync(path.join(directory,'hosted-session.enc'),Buffer.from('corrupt'),{mode:0o600})
 assert.throws(()=>store.read())
})
test('a hard-linked session file is refused without changing its other name',t=>{
 const {directory,store}=fixture(t)
 const other=path.join(directory,'other.enc')
 fs.writeFileSync(other,'untouched',{mode:0o600})
 fs.linkSync(other,path.join(directory,'hosted-session.enc'))
 assert.throws(()=>store.write({cookie:'secret'}))
 assert.throws(()=>store.clear())
 assert.equal(fs.readFileSync(other,'utf8'),'untouched')
})
test('installation slot survives logout and storage reconstruction without OS encryption',t=>{
 const {directory,store}=fixture(t,{isEncryptionAvailable:()=>false})
 const id=store.installationId()
 assert.match(id,/^[a-f0-9-]{36}$/)
 assert.equal(store.clear(),true)
 const reconstructed=storageModule.createHostedSessionStorage({directory,safeStorage:{isEncryptionAvailable:()=>false}})
 assert.equal(reconstructed.installationId(),id)
 assert.equal(reconstructed.write({cookie:'secret'}),false)
 assert.deepEqual(fs.readdirSync(directory),['hosted-installation-id'])
})
test('a corrupt or hard-linked installation identifier is refused without replacement',t=>{
 const {directory,store}=fixture(t)
 const file=path.join(directory,'hosted-installation-id')
 fs.writeFileSync(file,'not-an-installation-id',{mode:0o600})
 assert.throws(()=>store.installationId())
 assert.equal(fs.readFileSync(file,'utf8'),'not-an-installation-id')
 fs.writeFileSync(file,crypto.randomUUID())
 fs.linkSync(file,path.join(directory,'other-id'))
 assert.throws(()=>store.installationId())
})
