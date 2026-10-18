import type { Page } from '@playwright/test'

/**
 * Navigate to admin in edit mode for a page — uses the direct URL to avoid
 * race conditions from clicking data-gz elements in the preview iframe.
 * Waits for the component tree to render before returning.
 */
export async function openEditor(page: Page, pageName: string): Promise<void> {
  await page.goto(`/admin/pages/${pageName}/edit`)
  await page.waitForSelector('[data-testid^="component-"]', { timeout: 10000 })
}

/** Titles of the unsaved field drafts held in the draft store (IndexedDB). */
export function storedDraftTitles(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res, rej) => {
      const req = indexedDB.open('gazetta-drafts')
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
    if (!db.objectStoreNames.contains('drafts')) return []
    const rows = await new Promise<Array<{ id: string[]; value?: { editedContent?: { title?: string } } }>>(res => {
      const req = db.transaction('drafts').objectStore('drafts').getAll()
      req.onsuccess = () => res(req.result)
    })
    return rows.filter(r => r.id[3] === 'edit').map(r => r.value?.editedContent?.title ?? '')
  })
}

/** Pending titles of the unsaved page-metadata drafts held in the draft store. */
export function storedMetadataTitles(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res, rej) => {
      const req = indexedDB.open('gazetta-drafts')
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
    if (!db.objectStoreNames.contains('drafts')) return []
    const rows = await new Promise<Array<{ id: string[]; value?: { pending?: { title?: string } } }>>(res => {
      const req = db.transaction('drafts').objectStore('drafts').getAll()
      req.onsuccess = () => res(req.result)
    })
    return rows.filter(r => r.id[3] === 'metadata').map(r => r.value?.pending?.title ?? '')
  })
}

/** Keys of the drafts of one kind held in the draft store. */
export function storedDraftKeys(page: Page, kind: 'edit' | 'structural' | 'metadata'): Promise<string[]> {
  return page.evaluate(async kind => {
    const db: IDBDatabase = await new Promise((res, rej) => {
      const req = indexedDB.open('gazetta-drafts')
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
    if (!db.objectStoreNames.contains('drafts')) return []
    const rows = await new Promise<Array<{ id: string[] }>>(res => {
      const req = db.transaction('drafts').objectStore('drafts').getAll()
      req.onsuccess = () => res(req.result)
    })
    return rows.filter(r => r.id[3] === kind).map(r => r.id[4])
  }, kind)
}
