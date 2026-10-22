# basic-ops-tasks

A Node 24 GitHub Action with two tasks. In the sync modes (`fork`, `branch`) it
imports commits from a trusted upstream repository, or between branches of the
same repository, into a dedicated sync branch and opens a reviewable pull request.
In `python-index` mode it verifies that every library and version named in a
requirements.txt-like file exists on a Python package index, failing the job when
one does not. Built with GitHub's Actions toolkit and Rollup; `dist/index.js` is
the runtime executed by consumers.

**In sync modes the target branch is not directly updated. The sync branch is
published before PR review. Imported code is not automatically safe to execute.**

## Quick start

Install this workflow in the destination repository (your fork). Enable its
workflows intentionally under your organization's action allowlist; enabling a
fork does not require allowing every third-party action.

Replace `<REVIEWED_FULL_COMMIT_SHA>` with a reviewed 40-character commit SHA.
The placeholder is intentionally not a runnable pin. `@v1` is a convenient
moving release reference, not an immutable security pin.

```yaml
name: Sync trusted upstream
on:
  schedule:
    - cron: '30 6 * * *'
  workflow_dispatch:
permissions: {}
jobs:
  sync:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: write
      pull-requests: write
    concurrency:
      group: sync-trusted-upstream-main-into-main
      cancel-in-progress: false
    steps:
      - uses: ruivieira/basic-ops-tasks@<REVIEWED_FULL_COMMIT_SHA>
        with:
          upstream-repo: TRUSTED_OWNER/TRUSTED_REPO
          upstream-branch: main
          target-branch: main
          fail-on-conflict: true
```

No `actions/checkout` step is needed. In fork mode, repository/branch inputs may
be omitted to discover the parent repository and default branches. Pinning them
makes the intended source explicit. Use one concurrency group per destination
head, including across workflows that might share that head.

For `GITHUB_TOKEN` PR creation, enable **Settings → Actions → General → Workflow
permissions → Allow GitHub Actions to create and approve pull requests**, if
allowed by organization policy. **Keep default workflow permissions read-only**;
only the sync job needs write access. This action does not approve PRs. If PR
creation is denied, the push may already have succeeded; fix the setting and
explicitly adopt the dedicated head on a recovery run if necessary.

## Security and permissions

| Operation | Destination `GITHUB_TOKEN` permissions |
|---|---|
| `dry-run: true` | `contents: read` |
| `skip-pr: true` | `contents: write` |
| Push and create/update PR | `contents: write`, `pull-requests: write` |

Labels/assignees on PRs use PR write access. The action does not need `id-token`,
`actions`, `checks`, `packages`, or `security-events` write. Workflow permissions
apply to `GITHUB_TOKEN`, **not** to a PAT/App token passed as an input. Scope those
credentials at issuance to the required repositories and operations.

### Forks and triggering events

- **Schedule/manual run in your fork:** supported; the destination token writes
  your fork, not its parent. Run a trusted workflow ref with trusted inputs.
- **Contributor fork `pull_request`:** normally read-only base token and no
  repository secrets. Public-source dry-runs can work; publishing normally fails.
  Private-repository policies can differ. Never enable write tokens or expose
  secrets just to make a fork PR test pass.
- **Same-repository PR:** not protected by the fork secret boundary. Do not run
  privileged sync operations using contributor-controlled code or inputs.
- **`pull_request_target`, privileged `workflow_run`, comment-triggered jobs:**
  do not checkout/run untrusted PR code or use its payload/artifacts to select a
  writable sync source/head. Authorize and allowlist inputs explicitly. The action
  itself does not authenticate event actors or enforce an event allowlist.
- **Manual dispatch:** a selectable ref can change workflow code; manual initiation
  alone is not a sandbox. Restrict secret access and trusted workflow refs.
- **Self-hosted runners:** do not use persistent privileged runners for untrusted
  fork code. Prefer ephemeral GitHub-hosted runners.

### PAT/App tokens and imported-code execution

`GITHUB_TOKEN`-generated pushes/PRs generally do not trigger follow-on workflows.
Do not assume the generated PR has run CI, and do not auto-merge based only on
`status: synced`.

If CI must trigger, a short-lived, single-repository GitHub App token is preferable
to a long-lived PAT. **This changes the trust boundary:** imported code is pushed
to a branch in the destination repository. Push and same-repository PR workflows
may execute it with secrets or elevated permissions **before review**. Existing
scripts can be malicious without modifying workflow YAML. Protecting `main`
alone does not protect workflows executing the sync branch.

