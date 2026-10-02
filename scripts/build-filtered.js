const { spawn } = require('child_process')
const { resolve } = require('path')
const { existsSync } = require('fs')
const { pipeLines } = require('./build-log-filter')

const cwd = resolve(__dirname, '..')
const base = resolve(cwd, 'node_modules/.bin/electron-vite')
const ext = ['.cmd', '.exe', ''].find((e) => existsSync(base + e)) || ''
const p = spawn(base + ext + ' build', [], {
  cwd,
  shell: true,
  windowsHide: true,
  stdio: ['inherit', 'pipe', 'pipe']
})

pipeLines(p.stdout, process.stdout)
pipeLines(p.stderr, process.stderr)

p.on('exit', (code) => process.exit(code ?? 0))
