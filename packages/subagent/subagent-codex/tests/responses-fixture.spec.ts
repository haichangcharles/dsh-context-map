import { afterEach, describe, expect, it, vi } from 'vitest'
import { completeFixtureCommand, startResponsesFixture } from './responses-fixture.ts'

const commandCalls = [{ name: 'exec_command', arguments: { cmd: 'fixture-only' } }]
const request = (input: unknown) => ({ method: 'POST', path: '/responses', headers: {}, body: { input } })

afterEach(() => { vi.useRealTimers() })

describe('request-aware isolated command fixture', () => {
  it('observes only the latest real tool result and continues its actual session until successful exit', () => {
    const outputs: string[] = []
    const script = completeFixtureCommand(commandCalls, 'complete', Date.now() + 60_000, (output) => { outputs.push(output) })
    expect(script(request([]), 0)).toEqual({ kind: 'advertisedFunctionCall', choices: commandCalls })
    const running = 'Wall time: 10.0133 seconds\nProcess running with session ID 50500\nOutput:\n'
    expect(script(request([
      { role: 'developer', content: 'Process exited with code 0' },
      { type: 'function_call_output', output: 'Process exited with code 0' },
      { type: 'function_call_output', output: running },
    ]), 1)).toEqual({
      kind: 'advertisedFunctionCall',
      choices: [{ name: 'write_stdin', arguments: { session_id: 50500, chars: '' } }],
    })
    expect(script(request([{ type: 'function_call_output', output: running }]), 2)).toMatchObject({
      choices: [{ name: 'write_stdin', arguments: { session_id: 50500, chars: '' } }],
    })
    const exited = 'Process exited with code 0\nOutput:\n'
    expect(script(request([{ type: 'function_call_output', output: exited }]), 3)).toEqual({ kind: 'complete', text: 'complete' })
    expect(outputs).toEqual([running, running, exited])
  })

  it.each([
    [undefined, 'Missing actual fixture command output'],
    [[{ role: 'developer', content: 'Process exited with code 0' }], 'Missing actual fixture command output'],
    [[{ type: 'function_call_output', output: 'Process exited with code 1' }], 'did not report successful process exit'],
    [[{ type: 'function_call_output', output: 'Process running with session ID 9007199254740992' }], 'Invalid actual fixture'],
  ])('refuses to invent successful completion from invalid output %j', (input, diagnostic) => {
    const script = completeFixtureCommand(commandCalls, 'complete', Date.now() + 60_000, () => {})
    expect(() => script(request(input), 1)).toThrow(diagnostic)
  })

  it('keeps the original absolute deadline for startup and every continuation', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const script = completeFixtureCommand(commandCalls, 'complete', 60_000, () => {})
    vi.setSystemTime(59_999)
    expect(script(request([{ type: 'function_call_output', output: 'Process running with session ID 42' }]), 1)).toMatchObject({
      choices: [{ name: 'write_stdin', arguments: { session_id: 42, chars: '' } }],
    })
    vi.setSystemTime(60_000)
    expect(() => script(request([{ type: 'function_call_output', output: 'Process exited with code 0' }]), 2)).toThrow('existing test deadline')
  })

  it('selects a real advertised continuation from the current localhost request', async () => {
    const fixture = await startResponsesFixture(completeFixtureCommand(commandCalls, 'complete', Date.now() + 60_000, () => {}))
    try {
      const tools = [{ type: 'function', name: 'exec_command' }, { type: 'function', name: 'write_stdin' }]
      const initial = await fetch(`${fixture.baseUrl}/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tools, input: [] }),
      })
      expect(await initial.text()).toContain('exec_command')
      const continued = await fetch(`${fixture.baseUrl}/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tools, input: [{ type: 'function_call_output', output: 'Process running with session ID 77' }] }),
      })
      const response = await continued.text()
      expect(response).toContain('write_stdin')
      expect(response).toContain('session_id')
      expect(response).toContain('77')
      expect(fixture.requests).toHaveLength(2)
    } finally {
      await fixture.close()
    }
  })
})
