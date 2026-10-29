# Publishing

Publish copies content from an editing source to one or more destinations and renders it for those targets. Saving in the admin changes the active editing target; it does not publish to the other targets. To create your first site and publish to staging, follow [Getting started](./getting-started.md#publish-and-view-your-site).

Configure storage, target `type`, environments and history in [Targets](./targets.md). For putting the site online, see [Cloudflare](./cloudflare.md) or [Self-hosted](./self-hosted.md).

## Publish from the admin

1. Open **Publish** in the top bar, or click a target's sync chip.
2. Check **From**. It defaults to the active target when that target is editable, otherwise the first editable target. When several targets are editable, choose the source in the dropdown. This lets you promote content from staging without making it the active target.
3. Select one or more destinations under **To**. The selected source is not a destination. A target marked read-only can still receive a publish: read-only prevents editing there, not publishing into it.
4. Review **Items**. The list combines differences across the selected destinations, showing added, modified and destination-only items, with each destination's state. Changed items start selected; use the checkboxes or **Select all** / **Select none** to choose what to publish.
5. Click **Publish**. If a selected destination has `environment: 'production'`, the panel warns that live content will change and asks **Yes, publish to ...** before proceeding.
6. Watch progress and check the result for each destination. Successful results show the copied-file count; failures show an error. A success on one destination does not mean every destination succeeded.

With four or more configured targets, destinations are grouped by environment; a group checkbox selects its members. A sync chip opens the panel with that destination selected, but still review the source and items before publishing.

Items that exist only on a destination count toward its sync status, but publishing cannot remove them today ([#1094](https://github.com/gazetta-studio/gazetta-studio/issues/1094)). They appear as deleted in the comparison, without a publish checkbox; that label is not a promise that publishing deletes them.

### Production confirmation and validation

The extra confirmation depends on the destination's `environment`, not its name. Changing the item or destination selection clears a pending confirmation. Read the destination names before confirming.

The publish flow also reports template or validation errors. If a publish is blocked, read the panel's errors and fix the content or template before retrying. The server checks publish validation too; a client-side selection is not a guarantee that the write will succeed.

## Publish from the CLI

Run these commands from a project with a configured site. Name the destination explicitly, especially in scripts:

```bash
npx gazetta publish staging
npx gazetta publish production
```

The source is the first editable target in declaration order. Unlike the admin panel, this CLI command does not offer a source dropdown. For a project with several sites, include the site directory:

```bash
npx gazetta publish staging sites/main
```

There is no default destination when several targets are configured. Without a target argument, an interactive run asks you to choose; in CI it stops and asks you to specify one. A site with a single target cannot publish because that target is the editing source. Add another target first. Naming the editing source as the destination is also refused, in both the CLI and the admin.

Publish pre-renders pages and uploads content to storage. Its output follows the destination's [`type`](./targets.md#type): `dynamic` pages keep ESI placeholders assembled by a worker or `gazetta serve` at request time; `static` pages are assembled at publish time. For missing routes, see [Custom 404 page](./pages-and-fragments.md#custom-404-page).

`npx gazetta build` builds the production admin UI and custom editors/fields; it is not a content publish. `npx gazetta deploy production` runs the target's deploy adapter; see [Deploy](./deploy.md) for its contract and platform guides.

## Sync chips and unpublished-change dots

These are two different comparisons:

- **Top-bar sync chips** show each non-active target relative to the active target. A chip shows a changed-item count, **in sync** or **not yet published**. The count includes added, modified and destination-only items. Clicking a target chip opens Publish with that destination selected. With four or more targets, environment groups can collapse several chips; expand a group to choose a member.
- **Amber dots in the site tree** mark pages and fragments with unpublished changes against one automatically chosen target. The admin tries targets by environment: production, then staging, then local. It skips targets never published to when a previously published comparison is available. If every comparison is a first publish, items show the not-yet-published state instead. Hover a dot to see the comparison target.

A dot disappears when that item matches the chosen target. Comparisons refresh after saves and publishes. The dots are not separate counts for every destination, so use the chips or Publish panel to inspect a particular target.

## History, undo and rollback

History belongs to a target. A save records a revision on the target it writes to; a publish records a revision on its destination, when history is enabled there. Publishing does not replace the editing source's history with the destination's history.

To inspect a target in the admin, switch to it with the active-target control, open that control's menu and choose **View history**. The History panel lists revisions with their operation, time, source for publishes, message and affected items. **Restore** returns to a chosen revision's snapshot; the current revision's button is disabled.

An **Undo** action after a save or in a successful publish result restores the revision before the target's latest write. In a multi-destination publish, each result has its own Undo button. If another write has happened since the publish, Undo concerns that latest write, not a permanently pinned publish revision. Use History to choose a particular earlier state.

### Destination undo does not change served pages yet

**On a publish destination today, Undo and Restore bring back the content manifests but do not re-render the published output. Visitors keep seeing the same rendered pages.** Do not use destination undo as a way to take a visible publish back. Re-rendering and related publish-undo behavior are tracked in [#1092](https://github.com/gazetta-studio/gazetta-studio/issues/1092); that planned behavior is not shipped here.

On the editing source, restoring manifests changes the content the admin reloads. Restores are forward-only: they add a new rollback revision rather than deleting history. Restoring to an older revision is also called rollback.

### History from the CLI

Name the target whose history you want:

```bash
npx gazetta history staging
npx gazetta undo staging
```

To restore a specific revision, copy its ID from `history` and run `npx gazetta rollback <revision-id> staging`, replacing `<revision-id>` with that real ID. Undo needs a previous revision; it fails when there is nothing earlier to restore. On production targets, CLI undo and rollback ask for confirmation; in CI they require `--yes` instead. These commands have the same destination-rendering limitation described above.

Not every target keeps history. Public-storage targets and targets with `history.enabled: false` do not; see [History settings](./targets.md#history) for retention and [Public storage](./targets.md#publicstorage) for the storage rules.
