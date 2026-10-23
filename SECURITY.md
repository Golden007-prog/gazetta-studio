# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue, pull request or discussion:

1. Open [Report a vulnerability](https://github.com/gazetta-studio/gazetta-studio/security/advisories/new) (the repository's Security tab, then "Report a vulnerability").
2. Describe the problem, how to reproduce it, what an attacker could do with it, and the version or commit you tested.

Only you and the maintainers see the report. We'll answer in the report and work on the fix there, in a private fork when it needs code. When the fix is released, the advisory is published with credit to you, unless you'd rather not be named.

## What's in scope

- The `gazetta` npm package: the renderer, the CLI, the admin API and admin UI, the storage providers, and the Cloudflare worker it generates.
- The gazetta.studio website.

A vulnerability in one of Gazetta's dependencies belongs to that project, but tell us too if the way Gazetta uses it makes things worse.

Please don't run load tests or automated scanners against gazetta.studio.

## Supported versions

Gazetta is before 1.0. Fixes go into a new release; older versions don't get backported fixes.
