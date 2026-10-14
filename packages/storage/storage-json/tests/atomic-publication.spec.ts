import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeAtomic } from '../src/atomic.ts'
import { JsonStorageBackend } from '../src/index.ts'

const boundary = vi.hoisted(() => ({
  rename: vi.fn<(temp: string, target: string) => Promise<void>>(),
  fileSynced: false,
  fileClosed: false,
  openFailure: undefined as Error | undefined,
}))

// The expensive/non-deterministic boundary is the shared rename adapter. Keep
// JSON serialization, real temp writes, fsync, close, cleanup and public units real.
vi.mock('@deepseek-ai/dsh-atomic-write', () => ({ renameAtomicTemp: boundary.rename }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: (async (...args: Parameters<typeof actual.open>) => {
    if (args[1] === 'wx' && boundary.openFailure !== undefined) throw boundary.openFailure
    const handle = await actual.open(...args)
    if (args[1] === 'wx') {
      const sync = handle.sync.bind(handle)
      vi.spyOn(handle, 'sync').mockImplementation(async () => { await sync(); boundary.fileSynced = true })
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); boundary.fileClosed = true })
    }
    return handle
  }) }
})

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  boundary.rename.mockReset()
  boundary.fileSynced = false
  boundary.fileClosed = false
  boundary.openFailure = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })))
})
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-json-atomic-publication-'))
  roots.push(root)
  return root
}

describe('durable JSON atomic publication', () => {
  it('delegates a complete, synced and closed sibling to the shared rename owner', async () => {
    const root = await scratch()
    const target = join(root, 'record.json')
    await writeFile(target, 'old')
    boundary.rename.mockImplementation(async (temp, destination) => {
      expect(boundary.fileSynced).toBe(true)
      expect(boundary.fileClosed).toBe(true)
      expect(await readFile(temp, 'utf8')).toBe('complete next document')
      expect(await readFile(destination, 'utf8')).toBe('old')
      await rename(temp, destination)
    })
    await writeAtomic(target, 'complete next document')
    expect(boundary.rename).toHaveBeenCalledTimes(1)
    expect(await readFile(target, 'utf8')).toBe('complete next document')
    expect(await readdir(root)).toEqual(['record.json'])
  })

  it('preserves the final rename error, old target and temp cleanup after the shared owner rejects', async () => {
    const root = await scratch()
    const target = join(root, 'record.json')
    await writeFile(target, 'old')
    const failure = Object.assign(new Error('replacement remained unavailable'), { code: 'EPERM', syscall: 'rename' })
    boundary.rename.mockRejectedValue(failure)
    await expect(writeAtomic(target, 'next')).rejects.toBe(failure)
    expect(boundary.rename).toHaveBeenCalledTimes(1)
    expect(await readFile(target, 'utf8')).toBe('old')
    expect(await readdir(root)).toEqual(['record.json'])
  })

  it('does not retry or delegate an exclusive-open failure to the rename owner', async () => {
    const root = await scratch()
    const target = join(root, 'record.json')
    await writeFile(target, 'old')
    const failure = Object.assign(new Error('exclusive create unavailable'), { code: 'EPERM', syscall: 'open' })
    boundary.openFailure = failure
    await expect(writeAtomic(target, 'next')).rejects.toBe(failure)
    expect(boundary.rename).not.toHaveBeenCalled()
    expect(await readFile(target, 'utf8')).toBe('old')
    expect(await readdir(root)).toEqual(['record.json'])
  })

  it.each(['single', 'per-record'] as const)('keeps the %s unit authoritative record unchanged after publish failure', async (layout) => {
    const root = await scratch()
    const backend = new JsonStorageBackend(root)
    try {
      const unit = await backend.kv.open({ name: 'cache', version: 1, tables: ['sessions'], hasGlobal: false, layout })
      boundary.rename.mockImplementation(rename)
      await unit.putRecord('sessions', 'session', { title: 'old' })
      const failure = Object.assign(new Error('final publish failed'), { code: 'EPERM', syscall: 'rename' })
      boundary.rename.mockRejectedValue(failure)
      await expect(unit.putRecord('sessions', 'session', { title: 'new' })).rejects.toBe(failure)
      expect((await unit.loadAll()).tables.sessions?.session).toEqual({ title: 'old' })
    } finally { await backend.close() }
  })
})
