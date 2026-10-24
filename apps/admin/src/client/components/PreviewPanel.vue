<script setup lang="ts">
import { ref, watch, computed, onMounted, onUnmounted } from 'vue'
import morphdomSource from 'morphdom/dist/morphdom-umd.min.js?raw'
import { useEventListener, watchDebounced } from '@vueuse/core'
import { useSelectionStore } from '../stores/selection.js'
import { useEditingStore } from '../stores/editing.js'
import { usePreviewStore } from '../stores/preview.js'
import { useToastStore } from '../stores/toast.js'
import { useSiteStore } from '../stores/site.js'
import { useUiModeStore } from '../stores/uiMode.js'
import { useActiveTargetStore } from '../stores/activeTarget.js'
import { useLocaleStore } from '../stores/locale.js'
import { useRouter } from 'vue-router'
import { useComponentFocusStore } from '../stores/componentFocus.js'

/** FNV-1a hash — same function as in packages/gazetta/src/scope.ts */
function hashPath(path: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < path.length; i++) {
    hash ^= path.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

const selection = useSelectionStore()
const editing = useEditingStore()
const preview = usePreviewStore()
const toast = useToastStore()
const site = useSiteStore()
const uiMode = useUiModeStore()
const activeTarget = useActiveTargetStore()
const locale = useLocaleStore()
const router = useRouter()
const iframeRef = ref<HTMLIFrameElement | null>(null)
const loading = ref(false)
let currentHtml = ''
/** The bridge in the current frame document has started (`gazetta:ready`). */
let frameReady = false
let previewHoverTimer: ReturnType<typeof setTimeout> | null = null

const focus = useComponentFocusStore()

// Send hover highlight to bridge (skip in fullscreen)
function sendHighlight() {
  if (uiMode.mode === 'fullscreen') return
  iframeRef.value?.contentWindow?.postMessage({ type: 'gazetta:highlight', gzId: focus.highlightGzId ?? null }, '*')
}
watch(() => focus.highlightGzId, sendHighlight)

// Send selection to bridge — green overlay (skip in fullscreen)
function sendSelection() {
  if (uiMode.mode === 'fullscreen') return
  iframeRef.value?.contentWindow?.postMessage({ type: 'gazetta:showSelect', gzId: focus.selectedGzId ?? null }, '*')
}
watch(() => focus.selectedGzId, sendSelection)

const basePath = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')
/** Logical route only — drives fresh-load vs morph behavior. Swapping the
 *  active target must NOT force a fresh iframe load (scroll preservation). */
const previewRoute = computed(() => selection.previewRoute)
/** URL that's actually fetched. Includes ?target= so preview swaps content
 *  when the active target changes (e.g., preview tab click). */
const previewPath = computed(() => {
  if (!previewRoute.value) return null
  const target = activeTarget.activeTargetName
  const qs = target ? `?target=${encodeURIComponent(target)}` : ''
  let route = previewRoute.value

  // For pages, the locale route already includes the prefix (e.g., /fr/about).
  // For fragments (/@header or host-page route /), we need to prepend the
  // locale prefix so the preview resolves the locale-specific content.
  const loc = locale.effectiveLocale
  if (loc && !route.startsWith(`/${loc}`)) {
    // Fragment standalone: /@header → /fr/@header
    // Fragment on host page: / → /fr
    route = route === '/' ? `/${loc}` : `/${loc}${route}`
  }

  // Strip trailing slash to avoid POST redirect (which loses body)
  if (route === '/') route = ''
  return `${basePath}/preview${route}${qs}`
})

// Fragment scope — gzId of the fragment root for dimming
const fragmentScopeGzId = computed(() => {
  if (selection.type !== 'fragment' || !selection.name || !selection.fragmentHostPage) return null
  return hashPath(`@${selection.name}`)
})

/**
 * Accessible name for the preview iframe. Axe's frame-title rule
 * requires a non-empty title; screen readers announce it when users
 * enter the frame. Compose target + route so the title updates as
 * either changes (e.g., switching active target or selecting a
 * different page). Falls back to a static label when nothing is
 * selected yet — the iframe is briefly present before first load.
 */
const previewTitle = computed(() => {
  const target = activeTarget.activeTargetName
  const route = previewRoute.value
  if (target && route) return `Preview of ${route} on ${target}`
  if (route) return `Preview of ${route}`
  return 'Site preview'
})

// Device presets
const devicePresets = [
  { label: 'Desktop', width: '100%', icon: 'pi pi-desktop' },
  { label: 'Tablet', width: '768px', icon: 'pi pi-tablet' },
  { label: 'Mobile', width: '375px', icon: 'pi pi-mobile' },
]
const activePreset = ref(0)
const previewWidth = computed(() => devicePresets[activePreset.value].width)

// Highlight toggle — only meaningful in edit mode
const highlightEnabled = ref(true)

// Send bridge mode + highlight state to iframe
function sendBridgeMode() {
  iframeRef.value?.contentWindow?.postMessage(
    {
      type: 'gazetta:mode',
      mode: uiMode.mode,
      highlight: highlightEnabled.value,
    },
    '*',
  )
}
watch(() => uiMode.mode, sendBridgeMode)
watch(highlightEnabled, sendBridgeMode)

// Send fragment scope to bridge for dimming
function sendScope() {
  iframeRef.value?.contentWindow?.postMessage(
    {
      type: 'gazetta:scope',
      gzId: fragmentScopeGzId.value,
    },
    '*',
  )
}
watch(fragmentScopeGzId, sendScope)

// Bridge script — three-mode behavior controlled by parent via postMessage.
// The frame is sandboxed without allow-same-origin, so page script can't
// reach the admin; the bridge morphs its own document on `gazetta:morph`.
const BRIDGE_SCRIPT = `
<script>${morphdomSource.replace(/<\/script/gi, '<\\/script')}<\/script>
<script>
(function() {
  var adminOrigin = ${JSON.stringify(window.location.origin)};
  // Hover overlay — transient, subtle, fades
  var hoverOvl = document.createElement('div');
  hoverOvl.id = 'gz-hover';
  hoverOvl.style.cssText = 'position:fixed;pointer-events:none;border:1px solid rgba(167,139,250,0.5);border-radius:4px;z-index:100000;transition:opacity 0.2s;display:none;opacity:0;';
  document.body.appendChild(hoverOvl);

  // Selection overlay — persistent, solid green
  var selectOvl = document.createElement('div');
  selectOvl.id = 'gz-select';
  selectOvl.style.cssText = 'position:fixed;pointer-events:none;border:2px solid #22c55e;border-radius:4px;z-index:99999;display:none;';
  document.body.appendChild(selectOvl);

  // Fullscreen hides all overlays via CSS (preserves state for restore)
  var gzStyle = document.createElement('style');
  gzStyle.textContent = '[data-gz-mode="fullscreen"] #gz-hover, [data-gz-mode="fullscreen"] #gz-select, [data-gz-mode="fullscreen"] #gz-dim { display: none !important }';
  document.head.appendChild(gzStyle);

  // Dim overlay — fragment scope backdrop
  var dimOverlay = document.createElement('div');
  dimOverlay.id = 'gz-dim';
  dimOverlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.3);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);z-index:99998;pointer-events:none;display:none;transition:opacity 0.2s;opacity:0;';
  document.body.appendChild(dimOverlay);

  var hoveredEl = null;
  var selectedEl = null;
  var highlightScrollTimer = null;
  var mode = 'browse';
  var highlight = true;
  var scopedEl = null;
  var scopedOrigPos = '';

  function findGz(el) {
    while (el && el !== document.body) {
      if (el.dataset && el.dataset.gz) return el;
      el = el.parentElement;
    }
    return null;
  }

  function isInteractive(el) {
    var tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'LABEL' || tag === 'A' || el.isContentEditable) return true;
    var role = el.getAttribute && el.getAttribute('role');
    return role === 'button' || role === 'link' || role === 'menuitem' || role === 'tab' || role === 'switch' || role === 'checkbox' || role === 'radio' || role === 'textbox' || role === 'combobox';
  }

  function positionOverlay(ovl, el) {
    var rect = el.getBoundingClientRect();
    ovl.style.display = 'block';
    ovl.style.top = rect.top + 'px';
    ovl.style.left = rect.left + 'px';
    ovl.style.width = rect.width + 'px';
    ovl.style.height = rect.height + 'px';
  }

  function refreshOverlays() {
    if (hoveredEl && hoveredEl.isConnected) positionOverlay(hoverOvl, hoveredEl);
    else { hoveredEl = null; hoverOvl.style.display = 'none'; }
    if (selectedEl && selectedEl.isConnected) positionOverlay(selectOvl, selectedEl);
    else { selectedEl = null; selectOvl.style.display = 'none'; }
  }

  function showSelect(el) {
    selectedEl = el;
    positionOverlay(selectOvl, el);
  }

  function clearSelect() {
    selectedEl = null;
    selectOvl.style.display = 'none';
  }

  function showHover(el) {
    hoveredEl = el;
    positionOverlay(hoverOvl, el);
    hoverOvl.style.opacity = '1';
  }

  function clearHover() {
    hoverOvl.style.opacity = '0';
    setTimeout(function() { if (!hoveredEl) hoverOvl.style.display = 'none'; }, 200);
    hoveredEl = null;
  }

  function scrollIfOffscreen(el) {
    var rect = el.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function applyScope(gzId) {
    if (scopedEl) {
      scopedEl.style.position = scopedOrigPos;
      scopedEl.style.zIndex = '';
      scopedEl.style.cursor = '';
      scopedEl = null;
    }
    dimOverlay.style.opacity = '0';
    setTimeout(function() { if (!scopedEl) dimOverlay.style.display = 'none'; }, 200);

    if (!gzId) {
      if (mode === 'edit' && highlight) document.body.style.cursor = 'crosshair';
      return;
    }
    var el = document.querySelector('[data-gz="' + gzId + '"]');
    if (!el) return;

    scopedOrigPos = el.style.position;
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    el.style.zIndex = '99999';
    scopedEl = el;
    if (mode === 'edit' && highlight) {
      document.body.style.cursor = '';
      el.style.cursor = 'crosshair';
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    dimOverlay.style.display = 'block';
    dimOverlay.offsetHeight;
    dimOverlay.style.opacity = '1';
  }

  window.addEventListener('scroll', refreshOverlays, true);
  window.addEventListener('resize', refreshOverlays);

  function isInScope(el) {
    return !scopedEl || scopedEl.contains(el);
  }

  // Clear hover when mouse leaves the iframe
  document.addEventListener('mouseleave', function() {
    if (hoveredEl) { clearHover(); window.parent.postMessage({ type: 'gazetta:hover', gzId: null }, '*'); }
  });

  // Edit mode: mousemove hover highlight in preview
  document.addEventListener('mousemove', function(e) {
    if (mode !== 'edit' || !highlight) {
      if (hoveredEl) { clearHover(); window.parent.postMessage({ type: 'gazetta:hover', gzId: null }, '*'); }
      return;
    }
    var target = findGz(e.target);
    if (target && target !== hoveredEl && isInScope(target)) {
      showHover(target);
      window.parent.postMessage({ type: 'gazetta:hover', gzId: target.dataset.gz }, '*');
    } else if (!target || !isInScope(target)) {
      if (hoveredEl) { clearHover(); window.parent.postMessage({ type: 'gazetta:hover', gzId: null }, '*'); }
    }
  });

  document.addEventListener('click', function(e) {
    var link = e.target.closest ? e.target.closest('a[href]') : null;
    if (link) {
      var href = link.getAttribute('href');
      if (href) {
        e.preventDefault();
        e.stopPropagation();
        if (href.startsWith('/') || href.startsWith(adminOrigin)) {
          var path = href.startsWith('/') ? href : new URL(href).pathname;
          window.parent.postMessage({ type: 'gazetta:navigate', route: path }, '*');
        } else {
          window.parent.postMessage({ type: 'gazetta:external', url: href }, '*');
        }
        return;
      }
    }

    if (mode === 'fullscreen') return;
    if (isInteractive(e.target)) return;

    var target = findGz(e.target);
    if (!target || !isInScope(target)) return;

    e.preventDefault();
    e.stopPropagation();

    window.parent.postMessage({ type: 'gazetta:select', gzId: target.dataset.gz }, '*');
  }, true);

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') window.parent.postMessage({ type: 'gazetta:escape' }, '*');
  });

  window.addEventListener('message', function(e) {
    if (e.source !== window.parent) return;
    if (e.data && e.data.type === 'gazetta:morph') {
      try {
        var newDoc = new DOMParser().parseFromString(e.data.html, 'text/html');
        morphdom(document.body, newDoc.body, {
          onBeforeNodeDiscarded: function(node) {
            return !(node.id === 'gz-hover' || node.id === 'gz-select' || node.id === 'gz-dim');
          },
          onBeforeElUpdated: function(fromEl, toEl) {
            if (fromEl.id === 'gz-hover' || fromEl.id === 'gz-select' || fromEl.id === 'gz-dim') return false;
            return !fromEl.isEqualNode(toEl);
          }
        });
        var oldStyles = document.head.querySelectorAll('style');
        var newStyles = newDoc.head.querySelectorAll('style');
        for (var i = 0; i < oldStyles.length; i++) {
          if (newStyles[i] && oldStyles[i].textContent !== newStyles[i].textContent) {
            oldStyles[i].textContent = newStyles[i].textContent;
          }
        }
        refreshOverlays();
      } catch (err) {
        window.parent.postMessage({ type: 'gazetta:morph-failed' }, '*');
      }
    }
    if (e.data && e.data.type === 'gazetta:mode') {
      mode = e.data.mode || 'browse';
      highlight = e.data.highlight !== false;
      document.body.setAttribute('data-gz-mode', mode);
      if (hoveredEl) clearHover();
      refreshOverlays();
      var cursorTarget = scopedEl || document.body;
      document.body.style.cursor = '';
      if (scopedEl) scopedEl.style.cursor = '';
      cursorTarget.style.cursor = (mode === 'edit' && highlight) ? 'crosshair' : '';
    }
    if (e.data && e.data.type === 'gazetta:highlight') {
      if (highlightScrollTimer) { clearTimeout(highlightScrollTimer); highlightScrollTimer = null; }
      if (e.data.gzId) {
        var el = document.querySelector('[data-gz="' + e.data.gzId + '"]');
        if (el) {
          showHover(el);
          highlightScrollTimer = setTimeout(function() { scrollIfOffscreen(el); }, 150);
        }
      } else {
        clearHover();
        highlightScrollTimer = setTimeout(function() {
          if (selectedEl) scrollIfOffscreen(selectedEl);
          else window.scrollTo({ top: 0, behavior: 'smooth' });
        }, 150);
      }
    }
    if (e.data && e.data.type === 'gazetta:showSelect') {
      if (e.data.gzId) {
        var sel = document.querySelector('[data-gz="' + e.data.gzId + '"]');
        if (sel) showSelect(sel);
        else clearSelect();
      } else {
        clearSelect();
      }
    }
    if (e.data && e.data.type === 'gazetta:scrollTo') {
      if (e.data.gzId) {
        var scrollEl = document.querySelector('[data-gz="' + e.data.gzId + '"]');
        if (scrollEl) scrollIfOffscreen(scrollEl);
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }
    if (e.data && e.data.type === 'gazetta:scope') {
      applyScope(e.data.gzId);
    }
  });

  window.parent.postMessage({ type: 'gazetta:ready' }, '*');
})();
<\/script>
`

function injectBridge(html: string): string {
  // Strip dev server reload script (parent handles SSE) and inject bridge
  return html
    .replace(/<script>new EventSource\([^)]+\)[^<]*<\/script>/g, '')
    .replace('</body>', `${BRIDGE_SCRIPT}\n</body>`)
}

