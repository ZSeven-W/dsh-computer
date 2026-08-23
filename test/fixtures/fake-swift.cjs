#!/usr/bin/env node
const { writeFile } = require('node:fs/promises')

const marker = process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER
if (!marker) process.exit(2)

async function main() {
  await writeFile(marker, 'started\n')
  process.on('SIGTERM', async () => {
    await writeFile(`${marker}.terminated`, 'terminated\n')
    process.exit(143)
  })
  setInterval(() => {}, 1_000)
}

main().catch(error => {
  process.stderr.write(String(error))
  process.exit(1)
})
