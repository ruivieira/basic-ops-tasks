# basic-ops-tasks

Operational tasks and automation. Currently home to one deliverable:

## fork-sync-action

A GitHub Action that keeps a **fork** up to date with its **upstream**
repository, or syncs **one branch into another** of the same repository, by
opening a reviewable pull request: nothing lands on the target branch
without review. TypeScript on the official
[actions/toolkit](https://github.com/actions/toolkit), bundled with `ncc`,
running on the `node24` runtime.

Full documentation: [`fork-sync-action/README.md`](fork-sync-action/README.md)

### Example: sync a fork from its upstream

In the fork's `.github/workflows/sync-upstream.yml`:

```yaml
on:
  schedule:
    - cron: "30 6 * * *"   # daily at 06:30 UTC
  workflow_dispatch: {}

permissions:
  contents: write          # push the sync branch
  pull-requests: write     # open the pull request

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: ruivieira/basic-ops-tasks/fork-sync-action@v1
```

The upstream repository and both branch names are auto-detected from the
fork's parent.

### Example: sync one branch into another

In any repository (e.g. a rolling "develop into main" PR):

```yaml
on:
  workflow_dispatch: {}

permissions:
  contents: write
  pull-requests: write

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: ruivieira/basic-ops-tasks/fork-sync-action@v1
        with:
          source-branch: develop
          target-branch: main
```

Opens (or updates) a rolling pull request from `sync/develop-into-main` into
`main`, carrying every commit `develop` is ahead. The `develop` branch itself
is never modified.

### Testing and developing the action

```bash
cd fork-sync-action
npm install
npm run typecheck
npm test        # rebuilds dist/ and runs the offline scenario suite
```

See the action README for all 15 inputs, outputs, caveats (notably the repo
setting that lets Actions open pull requests), and the four-level testing
guide.