async function handleMessage(e: MessageEvent) {
  // Only the preview frame's bridge talks to this panel.
  if (!e.source || e.source !== iframeRef.value?.contentWindow) return
  if (e.data?.type === 'gazetta:ready') {
    frameReady = true
    sendBridgeMode()
    sendScope()
    return
  }
  if (e.data?.type === 'gazetta:morph-failed') {
    applyHtml(currentHtml, false)
    return
  }
  if (e.data?.type === 'gazetta:escape') {
    if (uiMode.mode === 'fullscreen') uiMode.toggleFullscreen()
  }
  if (e.data?.type === 'gazetta:select' && e.data.gzId) {
    iframeRef.value?.contentWindow?.postMessage({ type: 'gazetta:showSelect', gzId: e.data.gzId }, '*')
    if (selection.name) {
      const prefix = selection.type === 'page' ? '/pages' : '/fragments'
      // Navigate to edit first, then set pending. The ComponentTree's
      // pendingGzId watcher picks it up after the tree rebuilds.
      await router.push(`${prefix}/${selection.name}/edit`)
      focus.setPending(e.data.gzId)
    }
    iframeRef.value?.blur()
  }
  if (e.data?.type === 'gazetta:navigate' && e.data.route) {
    // Match against default routes first, then try locale-prefixed routes.
    // Locale nav links (e.g. /fr/about) won't match site.pages routes
    // (which are /about) — strip the locale prefix and retry.
    let page = site.pages.find(p => p.route === e.data.route)
    if (!page && locale.effectiveLocale) {
      const prefix = `/${locale.effectiveLocale}`
      const stripped = e.data.route === prefix ? '/' : e.data.route.replace(prefix, '')
      page = site.pages.find(p => p.route === stripped)
    }
    if (page) {
      const suffix = uiMode.mode === 'edit' ? '/edit' : ''
      router.push(`/pages/${page.name}${suffix}`)
    } else {
      toast.show(`No page found for route ${e.data.route}`, { type: 'error' })
    }
  }
  if (e.data?.type === 'gazetta:hover') {
    focus.previewHover(e.data.gzId ?? null)
    // When preview hover ends, scroll back to selected component after delay
    if (previewHoverTimer) {
      clearTimeout(previewHoverTimer)
      previewHoverTimer = null
    }
    if (!e.data.gzId) {
      previewHoverTimer = setTimeout(() => {
        iframeRef.value?.contentWindow?.postMessage({ type: 'gazetta:scrollTo', gzId: focus.selectedGzId ?? null }, '*')
        previewHoverTimer = null
      }, 300)
    }
  }
  if (e.data?.type === 'gazetta:external' && e.data.url) {
    toast.show(e.data.url, { link: e.data.url, duration: 5000 })
  }
}

