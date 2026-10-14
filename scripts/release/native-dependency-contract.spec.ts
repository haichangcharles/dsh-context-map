/** Published native constraints must preserve the version exercised by workspace CI. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'
import { releaseFamily, type ReleaseMember } from './families.ts'

function koffiConstraint(member: ReleaseMember): unknown {
  const dependencies = member.manifest.dependencies
  return typeof dependencies === 'object' && dependencies !== null && 'koffi' in dependencies
    ? dependencies.koffi : undefined
}

it('keeps every published Koffi consumer on its workspace-tested exact native version', () => {
  const root = resolve(import.meta.dirname, '../..')
  const lock = load(readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8')) as {
    importers: Record<string, { dependencies?: Record<string, { specifier: string; version: string }> }>
  }
  const consumers = releaseFamily('dsh').members(root).filter(member => koffiConstraint(member) !== undefined)
  expect(consumers.map(member => member.directory).sort()).toEqual([
    'packages/fs/fs-local', 'packages/host/directory-picker-native',
    'packages/sandbox/sandbox-windows-acl', 'packages/session/session-persistence-jsonl',
    'packages/subprocess/subprocess-local', 'packages/subprocess/win32-process',
  ])
  for (const consumer of consumers) {
    const tested = lock.importers[consumer.directory]?.dependencies?.koffi
    if (tested === undefined) throw new Error(`${consumer.directory} lacks a workspace-tested Koffi resolution`)
    // A fresh npm consumer does not inherit pnpm-lock.yaml. A caret can resolve
    // a different native installer even when workspace CI remains unchanged.
    expect(koffiConstraint(consumer), consumer.directory).toBe(tested.version)
    expect(tested.specifier, consumer.directory).toBe(tested.version)
    expect(tested.version).toMatch(/^\d+\.\d+\.\d+$/u)
  }
})
