# Delivery operations

## Pipeline

The delivery workflow has three permission boundaries:

1. **Verify:** pull requests, merge groups, and `main` run with read-only repository access. The job installs from `package-lock.json`, runs static checks and tests, builds once, validates the built CLI and browser application, generates `dist/ui/build-manifest.json`, and records the final manifest's SHA-256 immediately before packaging.
2. **Deploy:** every green push to `main`, or an explicitly dispatched deployment, receives GitHub Pages OIDC and Pages write permissions. It uploads only `dist/ui/`; ordinary `main` delivery has no manual approval step in this workflow.
3. **Hosted smoke:** a separate read-only job opens the deployed URL in Chromium, checks the application shell, sample file, service worker, notices, and browser console, authenticates the raw `build-manifest.json` bytes against the digest recorded by the verify job before parsing them, confirms that the manifest names the exact verified revision, and downloads every listed file to verify its exact byte count and SHA-256 digest.

All Pages-capable runs share one concurrency group from verification through hosted smoke: two `main` deliveries, or a delivery and an authorized rollback, cannot deploy or smoke-test concurrently. Actions holds up to 100 pending runs per group instead of replacing the previous pending run. Inspect the run result for any cancellation; queue order is by arrival at the concurrency group, not a guarantee of push order. Pull-request and merge-group checks use separate concurrency groups and cannot publish.

## Integrate through the merge queue

1. Prepare your scoped change on its own branch and worktree. Complete the applicable local checks and independent review for the exact diff.
2. Open a pull request to `main`. The required check is **Verify exact source and build** from GitHub Actions. After it passes, add the reviewed PR to the merge queue rather than pushing directly to `main`.
3. GitHub reruns that Verify check on the queued combination. A failed check prevents the merge. Verify the queued result in Actions; Deploy and hosted smoke are post-merge jobs, not required PR checks.
4. The resulting push to `main` automatically verifies and deploys the published revision, runs hosted smoke, and records release evidence in Actions. There is no separate deployment promotion or sign-off.

## Rollback

After a successful automatic `main` delivery and hosted smoke, a separate, time-limited Actions job attempts to retain a small `release-identity-<run>-<attempt>` JSON receipt without changing the hosted-smoke result. A successfully uploaded receipt is configured for seven-day retention; after upload, the evidence job attempts to report its raw SHA-256 in the run summary. The receipt binds the verified source and raw build-manifest digests to that successful run and attempt; it does not contain the deployed files or authorize a rollback. A missing, expired, or mismatched receipt is not evidence of known-good bytes.

Use **Actions → CI and Pages delivery → Run workflow** on the default branch:

1. Enter a previously successful exact 40-hex Git commit SHA in `target_ref`.
2. Enable `deploy`.
3. Run the workflow.

The dispatch rejects symbolic, abbreviated, or non-hex revisions. It checks out full history, refreshes the trusted `origin/main` reference, and fails unless the selected commit is an ancestor of that branch. The selected revision is then installed, checked, tested, and rebuilt before deployment. The workflow does not reuse an unverified working directory or a mutable local artifact. Confirm the hosted smoke job succeeds and compare `build-manifest.json` with the intended release record.

A rollback is still a deployment and requires the owner's applicable release authority.

## Cost and platform boundary

The intended target is the free GitHub Pages deployment for the organization repository `Xuaps/independent-circuit-editor` at the custom root origin `https://circuits.xuaps.com/`. During migration, `https://dvilchez.github.io/` remains an independent legacy deployment; the new deployment does not automatically redirect or retire it. The workflow does not subscribe to external hosting, paid Actions runners, or paid services. Repository administrators must keep billing and spending limits disabled unless the owner explicitly changes that policy.

## Delivery readiness event

**Delivery readiness signal** listens for completion of the existing delivery workflow; it does not poll. It reports `READY` only when the exact completed automatic `main` attempt has successful Verify, Deploy, and hosted smoke and its SHA is still the protected `main` tip. `HOLD`, `STALE`, no summary, or no event is not a green signal. Read the decision and exact SHA in the Actions summary; the listener job's own success only means it reported a decision.

This is a point-in-time coordination signal, not a new required check or an approval to merge or deploy. Topic worktrees can continue independently. The listener does not manipulate the merge queue, fetch deployed assets, notify an external receiver, or wake local agent sessions. Existing source review, Verify, native queue, and automatic Pages delivery remain unchanged.
