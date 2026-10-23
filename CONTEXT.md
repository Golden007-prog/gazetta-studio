# Gazetta

Stateless CMS that structures websites as composable components stored on multiple targets. Product-domain glossary capturing the canonical vocabulary used across design docs, code, and conversations.

For dev-process vocabulary (design phases, doc artifacts, testing, bots, skills, triage labels), see [`.claude/rules/dev-glossary.md`](.claude/rules/dev-glossary.md).

## Language

### Actors

**Content Author**:
A person who edits content (pages, fragments, assets, metadata) through the admin UI form editor.
_Avoid_: User, Editor (overloaded with editor pane), Publisher.

**Template Developer**:
A person who creates templates and custom editors/fields in a Gazetta project (`templates/`, `admin/`).
_Avoid_: Frontend dev, Engineer, Coder.

**Operator**:
A person who publishes content to targets and manages deployment health, via the admin UI publish dialog or `gazetta publish` CLI.
_Avoid_: Publisher, DevOps.

**CMS Developer**:
A person who maintains Gazetta itself (the `packages/gazetta/`, `apps/admin/` source tree). Distinct from Template Developer (who consumes Gazetta) and Operator (who runs sites built on Gazetta).
_Avoid_: Maintainer (ambiguous), Admin (collides with `apps/admin/` package), User.

### Structural primitives

**Page**:
A routable structural unit. Has a template, content, optional children, a `route`, and `metadata`. Lives under `pages/`. Identified by its directory name.
_Avoid_: Document (Sanity term), Entry, Post.

**Fragment**:
A shared, reusable structural unit referenced from other Pages or Fragments via `@name`. Has a template, content, optional children. Lives under `fragments/`. Identified by its directory name.
_Avoid_: Include, Partial, Block.

**Inline Component**:
A structural unit nested inside a parent Page or Fragment's `components` array, with a local `name`. Has a template, content, optional children. Not addressable from outside its parent.
_Avoid_: Subcomponent, Child component, Embedded component, Block.

**Children**:
The contents of a parent Page or Fragment's `components` array — a mix of Fragment References and Inline Components. The same vocabulary appears in template render contracts (`({ content, children }) => ...`).
_Avoid_: Subcomponents, Items, Slots.

**Fragment Reference**:
A string entry in a parent's `components` array of the form `"@name"` that resolves at render time to a Fragment.
_Avoid_: Fragment include, @-ref.

**Component** (internal — not domain language):
The implementation type `ComponentManifest` in code is an internal shape shared by Page and Fragment manifests. NOT a domain term in conversation or docs. When you need "any of {Page, Fragment, Inline Component}," name them explicitly.
_Avoid_: Using "Component" in domain conversation — it collides with React/Vue components and is rarely needed at the abstract level.

### Manifests

**Manifest**:
The authoritative declarative description of a domain entity's current state, stored as a JSON or TypeScript file. Distinct from the entity's renders, history, or other derivatives. Always qualified — "Page Manifest," "Asset Manifest" — never bare in domain conversation when ambiguity is possible.
_Avoid_: Definition, Spec, Descriptor, Config (collides with `site.config.ts`), Document (Sanity term).

**Page Manifest** (`page.json` and `page.{locale}.json`):
The descriptor of a Page. Carries `template`, `content`, `components` (Children), `route`, `metadata`. One default per Page; optional locale variants.

**Fragment Manifest** (`fragment.json` and `fragment.{locale}.json`):
The descriptor of a Fragment. Same shape as Page Manifest minus `route` and `metadata`.

**Asset Manifest** (`{name}.asset.json` and `{name}.asset.{locale}[.{theme}].json`):
The descriptor of an Asset. Carries `kind`, `mime`, `hash`, `width`/`height`, `alt`, `tags`, `variants`, etc. The default manifest is mandatory; per-locale and per-theme variants are optional metadata or bytes overrides.

**Site Manifest** (`site.config.ts`):
The descriptor of a Site, expressed as a TypeScript module using `defineSite()` from the `gazetta` package. Carries `name`, `locale`, `targets`, `ai`, `altText`, `themes`, etc. One per Site.

**Revision Manifest** (`rev-{timestamp}.json`):
The descriptor of one entry in a Target's history. Carries timestamp, operation, author, items written (path → blob hash). Stored under `.gazetta/history/revisions/`.

### References and usages

