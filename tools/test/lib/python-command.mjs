// Windows installs Python as python.exe; python3.exe can be a Store redirect
// even when the real interpreter is installed. These suites still execute
// Python and require its successful independent results.
export const PYTHON_COMMAND = process.platform === 'win32' ? 'python' : 'python3'
// Node writes these JSON pipes as UTF-8. Bind the real Python reader to that
// encoding rather than the Windows locale's legacy code page.
export const PYTHON_ARGS = Object.freeze(['-X', 'utf8'])
