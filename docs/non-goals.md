# Non-Goals

Things Gazetta deliberately does NOT do, with rationale. Designed to prevent re-litigation: when someone proposes one of these features, this doc is the answer.

A non-goal here doesn't mean "we hate the idea." It means: the architectural fit is wrong for Gazetta's defining constraints, OR the feature is owned by a different category of tool that does it better. Where applicable, recommended integration paths are documented.

## What makes a non-goal

A feature is a non-goal when AT LEAST ONE of:

1. It contradicts a defining architectural property (e.g., requires a database — Gazetta is stateless)
2. It's structurally well-served by integration with a specialist tool (don't reimplement)
3. It would require fundamental change to a stable design choice (e.g., form-first editing)

Non-goals are revisited if external context changes: new use cases, new architectural primitives that change the fit, or strong evidence the rationale is obsolete. The defaults are sticky; "we should reconsider X" requires explicit justification.

---

## Memberships / subscriptions / paywalls / native newsletters

**Why not**: this is downstream of content publishing — audience management, payment processing, member sessions. Adding it requires:

- A user database (Gazetta is stateless by design)
- Payment integration (out-of-scope)
- Session management at the runtime layer
- Member authentication separate from operator authentication

Adding this would fundamentally change Gazetta from "content structure" to "publishing platform with audience features." Different category of tool.

