# Delivery operations

## Pipeline

The delivery workflow has three permission boundaries:

1. **Verify:** pull requests and `main` run with read-only repository access. The job installs from `package-lock.json`, runs static checks and tests, builds once, validates the built CLI and browser application, generates `dist/ui/build-manifest.json`, and records the final manifest's SHA-256 immediately before packaging.
2. **Deploy:** every green push to `main`, or an explicitly dispatched deployment, receives GitHub Pages OIDC and Pages write permissions. It uploads only `dist/ui/`; ordinary `main` delivery has no manual approval step in this workflow.
3. **Hosted smoke:** a separate read-only job opens the deployed URL in Chromium, checks the application shell, sample file, service worker, notices, and browser console, authenticates the raw `build-manifest.json` bytes against the digest recorded by the verify job before parsing them, confirms that the manifest names the exact verified revision, and downloads every listed file to verify its exact byte count and SHA-256 digest.

All Pages-capable workflow runs share one concurrency group from verification through hosted smoke, so a `main` delivery and a dispatched rollback cannot deploy or smoke-test concurrently. Pull-request validation uses separate per-ref concurrency and cannot publish or block a release.

## Rollback

Use **Actions → CI and Pages delivery → Run workflow** on the default branch:

1. Enter a previously successful exact 40-hex Git commit SHA in `target_ref`.
2. Enable `deploy`.
3. Run the workflow.

The dispatch rejects symbolic, abbreviated, or non-hex revisions. It checks out full history, refreshes the trusted `origin/main` reference, and fails unless the selected commit is an ancestor of that branch. The selected revision is then installed, checked, tested, and rebuilt before deployment. The workflow does not reuse an unverified working directory or a mutable local artifact. Confirm the hosted smoke job succeeds and compare `build-manifest.json` with the intended release record.

A rollback is still a deployment and requires the owner's applicable release authority.

## Cost and platform boundary

The intended target is the free GitHub Pages deployment for the organization repository `Xuaps/independent-circuit-editor` at the custom root origin `https://circuits.xuaps.com/`. During migration, `https://dvilchez.github.io/` remains an independent legacy deployment; the new deployment does not automatically redirect or retire it. The workflow does not subscribe to external hosting, paid Actions runners, or paid services. Repository administrators must keep billing and spending limits disabled unless the owner explicitly changes that policy.
