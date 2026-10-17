# fork-sync-action

A GitHub Action that keeps a **fork** (repo B) up to date with its **upstream / parent**
repository (repo A) by opening a **pull request** that carries the incoming commits,
so nothing lands on your fork's branches without review. It also syncs **one branch
into another** of the same repository (e.g. `develop` into `main`) the same way:
as a reviewable pull request.

The action is served from the root of this repository (`basic-ops-tasks`), so the
`uses:` reference carries no subdirectory path:

```yaml
- uses: ruivieira/basic-ops-tasks@v1
```

```
repo A (upstream)                         repo B (fork)
  main ──●──●──●──●                          main ──●──●──●   (your own commits)
              │                                        ▲
              │ fetch                                   │ pull request
              ▼                                         │
        sync/upstream-main ── merge ────────────────────┘
        (force-pushed by the action)
```

Built on GitHub's official Actions toolkit (`@actions/core`, `@actions/github`),
bundled to a single `dist/index.js` with `@vercel/ncc`, running on the `node24`
runtime.

## What it does

1. Resolves the upstream repository (either from the `upstream-repo` input or
   automatically as the parent of the repository the workflow runs in) and both
   branch names (upstream's and the fork's default branches unless overridden).
   In branch-to-branch mode (`source-branch`), the source is simply a branch of
   the current repository instead.
2. Creates a throwaway git workspace, fetches the fork's `target-branch` and the
   upstream branch. No checkout of your repo needed.
3. If the fork already contains everything from upstream → exits with
   `status=up-to-date` and changes nothing.
4. Otherwise creates (or resets) a sync branch (`sync/upstream-<branch>` by
   default) at the target branch and merges upstream into it:
   fast-forwards when the fork is strictly behind, otherwise creates a merge
   commit. On conflicts, the sync branch is pointed at upstream's tip instead,
   so the pull request surfaces the conflicts for you to resolve.
5. Force-pushes the sync branch to the fork (the branch is owned by the action,
   so re-runs are idempotent) and opens a pull request `sync/... → target-branch`,
   or updates the existing open one.
6. Sets outputs (`status`, `pull-request-url`, `commit-count`, …) and writes a
   job summary.

## Quick start