// Message listener (auto-cleanup via VueUse)
useEventListener(window, 'message', handleMessage)

// SSE hot reload — listen for template/manifest changes from dev server
let sse: EventSource | null = null
onMounted(() => {
  try {
    sse = new EventSource('/__reload')
    sse.onmessage = () => fetchPreview(true)
    sse.onerror = () => {
      sse?.close()
      sse = null
    }
  } catch {
    /* SSE not available */
  }
})
onUnmounted(() => {
  sse?.close()
})

// Concurrency control for fetchPreview. Without this, rapid route /
// target / locale changes fire parallel fetches; their responses
// land in arbitrary order and `applyHtml` runs morphdom on a
// document tree that may already be mid-mutation from the previous
// invocation. That surfaces as a transient
// `Cannot read properties of null (reading 'querySelector')` page
// error from morphdom's internal traversal.
//
// Two-layer guard:
//   1. `inFlightController` aborts the previous fetch before starting
//      a new one — drops the network round-trip when we already know
//      the response is stale.
//   2. `fetchGeneration` discards stale responses that completed
//      between abort and `applyHtml` — the abort may not be checked
//      until the next microtask, so an in-progress `await res.text()`
//      can still resolve. The generation check at the apply site
//      makes that response a no-op.
let inFlightController: AbortController | null = null
let fetchGeneration = 0

