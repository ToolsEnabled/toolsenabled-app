import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const helper = fileURLToPath(new URL('../lib/page2-native-picker.py', import.meta.url))

test('native X11 picker ownership accepts only the bound process and its actual transient chain', { skip: process.platform !== 'linux' }, () => {
  const script = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location('native_picker', sys.argv[1])
picker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(picker)
properties = {
 ('0x1', '_NET_WM_PID'): '_NET_WM_PID(CARDINAL) = 123',
 ('0x2', '_NET_WM_PID'): '_NET_WM_PID(CARDINAL) = 456',
 ('0x2', 'WM_TRANSIENT_FOR'): 'WM_TRANSIENT_FOR(WINDOW): window id # 0x1',
 ('0x3', 'WM_TRANSIENT_FOR'): 'WM_TRANSIENT_FOR(WINDOW): window id # 0x2',
 ('0x4', '_NET_WM_PID'): '_NET_WM_PID(CARDINAL) = 999',
 ('0x5', 'WM_TRANSIENT_FOR'): 'WM_TRANSIENT_FOR(WINDOW): window id # 0x6',
 ('0x6', 'WM_TRANSIENT_FOR'): 'WM_TRANSIENT_FOR(WINDOW): window id # 0x5',
}
read = lambda window, prop: properties.get((window, prop), '')
for window in ('0x1', '0x2', '0x3'):
 assert picker.window_is_owned(window, 123, read), window
for window in ('0x4', '0x5', '0x6', '0x7'):
 assert not picker.window_is_owned(window, 123, read), window
assert not picker.window_is_owned('0x3', 987, read)
properties[('0x2', 'WM_TRANSIENT_FOR')] = 'WM_TRANSIENT_FOR(WINDOW): window id # 0x4'
assert not picker.window_is_owned('0x3', 123, read)
properties[('0x1', '_NET_WM_NAME')] = 'QA application'
title_reads=[]
def described(window, prop):
 if prop == '_NET_WM_NAME': title_reads.append(window)
 return read(window, prop)
summaries=picker.owned_window_summaries(['0x1', '0x2', '0x3', '0x4', '0x1'], 123, described)
assert title_reads == ['0x1'], 'A foreign title was read or an owned title duplicated'
assert len(summaries) == 1 and summaries[0]['title'] == 'QA application'
print('Exact process, owned nested modal, unrelated window, missing property, cycle and changed parent checked; no native input sent.')
`
  const result = spawnSync('/usr/bin/python3', ['-B', '-c', script, helper], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /no native input sent/)
})

test('native picker requires exact path readback before accepting, including a lost leading slash', { skip: process.platform !== 'linux' }, () => {
  const script = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location('native_picker', sys.argv[1])
picker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(picker)
expected='/home/qa/audit/workspace'
for returned in (expected, expected+'/', expected[1:], '/home/qa'+expected, None, 'ToolsEnabled QA copy proof marker'):
 events=[]
 key=lambda value: events.append(('key', value))
 paste=lambda value: events.append(('paste', value))
 try:
  picker.enter_native_path(expected, key, paste, lambda: returned, lambda: None)
  assert returned == expected
  assert events[-1] == ('key', 'alt+o')
 except RuntimeError as error:
  assert returned != expected
  assert 'exact QA path' in str(error)
  assert not any(value in ('Return', 'alt+s', 'alt+o') for action, value in events if action == 'key')
 assert [event for event in events if event[0] == 'paste'] == [('paste', expected)]
events=[]
picker.enter_native_path(expected, lambda value: events.append(value), lambda _: None, lambda: expected+'/', lambda: None, directory=True)
assert events[-1] == 'alt+o'
assert 'Return' not in events
events=[]
def lost_focus(value):
 events.append(value)
 if value == 'ctrl+a': raise RuntimeError('lost focus')
try:
 picker.enter_native_path(expected, lost_focus, lambda _: events.append('paste'), lambda: expected, lambda: None)
 raise AssertionError('lost focus was ignored')
except RuntimeError:
 assert events == ['ctrl+l', 'ctrl+a']
print('Lost slash, relative prefix, absent copy, unchanged marker and focus loss refuse acceptance; no native input sent.')
`
  const result = spawnSync('/usr/bin/python3', ['-B', '-c', script, helper], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /refuse acceptance; no native input sent/)
})

test('native clipboard imports matching GTK and GDK versions when the optional desktop backend is installed', { skip: process.platform !== 'linux' }, t => {
  const available = spawnSync('/usr/bin/python3', ['-c', 'import gi'], { encoding: 'utf8' })
  if (available.status !== 0) return t.skip('Native picker PyGObject backend is not installed')
  const script = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location('native_picker', sys.argv[1])
picker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(picker)
Gdk, GLib, Gtk = picker.native_clipboard_modules()
assert Gdk._version == '3.0'
assert Gtk._version == '3.0'
print('Matching desktop clipboard libraries loaded; no clipboard read or write and no native input sent.')
`
  const result = spawnSync('/usr/bin/python3', ['-B', '-c', script, helper], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /no clipboard read or write/)
})
