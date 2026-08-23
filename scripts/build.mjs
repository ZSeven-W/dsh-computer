import { spawn } from 'node:child_process'
import { join } from 'node:path'

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)))
  })
}

await run(process.execPath, [join('node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'])
if (process.platform === 'darwin') {
  await run('swift', ['build', '-c', 'release', '--package-path', 'native'])
} else {
  console.log(`Swift helper build skipped on ${process.platform}; runtime reports macOS-only support`)
}
