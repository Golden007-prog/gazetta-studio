/**
 * Page Object for the component tree panel in the editor.
 *
 * Wraps the `[data-testid="component-{name}"]` rows + their
 * hover-revealed actions (add / remove / move / revert) and the
 * add-component dialog. Tests describe user-level actions — `open`,
 * `add`, `remove`, `moveUp` — without fishing for testid strings.
 *
 * Conventions match PublishPanelPom + SiteTreePom:
 *   - `page` injected in the constructor; no inheritance
 *   - Methods = user actions; getters return locators; assertions stay
 *     in the tests
 *   - Composes class-based selectors (.node-dirty-dot, .node-revert)
 *     under the row's testid so stable internal markup doesn't leak
 *     into spec files
 */
import type { Locator, Page } from '@playwright/test'

export class ComponentTreePom {
  constructor(private readonly page: Page) {}

  // ---- Rows -----------------------------------------------------------

  /** Row for a component by name (e.g. 'hero', 'features'). */
  row(name: string): Locator {
    return this.page.locator(`[data-testid="component-${name}"]`)
  }

  /** Every component row — used for count assertions in add/remove tests. */
  get allRows(): Locator {
    return this.page.locator('[data-testid^="component-"]')
  }

  /** Click a component row to focus its editor. */
  async open(name: string): Promise<void> {
    await this.row(name).click()
  }

  /**
   * The editor form for component `path` (`hero`, `features/fast`). The
   * page row has a form too when its template has fields, so a bare
   * `editor-container` can be the previous one, not the one just opened.
   */
  editor(path: string): Locator {
    return this.page.locator(`[data-testid="editor-container"][data-path="${path}"]`)
  }

  /** Open a component with schema fields and wait until its form is shown. */
  async openEditor(path: string): Promise<Locator> {
    await this.open(path.split('/').pop() ?? path)
    const editor = this.editor(path)
    await editor.waitFor()
    return editor
  }

  // ---- Dirty + revert -------------------------------------------------

  /**
   * Dirty dot on a component row (pending-edit or in-flight save).
   * Composes `.node-dirty-dot` under the row's testid — the class is
   * internal markup but stable per ComponentTree.vue.
   */
  dirtyDot(name: string): Locator {
    return this.row(name).locator('.node-dirty-dot')
  }

  /**
   * Revert button on a component row — visible on hover when the row
   * has pending edits. Wraps the `.node-revert` class inside the
   * row's testid.
   */
  revertButton(name: string): Locator {
    return this.row(name).locator('.node-revert')
  }

  /** Hover then click revert. */
  async revert(name: string): Promise<void> {
    await this.row(name).hover()
    await this.revertButton(name).click()
  }

  // ---- Add / remove / move -------------------------------------------

  /**
   * Add an inline component: open dialog → fill name → pick template
   * → submit. `template` matches the listbox option text (e.g.
   * 'text-block', 'hero').
   */
  async add(name: string, template: string): Promise<void> {
    await this.page.click('[data-testid="add-component"]')
    const nameInput = this.page.locator('[data-testid="add-component-name"]')
    await nameInput.waitFor({ timeout: 5000 })
    await nameInput.fill(name)
    // PrimeVue Listbox — options don't carry testids; text match is the
    // only stable handle short of patching PrimeVue.
    await this.page.locator('.p-listbox-option', { hasText: template }).click()
    await this.page.click('[data-testid="add-component-submit"]')
  }

  /** Hover then click the per-row remove button. */
  async remove(name: string): Promise<void> {
    await this.row(name).hover()
    await this.page.click(`[data-testid="remove-${name}"]`)
  }

  /**
   * Hover then click the per-row Duplicate button (#45). The duplicate
   * lands at the source's index + 1 with name `${source}-copy[-N]`;
   * pending until save like every other structural change.
   */
  async duplicate(name: string): Promise<void> {
    await this.row(name).hover()
    await this.page.click(`[data-testid="duplicate-${name}"]`)
  }

  /**
   * Move a top-level row one position up. Uses the Alt+ArrowUp keyboard
   * shortcut (#105 — replaces the legacy move-up button).
   *
   * Direct event dispatch via `evaluate` instead of focus+keyboard.press:
   * after a save cycle the v-for re-renders the block; Playwright's
   * `focus()` can resolve against a freshly-attached element before
   * Vue has finished its DOM patch, leaving focus on `body` and
   * `keyboard.press` going to a no-op. Dispatching the keydown event
   * synchronously on the handle's `closest('.top-level-block')` (where
   * the listener lives) is deterministic and CI-cold-start safe.
   */
  async moveUp(name: string): Promise<void> {
    await this.dispatchAltArrow(name, 'ArrowUp')
  }

  /** Move a top-level row one position down (Alt+ArrowDown shortcut). */
  async moveDown(name: string): Promise<void> {
    await this.dispatchAltArrow(name, 'ArrowDown')
  }

  private async dispatchAltArrow(name: string, key: 'ArrowUp' | 'ArrowDown'): Promise<void> {
    const handle = this.page.locator(`[data-testid="drag-handle-${name}"]`)
    await handle.waitFor({ state: 'visible', timeout: 10000 })
    // `waitFor({ state: 'visible' })` doesn't imply "Vue's reactivity queue
    // is flushed and event listeners are attached on the current DOM nodes."
    // After a save cycle, `selection.reload()` schedules another v-for patch
    // whose DOM nodes can attach mid-evaluate, so the synthetic keydown
    // below fires against a detached `.top-level-block` listener and the
    // store action never runs (#288). Two rAF rounds: the first rAF lets
    // Vue's scheduler flush; the second ensures the resulting DOM commit
    // has landed. Same mechanism Vue's `nextTick` uses internally.
    await this.page.evaluate(
      () =>
        new Promise<void>(resolve => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        }),
    )
    await handle.evaluate((el, k) => {
      const block = el.closest('.top-level-block')
      if (!block) throw new Error('drag handle is not inside a top-level block')
      block.dispatchEvent(new KeyboardEvent('keydown', { key: k, altKey: true, bubbles: true, cancelable: true }))
    }, key)
  }

  // ---- Dialog surfaces (for assertions about the add flow) ----------

  /** Name field in the add-component dialog. */
  get addDialogNameInput(): Locator {
    return this.page.locator('[data-testid="add-component-name"]')
  }

  /** Submit button in the add-component dialog. */
  get addDialogSubmit(): Locator {
    return this.page.locator('[data-testid="add-component-submit"]')
  }
}
