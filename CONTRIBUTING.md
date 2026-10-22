# Contributing to Gazetta

Thanks for your interest in contributing! Gazetta is an open-source stateless CMS
that structures websites as composable components.

## Getting started

```bash
git clone https://github.com/gazetta-studio/gazetta-studio.git
cd gazetta-studio
npm install
npm run build
npm run dev          # site + CMS on http://localhost:3000
npm test             # all tests (see "Running tests" for the Docker ones)
```

New to the codebase? The [README](README.md) explains how Gazetta works,
[CONTEXT.md](CONTEXT.md) defines its vocabulary, and [AGENTS.md](AGENTS.md) has the
repository layout, every command and the conventions. Coding agents read AGENTS.md too.

## Picking an issue

Issues labelled [`ready-for-agent`](https://github.com/gazetta-studio/gazetta-studio/labels/ready-for-agent)
are open to anyone, people and bots. To start small, look for
[`good first issue`](https://github.com/gazetta-studio/gazetta-studio/labels/good%20first%20issue).

1. **Check that nobody is on it.** An open PR that mentions the issue shows in the
   issue's Development section or its timeline.
2. **Open a draft PR early**, even before it has much code, with `Fixes #123` in its
   description. The bots that work on issues skip any issue an open PR mentions, so
   they won't open a second PR for it.

If you're not sure what to pick:

| Kind | How to spot it | Good first pick? |
|---|---|---|
| Bug fix | `bug`, and the issue says what should happen (Expected, or Acceptance criteria) | Yes: one PR, and the behaviour is spelled out |
| Missing tests | Titles like "Test the …" or "Route tests for …" | Yes: no product change, and a good way into an area |
| Surviving mutants | "Surviving mutants in X.ts: N coverage gaps" | When N is small. You can also take part of one: say `Part of #123` instead of `Fixes #123` |
| Feature cut | `enhancement`, and the body starts with `**Feature**:` | Later: it follows a design doc, and every issue under **Depends on** must be closed |
| Flaky test | `flake` | Hard: it needs CI to reproduce |

The `area:` labels say which part of the code an issue is in. Issues without
`ready-for-agent` aren't ready yet: they still need a decision or more information.
Ask on the issue if anything is unclear.

## Making the change

1. Fork the repository and create a branch, for example `fix/issue-123`.
2. Read what the issue points to: the design doc it names (`.claude/rules/design-*.md`),
   and [CONTEXT.md](CONTEXT.md) for the project's vocabulary.
3. Add tests with the change. A bug fix comes with a test that fails without the fix.
4. If users see the change, update the docs in the same PR.

The design docs record decisions the maintainer made. If your change seems to need a
different decision, ask on the issue first.

### Before you push

- Run `npm run format`. CI's format check fails on unformatted code.
- Run the tests for what you changed (`cd packages/gazetta && npx vitest run tests/<file>`),
  then `npm test`.
- After changing types, run `npm run build`: `tsc --noEmit` misses some errors.
- For UI changes, give new interactive elements a `data-testid`, and check both light
  and dark mode.

### After you open a PR

- If it's your first PR here, its CI waits until a maintainer approves the run.
- Sourcery and Sentry Seer review every PR automatically. Fix what holds, and reply to
  what doesn't; the maintainer's review decides.
- Keep "Allow edits by maintainers" turned on. `main` only accepts branches that are
  up to date with it, and this lets the maintainer update yours.
- You don't need to squash your commits.

## Running tests

```bash
npm test                                   # every workspace
npm test -w packages/gazetta               # one workspace
cd packages/gazetta && npx vitest run tests/some-file.test.ts
npx playwright test                        # e2e
```

The admin workspace's tests end with `apps/admin/tests/docker.test.ts`, which starts
MinIO and Azurite through Docker. Without Docker running, that step fails; run the
workspace you changed instead, for example `npm test -w packages/gazetta`.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