**Reference** (out-pointing):
An in-content link from one entity to another, stored inside a content tree. Subtypes: Asset Reference, Fragment Reference.
_Avoid_: Ref (bare), Pointer, Link.

**Asset Reference**:
An object in a Manifest's content tree of the form `{ _asset: "name", ... }` that points to an Asset. May carry per-reference overrides like `alt` or `focalPoint`.
_Avoid_: Asset link, Asset ref (in docs).

**Fragment Reference** (already defined above):
A string entry in a parent's `components` array of the form `"@name"` that points to a Fragment.

**Usage** (in-pointing):
The inverse of a Reference — a record stating "entity X is referenced from location Y." Materialized for fast lookup. Surfaces in the Usage Panel and gates Asset deletion.
_Avoid_: Backlink, Inbound ref, Where-used.

**Usage Sidecar**:
The stored materialization of Usages on disk. Lives under `.gazetta/asset-refs/{asset}/{item}` (or analogous paths for other usage indices). Per-edge files (one per usage) for multi-instance write correctness.
_Avoid_: Refs sidecar, Backlink index.

**Usage Panel**:
The admin UI surface that lists an Asset's Usages — where in the site the Asset is referenced. Drives the delete-with-replace flow when the Asset has nonzero Usages.

**Ref / AssetRef** (internal — type name only):
The TypeScript type `AssetRef` in code carries Usage data (where the Asset is referenced from), not Reference data (the in-content link). Internal naming preserved for stability; in domain conversation always say "Usage" for the discovery side.

### Targets and target roles

**Target**:
A storage location plus a runtime that holds a complete copy of a Site's content. Each Target has a `type` (static / dynamic), an `environment` (local / staging / production / unset), and an `editable` flag. Multiple Targets can coexist; they may diverge in content. Defined in detail in `design-concepts.md`.
_Avoid_: Environment (a property, not the Target itself), Stage, Channel.

**Active Target**:
The Target the editor is currently focused on. Drives tree, editor, preview, save destination, sync indicators, and publish defaults. Cheap and reversible to switch. Independent of publish operations — distinct from Source Target and Destination Target.
_Avoid_: Selected target, Current target, Edit target.

**Source Target**:
The role a Target plays as the source of a Publish operation — the Target whose content is being read and copied or rendered. Often the Active Target, but the Operator may pick any Target.
_Avoid_: Origin, From-target, Source (bare — collides with `SourceContext` and Asset Reference contexts).

**Destination Target**:
The role a Target plays as the destination of a Publish operation — where the Publish writes to. Picked by the Operator. Multiple Destination Targets are allowed (fan-out publish).
_Avoid_: To-target, Target (bare in publish context — ambiguous), Sink.

**Removal**:
Publishing the absence of a Page or Fragment to a Destination Target: the item exists on the Destination Target but not on the Source Target, and the Operator chooses to take it off, so the Destination Target stops serving it (404; for a translation on worker and ESI targets, visitors get the default-language version). Always chosen per item, or for all such items with `gazetta publish --remove`; Gazetta never removes on its own, because an item missing from the Source Target may have been deleted there or added on the Destination Target. A pipeline that passes `--remove` makes it automatic for that target by the Operator's choice. Per [`design-target-removal.md`](.claude/rules/design-target-removal.md).
_Avoid_: Delete (the Source Target operation: Archive, then Purge), Prune, Sync-delete.

**Source Context** (internal — admin API plumbing):
The TypeScript type `SourceContext` in `admin-api/source-context.ts` holds the storage, content root, and history wiring for the **Active Target** in an admin-API request. Distinct from Source Target (which is a publish role). The code-side name predates the role-naming clarification; semantics are unchanged.

**Worker** (Gazetta-specific contract):
The runtime that handles HTTP requests at the edge for `esi` and `dynamic` Targets — typically Cloudflare Workers, Deno Deploy, or a WinterTC-compatible edge runtime. Gazetta workers route requests, cache responses, and assemble pre-rendered fragments via string concatenation. **Workers never run template code** (locked invariant per [ADR 0007](docs/adr/0007-worker-boundary-discipline.md) and `design-rendering.md` Q1). Template execution happens at publish time (Node/Bun) or at Origin (Node/Bun for `dynamic` Targets).
_Avoid_: Edge runtime (broader; not Gazetta-specific), Worker process (generic Node concept).

