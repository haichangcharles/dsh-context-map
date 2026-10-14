import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const source = resolve(import.meta.dirname, 'prepare-ci-bubblewrap.sh')

async function runner(operation: (fixture: {
  env: NodeJS.ProcessEnv
  root: string
  pathFile: string
  logFile: string
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ci-bwrap-test-'))
  const pathFile = join(root, 'github-path')
  const logFile = join(root, 'commands')
  try {
    await Promise.all([writeFile(pathFile, ''), writeFile(logFile, '')])
    const scripts = {
      uname: ['#!/usr/bin/env bash', 'if [[ "$1" == "-s" ]]; then echo "${TEST_SYSTEM:-Linux}"; else echo "${TEST_ARCH:-x86_64}"; fi'],
      'apt-get': ['#!/usr/bin/env bash', 'echo "apt-get $*" >> "$TEST_COMMAND_LOG"',
        'if [[ "$1" == -c ]]; then cat "$2" >> "$TEST_COMMAND_LOG"; fi',
        'if [[ "$*" == *"update -q" ]]; then exit "${TEST_UPDATE_STATUS:-0}"; fi',
        'if [[ "$*" == *"download bubblewrap" ]]; then',
        '  if [[ "${TEST_DOWNLOAD_STATUS:-0}" != 0 ]]; then exit "$TEST_DOWNLOAD_STATUS"; fi',
        '  if [[ "${TEST_PACKAGES:-one}" != empty ]]; then touch bubblewrap_0.9.0-99_amd64.deb; fi',
        '  if [[ "${TEST_PACKAGES:-one}" == two ]]; then touch bubblewrap_0.9.0-98_amd64.deb; fi', '  exit 0', 'fi', 'exit 97'],
      'dpkg-deb': ['#!/usr/bin/env bash', 'echo "dpkg-deb $*" >> "$TEST_COMMAND_LOG"', 'mkdir -p "$3/usr/bin"',
        'cat > "$3/usr/bin/bwrap" <<\'BWRAP\'', '#!/usr/bin/env bash', 'echo "bwrap $*" >> "$TEST_COMMAND_LOG"',
        'if [[ "$1" == --version ]]; then echo "bubblewrap 0.9.0"; exit 0; fi',
        'exit "${TEST_PROBE_STATUS:-0}"', 'BWRAP', 'chmod +x "$3/usr/bin/bwrap"'],
      sudo: ['#!/usr/bin/env bash', 'echo "sudo $*" >> "$TEST_COMMAND_LOG"', 'exit "${TEST_SYSCTL_STATUS:-0}"'],
    }
    for (const [name, lines] of Object.entries(scripts)) {
      await writeFile(join(root, name), lines.join('\n') + '\n', { mode: 0o700 })
    }
    await operation({ root, pathFile, logFile, env: { ...process.env,
      PATH: `${root}:${process.env.PATH ?? ''}`, RUNNER_TEMP: root, GITHUB_PATH: pathFile,
      TEST_COMMAND_LOG: logFile } })
  } finally { await rm(root, { recursive: true, force: true }) }
}

// The production preparation script runs on Linux; POSIX hosts execute its command fixtures.
describe.skipIf(process.platform === 'win32')('CI bubblewrap preparation', () => {
  it('uses isolated authenticated package indices, probes confinement, and publishes only its ready binary', async () => {
    await runner(async ({ env, root, pathFile, logFile }) => {
      const { stdout } = await execute('bash', [source], { env })
      expect(stdout).toContain('bubblewrap functional probe passed')
      const bin = (await readFile(pathFile, 'utf8')).trim()
      expect(bin.startsWith(join(root, 'dsh-bubblewrap.'))).toBe(true)
      await expect(stat(join(bin, 'bwrap'))).resolves.toBeDefined()
      const packageRoot = resolve(bin, '../..')
      await expect(stat(join(packageRoot, 'apt-lists'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(join(packageRoot, 'archives'))).rejects.toMatchObject({ code: 'ENOENT' })
      const commands = await readFile(logFile, 'utf8')
      expect(commands).toContain(`Dir::State::lists=${packageRoot}/apt-lists`)
      expect(commands).toContain('download bubblewrap')
      expect(commands).toContain('#clear APT::Update::Post-Invoke-Success;')
      expect(commands).toContain('AllowUnauthenticated=false')
      expect(commands).not.toContain('apt-get install')
      expect(commands).not.toContain('curl')
      expect(commands).toContain('--ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true')
    })
  })

  it('allocates separate package indices and binaries for simultaneous preparation processes', async () => {
    await runner(async ({ env, pathFile }) => {
      await Promise.all([execute('bash', [source], { env }), execute('bash', [source], { env })])
      const binaries = (await readFile(pathFile, 'utf8')).trim().split('\n')
      expect(binaries).toHaveLength(2)
      expect(new Set(binaries).size).toBe(2)
      for (const bin of binaries) await expect(stat(join(bin, 'bwrap'))).resolves.toBeDefined()
    })
  })

  it.each([{ TEST_UPDATE_STATUS: '43' }, { TEST_DOWNLOAD_STATUS: '44' },
    { TEST_PACKAGES: 'empty' }, { TEST_PACKAGES: 'two' }])(
    'fails closed before extraction when package metadata or payload acquisition fails: %j', async (changes) => {
      await runner(async ({ env, pathFile, logFile }) => {
        await expect(execute('bash', [source], { env: { ...env, ...changes } })).rejects.toBeDefined()
        expect(await readFile(pathFile, 'utf8')).toBe('')
        expect(await readFile(logFile, 'utf8')).not.toContain('dpkg-deb')
      })
    })

  it('does not publish a binary when the real-kernel probe fails', async () => {
    await runner(async ({ env, pathFile }) => {
      await expect(execute('bash', [source], { env: { ...env, TEST_PROBE_STATUS: '52' } }))
        .rejects.toMatchObject({ code: 52 })
      expect(await readFile(pathFile, 'utf8')).toBe('')
    })
  })

  it('lets the functional probe decide when the optional AppArmor knob is absent', async () => {
    await runner(async ({ env, pathFile }) => {
      const { stdout } = await execute('bash', [source], { env: { ...env, TEST_SYSCTL_STATUS: '1' } })
      expect(stdout).toContain('apparmor userns knob absent')
      expect((await readFile(pathFile, 'utf8')).trim()).not.toBe('')
    })
  })

  it.each([{ TEST_SYSTEM: 'Darwin' }, { TEST_ARCH: 'aarch64' }])(
    'rejects unsupported hosts without downloading packages: %j', async (changes) => {
      await runner(async ({ env, logFile }) => {
        await expect(execute('bash', [source], { env: { ...env, ...changes } }))
          .rejects.toMatchObject({ code: 1 })
        expect(await readFile(logFile, 'utf8')).toBe('')
      })
    })
})
