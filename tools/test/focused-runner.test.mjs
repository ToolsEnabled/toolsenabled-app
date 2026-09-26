import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const linuxTest = (name, fn) => test(name, { skip: process.platform !== 'linux' ? 'The shared focused runner uses Linux process groups and typed sysfs sensors.' : false }, fn)
const runner = fileURLToPath(new URL('../run-focused.py', import.meta.url))
function check(t, body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'te-focused-monitor-'))
  t.diagnostic('RETAINED_MONITOR_FIXTURE ' + root)
  const program = `
import importlib.util, json, os, pathlib, signal, subprocess, sys, time
spec = importlib.util.spec_from_file_location("focused", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
root = pathlib.Path(sys.argv[2])
receipt = {"cpu":{"x86_pkg_temp":64000}}
def reading(value=64000):
    return {"at":str(time.monotonic()), "cpu":{"x86_pkg_temp":value}, "freeBytes":m.DISK_STOP_BYTES+1}
def live(pid):
    try:
        state=pathlib.Path(f"/proc/{pid}/stat").read_text().rsplit(")",1)[1].split()[0]
        return state not in ("Z","X")
    except FileNotFoundError:
        return False
` + body + `
(root/"receipt.json").write_text(json.dumps(receipt, indent=2))
print(json.dumps({"ok": True, "receipt": str(root/"receipt.json")}))
`
  const answer = JSON.parse(execFileSync('python3', ['-B', '-c', program, runner, root], { encoding: 'utf8', timeout: 10000 }))
  assert.equal(answer.ok, true)
}

linuxTest('thermal monitor actually stops and resumes a child while retaining all samples and maxima', t => check(t, `
seen_stop = []
values = iter([74000, 75000, 67000])
def observe():
    value=next(values,64000)
    if "pid" in receipt:
        state=pathlib.Path(f"/proc/{receipt['pid']}/stat").read_text().rsplit(")",1)[1].split()[0]
        if state=="T": seen_stop.append(True)
    return reading(value)
with open(root/"child.log","x") as output:
    result=m.run_child([sys.executable,"-c","import time; time.sleep(.2); print('finished')"],cwd=root,env=os.environ,output=output,seconds=2,receipt=receipt,observe_fn=observe,interval=.02)
assert result==0
assert seen_stop
assert [r["signal"] for r in receipt["transitions"]]==["SIGSTOP","SIGCONT"]
assert receipt["maxPackageMilliC"]==75000
assert len(receipt["samples"])>=3
assert (root/"child.log").read_text().strip()=="finished"
`))

linuxTest('monitor failure cleans up owned descendants even when a child ignores TERM', t => check(t, `
script="import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c','import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)']); print(p.pid,flush=True); time.sleep(30)"
calls=0
def broken():
    global calls
    calls+=1
    # Refuse only once the TERM-ignoring grandchild exists (its pid is in the log). Under a full
    # suite a cold Python start can outlast three 30ms readings, and the check below needs that pid.
    if calls>=3 and (root/"child.log").read_text().strip(): raise RuntimeError("synthetic monitor refusal")
    return reading()
with open(root/"child.log","x") as output:
    try:
        m.run_child([sys.executable,"-c",script],cwd=root,env=os.environ,output=output,seconds=2,receipt=receipt,observe_fn=broken,interval=.03)
        raise AssertionError("monitor error was swallowed")
    except RuntimeError: pass
child=int((root/"child.log").read_text().strip())
time.sleep(.03)
assert not live(child)
assert not live(receipt["pid"])
assert receipt["exceptionType"]=="RuntimeError"
`))

linuxTest('leader exit still cleans up a surviving process in its owned group', t => check(t, `
script="import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c','import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)']); print(p.pid,flush=True); time.sleep(.06)"
with open(root/"child.log","x") as output:
    m.run_child([sys.executable,"-c",script],cwd=root,env=os.environ,output=output,seconds=2,receipt=receipt,observe_fn=reading,interval=.02)
child=int((root/"child.log").read_text().strip())
time.sleep(.03)
assert not live(child)
assert receipt["exitCode"]==0
`))