**Origin** (Gazetta-specific contract):
The Node/Bun server that runs templates per request for `dynamic` Targets. Origin executes Dynamic Fragments with full Node API access (file system, child processes, etc.). Workers call Origin on cache miss for dynamic content; Origin's responses are not cached by the Worker (per `design-cache.md` Q4 — cache only content-addressed responses). For `static` and `esi` Targets, no Origin exists.
_Avoid_: Server (too generic), Backend (broader infrastructure term).

### Assets

**Asset**:
A first-class media or downloadable entity stored on a Target — images, video, audio, documents, fonts. Has a name, an Asset Manifest, byte content, and zero or more responsive variants. Referenced from content via Asset References. Defined in detail in `design-media.md`.
_Avoid_: Media (acceptable as plain English in UI labels, never as the canonical noun in code or docs), File, Resource, Attachment.

**Asset Kind**:
The rendering contract an Asset honors — `embedded` (rendered inline as `<img>`/`<video>`/`<audio>`), `downloadable` (linked for download as `<a href download>`), or `font` (loaded via `@font-face`). Set at upload time; identity attribute; never overridable on locale or theme variants. Implemented as `AssetKind` in code.
_Avoid_: Asset Type (too generic), Asset Category (no such concept), Asset Role.

**Format-axis adjectives** (no abstract noun):
When discussing file format, use adjective form: "image asset," "audio asset," "PDF asset." There is no "Asset Category" or "Asset Format" noun — the picker's `accept: ['image', ...]` filter values are picker UI concerns, not domain categories.
_Avoid_: Asset Type, Asset Category, Asset Format (as nouns).

### Locale and theme dimensions

**Locale Variant**:
A non-default-locale Manifest of a Page or Fragment, stored as a standalone file alongside the default. Example: `page.fr.json` is a Locale Variant of the home page. Has the same shape as the default Manifest; can declare different content, components, metadata. Distinct from Override (which is a partial overlay against the default; see below).
_Avoid_: Locale Manifest (more pedantic, less idiomatic), Translation (the activity, not the entity), Localized Version, Variant (bare — collides with Responsive Variant).

**Locale Bytes Override**:
An Asset's per-locale byte payload — a Locale Override Manifest carrying its own `hash` field plus locale-specific bytes at `{name}-{hash}.{locale}.{ext}` and locale-specific Responsive Variants. The asset overlays this on top of the default Asset Manifest at resolve time. Used for assets where bytes themselves differ per locale (e.g., text baked into the image).
_Avoid_: Locale Bytes (without "Override" — drops the layering semantics), Locale Asset.

**Locale Metadata Override**:
An Asset's per-locale metadata layer — a Locale Override Manifest with no `hash` field. Overrides metadata fields (alt, title, description, focalPoint, tags) for one locale; the bytes themselves stay default. Used for assets that share visuals across locales but need translated alt or descriptions.
_Avoid_: Locale Metadata (without "Override"), Locale Manifest.

