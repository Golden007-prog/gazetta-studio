# Offline mode

How Gazetta admin handles transient connectivity loss — what authors see,
what changes for operators, and what's intentionally not in v1.

For the design model + architectural locks, see
[`.claude/rules/design-offline.md`](../.claude/rules/design-offline.md).

## What it is

The admin keeps working when the network goes away. Pages already loaded
stay viewable, edits in progress aren't lost, and saves either land
silently when connection comes back or surface as something the author
can act on. The browser fetches the SPA bundle once and serves it from
disk on subsequent visits, including cold loads while offline.

This is offline-AWARE, not offline-FIRST. Authors don't choose to "go
offline"; offline is what happens to them. There's no toggle.

## What changes for authors

### Connection state

A thin strip appears at the top of the admin when the connection isn't
healthy:

| State | What you see | What it means |
|---|---|---|
| Online | Nothing | Saves go through normally. The absence is the state. |
| Connection unstable | Subtle "Connection unstable" with spinner | Recent request failed; admin is probing the server. Editing keeps working. |
| Offline | Persistent "Offline" banner with "Send now" button | Server unreachable. Saves go to the local store and replay later. |
| Reconnecting | Subtle "Reconnecting" indicator | Server just answered; admin is catching up. Brief — usually a flash. |

When connection returns after offline, a transient toast says "Connection
back" so you know without checking the banner.

### Save behavior

Click Save the same way regardless of connection state. The button label
doesn't change between online and offline — your mental model is
"I clicked Save; it says saved."

What happens underneath:

| Situation | Outcome |
|---|---|
| Online; save succeeds | Standard. Editor goes clean. |
| Online; save fails partway (server crashed mid-response) | Admin checks what landed; either silently confirms success or surfaces an error. No silent loss. |
| Offline; save attempted | Saved locally. Will send when connection comes back. |
| Save attempted while someone else just saved the same item | "Was edited by someone else" banner with "Show what changed" + "Discard my changes" |

### "Was edited by someone else"

If the server's version of a page or fragment changed between when you
loaded it and when you tried to save (typical scenario: a colleague
edited the same item from another browser, or the file was edited
out-of-band by `git pull` or a text editor), you get a banner instead
of a silent overwrite.

Two actions:

- **Show what changed** — opens a field-by-field diff. "Title: 'Mine'
  vs 'Theirs.'" Object/array fields show "(changes inside)" without
  diving deep — at-a-glance information so you can decide.
- **Discard my changes** — drops every unsaved edit on this page (in
  this language), including edits to other components you opened
  earlier, and reloads the server's current version.

There's deliberately no "Save anyway / Overwrite" button. If you want
your changes on top of theirs, view the diff, manually port the edits
you care about onto the new version, and save fresh. Keeps the team
from accidentally clobbering each other's work.

### Pending edits across tabs and reload

Three kinds of edits survive reload:

- **Structural** — component reorders / adds / removes. Reorder
  components on `/home`, close the tab, reopen — tree comes back
  the way you left it.
- **Field-level** — title text, content blocks, anything you type
  into the editor form. Edit a heading on `/home`, close the tab,
  reopen `/home` — the heading you typed is back, dirty, waiting
  to save.
- **SEO settings** — a page's title, description, OG image, canonical
  URL and "Hide from search engines". Change `/home`'s SEO title,
  close the tab, reopen `/home` — the new title is back, waiting to
  save. It comes back on its own page, in the language you edited it
  in; other pages have nothing to save.

All three work across multiple pages. If you have unsaved edits on
`/home/_root` AND on `/about/_root`, both come back when you
navigate to those pages after reload. The saved baseline is
fetched fresh from the server; your dirty edits overlay on top.

Each unsaved edit remembers the version of the page it was made on.
If someone else saved that page while your tab was closed, Save shows
the usual "edited by someone else" banner instead of saving over their
version, as it would have if the tab had stayed open. If nobody did,
Save works as usual. Edits kept by an older version of the admin,
which didn't record the version, save over the current one.

Save clears the dirty state for the saved item; navigating to a
different page doesn't lose the others. **Don't Save** discards them.

Unsaved edits belong to the target you made them on. Switch from
`local` to `staging` and the edits you left on `local` stay there;
they come back when you switch back. Edits in two tabs are kept
separately, so one tab never erases the other's — but if both tabs
edit the *same* field, the last one written wins.

### Shared computers

