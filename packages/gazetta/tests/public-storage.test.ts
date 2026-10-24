/**
 * `isPublicStorage` and the `isEditable` default that follows it
 * (design-public-storage.md Q6): private only for an explicitly editable
 * filesystem target or a target whose deploy adapter copies site files;
 * public otherwise; an explicit `publicStorage` wins; `environment` never
 * decides privacy.
 */
import { describe, expect, it } from 'vitest'
import type { DeployAdapter } from '../src/deploy/types.js'
import {
  isEditable,
  isPublicStorage,
  type StorageKind,
  type TargetConfig,
  type TargetEnvironment,
} from '../src/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'

function storageOf(kind: StorageKind | undefined) {
  const storage = memoryStorage()
  return kind ? { ...storage, kind } : storage
}

const copyAdapter: DeployAdapter = {
  name: 'copy',
  supports: ['static'],
  copiesSiteFiles: true,
  execute: async () => ({}),
}
const workerAdapter: DeployAdapter = { name: 'worker', supports: ['dynamic'], execute: async () => ({}) }

interface Row {
  kind: StorageKind | undefined
  editable?: boolean
  deploy?: DeployAdapter
  environment?: TargetEnvironment
  publicStorage?: boolean
  isPublic: boolean
  editableResolved: boolean
}

const rows: Row[] = [
  // Default rule
  { kind: 'filesystem', editable: true, isPublic: false, editableResolved: true },
  { kind: 'filesystem', isPublic: true, editableResolved: false },
  { kind: 'filesystem', editable: false, isPublic: true, editableResolved: false },
  { kind: 'r2', editable: true, isPublic: true, editableResolved: true },
  { kind: 's3', isPublic: true, editableResolved: false },
  { kind: 'azure', isPublic: true, editableResolved: false },
  { kind: undefined, editable: true, isPublic: true, editableResolved: true },
  { kind: undefined, isPublic: true, editableResolved: false },
  { kind: 'r2', deploy: copyAdapter, isPublic: false, editableResolved: true },
  { kind: 'r2', deploy: copyAdapter, environment: 'production', isPublic: false, editableResolved: false },
  { kind: 'r2', deploy: workerAdapter, isPublic: true, editableResolved: false },
  // environment never makes storage private or public
  { kind: 'r2', environment: 'local', isPublic: true, editableResolved: false },
  { kind: 'filesystem', environment: 'local', isPublic: true, editableResolved: false },
  { kind: 'filesystem', editable: true, environment: 'production', isPublic: false, editableResolved: true },
  // Explicit publicStorage wins
  { kind: 'r2', publicStorage: false, isPublic: false, editableResolved: true },
  { kind: 'r2', publicStorage: false, environment: 'staging', isPublic: false, editableResolved: false },
  { kind: undefined, publicStorage: false, isPublic: false, editableResolved: true },
  { kind: 'filesystem', editable: true, publicStorage: true, isPublic: true, editableResolved: true },
  { kind: 'r2', deploy: copyAdapter, publicStorage: true, isPublic: true, editableResolved: false },
]

describe('isPublicStorage / isEditable', () => {
  it.each(rows)(
    'kind=$kind editable=$editable deploy=$deploy.name env=$environment publicStorage=$publicStorage → public=$isPublic editable=$editableResolved',
    ({ kind, editable, deploy, environment, publicStorage, isPublic, editableResolved }) => {
      const target: TargetConfig = { storage: storageOf(kind), editable, deploy, environment, publicStorage }
      expect(isPublicStorage(target)).toBe(isPublic)
      expect(isEditable(target)).toBe(editableResolved)
    },
  )
})