Keep imported-code CI read-only, secret-free, and off privileged self-hosted
runners. Use protected environments for deployment, require actual checks and
review, and never auto-approve merely because the PR was created by this action.
Importing workflow files may require additional token capabilities and may be
rejected; do not grant workflow-write scope by default or broaden tokens to
silence a permissions error.

### Private upstreams and confidentiality

A repository's `GITHUB_TOKEN` is not organization-wide private repository access.
For a different private upstream, supply a separate token with **read-only contents
access to that upstream**:

```yaml
with:
  upstream-repo: trusted-org/private-source
  upstream-token: ${{ secrets.UPSTREAM_READ_TOKEN }}
```

This token is used for upstream metadata and Git fetch. The destination token
still defaults to `github.token`. **Importing private source into a public or
less-restricted destination publishes its reachable history and commit metadata.**
Visibility is not automatically checked; verify authorization before syncing.
Never use untrusted event data to select a private source for publication.

### Credential and Git isolation

Remote URLs/configs contain no tokens. HTTPS authentication is supplied only in
per-command environment configuration, scoped to the remote URL; both tokens and
encoded forms are masked in runner logs. Git helpers, hooks, templates, inherited
`GIT_*` overrides and global/system configuration are disabled. Remotes use HTTPS;
`file://` is retained for offline tests. HTTP remotes and credential-bearing URLs
are rejected. Each Git subprocess has a two-minute timeout.

Temporary workspaces are removed on success and ordinary errors, including
conflicts and dry-runs. Abrupt termination can prevent cleanup; runner disposal
remains important. A job is not a security boundary between steps: do not place
untrusted steps beside credentialed work. Fetch/checkout is full-history and can
consume substantial disk; apply job timeouts and use trusted sources.

## Sync behavior and safe migration

1. Resolve the source and target; validate branch refs.
2. Fetch into an isolated temporary Git repository.
3. If the target already contains the source, return `up-to-date` without pushing.
4. Compute the merge. `merge` uses the merge result; `tip` checks mergeability but
   publishes the source tip. Both report conflicts. Operational failures (including
   unrelated histories) fail closed instead of being treated as conflicts.
5. If `fail-on-conflict: true`, fail **before any push or PR mutation**. Otherwise
   a conflict publishes the source tip for manual resolution.
6. Push only the dedicated head with an explicit force-with-lease snapshot, then
   create/update its PR and write outputs/summary.

### Head names and adoption

Default heads are `sync/<sha256>`, derived from mode, destination repository,
upstream repository, source branch, and target branch. Different sync identities
have different heads. Custom heads must be valid refs in the **`sync/` namespace**
and differ from the source/target branches where applicable.

An existing head is updated automatically only when its open PR matches the
head/base and contains this action's exact sync-identity marker. The marker is an
operational ownership check, not cryptographic authorization; repository writers
can edit it. Do not remove it from rolling PR bodies.

For deliberate migration, a failed PR-creation recovery, or repeated `skip-pr`
runs, opt in with `allow-head-update: true` **only after verifying that the branch
is dedicated to this sync**. This permits replacing its history; it does not
bypass the lease, namespace restrictions, or branch protection.

Earlier releases used `sync/upstream-<branch>` or
`sync/<source>-into-<target>`. Existing PRs on those heads are not silently adopted.
Either let the new default create a new dedicated head and retire the old PR
manually, or explicitly select and adopt the old `sync/` head once. A closed or
merged PR no longer verifies its retained head; delete the old branch manually
or explicitly adopt it for a new PR. Custom heads outside `sync/` must be renamed.

A failed lease means someone changed the remote after the snapshot. Investigate
and rerun; do not replace it with an unconditional force push. Do not share a
custom head between different sync identities, even with concurrency enabled.

## Other examples

Branch-to-branch sync (same job permissions as above):

```yaml
- uses: ruivieira/basic-ops-tasks@<REVIEWED_FULL_COMMIT_SHA>
  with:
    mode: branch
    source-branch: develop
    target-branch: main
    fail-on-conflict: true
```

Read-only preview (reduce job permissions to `contents: read`):

```yaml
- uses: ruivieira/basic-ops-tasks@<REVIEWED_FULL_COMMIT_SHA>
  with:
    upstream-repo: trusted-org/source
    upstream-branch: main
    target-branch: main
    dry-run: true
```

Push without PR (job needs only `contents: write`):

