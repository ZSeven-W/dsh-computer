import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const testDir = join(root, 'test')
const files = readdirSync(testDir, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map(entry => join(testDir, entry.name))
  .sort()

if (files.length === 0) throw new Error('no Node tests discovered')
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit', shell: false })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
