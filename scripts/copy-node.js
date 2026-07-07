const { existsSync, mkdirSync, copyFileSync } = require('fs')
const { join } = require('path')

const nodeExe = process.execPath
const destDir = join(__dirname, '..', 'node_runtime')
if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })

const srcExe = join(nodeExe)
const destExe = join(destDir, 'node.exe')
try {
  copyFileSync(srcExe, destExe)
  console.log('[copy-node] copied', srcExe, '->', destExe)
} catch (e) {
  console.error('[copy-node] failed to copy node.exe:', e.message)
  process.exit(1)
}