```yaml
- uses: ruivieira/basic-ops-tasks@<REVIEWED_FULL_COMMIT_SHA>
  with:
    source-branch: develop
    target-branch: main
    head-branch: sync/develop-into-main
    skip-pr: true
    allow-head-update: true # deliberate repeated updates of this dedicated branch
```

## Python index check

`mode: python-index` reads a requirements.txt-like file, resolves every project
name and version specifier against a PEP 503 simple index, and fails the step
(and therefore the CI job) when a library or version is missing. It needs no
`token` and no repository write permissions:

```yaml
name: Verify requirements
on:
  pull_request:
    paths: ["requirements*.txt", "constraints*.txt"]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  requirements:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@<REVIEWED_FULL_COMMIT_SHA>
        with:
          persist-credentials: false
      - uses: ruivieira/basic-ops-tasks@<REVIEWED_FULL_COMMIT_SHA>
        with:
          mode: python-index
          requirements-file: requirements.txt
          index-url: https://pypi.org/simple
          python-version: '3.12.7' # enables PEP 508 environment-marker evaluation
```

Useful for a mirror with no authentication:

```yaml
- uses: ruivieira/basic-ops-tasks@<REVIEWED_FULL_COMMIT_SHA>
  with:
    mode: python-index
    requirements-file: requirements-dev.txt
    index-url: https://packages.example.com/simple
    timeout-seconds: '60'
```

Indexes must be anonymous. The action never sends an `Authorization` header,
and index or artifact URLs containing `user:password@` are rejected, so a
private index that requires credentials is not supported. `--index-url` and
`--extra-index-url` lines inside the requirements file are ignored with a
warning: `index-url` (plus `extra-index-urls`) is the only source of index
URLs, so a pull request cannot redirect the check at another host.

### What is verified

- Project names (PEP 503-normalized) must exist on the index.
- PEP 440 specifiers (`==`, `!=`, `<=`, `>=`, `<`, `>`, `~=`, `===`, `==1.4.*`)
  must match at least one installable version. Pre-releases are accepted when no
  stable version matches, matching pip; `allow-prerelease: true` or a `--pre`
  line in the file relaxes this further.
- PEP 592 yanked versions are treated as unavailable unless the requirement is an
  exact `==` pin, which pip also allows.
- Extras (`requests[socks]`), line continuations, `--hash` options, `-r`/`-c`
  includes and `--pre` lines are parsed. `--index-url` and `--extra-index-url`
  lines are ignored (with a warning); the index comes from the action inputs.
- PEP 508 environment markers (`; sys_platform == 'emscripten'`,
  `; python_full_version == '3.13.*'`) are evaluated when `python-version` is
  set; requirements whose marker is false are skipped. A skipped marker-gated
  requirement never fails the job. Without `python-version`, markers are not
  evaluated and the action warns that every requirement is checked
  unconditionally.
- Direct artifact requirements (`pkg @ https://…`), `file://` URLs and VCS
  references (`git+…`, `hg+…`, `svn+…`, `bzr+…`) fail: the action never fetches
  them, and a hermetic Konflux build cannot prefetch those protocols from an
  index either.
- Local paths and `-e` editables are reported as skipped (they trigger no
  request); `--find-links` is ignored with a warning.
- The configured index is the only network destination. Nothing in the
  requirements file can make the action contact another host: URL requirements
  fail before any request is made.
- The requirements file and every `-r`/`-c` include must resolve, after
  following symlinks, inside `GITHUB_WORKSPACE`. Paths elsewhere (including
  `/etc/passwd`, `/proc/self/environ` or a committed symlink pointing out of the
  checkout) are rejected before the file is read, so a pull request cannot turn
  the check into a reader of runner-local files. There is no opt-out.

