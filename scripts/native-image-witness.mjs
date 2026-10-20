/** Record startup identity privately; importing this module never writes target stdout. */
import { appendFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

let configuration
try {
  configuration = JSON.parse(process.env.DSH_NATIVE_IMAGE_WITNESS_CONFIG ?? '')
  const fields = ['output', 'expectedExecutable', 'cli', 'worker']
  if (configuration === null || typeof configuration !== 'object'
    || Object.keys(configuration).length !== fields.length
    || fields.some(key => typeof configuration[key] !== 'string'
      || configuration[key].length > 8192 || !isAbsolute(configuration[key]))) throw new Error('invalid')
} catch { throw new Error('Native image witness configuration is missing or invalid') }

const comparable = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
const entry = process.argv[1] === undefined ? undefined : comparable(process.argv[1])
const role = entry === comparable(configuration.cli) ? 'vitest-cli'
  : entry === comparable(configuration.worker) ? 'vitest-worker' : 'other-node'
appendFileSync(configuration.output, `${JSON.stringify({ kind: 'native-image-start',
  pid: process.pid, ppid: process.ppid, executable: process.execPath, version: process.version,
  expectedImage: comparable(process.execPath) === comparable(configuration.expectedExecutable), role })}\n`, 'utf8')