async function fetchPreview(morph = true) {
  if (!previewPath.value) {
    currentHtml = ''
    return
  }
  // Cancel any in-flight fetch and bump the generation counter. The
  // counter increment must happen before any await so the captured
  // `myGen` below holds the new value.
  inFlightController?.abort()
  const controller = new AbortController()
  inFlightController = controller
  const myGen = ++fetchGeneration

  loading.value = true
  try {
    const overrides = editing.allOverrides
    const hasOverrides = Object.keys(overrides.content).length > 0 || Object.keys(overrides.structural).length > 0
    let res: Response
    if (hasOverrides) {
      res = await fetch(previewPath.value, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrides }),
        signal: controller.signal,
      })
    } else {
      res = await fetch(previewPath.value, { signal: controller.signal })
    }
    const html = injectBridge(await res.text())
    // If a newer fetch was started while this one was in flight,
    // discard our response — applying it would race with the newer
    // call's `applyHtml` and corrupt morphdom's tree.
    if (myGen !== fetchGeneration) return
    applyHtml(html, morph)
    // Send initial bridge mode + scope after iframe loads
    setTimeout(() => {
      sendBridgeMode()
      sendScope()
    }, 100)
  } catch (err) {
    // Abort errors are expected — just bail out silently.
    if (err instanceof DOMException && err.name === 'AbortError') return
    if (myGen !== fetchGeneration) return
    applyHtml('<pre style="color:red;padding:2rem">Failed to load preview</pre>', false)
  } finally {
    if (myGen === fetchGeneration) loading.value = false
  }
}