The index is queried with PEP 691 JSON (`application/vnd.pypi.simple.v1+json`)
and falls back to parsing the HTML simple index for older mirrors. Each project
page is fetched once per run. Index URLs come only from the action inputs, and
no `Authorization` header is ever sent. A failing index (HTTP error, timeout,
oversized response) fails the check rather than silently passing.
`requires-python` is not evaluated: the check answers "does this distribution
version exist for the target marker environment", not "would pip install it on
this platform".

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `mode` | `auto` | `fork`, `branch`, `python-index`, or `auto` (`branch` when source-branch is set; otherwise `fork`). Explicit modes validate compatible inputs. |
| `token` | `${{ github.token }}` | Destination metadata, push and PR token. |
| `upstream-repo` | fork parent | `owner/name`; fork mode only. |
| `upstream-branch` | upstream default | Source ref; fork mode only. |
| `upstream-token` | token | Read-only upstream Git/metadata token. |
| `source-branch` | empty | Same-repository source; required in explicit branch mode. Cannot combine with upstream-repo/branch. |
| `target-branch` | destination default | PR base; not directly updated. |
| `head-branch` | `sync/<identity-sha256>` | Dedicated PR head; must be in `sync/`. |
| `allow-head-update` | `false` | Explicit adoption/update without matching open PR identity. |
| `merge-strategy` | `merge` | `merge` or `tip`; both check mergeability. |
| `fail-on-conflict` | `false` | Reject conflicts before publishing anything. |
| `pr-title` | generated | Conventional-commit-style title for new PRs. |
| `pr-body` | generated | Custom Markdown; the identity marker is appended in all cases. |
| `labels` | empty | Comma-separated labels; failures are warnings. |
| `assignees` | empty | Comma-separated usernames; failures are warnings. |
| `dry-run` | `false` | Compute without push or PR changes. |
| `skip-pr` | `false` | Publish head without PR creation/update. |
| `requirements-file` | `requirements.txt` | `python-index`: file to verify, relative to `GITHUB_WORKSPACE`. |
| `index-url` | `https://pypi.org/simple` | `python-index`: PEP 503 simple index base URL; the only index source, anonymous only. |
| `extra-index-urls` | empty | `python-index`: comma-separated additional index URLs (action inputs are the only source). |
| `allow-prerelease` | `false` | `python-index`: accept pre-releases; the file's `--pre` does this too. |
| `timeout-seconds` | `30` | `python-index`: per-request HTTP timeout. |
| `python-version` | empty | `python-index`: target Python version for marker evaluation (e.g. `3.12.7`); empty disables evaluation. |
| `platform` | `linux` | `python-index`: target `sys_platform` for marker evaluation: `linux`, `darwin`, `win32`. |
| `platform-machine` | runner arch | `python-index`: target `platform_machine` for marker evaluation. |

## Outputs

| Output | Meaning |
|---|---|
| `status` | `up-to-date`, `synced`, or `conflicts`; not a security attestation. |
| `pull-request-number`, `pull-request-url` | Created/updated PR, empty when none. |
| `head-sha` | Produced head SHA. |
| `target-sha`, `upstream-sha` | Fetched target/source SHAs. |
| `commit-count` | Commits the head brings to the target. |
| `pushed` | Whether a push succeeded. |
| `checked-count` | `python-index`: requirements inspected. |
| `failed-count` | `python-index`: requirements missing or failing to resolve. |
| `skipped-count` | `python-index`: requirements skipped (local paths, editables, unsatisfied markers). |

Consume outputs through step `env:` mappings when using shell commands, not
expression interpolation into shell source. PR/API failure after a successful
push is not transactional rollback: the branch remains, and no destructive
cleanup is attempted. A custom PR body is trusted maintainer-authored Markdown;
generated branch/commit text is escaped.

## Development and release

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
# npm test rebuilds dist, runs offline scenarios and local mocked-API security tests
git diff --exit-code -- dist
```

Use Node 24, matching `action.yml`. Commit rebuilt `dist/index.js` and its map with
source changes. Offline tests use temporary local repositories and fake tokens;
API tests bind loopback only. They do not prove live GitHub policy behavior.

CI runs on every PR and main push with read-only permissions and SHA-pinned
actions. It checks type safety, tests, and bundle/source integrity. **Maintainers
must make `Node 24 / tests and bundle integrity` a required check in the repository
ruleset.** This cannot be enabled by committing workflow YAML. Keep review,
code-scanning and release-tag protection enabled; protect publisher accounts and
credentials. No privileged publish job should execute untrusted PR code.

Before publishing, use throwaway repositories to test default tokens, fine-grained
PATs/App tokens, private upstreams, denied PR creation, fork PRs, protected refs,
workflow-file changes, and concurrent updates. These tests require explicit
permission to mutate those repositories. GitHub Enterprise uses
`GITHUB_SERVER_URL`/`GITHUB_API_URL`; test against the target server's policies.

Cut releases only from a reviewed, CI-validated commit. Full version tags are not
inherently immutable: configure immutable releases/protected version tags where
supported. A moving major tag such as `v1` is intentionally mutable and must be
updated through the protected publisher process. Prefer full commit-SHA pins for
consumers; never bypass protections merely to move a tag.

See [SECURITY.md](SECURITY.md) for responsible disclosure. Dependency updates are
proposed by Dependabot; review and rebuild the bundled runtime for each update.