linuxTest('wall timeout resumes a stopped group only to terminate it and cannot leave it alive', t => check(t, `
with open(root/"child.log","x") as output:
    m.run_child([sys.executable,"-c","import time; time.sleep(30)"],cwd=root,env=os.environ,output=output,seconds=.12,receipt=receipt,observe_fn=lambda:reading(74000),interval=.02)
assert receipt["aborted"]=="wall timeout including paused time"
assert receipt["transitions"][0]["signal"]=="SIGSTOP"
assert receipt["elapsedSeconds"]<2
assert not live(receipt["pid"])
`))

linuxTest('only the five reviewed test selectors pass and control overrides are refused', t => check(t, `
selectors=["T1642_HANDOFF_BASELINE=1","TASK_STALENESS_BASELINE=1","T1644_RENDERER_PREFS_BASELINE=1","T839_IMAGE_FIXTURE_ROOT="+str(root),"TOOLSENABLED_TEST_RETAIN_FIXTURES=1"]
values=m.test_environment(selectors)
assert values==dict(item.split("=",1) for item in selectors)
for item in ["HOME=/wrong","MC_CANONICAL_ROOT=/wrong","TOOLSENABLED_TEST_STRICT=0","T1642_HANDOFF_BASELINE=0","T839_IMAGE_FIXTURE_ROOT=relative","UNREVIEWED=1"]:
    try:
        m.test_environment([item])
        raise AssertionError("unreviewed selector accepted")
    except ValueError: pass
try:
    m.test_environment(["T1642_HANDOFF_BASELINE=1","T1642_HANDOFF_BASELINE=1"])
    raise AssertionError("duplicate accepted")
except ValueError: pass
`))

linuxTest('unreviewed Node arguments are refused before any focused child starts', t => check(t, `
import contextlib, io
calls=[]
m.run_child=lambda *args, **kwargs: calls.append(args)
for flag in ["--inspect", "--eval=process.exit()", "--import=/unreviewed", "--experimental-vm-modules=1", "--max-old-space-size=32"]:
    sys.argv=["run-focused", "--app", str(root), "--engine", str(root), "--node", sys.executable,
              "--lock", str(root/"lock"), "--out", str(root/"refused"), "--node-arg="+flag, "suite.test.mjs"]
    with contextlib.redirect_stderr(io.StringIO()):
        try:
            m.main()
            raise AssertionError("unreviewed Node argument accepted")
        except SystemExit as error:
            assert error.code==2
assert calls==[]
assert not (root/"refused.tap").exists()
`))

linuxTest('VM modules are explicit in the effective command and receipt while NODE_OPTIONS stays scrubbed', t => check(t, `
import contextlib, io
m.observe=reading
m.subprocess.check_output=lambda *args, **kwargs: "synthetic-reviewed-ref"
seen={}
def child(command, **kwargs):
    seen.update(command=command, env=kwargs["env"])
    kwargs["output"].write("inert focused child\\n")
    kwargs["receipt"].update(exitCode=0, elapsedSeconds=0)
    return 0
m.run_child=child
os.environ["NODE_OPTIONS"]="--inspect --unreviewed"
sys.argv=["run-focused", "--app", str(root), "--engine", str(root), "--node", sys.executable,
          "--lock", str(root/"lock"), "--out", str(root/"allowed"),
          "--node-arg=--experimental-vm-modules", "suite.test.mjs"]
with contextlib.redirect_stdout(io.StringIO()):
    assert m.main()==0
receipt=json.loads((root/"allowed-admission.json").read_text())
assert receipt["nodeArgs"]==["--experimental-vm-modules"]
assert receipt["command"]==seen["command"]
command=seen["command"]
assert command[command.index(sys.executable)+1]=="--experimental-vm-modules"
assert command.index("--experimental-vm-modules")<command.index("suite.test.mjs")
assert "NODE_OPTIONS" not in seen["env"]
assert seen["env"]["TOOLSENABLED_TEST_STRICT"]=="1"
assert seen["env"]["MC_CANONICAL_ROOT"]==str(root)
`))
