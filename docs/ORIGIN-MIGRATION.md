# Origin migration

The source is `https://dvilchez.github.io/`. The destination is the `Xuaps/independent-circuit-editor` deployment at `https://circuits.xuaps.com/`.

Browsers isolate data by origin. Local recovery stored in `localStorage`, the service-worker cache and its offline readiness, granted file handles, and other origin-scoped browser state do not transfer from the source to the destination.

## Safe project handoff

For a project in this application's own format:

1. At the old origin, use **Save**, or **Download copy** where shown, to produce a `.circuit.json` file.
2. Independently verify that the saved or downloaded file is present and readable.
3. Make and retain a backup of that file.
4. At the new origin, use **Open** to load the verified file.
5. Wait for the new origin to report **Offline ready** before relying on offline reload there.

This migration guide does not announce an automatic redirect or retirement of the old origin. The personal site remains an independent legacy deployment during migration.