function applyHtml(html: string, morph: boolean) {
  const iframe = iframeRef.value
  if (!iframe) return

  // The frame's document is out of reach from here (its own origin), so an
  // in-place update goes to the bridge, which answers `gazetta:morph-failed`
  // when it can't apply it.
  if (morph && currentHtml && frameReady && iframe.contentWindow) {
    iframe.contentWindow.postMessage({ type: 'gazetta:morph', html }, '*')
  } else {
    frameReady = false
    iframe.srcdoc = html
  }
  currentHtml = html
}

watch(
  () => preview.version,
  () => fetchPreview(true),
)
// Route change = fresh iframe load (srcdoc replaced). Scroll position
// resets — the author navigated to a different page, so that's expected.
watch(previewRoute, () => fetchPreview(false), { immediate: true })
// Locale change = fresh iframe load (different content language).
// For pages, previewRoute already changes (route includes locale prefix).
// For fragments, previewRoute stays the same but previewPath changes.
watch(
  () => locale.effectiveLocale,
  () => fetchPreview(false),
)
// Target change on the same route = morphed swap. Preserves scroll,
// zoom, and iframe focus — that's the point of preview tabs per
// design-editor-ux.md ("feels like flipping tabs, not navigating").
watch(
  () => activeTarget.activeTargetName,
  (name, prev) => {
    if (name && prev && name !== prev && previewRoute.value) fetchPreview(true)
  },
)
watchDebounced(
  () => preview.draftVersion,
  () => fetchPreview(true),
  { debounce: 300 },
)
</script>

