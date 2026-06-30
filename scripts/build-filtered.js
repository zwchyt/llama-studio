const { spawn } = require('child_process')
const { resolve } = require('path')

const cwd = resolve(__dirname, '..')
const p = spawn(resolve(cwd, 'node_modules/.bin/electron-vite') + '.cmd build', [], {
  cwd,
  shell: true,
  windowsHide: true,
  stdio: ['inherit', 'pipe', 'pipe']
})

let buf = ''
p.stdout.on('data', (chunk) => {
  buf += chunk.toString()
  const lines = buf.split('\n')
  buf = lines.pop() || ''
  for (const line of lines) {
    if (/\.(woff|ttf)2?\s/.test(line) || /KaTeX_/.test(line) || /Use of eval in/.test(line)) continue
    process.stdout.write(line + '\n')
  }
})
p.stdout.on('end', () => {
  if (buf && !/\.(woff|ttf)2?\s/.test(buf) && !/KaTeX_/.test(buf) && !/Use of eval in/.test(buf)) process.stdout.write(buf)
})

let errBuf = ''
p.stderr.on('data', (chunk) => {
  errBuf += chunk.toString()
  const lines = errBuf.split('\n')
  errBuf = lines.pop() || ''
  for (const line of lines) {
    if (/\.(woff|ttf)2?\s/.test(line) || /KaTeX_/.test(line) || /Use of eval in/.test(line)) continue
    process.stderr.write(line + '\n')
  }
})
p.stderr.on('end', () => {
  if (errBuf && !/\.(woff|ttf)2?\s/.test(errBuf) && !/KaTeX_/.test(errBuf) && !/Use of eval in/.test(errBuf)) process.stderr.write(errBuf)
})

p.on('exit', (code) => process.exit(code ?? 0))