When the admin sits behind an auth proxy (Cloudflare Access,
oauth2-proxy and the other trust modes in [auth.md](auth.md)), unsaved
edits belong to the person who made them. When someone else signs in
on the same browser, the admin deletes the previous person's unsaved
edits — it doesn't keep them for later, because anything left in the
browser can be read by whoever uses it next.

Two limits to know:

- **Opening the admin offline** can't ask the server who you are, so it
  shows the unsaved edits of whoever last used the admin online in this
  browser. This applies only when the browser itself is offline: if it's
  online but the server doesn't answer within 3 seconds or answers with a
  server error, the admin shows
  no earlier unsaved edits and keeps them as they are. It keeps asking the
  server, and once it answers, edits you make meanwhile are kept under
  your name. Until then, reloading the page loses them; your earlier
  unsaved edits come back on the next load. The site tree from your last
  visit isn't shown either: it fills in once the server answers.
- **If the admin can't tell who you are** (your sign-in expired and the
  proxy answers with its login page), it shows no unsaved edits and
  keeps them as they are. Sign in again and reload.

### "Send now"

When you're offline and the admin says it's offline, but you know the
network is actually back (you just reconnected to Wi-Fi, or the VPN
came up), click "Send now" on the offline banner. The admin probes
immediately rather than waiting for the next scheduled check.

This is purely a hint to the admin's heartbeat scheduler — it doesn't
override anything. If the network really is down, the probe just
fails again and the banner stays.

### Opening the admin offline

Once you've used the admin online in a browser, you can open it there
offline — including a bookmarked page URL — and see the site tree as it
was last time. The lists come from the last answers the server gave;
the Offline banner tells you they may be out of date. They are kept for
7 days.

Opening a page in the editor offline doesn't work yet (#969).

### Storage warning

If your browser's local storage approaches its cap (around 80%), a
subtle banner appears: "Storage almost full — please connect to send
your saved items." Dismissing the banner suppresses it at that level;
it reappears only if usage climbs strictly above the dismissal point.

This is rare in practice. The admin's persistent storage is small
(query results + unsaved edits); the warning fires when
the whole-origin storage budget is being consumed by something else
(other apps on the same domain, browser caches accumulating).

## What v1 does NOT do

Setting expectations honestly. These items are deliberately not in v1
and have specific triggers to revisit.

### No replay while the tab is closed

If you save offline, close the tab, then reconnect: the save sends on
your **next admin open**, not in the background. The browser would
need a service worker with [Background Sync](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API)
to do this — possible technically, but adds machinery for marginal
value (authors reopen the admin to check status anyway).

### No live multi-author concurrent editing

Two authors editing the same page simultaneously can both type freely;
the second one to save sees the "Was edited by someone else" banner.
There's no live cursor / presence indicator showing "Bob is also
editing this." That kind of real-time collaboration requires a
persistent connection layer (WebSocket / SSE-with-back-channel) and
conflict-free data structures (OT or CRDT) — its own design space,
not in this v1 scope.

### Not installable as a PWA

The admin runs in a regular tab. There's no install prompt, no
home-screen icon, no standalone window mode. The service worker is
scoped to caching the SPA bundle for offline-reload reliability,
not full PWA installation.

### No push notifications

If a colleague edits content while you're not looking at the admin,
you find out the next time you open the affected page (via the
"Was edited by someone else" banner). No browser notification
("Bob saved /home").

## Operator concerns

### Browser support

The admin bundle needs modern JavaScript: Chrome or Edge 111+, Firefox
114+ or Safari 16.4+. The bundle targets Vite's default
"baseline widely available" browser set, so anything older cannot parse
it at all. `index.html` runs a small check before the bundle loads and
shows "This browser is too old for the Gazetta admin" with the minimum
versions instead of leaving a broken page.

Every browser at or above that floor already ships IndexedDB,
BroadcastChannel and Service Worker, so the offline features need no
extra version matrix. When IndexedDB is unavailable (private or
incognito modes), the admin warns once via console and falls back to
in-memory storage: works for the tab session, lost on reload. Authors
using private browsing should expect the warning.

### HTTPS requirement

Service workers require HTTPS in production. Localhost development
works on HTTP. This was already a Gazetta requirement for auth
cookies — no new constraint introduced by offline mode.

If you're serving the admin behind a reverse proxy, terminate TLS at
the proxy (Caddy, nginx, Cloudflare) and pass through. The admin's
service worker registers at `/admin/sw.js` and scopes to `/admin/`.

### What needs to be deployed

Nothing extra. Offline mode is built into the admin SPA; the service
worker ships in the same `dist/` bundle as `index.html` and the JS/CSS
chunks. Standard `gazetta serve` or any static host serving the
admin works.