<template>
  <div class="preview-panel" :class="{ fullscreen: uiMode.mode === 'fullscreen' }" data-testid="preview-panel">
    <div v-if="!previewPath" class="preview-empty" data-testid="preview-empty">
      <i class="pi pi-eye" style="font-size: 2rem; color: #ddd; margin-bottom: 0.5rem;" />
      <p>Select a page or fragment to preview</p>
    </div>
    <template v-else>
      <div class="preview-toolbar">
        <div class="preview-devices">
          <button v-for="(preset, i) in devicePresets" :key="preset.label"
            :class="['device-btn', { active: activePreset === i }]"
            :title="preset.label"
            @click="activePreset = i">
            <i :class="preset.icon" />
          </button>
          <template v-if="uiMode.mode === 'fullscreen' && selection.previewRoute">
            <span class="preview-separator" />
            <span class="preview-route"><i class="pi pi-globe" />{{ selection.previewRoute }}</span>
          </template>
        </div>
        <div class="preview-actions">
          <!-- Host page selector for fragment preview -->
          <select v-if="selection.type === 'fragment' && selection.staticPages.length > 1 && uiMode.mode !== 'fullscreen'"
            class="host-page-select"
            data-testid="host-page-select"
            :value="selection.fragmentHostPage?.name ?? ''"
            @change="selection.setFragmentHostPage(($event.target as HTMLSelectElement).value)">
            <option v-for="page in selection.staticPages" :key="page.name" :value="page.name">
              {{ page.name }}
            </option>
          </select>
          <button v-if="uiMode.mode === 'edit'"
            :class="['device-btn', { active: highlightEnabled }]"
            :title="highlightEnabled ? 'Hide highlights' : 'Show highlights'"
            data-testid="highlight-toggle"
            @click="highlightEnabled = !highlightEnabled">
            <i class="pi pi-eye" />
          </button>
          <button class="device-btn"
            :title="uiMode.mode === 'fullscreen' ? 'Exit fullscreen' : 'Fullscreen'"
            data-testid="fullscreen-toggle"
            @click="uiMode.toggleFullscreen()">
            <i :class="uiMode.mode === 'fullscreen' ? 'pi pi-window-minimize' : 'pi pi-window-maximize'" />
          </button>
        </div>
      </div>
      <div class="preview-frame-wrapper">
        <iframe ref="iframeRef" class="preview-iframe" data-testid="preview-iframe"
          sandbox="allow-scripts"
          :title="previewTitle"
          :style="{ width: previewWidth, maxWidth: '100%' }" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.preview-panel { height: 100%; display: flex; flex-direction: column; }
