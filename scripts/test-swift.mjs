import { spawn } from 'node:child_process'

if (process.platform !== 'darwin') {
  console.log(`Swift helper tests skipped on ${process.platform}; runtime reports macOS-only support`)
  process.exit(0)
}

const child = spawn('swift', ['test', '--package-path', 'native'], { stdio: 'inherit', shell: false })
child.on('error', error => { throw error })
child.on('close', code => { process.exitCode = code ?? 1 })