**Theme Bytes Override** / **Theme Metadata Override**:
Theme-axis analogues of the locale overrides above. Theme is a peer override dimension to locale; the same layering semantics apply.
_Avoid_: Theme Variant (collides with Locale Variant — themes don't have whole-file variants today), Theme Asset.

**Locale-Priority Fallback Chain**:
The non-configurable cross-dimension resolution order when an Asset is requested for a (locale, theme) cell. Locale matters more than theme: `(fr, dark) → (fr, light) → (default-locale, dark) → (default-locale, light)`. The default-locale-default-theme manifest is the floor and is always read separately as the base.
_Avoid_: Fallback Chain (when both dimensions matter — qualify with Locale-Priority).

**Translate** (verb):
The action of creating a Locale Variant from a default Manifest. "Translate the home page to French" copies `page.json` to `page.fr.json` so the author can edit it in the new locale. The result is a Locale Variant; the activity is "translating."
_Avoid_: Localize (means roughly the same; pick one — Translate is the canonical verb).

**Responsive Variant**:
A single per-width entry in an image Asset's `variants` array — the responsive `srcset` ladder. Implemented as `AssetVariant` in code. Distinct from Locale Variant — same word in conversation only, qualified by context. Always say "Responsive Variant" when ambiguity is possible.
_Avoid_: Variant (bare — qualify with Responsive or Locale), Width Variant, Asset Variant (in domain conversation; type name kept in code for stability).

### Soft delete and redirects

**Archive** (verb + state):
The operation of transitioning a Page or Fragment from live to a non-live state without removing the manifest. Sets `archived: true` on the manifest along with `archivedAt` and `archivedBy` snapshots. Archived items remain readable via admin (read-only), keep their reverse-dep sidecars (asset-refs, fragment-deps), and survive restore. Recoverable via Restore; permanently removable via Purge. Replaces the prior hard-delete semantics. Per [`design-soft-delete.md`](.claude/rules/design-soft-delete.md).
_Avoid_: Delete (hard-deletion is now an explicit operator action via Purge; "Delete" by itself in domain conversation defaults to Archive), Trash (Webflow/WordPress vocabulary; Gazetta uses Archive).

**Alias** (data field):
The `aliasOf` field on an Archive's manifest, pointing at the name of a live target Page or Fragment. Aliases are flattened on rename (`design-soft-delete.md` Q3 lock) — chains collapse to depth-1; multi-hop aliases are forbidden permanently. Drives the Redirect mechanism.
_Avoid_: Symlink (filesystem metaphor; Aliases are content-tree state, not filesystem state), Reference (collides with the in-content Reference / Usage distinction).

**Redirect**:
A Page or Fragment whose manifest carries `archived: true` AND a non-empty `aliasOf` pointing at a live target. The Worker (or `_redirects` host-glue for plain-static targets) emits `301 Moved Permanently` from the source URL to the alias target's route; a static target without `redirects.format` gets a redirect page with an instant refresh there instead (`design-soft-delete.md` Q10, #1152). Distinguished from a **Pure Soft-Delete** (archived without `aliasOf` — emits `410 Gone` where Gazetta answers the request).

A Redirect originates from one of two operations:
- **Rename Redirect** — composed during the rename operation; the archived old name carries `aliasOf` pointing at the new name (per `design-soft-delete.md` Q3 flatten lock).
- **Manual Redirect** — created standalone via the admin's redirect creation UI; no preceding content at the source name.

Both produce the same on-disk shape and the same HTTP response. The distinction matters for forensic queries (per `design-audit.md`) and UX entry points.

v1 ships 301 redirects only, depth-1 (no chains; flattened on rename). Status codes beyond 301, time-bounded redirects, and scheduled activation/expiry are reserved per [`design-redirects.md`](.claude/rules/design-redirects.md) "Future surfaces" + `design-scheduling.md`'s `redirect-activate` / `redirect-expire` actions.
_Avoid_: URL Rewrite (different mechanism — Gazetta does not own URL rewriting), HTTP Redirect (too generic; "Redirect" in domain language always means the Gazetta primitive defined above).

**Pure Soft-Delete**:
An Archive without an `aliasOf` field. Emits `410 Gone` at the source URL wherever Gazetta answers the request (a worker, `gazetta serve`, a dynamic origin); a plain static host answers `404 Not Found`, which Google treats the same (`design-soft-delete.md` Q14). Same HTML marker mechanism as Redirect, different marker grammar (`<!-- gazetta:archived gone -->`; on static targets, a `.gone` archive sidecar).
_Avoid_: Hard Delete (Purge is the hard-delete operation), Removed (a Removal takes an item off a Target, a different operation).

### Composition and resolution

**Compose** (verb):
Walk a Page or Fragment tree, replace each Fragment Reference with its loaded Manifest, recursively process Children, and produce a fully-loaded structure ready for rendering. The same verb applies to walking a content tree and replacing each Asset Reference with its Resolved Asset Reference. Distinct from Resolve (which picks a single value from rules).
_Avoid_: Resolve (when tree-walking; reserved for chain-pick and config-merge), Hydrate (collides with SSR hydration), Render (collides with template execution), Process, Walk.

**Resolve** (verb):
Given inputs and rules, produce a single picked or flattened value. Two flavors: (a) Fallback Chain Resolution — given a (locale, theme) request and the Locale-Priority Fallback Chain, pick the right cell; (b) Config Resolution — merge layered config (env, site, target) into a single flat value. Code uses `resolve*` names for both flavors plus the (α) tree-walking operation; in conversation, reserve Resolve for chain-pick and config-merge — say Compose for tree-walking.
_Avoid_: Compose (when picking a value), Pick (too generic), Flatten (config-only flavor; doesn't capture chain-pick).

**Resolved Component**:
The output of composing a Component (Page, Fragment, or Inline Component). A tree where Fragment References have been replaced by loaded Fragment Manifests, Children are recursively composed, and the Template plus its content are bundled. Templates receive a Resolved Component as input.
_Avoid_: Loaded component, Hydrated component.

**Resolved Page**:
The composed form of a Page — Resolved Component plus route and metadata, ready for the renderer.

**Resolved Asset Reference**:
The output of composing an Asset Reference: `{ url, srcset, alt, width, height, focalPoint, mime, ... }` (Embedded), `{ url, title, description, size, mime }` (Downloadable), or `{ cssName, variants }` (Font). Templates receive Resolved Asset References, never raw Asset References.
_Avoid_: Materialized asset, Hydrated asset, Asset response.

**Composer** (informal — operation, not a class):
The function or module that performs Composition. `resolveComponent` and `resolveAssetRefs` in code are Composers despite their `resolve*` names. New code that performs composition should be named `compose*` from the start.

### Extension surfaces and providers

**Extension surface**:
A typed interface defining a category of pluggable functionality. Gazetta has 12: Storage, Cache, Audit, AltText (AI), Transform Adapter, Deploy Adapter, Validator, AuthIdentity, Hook, Admin Editor, Admin Field, Notification. Each surface has its own interface and per-surface conventions; operators reach a surface either by assigning a constructed Provider instance to a config field (Storage, Cache, AltText, Transform, etc., per ADR-0008) or by adding a Contribution to a typed array under `admin.{surface}` (`admin.hooks`, `admin.validators`, `admin.routes`, per ADR-0009).
_Avoid_: Plugin slot, Extension point, Hook (collides — Hook is one specific surface).

**Provider**:
A single implementation of an Extension Surface. `MemoryCache` and `RedisCache` are Providers of the Cache surface; `R2Storage` and `AzureBlobStorage` are Providers of the Storage surface. Operators select Providers via factory calls in `site.config.ts` (e.g., `cache: memoryCache({...})`); v1 ships reference Providers in-tree. Provider authors satisfy the eight Universal Provider Requirements from ADR-0004 (preserved across ADR-0008 and ADR-0009 supersessions).
_Avoid_: Plugin (the npm distribution unit, not the runtime construct), Backend (too generic), Adapter (use only when matching the term-of-art for the surface, e.g., Transform Adapter, Deploy Adapter).

**Contribution**:
What a factory function returns when its target surface registers via array (rather than via a Provider field). Each surface has its own contribution shape: `HookContribution` (for `admin.hooks`), `Validator` (for `admin.validators` — the `Validator` interface IS its own contribution shape), `RouteContribution` (for `admin.routes`). All contribution shapes carry a `source: string` field for diagnostics + audit. Per ADR-0009, contributions replace the locked-design's `PluginAPI` register methods.

**Plugin**:
An npm package distributing one or more factory functions that return contributions for Gazetta extension surfaces. A plugin can ship hook factories (returning `HookContribution`), validator factories (returning `Validator`), route factories (returning `RouteContribution`), provider factories (returning `StorageProvider` / `AdminCache` / `AltTextAdapter` / etc.), or any combination. The operator imports each factory and invokes it inline in `site.config.ts`. Per ADR-0009, plugins have no runtime shape — there is no `Plugin` interface, no `init(api)` lifecycle, no `dispose()`. Each factory's output composes via its surface's contribution-array semantics (priority for hooks, registry-merge for validators, Hono-mount for routes) or by direct field assignment (Provider instances).
_Avoid_: Provider (narrower — one factory's output, not the whole package), Extension (too generic), runtime contract (there isn't one).

### Identity, capabilities, and trust

**Capability**:
A `verb:domain` permission token (e.g., `read:pages`, `edit:fragments`, `publish:non-production`, `comment:write`). The vocabulary primitive of Gazetta's authorization model. Operators assign Capabilities to Roles in `site.config.ts`; Roles aggregate Capabilities into named sets that map to Principals via the Trust mode's group/claim mapping. Plugin-contributed Capabilities use a plugin-specific prefix (e.g., `search:rebuild-index`) — built-in prefixes (read / edit / delete / publish / configure / review / restore / comment / mention / subscribe) are reserved.
_Avoid_: Permission (collides with filesystem permissions), Right, Privilege.

**Trust mode**:
The strategy by which Gazetta extracts a Principal from an incoming request — chosen by the Operator at site config time per `admin.auth.trust`. Six in-tree modes (`none` / `forwarded-user` / `cloudflare-access` / `azure-easy-auth` / `aws-cognito` / `tailscale`) each describe how Gazetta reads the authenticated identity from upstream-provided headers / tokens. Plugin-supplied trust modes register via the AuthIdentity Extension Surface. Locked invariant: Gazetta consumes upstream identity, never authenticates itself.
_Avoid_: Auth mode (less specific), Auth provider (collides with AuthIdentity Provider — the implementation), Identity strategy.

**Principal** (internal — request-context type):
The TypeScript type carrying the runtime user identity (id / email? / role / trustMode) propagated through admin-API requests, hook contexts, and audit events. Domain conversation says "Actor" (the role: Content Author / Operator / etc.) or just "user"; "Principal" is the API-surface technical name. Same posture as `ComponentManifest` and `SourceContext`.
_Avoid_: Using "Principal" in domain conversation — say "actor" or "user."

### Audit and notifications

**Audit event**:
The unit of forensic record in Gazetta's audit log. Every write (save / publish / delete / restore / configure-roles) emits exactly one Audit event with a structured shape: timestamp, actor (snapshot at decision time), action, outcome, scope, optional metadata. Closed enums for `action` and `outcome`; extension is closed-enum-additive. Stored via the configured AuditProvider — `HistoryAuditProvider` extends each history Revision with audit fields; external sinks (`HttpWebhookAuditProvider`, etc.) emit standalone events.
_Avoid_: Audit log entry (longer; less precise), Log event (collides with operational logs — see `design-logging.md`).

**Notification**:
The unit of delivery for collaboration events to a recipient (mention, reply, subscription firing, content-comment). Has a recipient identity, a category, a human-readable message, and a deep-link to the relevant content. Stored at `.gazetta/notifications/{recipient-id}/{notification-id}.json` for in-admin delivery; future external NotificationProviders (email, Slack, webhook) deliver to operator-configured destinations.
_Avoid_: Alert (too generic, collides with browser notifications), Message (collides with comment messages).

### Collaboration

**Comment thread**:
A conversation anchored to a Gazetta entity — a Page, Fragment, Asset, or specific position within a Manifest (via stable component ID + optional field path). Contains an ordered list of Messages (text + structured Mentions), open/resolved state, and audit metadata. Stored at `.gazetta/comments/{kind}/{name}/threads/{thread-id}.json` with per-thread granularity for multi-instance correctness. Resolution is reversible; the thread persists.
_Avoid_: Discussion (less precise), Conversation (broader UX term), Thread (bare — qualify with Comment when ambiguity is possible).

**Mention**:
A structured reference to an Actor inside a Comment Thread message — `{ type: 'mention', userId: 'bob@example.com' }`. NOT parsed from text; created by the `@`-picker UI which filters to users with content access (privacy gate). Triggers Notification dispatch to the mentioned user.
_Avoid_: @-mention (decorative; the structured form is the truth), Tag (too generic).

### Editor state

**Pending edits**:
Form-state changes the Author has made but not yet committed via explicit Save click. Stored per-item in Pinia stores (`editorContent`, `editorStash`, `editorStructural`, `editorMetadata`); persisted to IndexedDB so they survive browser reload, navigation between pages, and offline sessions. The Author can navigate freely between items with multiple pending edits accumulated; each item's pending state is independent. Pending edits never silently apply; saving is always an explicit Author action. Distinct from Save queue.
_Avoid_: Draft (overloaded with review-state's `draft` value), Working copy (rejected term per `design-decisions.md` #14), Dirty state (UI-only; doesn't capture the persistence semantics), Unsaved changes (acceptable in plain-language UI; less precise as domain noun).

**Save queue**:
Save attempts the Author committed (clicked Save) while offline that are waiting for the system to deliver to the Server. Stored in IndexedDB; replays on reconnect via Vue Query mutation cache. Each queued save was an explicit commit-of-intent by the Author — Save semantics don't change online vs. offline (per [ADR 0006](docs/adr/0006-save-as-commit-intent.md)). Conflicts on replay surface to the Author for resolution. Distinct from Pending edits — Pending is "I haven't committed," Queue is "I committed but delivery's pending."
_Avoid_: Outbox (email metaphor; misleading since not sent, just local), Pending saves (collides with "Pending edits" — different concept), Sync queue (less precise; doesn't capture commit-intent).

### Project, Site, and Workspace

**Project**:
The outermost unit: a Git repo + root `package.json` with npm workspaces (`admin/`, `templates/`) + zero or more Sites under `sites/`. Holds shared templates, custom editors, and admin customizations. One Project can host many Sites. Created by `gazetta init`.
_Avoid_: Repo (mechanical, not domain), Workspace (collides with npm workspaces), Codebase.

**Site**:
One brand or domain: a content tree (pages, fragments, assets), a Site Manifest (`site.config.ts`), and one or more Targets. Lives at `sites/{name}/` inside a Project. Multiple Sites per Project supported (agency / multi-brand setups). The Site is the natural unit of content; the Project is the natural unit of code-and-templates.

**Locked invariant: one Site per process.** Each Gazetta runtime invocation (`gazetta dev`, `gazetta serve`, `gazetta publish`) loads exactly one Site. Multi-Site Projects exist as a *layout* concern — `sites/{a,b,c}/` coexist on disk — but the operator picks ONE per command (`gazetta dev site-a`). The runtime has no concept of multi-Site routing, multi-Site cache scoping, or cross-Site state. Multiple Sites in one Project means multiple processes, deployed independently. This invariant simplifies every foundational dimension (cache, auth, audit, hooks, plugins, offline) by removing per-Site isolation as a recurring concern.
_Avoid_: Project (the Project contains the Site, not vice versa), Brand, Property, Tenant.

**Workspace** (internal — npm tooling, not domain):
The npm-workspaces concept. `admin/` and `templates/` are npm workspaces inside the Project's root `package.json`. They share dependencies and tooling. Not a domain term — CMS Developers care about workspaces; Content Authors, Template Developers, and Operators don't.
_Avoid_: Using "Workspace" as a domain noun for Project, Site, or Target.

## Relationships

- Roles are not exclusive — one person can hold any combination. Solo open-source projects are all four.
- **Content Author** uses tools the **Template Developer** built (custom editors, fields), running on infrastructure the **Operator** publishes, in a system the **CMS Developer** maintains.
- Documentation is written for one specific actor — `docs/content-assets.md` for Content Authors, `docs/template-assets.md` for Template Developers, deployment guides for Operators, `.claude/rules/*.md` for CMS Developers.
- A **Page** has Children (zero or more). A **Fragment** has Children (zero or more). Children are a mix of **Fragment References** and **Inline Components**.
- An **Inline Component** can have its own Children, recursively.
- A **Fragment** can be referenced by many Pages or Fragments via Fragment References. The same Fragment is rendered everywhere it's referenced.
- A **Page** or **Fragment** holds **Asset References** in its content tree. Each Asset Reference targets one **Asset** by name and may carry per-reference overrides.
- Each Reference produces a **Usage** at the target entity. An Asset's Usages enumerate the (Page or Fragment, location-in-content) pairs that reference it.
- **Usages** are derived from **References** but materialized as **Usage Sidecars** for fast lookup without scanning the full site.
- A **Target** can play any of three roles: **Active Target** (editor focus), **Source Target** (publish reads from), **Destination Target** (publish writes to). One physical Target may play multiple roles in one workflow — the same `local` Target is typically both Active and Source of a publish to staging.
- A **Page** or **Fragment** has one default **Manifest** plus zero or more **Locale Variants** — standalone Manifests stored alongside the default.
- An **Asset** has one default **Asset Manifest** plus zero or more **Locale Overrides** (Bytes or Metadata) and **Theme Overrides** — partial overlays, not standalone files. The **Locale-Priority Fallback Chain** resolves a request to a concrete cell.
- An image **Asset** has zero or more **Responsive Variants** in its default Manifest, plus zero or more Responsive Variants per Locale Bytes Override (each Locale Bytes Override is independently sized).
- A **Project** contains zero or more **Sites**. A **Site** has one or more **Targets**. Templates, custom editors, and admin customizations are project-level (shared across all Sites in the Project). Pages, fragments, and assets are per-Site.

## Example dialogue

> **Content Author:** "I uploaded the hero image but the alt text didn't fill in."
> **Operator:** "AI alt is configured for staging but not for prod — that's why."
> **Template Developer:** "I can mark the hero field `altRequired: true` so saves block when alt is empty."
> **CMS Developer:** "The Validator interface lets us add that check at save-delta and at publish gate independently."

> **Content Author:** "The footer changed on every page. Did I do that?"
> **Template Developer:** "The footer is a **Fragment**, so editing it once updates every Page that has a `@footer` **Fragment Reference** in its **Children**."

> **Content Author:** "Does the hero on the home page also appear on /about?"
> **Template Developer:** "No — it's an **Inline Component**, so it's local to the home page's manifest. The `@header` next to it IS shared across pages because it's a **Fragment Reference**."

> **Content Author:** "Can I delete this asset?"
> **Operator:** "It has 3 **Usages** — one **Asset Reference** in the home **Page Manifest**, two in fragment manifests. Pick a replacement to rewrite those references, then delete."

> **Operator:** "I want to publish staging to prod."
> **Content Author:** "Wait — staging is the Active Target right now. Will switching break my edits?"
> **Operator:** "No. I'm picking staging as the **Source Target** and prod as the **Destination Target**. Active Target is independent of the publish — your editor focus stays where it is."

> **Content Author:** "I clicked Translate to French and now the page has English text in it."
> **Template Developer:** "Translate copies the default **Page Manifest** to a new **Locale Variant** (`page.fr.json`). It starts with the same content; you edit the French Locale Variant to translate."

> **Content Author:** "Why does this asset have one French alt but no French version of the image?"
> **Template Developer:** "It has a **Locale Metadata Override** — only the alt is localized. If you also need different bytes for French, add a **Locale Bytes Override**."

> **CMS Developer:** "The publish pipeline composes each Page's tree, resolves the locale and theme cells per Asset Reference, and renders the final HTML."
> **Template Developer:** "So composition is the tree-walk and resolution is the cell-pick. Got it."

## Flagged ambiguities

The following terms were ambiguous in the codebase or design docs at the time this glossary was written. Each was resolved by picking a canonical term; type names in code were preserved for stability (Posture A — document what is, don't refactor in this pass).

- **"Component"** was used both as the abstract base and as casual shorthand for a child of a Page or Fragment — and collides with React/Vue components in template development. Resolved: drop Component as a domain noun. Use Page, Fragment, or Inline Component explicitly. The internal type `ComponentManifest` is stable. See [ADR 0003](docs/adr/0003-component-not-a-domain-noun.md).

- **"Manifest"** was used as a suffix on at least 13 distinct types (`PageManifest`, `AssetManifest`, `RevisionManifest`, ...). Resolved: promote Manifest to a domain noun ("a Manifest is the authoritative declarative description of a domain entity's current state, stored as a JSON or YAML file") and always qualify in conversation when ambiguity is possible.

- **"Reference / Ref"** was used for at least four distinct things: in-content link, location-record of where references occur, fragment-name string, and the storage sidecar that materializes location-records. Resolved: Reference (out-pointing, in content) vs. Usage (in-pointing, derived). The code's `AssetRef` type carries Usage data; type name is stable. See [ADR 0002](docs/adr/0002-reference-vs-usage.md).

- **"Source"** was used for both publish-source-Target and admin-API editing context (`SourceContext`). Resolved: Source Target (publish role) vs. Source Context (internal admin-API plumbing for the Active Target). Type name is stable.

- **"Variant"** collided between Locale Variant (whole-file non-default Manifest of a Page or Fragment) and Responsive Variant (per-width entry in an image Asset's `variants` array, code type `AssetVariant`). Resolved: always qualify. Locale Variant for the standalone-file case; Responsive Variant for the image-width axis.

- **"Override"** was used for both the asset-only locale-bytes-or-metadata-overlay-on-default case and (occasionally) for whole-file locale variants. Resolved: Override is partial overlay; Locale Variant is whole-file. Subtypes: Locale Bytes Override, Locale Metadata Override, Theme Bytes Override, Theme Metadata Override.

- **"Resolve"** was used for three structurally different operations: (1) walk a tree and replace references with loaded contents; (2) pick a value from a fallback chain; (3) merge layered config. Resolved: Compose (verb) for the tree-walking operation; Resolve (verb) for chain-pick and config-merge. Code names with `resolve*` prefix are stable; new code should use `compose*` for tree-walking. See [ADR 0001](docs/adr/0001-compose-vs-resolve-verb-split.md).

- **"Kind"** collided between Asset Kind (rendering contract: embedded / downloadable / font, code type `AssetKind`) and informal usage for format category (image / video / audio). Resolved: Asset Kind is the rendering contract; format gets adjective form ("image asset," "audio asset") with no noun.

- **"Site"** vs **"Project"** were occasionally swapped. Resolved: Project contains Sites. Project = Git repo + workspaces; Site = brand/domain with its own content and Targets.

- **"User" / "Editor" / "Author" / "Developer" / "Maintainer"** were used loosely. Resolved: four canonical actors — Content Author, Template Developer, Operator, CMS Developer.