/* Light mode defaults */
.preview-panel.fullscreen {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  z-index: 1000; background: #f8f8fa;
}
.preview-empty { padding: 1rem; color: #aaa; font-size: 0.875rem; display: flex; flex-direction: column; align-items: center; padding-top: 3rem; }
.preview-toolbar { display: flex; align-items: center; justify-content: space-between; padding: 0.375rem 0.5rem; border-bottom: 1px solid #e5e7eb; }
.preview-devices { display: flex; gap: 0.25rem; align-items: center; }
.preview-actions { display: flex; gap: 0.25rem; align-items: center; }
.device-btn { background: none; border: 1px solid transparent; border-radius: 4px; padding: 0.25rem 0.5rem; color: #9ca3af; cursor: pointer; font-size: 0.875rem; }
.device-btn:hover { color: #374151; border-color: #d1d5db; }
.device-btn.active { color: #a78bfa; border-color: #a78bfa; }
.host-page-select { background: #f3f4f6; color: #374151; border: 1px solid #d1d5db; border-radius: 4px; padding: 0.2rem 0.4rem; font-size: 0.75rem; cursor: pointer; }
.preview-separator { width: 1px; height: 14px; background: #d1d5db; margin-left: 8px; margin-right: 8px; }
.preview-route { display: inline-flex; align-items: center; gap: 6px; background: #f3f4f6; border: 1px solid #e5e7eb; border-radius: 9999px; padding: 2px 10px; height: 24px; font-size: 12px; color: #6b7280; font-family: ui-monospace, monospace; }
.preview-route .pi { font-size: 10px; color: #9ca3af; }
.preview-frame-wrapper { flex: 1; display: flex; justify-content: center; overflow: auto; background: #e5e7eb; }
.preview-iframe { flex: none; height: 100%; border: 0; background: #fff; transition: width 0.2s; }


</style>

<style>
/* Dark mode overrides (non-scoped — :global in scoped doesn't reliably apply) */
.dark .preview-panel.fullscreen { background: #09090b; }
.dark .preview-toolbar { border-bottom-color: #27272a; }
.dark .device-btn { color: #71717a; }
.dark .device-btn:hover { color: #e4e4e7; border-color: #3f3f46; }
.dark .host-page-select { background: #1e1e2e; color: #e0e0e0; border-color: #3f3f46; }
.dark .preview-separator { background: #3f3f46; }
.dark .preview-route { background: #18181b; border-color: #27272a; color: #a1a1aa; }
.dark .preview-route .pi { color: #52525b; }
.dark .preview-frame-wrapper { background: #1a1a2e; }
</style>
