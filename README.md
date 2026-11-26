# Independent Circuit Editor

An independently developed, browser-based editor and deterministic simulator for a small educational 24 V DC circuit model. It includes a Node.js CLI that uses the same project contracts and simulation core.

This project is not CADe_SIMU, is not a compatible replacement, and does not import `.CAD` files. It is an educational tool, not a substitute for qualified electrical engineering or safety review.

## Current scope

- One-sheet circuit projects in the project's own JSON format
- DC supply, push buttons, relay coil and contacts, and lamp components
- Explicit relay-contact bindings
- Deterministic Run, Pause, Step, Resume, Stop, and Reset behavior
- Browser save/open/download, best-effort local recovery, SVG export, and print
- Production service worker for same-origin offline reload
- Shared-core CLI validation, editing, inspection, and scenario verification

See [documented limitations](docs/LIMITATIONS.md) before relying on the application.

## Requirements

- Node.js 22
- npm 10 or 11

## Local development

```sh
npm ci
npm run dev
```

Open the loopback URL printed by Vite.

## Production build

```sh
npm ci
npm run typecheck
npm run build
npm run manifest
npm run preview
```

The deployable static site is `dist/ui/`. The CLI bundle is `dist/cli/index.js`. The build regenerates `public/THIRD_PARTY_NOTICES.txt` from the locked production npm dependency graph and includes it in the static site; this attribution file is not legal certification.

## Validation

```sh
npm run typecheck
npm run check:boundaries
npm run test:unit
npm run test:contracts
npm run build
npm run test:integration:built
npm run test:browser
npm run manifest
```

The browser gate uses Chromium and includes the production offline path. Passing automated checks does not establish electrical, accessibility, browser, deployment, or safety certification.

## CLI

After building:

```sh
node dist/cli/index.js verify examples/p0/selfhold.circuit.json \
  --scenario examples/p0/start-stop.scenario.json
```

See [CLI usage](docs/CLI.md).

## Delivery

GitHub Actions validates pull requests without publication permissions. A green push to `main` builds once, validates the exact build, records its SHA-256 manifest, and may deploy only `dist/ui/` to the repository's root GitHub Pages site. Manual workflow dispatch can select a previous known-good Git revision for a fully revalidated rollback.

Pages activation, the first push, and the first deployment remain owner-controlled operations.

See [operations and rollback](docs/OPERATIONS.md).

## License

First-party content in this public snapshot is licensed under the [MIT License](LICENSE).
