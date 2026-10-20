/** Diagnostic control only: actual engine source/artifact or plain VM; zero providers. */
import { Worker } from 'node:worker_threads'
import { tmpdir } from 'node:os'

const arm = process.argv[2]
if (!['source', 'built', 'plain', 'dual-tsx-vm', 'dual-tsx-message', 'esm-tsx-vm', 'dual-tsx-vm-timeout', 'dual-tsx-typescript'].includes(arm)) throw new Error('Unknown reduction arm')
const forbidden = new Set(['DEEPSEEK_API_KEY', 'SILICONFLOW_API_KEY', 'TYPESAFE_API_KEY', 'OPENAI_API_KEY', 'JEV_API_KEY', 'OPENAI_BASE_URL'])
for (const key of Object.keys(process.env)) if (forbidden.has(key.toUpperCase())) delete process.env[key]
globalThis.fetch = async () => { throw new Error('Worker reduction forbids network inference') }
const timer = setTimeout(() => { console.error('Worker reduction timed out'); process.exit(124) }, 120_000)
timer.unref()

function observe(worker, cycle) {
  const threadId = worker.threadId
  const report = (stage, detail = {}) => console.log(JSON.stringify({ arm, cycle, stage, pid: process.pid, threadId, ...detail }))
  report('spawn')
  worker.once('online', () => report('online'))
  const exited = new Promise(resolve => worker.once('exit', code => { report('exit', { code }); resolve() }))
  return { report, exited }
}

async function plain(cycle) {
  const usesLoader = arm !== 'plain'
  const prefix = []
  if (usesLoader) {
    prefix.push(`import { register as registerEsm } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}`)
    if (arm !== 'esm-tsx-vm') {
      prefix.push(`import { register as registerCjs } from ${JSON.stringify(import.meta.resolve('tsx/cjs/api'))}`)
      prefix.push('registerCjs()')
    }
    prefix.push('registerEsm()')
  }
  if (arm === 'dual-tsx-typescript') {
    const fixture = new URL('./typed-worker-value.ts', import.meta.url).href
    prefix.push(`const { typedValue: typedModuleValue } = await import(${JSON.stringify(fixture)})`)
    prefix.push("if (typedModuleValue !== 42) throw new Error('Unexpected typed import value')")
  }
  const vmOptions = arm === 'dual-tsx-vm-timeout' ? ', { timeout: 5000 }' : ''
  const computation = arm === 'dual-tsx-message' ? '42'
    : `await new vm.Script('(async () => { return 42 })()').runInContext(vm.createContext({})${vmOptions})`
  const env = usesLoader && process.platform === 'win32' ? { TMP: tmpdir(), TEMP: tmpdir() } : {}
  if (usesLoader && process.env.TSX_TSCONFIG_PATH !== undefined) env.TSX_TSCONFIG_PATH = process.env.TSX_TSCONFIG_PATH
  const body = prefix.join('\n') + '\n' + `import { parentPort } from 'node:worker_threads';
import vm from 'node:vm';
parentPort.on('message', () => {});
const result = ${computation};
parentPort.postMessage(${arm === 'dual-tsx-typescript' ? '{ value: result, typedModuleValue }' : 'result'});`
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(body)}`), { execArgv: [], env })
  const { report, exited } = observe(worker, cycle)
  try {
    const message = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject) })
    const value = arm === 'dual-tsx-typescript' ? message?.value : message
    if (value !== 42) throw new Error('Unexpected plain result')
    if (arm === 'dual-tsx-typescript' && message?.typedModuleValue !== 42) throw new Error('Missing typed import result')
    const detail = arm === 'dual-tsx-typescript' ? { typedModuleValue: message.typedModuleValue }
      : arm === 'dual-tsx-vm-timeout' ? { syncTimeoutMs: 5000 } : {}
    report('result', detail)
  } finally {
    report('terminate-start')
    await worker.terminate()
    await exited
    report('terminate-resolve')
  }
}

async function engine() {
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: SessionProjection } = await import('@deepseek-ai/dsh-session-projection')
  const { default: SubagentRuntime } = await import('@deepseek-ai/dsh-subagent')
  const { default: Engine } = await import(arm === 'source' ? '../../src/index.ts' : '../../lib/index.js')
  const ctx = new Context()
  try {
    await ctx.plugin(SessionProjection)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({ name: 'diagnostic-unused', inheritsParentContext: false,
      capabilities: { agentOptions: true, outputSchema: true, depthLimit: false, toolFilter: false, persona: false },
      async start() { throw new Error('Worker reduction must not start an agent') },
    })
    await ctx.plugin(Engine, { provider: 'diagnostic-unused', maxConcurrentAgents: 1 })
    for (let cycle = 0; cycle < 4; cycle++) {
      const run = ctx.workflowEngine.start({ script: 'return 42',
        meta: { name: 'native-reduction', description: 'Fixed normal result/dispose diagnostic' },
        parent: { id: 'native-reduction-parent', options: {} } })
      // Read the existing native handle for diagnostic identity; never replace its lifecycle.
      const { report, exited } = observe(run.worker, cycle)
      try {
        const result = await run.result
        if (result.stopReason !== 'completed' || result.value !== 42 || result.agentsStarted !== 0) throw new Error('Unexpected engine result')
        report('result')
      } finally {
        report('terminate-start')
        await run.dispose()
        await exited
        report('terminate-resolve')
      }
    }
  } finally { await ctx.fiber.dispose() }
}

try {
  if (arm !== 'source' && arm !== 'built') for (let cycle = 0; cycle < 4; cycle++) await plain(cycle)
  else await engine()
} finally { clearTimeout(timer) }