If you're behind a CDN, make sure `sw.js` isn't aggressively cached
by an intermediary — when a new admin version ships, the SW file at
`/admin/sw.js` needs to update so users get the toast. A short
`Cache-Control` (e.g., `no-cache`, `max-age=0`) on `sw.js`
specifically is the right move; the chunks it precaches have
content-hashed filenames and can be cached forever.

### Configuration

The defaults are correct. There are no required knobs. If you need to
opt out (corporate environments that block service workers, sandboxed
deployments), the admin still works — connection-state and save-conflict
detection don't depend on the SW; only the cold-load-while-offline
path does.

### Update flow

When you publish a new version of Gazetta and authors load the admin:

1. The browser fetches `/admin/sw.js`. If the content changed (it does
   on every release), the SW enters the "waiting" state.
2. Within an hour (or on next page reload), the admin detects the
   waiting SW and shows a toast: "A new version is available — Refresh."
3. The author clicks "Refresh." The SW activates and the page reloads
   with the new bundle.

Users running with one tab open all day get the toast; users who close
and reopen pick up the new version on the next load. No silent
upgrades — if an author is mid-edit, they see the toast but aren't
forced to refresh until they choose.

### Verifying it works

Quick check after deploying a new version:

```
1. Open the admin in a normal tab → admin loads.
2. DevTools → Application → Service Workers → confirm /admin/sw.js
   is registered + active.
3. DevTools → Application → Storage → confirm IndexedDB has a
   `gazetta-cache` database (query results) and a `gazetta-drafts`
   database (unsaved edits).
4. DevTools → Network → throttle to "Offline."
5. Reload the page.
6. Admin should still load (from SW cache) with the "Offline" banner
   at the top, and the site tree should show the pages.
7. Throttle back to "Online."
8. Banner replaces with brief "Connection back" toast; admin
   reconnects.
```

If step 5 shows "site can't be reached" rather than the admin loading
offline, the service worker isn't registered correctly. Check that
`/admin/sw.js` is reachable directly (HTTP 200, `Content-Type:
application/javascript`).

### Multi-instance deployments

If you run the admin behind a load balancer with multiple instances:

- Each browser tab talks to one instance at a time. Offline state and
  save conflicts are detected per-tab; nothing flows across instances
  in the offline path.
- IndexedDB storage is per-browser-origin, not per-instance — same
  storage regardless of which instance the tab last hit.
- Service worker registration is per-origin; load-balanced instances
  serving the same `/admin/sw.js` content (which they should, if they
  shipped the same admin build) is the standard pattern.

### Troubleshooting

**"Was edited by someone else" appears unexpectedly.**

Either someone really did edit the page (check the audit log when
audit ships in a future release), or the file was changed on disk
out-of-band — `git pull`, manual `sed`, an editor watching the
filesystem, etc. The admin compares the manifest's content hash
between your read and your write; any change between those two
moments triggers the conflict.

**Banner says "Offline" but I can browse other sites.**

The admin probes `GET /api/health`. If that endpoint is reachable
but returning errors (5xx), the admin treats it as offline — the
server is up but unhealthy. Check the admin process logs for the
underlying cause.

**Service worker doesn't update.**

Force a refresh in DevTools → Application → Service Workers →
"Update on reload" + click "Update." If the new SW still isn't
served, the `/admin/sw.js` URL is being cached by an intermediary
(CDN, proxy). Add a short `Cache-Control` to the SW URL specifically.

**IndexedDB warning in console.**

Most likely the user is in private browsing. Admin still works,
just without persistence — refresh loses tab-session state.
Document this for users who need to know; nothing to fix on the
operator side.

## Roadmap

What's deferred in v1 with documented triggers to revisit:

- **Replay while tab closed (Background Sync)** — see "What v1 does
  NOT do" above.
- **Live multi-author concurrent editing** — Tier 3 strategic bet;
  needs OT/CRDT design.
- **Audit integration** — replayed save events should mark
  `metadata.replayed: true` with the original-attempt timestamp.
  Lands when the audit-log foundation ships.

## Reference

- Design doc: [`.claude/rules/design-offline.md`](../.claude/rules/design-offline.md)
- Cache layer (read-side, server): [`docs/cache.md`](cache.md) — the L4
  cache the offline L6 cache mirrors
- Save concurrency (the etag mechanism): admin API documents the
  `If-Match` header contract; refer to the design doc for the
  client-side chain projection model