**Who owns this**: [Ghost](https://ghost.org/) for newsletters + memberships. [Substack](https://substack.com/) for indie publishers. [Stripe](https://stripe.com/) + [Auth0](https://auth0.com/) for custom membership stacks.

**Integration path**: a Gazetta site can integrate Ghost as a sidecar — Ghost handles members + newsletters; Gazetta handles content structure. Templates fetch from Ghost's API at render time. Or use Stripe + a session middleware in the Hono runtime.

---

## Content branching (git-like content branches)

**Why not**: multi-Target already covers ~80-90% of real branching use cases. Adding delta-based content branches would duplicate the multi-Target model with worse semantics.

Researched alternatives:
- [Contentstack Branches](https://www.contentstack.com/docs/developers/branches/about-branches) supports content-type and global-field branching ONLY, not entries/assets. Not full content branching.
- Most CMSes don't have any kind of branching beyond multi-environment.

**Who owns this**: not a real industry standard. Content branching is a niche feature.

**Integration path**: use multi-Target for the same use cases. "Branch" = create a new Target as a copy; "merge" = publish that Target back to the canonical one.

---

## Content federation (compose at query time from external systems)

**Why not**: at the CMS level, federation means generating editor forms from remote schemas + reconciling at render. The form layer is generated from local Zod schemas; federating remote schemas requires either pulling them into the local schema graph (loses the CMS's deterministic shape) or generating dynamic forms (form generation is a hard problem).

Templates already fetch external data at render time — that's federation at the right layer (Template Developer, not CMS).

**Who owns this**: [Hygraph Content Federation](https://hygraph.com/docs/getting-started/fundamentals/content-federation) is the reference for CMS-level federation. They specialize in unifying enterprise content across CMS + PIM + commerce + legacy systems.

**Integration path**: Templates fetch from external APIs at render. For a Hygraph-style "compose into one query" use case: deploy Hygraph alongside Gazetta and render its results in templates.

---

## Built-in full-text search

**Why not**: real search needs an index, runs as its own service, has its own scaling profile. Building search inside Gazetta means duplicating Algolia or Meilisearch — worse, and we'd never reach feature parity. The CMS focuses on content structure; search is an indexing-and-query specialty.

**Who owns this**: [Algolia](https://www.algolia.com/), [Meilisearch](https://www.meilisearch.com/), [Typesense](https://typesense.org/), [Elasticsearch](https://www.elastic.co/).

**Integration path**: a future `gazetta search-index` CLI command could build an index from rendered output, optionally pushing to Algolia or Meilisearch. Templates implement search UI against the index. (Tracked as deferred in [ROADMAP.md](../ROADMAP.md).)

---

## Visual editing as primary editor paradigm

**Why not**: visual editing (click-on-rendered-page-to-edit) is a fundamentally different UX paradigm from form-driven editing. We're form-first by design — Zod → @rjsf, with custom editors for one-off cases. Adding visual editing as a secondary paradigm is fine in principle but requires significant design space exploration; making it the primary paradigm would be a strategic re-positioning.

**Who owns this**: [Storyblok](https://www.storyblok.com/), [Builder.io](https://www.builder.io/), [Webflow](https://webflow.com/), [Framer](https://www.framer.com/) all lead with visual editing.

**Integration path**: the preview iframe is already there. Click-to-edit on the iframe is implementable later as a secondary mode if Marketing-team operators specifically ask. Defer until clear demand. Template Developers who want visual-first authoring should evaluate Storyblok or Builder.

---

## Database integration

**Why not**: Gazetta is stateless by design. Targets ARE the state. Adding a database means:

- Choosing a database (Postgres? SQLite? Cloud-managed?) — committing operators to that choice
- Migrations, backups, replication — operations burden that contradicts "lose the CMS, reconnect to targets"
- Different consistency model than the file-based one

The stateless property is what differentiates Gazetta from WordPress / Strapi / Ghost. Trading it would erase the differentiator.

**Who owns this**: every database-backed CMS. Pick the one that fits.

**Integration path**: templates can query a database at render time (template author's choice). Templates can also POST to a database. The CMS itself stays stateless; specific templates can have database side effects.

---

## E-commerce primitives

**Why not**: shopping cart, payment processing, inventory, customer accounts — these are a separate category of system. Building them inside a CMS means competing with Shopify / WooCommerce / Medusa.

**Who owns this**: [Shopify](https://www.shopify.com/), [Medusa](https://medusajs.com/), [Saleor](https://saleor.io/), [BigCommerce](https://www.bigcommerce.com/).

**Integration path**: templates fetch product / inventory / order data from a commerce system at render. Gazetta handles content (product descriptions, brand pages, blog posts); commerce system handles transactions.

---

## Content scoring (Yoast-style readability + keyword scoring)

**Why not**: per [seo-plan.md](../.claude/rules/seo-plan.md), content scoring correlates weakly with rankings (r = 0.10-0.32 in studies) and encourages over-optimization. The SERP preview tells authors what Google will display, which is what they actually need. Yoast-style green/red dots add noise without signal.

AI SEO and GEO review reports are content scoring with AI, and a non-goal for the same reason. For example, Hygraph's SEO agent produces Generative Engine Optimization review reports ([changelog](https://hygraph.com/changelog), 2026-07-30).

**Integration path**: don't.

---

## Concurrent editing safety / OT / CRDT (in current scope)

**Status**: deferred, not non-goal. May become Tier 1 if team-CMS positioning becomes the strategic direction. See [ROADMAP.md](../ROADMAP.md) Tier 3 — Real-time presence (read-only) is the first step; full collaborative editing comes later if at all.

The current "last write wins" semantics (per [`operations.md`](../.claude/rules/operations.md)) is sufficient for solo authors and small teams who coordinate out-of-band. Adding OT/CRDT is a 3-6 month commitment to a real-time editing infrastructure; we don't make that commitment without product validation.

---

## First-class Solid / Svelte / framework-of-the-week template support

**Why not**: Templates are framework-agnostic by contract. Each template imports its own framework, SSRs to the standard `{ html, css, js }` shape, and ships its own framework dependency. The CMS doesn't need to ship first-class anything — React, Vue, Svelte, Solid, plain TS all work today through the same template contract.

Adding "first-class Solid support" or "first-class Svelte support" implies CMS-side machinery the contract doesn't need. Operators who want a particular framework write a template using that framework; the contract handles it.

**Integration path**: write the template using the framework you want.

**Closed issues**: #65 (Svelte template support), #69 (Solid.js JSX support).

---

## Broad plugin system beyond documented extension surfaces

**Why not**: Gazetta has ten documented extension surfaces (storage providers, templates, custom editors, custom field widgets, transform adapters, deploy adapters, AI providers, hooks, validators, cache providers) with their own typed interfaces. Together they ARE the plugin system — operators extend Gazetta by implementing one of these surfaces. The unifying contract for discovery + lifecycle + composition lands in [`design-plugins.md`](../.claude/rules/design-plugins.md) (Tier 2 design pass).

Broader runtime extensibility — custom Hono routes, custom CLI commands — would be additive, but introduces sandboxing/trust questions that aren't worth answering without concrete operator demand.

**Integration path**: file an issue with the specific extension surface needed and the use case. Most legitimate cases fit one of the existing nine surfaces; the design pass for `design-plugins.md` will formalize how new surfaces get added.

---

## How to revisit a non-goal

Anyone proposing a feature listed here should:

1. Read the rationale above
2. Identify which assumption they think has changed (architectural property obsolete? Better integration path emerged? Different category of users now relevant?)
3. Open an issue with that argument

Non-goals are sticky but not absolute. The bar for revisiting is "the world changed"; the bar for staying is "the rationale still holds."
