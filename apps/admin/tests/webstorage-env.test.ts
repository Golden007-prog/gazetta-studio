/**
 * Tests must see jsdom's Web Storage, not Node's built-in one. On Node 25
 * Node's `localStorage` global shadows jsdom's and lacks `clear()`, which
 * breaks any test that resets storage between cases.
 */
import { describe, it, expect } from 'vitest'

describe('test environment Web Storage', () => {
  it.each([
    ['localStorage', () => localStorage],
    ['sessionStorage', () => sessionStorage],
  ])('%s is a full jsdom Storage', (_name, get) => {
    const storage = get()
    expect(storage).toBeInstanceOf(window.Storage)
    expect(typeof storage.clear).toBe('function')
    storage.setItem('k', 'v')
    storage.clear()
    expect(storage.getItem('k')).toBeNull()
  })
})
