import { describe, expect, it } from 'vitest'
import {
  isStateFolderSafeOnPublic,
  isStatePath,
  SENSITIVE_STATE_FOLDERS,
  STATE_FOLDERS,
  STATE_ROOT,
  stateFolderPath,
} from '../src/state-folders.js'

describe('stateFolderPath', () => {
  it('builds the root-relative path for each registered folder', () => {
    expect(stateFolderPath('history')).toBe('.gazetta/history')
    expect(stateFolderPath('audit')).toBe('.gazetta/audit')
    expect(stateFolderPath('review')).toBe('.gazetta/review')
    expect(stateFolderPath('fragment-deps')).toBe('.gazetta/fragment-deps')
    expect(stateFolderPath('asset-refs')).toBe('.gazetta/asset-refs')
    expect(stateFolderPath('alias-targets')).toBe('.gazetta/alias-targets')
    expect(stateFolderPath('publish-generation')).toBe('.gazetta/publish-generation')
  })

  it('joins segments with slashes', () => {
    expect(stateFolderPath('review', 'page', 'index', 'state.json')).toBe('.gazetta/review/page/index/state.json')
    expect(stateFolderPath('fragment-deps', 'a%2Fb')).toBe('.gazetta/fragment-deps/a%2Fb')
  })

  it('rejects unregistered folders at compile time', () => {
    // @ts-expect-error folders outside the registry cannot be built
    void stateFolderPath('not-a-folder')
    expect(STATE_ROOT).toBe('.gazetta')
  })
})

describe('isStateFolderSafeOnPublic', () => {
  it('marks only publish-generation safe on public targets', () => {
    expect(isStateFolderSafeOnPublic('history')).toBe(false)
    expect(isStateFolderSafeOnPublic('audit')).toBe(false)
    expect(isStateFolderSafeOnPublic('review')).toBe(false)
    expect(isStateFolderSafeOnPublic('fragment-deps')).toBe(false)
    expect(isStateFolderSafeOnPublic('asset-refs')).toBe(false)
    expect(isStateFolderSafeOnPublic('alias-targets')).toBe(false)
    expect(isStateFolderSafeOnPublic('publish-generation')).toBe(true)
  })
})

describe('isStatePath', () => {
  it('accepts paths inside the namespace', () => {
    expect(isStatePath('.gazetta/history')).toBe(true)
    expect(isStatePath('.gazetta/history/x.json')).toBe(true)
    expect(isStatePath('sites/main/.gazetta/audit')).toBe(true)
  })

  it('rejects lookalikes and unrelated paths', () => {
    expect(isStatePath('.gazetta-deploy/tmp')).toBe(false)
    expect(isStatePath('dist/.gazetta-deploy')).toBe(false)
    expect(isStatePath('content/pages/index.yaml')).toBe(false)
    expect(isStatePath('gazette/history')).toBe(false)
  })
})

describe('SENSITIVE_STATE_FOLDERS', () => {
  it('is history, audit and review, each a registry key unsafe on public targets', () => {
    expect(SENSITIVE_STATE_FOLDERS).toEqual(['history', 'audit', 'review'])
    for (const folder of SENSITIVE_STATE_FOLDERS) {
      expect(STATE_FOLDERS[folder].safeOnPublic).toBe(false)
    }
  })
})
