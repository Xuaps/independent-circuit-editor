# CLI usage

Build the project before running the CLI:

```sh
npm run build
```

The direct executable is `dist/cli/index.js`. Use `--help` for the current command list:

```sh
node dist/cli/index.js --help
```

Example verification:

```sh
node dist/cli/index.js verify examples/p0/selfhold.circuit.json \
  --scenario examples/p0/start-stop.scenario.json
```

The CLI reads and writes the project's own JSON format. It does not support proprietary `.CAD` files. Machine-readable commands emit JSON responses and use process exit codes to distinguish success, validation failures, and operational errors.

The CLI and browser use the same contracts and deterministic simulation core, but a successful CLI result is not an electrical-safety certification.