In the **fork** (repo B), drop this into `.github/workflows/sync-upstream.yml`
(see [Publishing this action](#publishing-this-action) for how the `@v1`
reference resolves):

```yaml
name: Sync upstream

on:
  schedule:
    - cron: "30 6 * * *"   # daily at 06:30 UTC
  workflow_dispatch: {}     # also runnable manually

permissions:
  contents: write          # push the sync branch
  pull-requests: write     # open the pull request

concurrency:
  group: sync-upstream     # never two syncs at once

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: ruivieira/basic-ops-tasks@v1
```

That's all: upstream repo, upstream branch and target branch are all
auto-detected. Remember to enable Actions in the fork once
(*Settings → Actions → General → Allow all actions and workflows*), because
GitHub disables workflows in forks by default. While you're there, tick
*Allow GitHub Actions to create and approve pull requests* (same page,
*Workflow permissions*), or the run will fail when opening the pull request
(see [Notes and caveats](#notes-and-caveats)).

## Examples

### 1. Minimal: sync default branches on a schedule

See [Quick start](#quick-start). Everything is auto-detected from the fork's
parent repository.

### 2. Pick the branches when triggering manually

```yaml
name: Sync upstream

on:
  workflow_dispatch:
    inputs:
      upstream-branch:
        description: "Branch on the parent repo to pull from"
        default: main
      target-branch:
        description: "Branch on the fork to update"
        default: main

permissions:
  contents: write
  pull-requests: write

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: ruivieira/basic-ops-tasks@v1
        with:
          upstream-branch: ${{ inputs.upstream-branch }}
          target-branch: ${{ inputs.target-branch }}
```

### 3. Branch-to-branch sync within one repository

The same machinery also works between two branches of the *same* repository:
set `source-branch` and the action opens (or updates) a pull request that
carries every commit `source-branch` is ahead of `target-branch`, e.g. a
rolling "develop into main" PR:

```yaml
name: Sync develop into main

on:
  schedule:
    - cron: "30 7 * * 1"   # Mondays 07:30 UTC
  workflow_dispatch: {}

permissions:
  contents: write
  pull-requests: write

concurrency:
  group: sync-develop-into-main

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: ruivieira/basic-ops-tasks@v1
        with:
          source-branch: develop
          target-branch: main
```

The pull request head is a dedicated branch (`sync/develop-into-main` by
default) that the action force-pushes; your `develop` branch is never
modified. Everything else behaves like fork mode: fast-forward when possible,
`status=conflicts` with the head pointed at the source tip when the branches
diverge, and one rolling PR per branch pair.

More branch-to-branch recipes:

**Pick the branches when triggering manually:**

```yaml
name: Sync branches

on:
  workflow_dispatch:
    inputs:
      source-branch:
        description: "Branch that carries the changes"
        default: develop
      target-branch:
        description: "Branch that receives them"
        default: main

permissions:
  contents: write
  pull-requests: write

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: ruivieira/basic-ops-tasks@v1
        with:
          source-branch: ${{ inputs.source-branch }}
          target-branch: ${{ inputs.target-branch }}
```

**Several branch pairs from one workflow (matrix):** each pair gets its own
head branch and its own rolling pull request, so the jobs can run in
parallel:

```yaml
on:
  workflow_dispatch: {}
  schedule:
    - cron: "0 7 * * 1"   # Mondays 07:30 UTC

permissions:
  contents: write
  pull-requests: write

jobs:
  sync:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
          - { source: develop, target: main }      # integrate develop
          - { source: main, target: release/1.x }  # propagate to the release branch
    steps:
      - uses: ruivieira/basic-ops-tasks@v1
        with:
          source-branch: ${{ matrix.source }}
          target-branch: ${{ matrix.target }}
```

**Reacting to the result** works exactly like the auto-merge example in fork
mode (example 6 below): the outputs (`status`, `pull-request-number`,
`commit-count`, …) are identical in both modes, so the auto-merge and
conflict-warning steps apply unchanged.

### 4. Fully pinned repositories, branches and pull-request metadata

Works even when the repo running the workflow is *not* a GitHub fork (any repo
can pull from any other repo it can read):

```yaml
      - uses: ruivieira/basic-ops-tasks@v1
        with:
          upstream-repo: octocat/Hello-World
          upstream-branch: develop
          target-branch: develop
          head-branch: sync/develop-from-hello-world
          pr-title: "chore: pull latest develop from Hello-World"
          labels: automated, dependencies
          assignees: rui
```

### 5. Private upstream repository

The default `github.token` can only read the upstream repo if it is public (or
in the same org with matching permissions). For a private upstream, pass a PAT
that can read it:

```yaml
      - uses: ruivieira/basic-ops-tasks@v1
        with:
          upstream-token: ${{ secrets.UPSTREAM_READ_PAT }}
```

The main `token` (used for pushing the branch and opening the PR in the fork)
still defaults to `github.token`.

### 6. React to the result: auto-merge clean syncs, warn on conflicts

```yaml
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - id: sync
        uses: ruivieira/basic-ops-tasks@v1

      - name: Auto-merge clean sync pull requests
        if: steps.sync.outputs.status == 'synced' && steps.sync.outputs.pull-request-url != ''
        env:
          GH_TOKEN: ${{ github.token }}
          PR: ${{ steps.sync.outputs.pull-request-number }}
        run: gh pr merge --auto --merge --repo "$GITHUB_REPOSITORY" "$PR"

      - name: Warn on conflicts
        if: steps.sync.outputs.status == 'conflicts'
        run: |
          echo "::warning::Upstream diverged; resolve conflicts in ${{ steps.sync.outputs.pull-request-url }}"

      - name: Nothing to do
        if: steps.sync.outputs.status == 'up-to-date'
        run: echo "Fork is already up to date."
```

### 7. CI for the action itself (typecheck, build, offline tests)

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - run: npm run typecheck
      - run: npm test          # rebuilds dist/ and runs the offline scenario tests
      - run: git diff --exit-code -- dist   # fail if dist/ was not committed
```

### 8. Trying it out safely: dry-run

Runs the whole sync logic (fetch, merge, conflict detection) but pushes nothing
and opens no pull request; good for a first run or a smoke test:

```yaml
      - uses: ruivieira/basic-ops-tasks@v1
        with:
          dry-run: true
```

Related: `skip-pr: true` pushes the sync branch but lets you open the pull
request yourself.

## Inputs

GitHub Actions `with:` inputs are flat key/value strings; the platform has no
nested `with.sync-branches.{…}` grouping. The two modes are separated by which
inputs you set instead, and the action rejects runs that combine them
(`source-branch` together with `upstream-repo`/`upstream-branch` fails).

**Shared by both modes:**

| Input | Required | Default | Description |
|---|---|---|---|
| `token` | no | `${{ github.token }}` | Token for repo info, pushing the branch and opening the PR. Needs `contents:write`, `pull-requests:write`. |
| `target-branch` | no | fork default branch | Branch to update (the pull request base). |
| `head-branch` | no | `sync/upstream-<upstream-branch>` | Branch carrying the changes (the pull request head). Defaults to `sync/<source-branch>-into-<target-branch>` in branch-to-branch mode. |
| `merge-strategy` | no | `merge` | `merge`: merge the source into the target branch (fast-forward when possible). `tip`: head points at the source tip; divergence shows as conflicts in the PR. |
| `fail-on-conflict` | no | `false` | Fail instead of opening a conflicted pull request. |
| `pr-title` | no | `Sync <source>:<branch> into <target>` | Pull request title. |
| `pr-body` | no | generated summary | Pull request body (commit list + conflict banner). |
| `labels` | no | (none) | Comma-separated labels for the PR. |
| `assignees` | no | (none) | Comma-separated usernames to assign. |
| `dry-run` | no | `false` | Compute everything, push nothing, open no PR. |
| `skip-pr` | no | `false` | Push the sync branch but open no PR. |

**Fork mode** (the default; sync from an upstream repository):

| Input | Required | Default | Description |
|---|---|---|---|
| `upstream-repo` | no | fork's parent | Upstream repository as `owner/name`. |
| `upstream-branch` | no | upstream default branch | Branch on the upstream repo to pull from. |
| `upstream-token` | no | `token` | Separate token to fetch from a private upstream. |

**Branch-to-branch mode** (sync within the current repository; activates when
`source-branch` is set):

| Input | Required | Default | Description |
|---|---|---|---|
| `source-branch` | no | (none) | Branch of the current repository to sync into `target-branch`. Cannot be combined with `upstream-repo`/`upstream-branch`; must differ from `target-branch`. |

## Outputs

| Output | Description |
|---|---|
| `status` | `up-to-date`, `synced` or `conflicts`. |
| `pull-request-number` | Number of the opened/updated PR (empty when none). |
| `pull-request-url` | URL of the opened/updated PR (empty when none). |
| `head-sha` | SHA of the produced head branch. |
| `target-sha` / `upstream-sha` | SHAs of the target and upstream branches (in branch-to-branch mode, `upstream-sha` is the source branch tip). |
| `commit-count` | Commits the PR brings in. |
| `pushed` | `true` when the head branch was pushed. |

## Notes and caveats

- **Workflow permissions**: the workflow needs `contents: write` (push the sync
  branch) and `pull-requests: write` (open the PR). The examples include them.
- **Repo setting: let Actions create PRs**: the workflow-level
  `pull-requests: write` is not enough on its own. The repository (or org) must
  also have *Settings → Actions → General → Workflow permissions → Allow
  GitHub Actions to create and approve pull requests* enabled. On fresh repos
  this defaults to **off**, and the run fails with `GitHub Actions is not
  permitted to create or approve pull requests` right after pushing the branch
  (found in live testing). Fix it once per repo, or at org level:
  `gh api -X PUT repos/OWNER/REPO/actions/permissions/workflow -f default_workflow_permissions=write -F can_approve_pull_request_reviews=true`
- **PRs created with `github.token` do not trigger other workflows**: GitHub
  blocks workflow-triggered-by-workflow recursion. If the sync PR must run your
  CI (e.g. before auto-merge), pass a PAT as `token`.
- **The head branch is force-pushed** on every run. Don't commit to
  `sync/upstream-*` manually; use `head-branch` if you need your own name.
- **One rolling PR per branch pair**: re-runs update the same open pull request
  (branch is force-pushed, body refreshed) instead of piling up new PRs.
- **Upstream default branch changes** are picked up automatically when you don't
  pin `upstream-branch`.
- Works on GitHub Enterprise Server too: the action honors
  `GITHUB_SERVER_URL`/`GITHUB_API_URL`.

## Publishing this action

The action lives at the root of this repository, so consumers reference it
without a subdirectory path:

```yaml
- uses: ruivieira/basic-ops-tasks@v1
```

`v1` is the moving major tag: it always points at the latest stable release of
the 1.x line. Full version tags (`v1.0.0`, `v1.1.0`, …) and commit SHAs are
immutable pins. A release is cut by tagging `main`:

```bash
git tag v1.1.0
git tag -f v1 && git push origin v1.1.0 v1
```

History: before `v1.1.0` the action lived under `fork-sync-action/`, and older
refs still resolve through the subdirectory path
(`ruivieira/basic-ops-tasks/fork-sync-action@v1.0.0`). Prefer the root
reference in new workflows.

`dist/index.js` is the artifact the runner executes; always rebuild
(`npm run build`) and commit it together with `src/` changes.

## Testing

Four levels, from fastest to most real. Levels 1–2 run entirely on your
machine; levels 3–4 touch real GitHub.

### 1. Offline scenario tests (seconds, no network)

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run build         # ncc bundle -> dist/index.js
npm test              # rebuild + offline end-to-end scenarios
```

`test/local-sync.test.mjs` builds two bare git repositories behind `file://`
remotes (an upstream and a diverged fork), runs the compiled action exactly the
way the runner would (inputs via `INPUT_*` env vars, outputs parsed back from
`GITHUB_OUTPUT`), and covers: merge sync, up-to-date, conflict fallback to
upstream tip, `fail-on-conflict`, the `tip` strategy, dry-run, custom head
branches, and branch-to-branch sync (fast-forward, up-to-date, conflict
fallback, and input validation). It needs no network and no GitHub API calls.

### 2. Static validation with actionlint

[actionlint](https://github.com/rhysd/actionlint) lints workflow files and,
through the local `uses: ./` reference, cross-checks every `with:` input and
`steps.*.outputs.*` reference against `action.yml`, catching typos in input
names, invalid expression contexts, and bad YAML before GitHub ever sees them:

```bash
curl -fsSL "$(curl -fsSL https://api.github.com/repos/rhysd/actionlint/releases/latest \
  | grep -oE 'https://[^\"]+_linux_amd64\.tar\.gz' | head -1)" | tar xz -C ~/.local/bin actionlint
actionlint    # run from the repository root (.github/workflows is picked up automatically)
```

### 3. Live smoke test, zero side effects (dry-run)

`.github/workflows/fork-sync-smoke.yml` runs this action from a real GitHub
runner against a real public upstream in `dry-run: true` mode: it does the
actual fetch and merge and reports `status`/outputs, but pushes nothing and
opens no pull request. Trigger it manually from the Actions tab ("Run
workflow", optionally choosing which public repo to pull from), or let it run
automatically on pushes/PRs that touch the action.

If the action ever moves to its own repository, move the workflow along with it
and update the reference.

### 4. Full end-to-end with throwaway repos

The only level that exercises the push and the pull request for real:

1. Create a sandbox upstream repo A and fork it to get B (or use any existing
   repo as B and point `upstream-repo` at any repo it can read). Enable
   Actions in B: GitHub disables workflows in forks until you do.
2. Add the sync workflow to B. While iterating, reference the action by
   branch, not by tag:
   `uses: ruivieira/basic-ops-tasks@your-branch`.
3. Push commits to A, run the workflow from B's Actions tab, and verify the
   pull request appears in B with the right commits.
4. Deliberately test the conflict path: commit the same line in A and B,
   re-run, then resolve the conflicted PR in B.
5. Delete the sandbox repos when done.

Gotchas that only show up at this level:

- PRs opened with `github.token` do not trigger other workflows in B; pass a
  PAT as `token` if the sync PR must run CI.
- Only tag `v1` after this level passes. Iterate on a branch ref and move the
  tag afterwards (`git tag -f v1 && git push -f origin v1`).

[act](https://github.com/nektos/act) (Docker/Podman) can also run workflows
locally, which is handy for workflow-syntax issues, but the parts that matter
here (hub API calls, pull request creation) still talk to real GitHub, so
level 4 with sandbox repos remains the honest test.
