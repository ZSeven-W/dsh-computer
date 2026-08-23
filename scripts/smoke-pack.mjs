import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const scratch = await mkdtemp(join(tmpdir(), 'dsh-computer-pack-'))
const packs = join(scratch, 'packs')
const install = join(scratch, 'install')
const npmCache = join(scratch, 'npm-cache')

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${stdout}${stderr}`)))
  })
}

try {
  await Promise.all([mkdir(packs), mkdir(install), mkdir(npmCache)])
  const npmCli = process.platform === 'win32'
    ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : null
  if (npmCli) await access(npmCli)
  const runNpm = (args, options = {}) => run(
    npmCli ? process.execPath : 'npm', npmCli ? [npmCli, ...args] : args,
    { ...options, env: { ...process.env, npm_config_cache: npmCache } },
  )

  await runNpm(['pack', '--pack-destination', packs])
  const archive = (await readdir(packs)).find(name => name.endsWith('.tgz'))
  if (!archive) throw new Error('npm pack produced no archive')

  await writeFile(join(install, 'package.json'), JSON.stringify({ private: true, type: 'module' }, null, 2) + '\n')
  await runNpm(['install', '--no-audit', '--no-fund', join(packs, archive)], { cwd: install })
  try {
    await access(join(install, 'node_modules', '@deepseek-ai'))
    throw new Error('packed install unexpectedly pulled @deepseek-ai/*')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const installed = join(install, 'node_modules', '@zseven-w', 'dsh-computer')
  try {
    await access(join(installed, 'native', '.build'))
    throw new Error('packed archive leaked a machine-specific Swift build artifact')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  for (const relative of [
    'cordis.patch.yml', 'README.md', 'README.zh.md', 'lib/index.js', 'lib/index.d.ts',
    'lib/contracts.js', 'lib/contracts.d.ts', 'native/Package.swift',
    'native/Sources/DSHComputerHelper/main.swift', 'native/Sources/ComputerCore/Models.swift',
  ]) await access(join(installed, relative))

  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  for (const field of ['dependencies', 'peerDependencies']) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (name.startsWith('@deepseek-ai/')) throw new Error(`${field} contains forbidden host package ${name}`)
    }
  }

  const probe = [
    "import { ComputerController, COMPUTER_DRIVER_SERVICE } from '@zseven-w/dsh-computer';",
    "if (COMPUTER_DRIVER_SERVICE !== 'zsevenComputerDriver') throw new Error('bad service');",
    "const driver = new ComputerController({ platform: 'linux' });",
    "const evidence = await driver.evidence({ scopeId: 'packed-smoke' });",
    "if (evidence.status.platform !== 'unsupported') throw new Error('unsupported runtime did not degrade');",
    "await driver.dispose();",
  ].join('\n')
  await run(process.execPath, ['--input-type=module', '-e', probe], { cwd: install })
  let nativeDetail = 'native installed-helper smoke skipped on non-macOS'
  if (process.platform === 'darwin') {
    const helperCache = join(scratch, 'installed-helper-cache')
    const nativeProbe = [
      "import { NativeHelper, NativeHelperError } from '@zseven-w/dsh-computer';",
      `const helper = new NativeHelper({ packageRoot: ${JSON.stringify(installed)}, cacheRoot: ${JSON.stringify(helperCache)} });`,
      "try {",
      "  const status = await helper.request({ id: 'packed-status', command: 'status' }, { scopeId: 'packed-smoke' });",
      "  if (status.platform !== 'macos' || typeof status.accessibilityTrusted !== 'boolean') throw new Error('bad native status');",
      "  let observed;",
      "  try {",
      "    const value = await helper.request({ id: 'packed-observe', command: 'observe', app: null, window: null, maxDepth: 1, maxNodes: 4 }, { scopeId: 'packed-smoke' });",
      "    observed = { ok: true, nodes: value.nodes.length, truncated: value.truncated };",
      "  } catch (error) {",
      "    if (!(error instanceof NativeHelperError) || error.code !== 'accessibility_permission_required') throw error;",
      "    observed = { ok: false, code: error.code };",
      "  }",
      "  process.stdout.write(JSON.stringify({ status, observed }));",
      "} finally { await helper.dispose(); }",
    ].join('\n')
    const native = await run(process.execPath, ['--input-type=module', '-e', nativeProbe], { cwd: install })
    nativeDetail = `installed helper ${native.stdout.trim()}`
  }
  console.log(
    `packed install smoke passed: ${archive}; no @deepseek-ai packages; unsupported runtime degrades clearly; ${nativeDetail}`,
  )
} finally {
  await rm(scratch, { recursive: true, force: true })
}
