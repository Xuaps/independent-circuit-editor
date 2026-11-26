#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { resolve } from 'node:path';
import { limitedMetadata } from '../contracts/metadata';
import { validateShape } from '../contracts/validation';
import { applyOperations } from '../core/commands';
import { compileProject } from '../core/compiler';
import { createProject } from '../core/domain/project';
import { diagnostic, type Diagnostic, type Project, type Result } from '../core/domain/types';
import { decodeOperations, decodeProject, serializeProject } from '../core/persistence';
import { createScenarioRun, type RunReport } from '../core/scenario';
import { verifyReport } from '../core/verification';
import { HostError, publishExclusive, readBounded } from '../hosts/node/files';
import { ArgumentError, identify, parse, type Command } from './arguments';

type Envelope = { apiVersion: 1; command: Command | null; ok: boolean; exitCode: number; diagnostics: readonly Diagnostic[]; result: unknown };
class Failure extends Error {
  constructor(readonly exit: number, readonly diagnostics: readonly Diagnostic[]) { super(diagnostics[0]?.code); }
}
const identity = (p: Project) => ({ projectId: p.projectId, revision: p.revision, modelSet: p.modelSet });
function checked<T>(r: Result<T>, otherwise: number): T {
  if (!r.ok) throw new Failure(r.category === 'resource-limit' ? 7 : otherwise, r.diagnostics);
  return r.value;
}
async function project(file: string): Promise<Project> {
  const r = decodeProject(await readBounded(file));
  return checked(r, !r.ok && r.category === 'invalid-document' ? 4 : 3);
}
const info = (code: string, message = code): Diagnostic => ({ ...diagnostic(code, [], message), severity: 'info' });
function boundedDiagnostics(items: readonly Diagnostic[]): readonly Diagnostic[] {
  if (items.length > 10000) throw new Failure(7, [diagnostic('RESPONSE_LIMIT')]);
  return items.map(d => ({ severity: d.severity, code: d.code,
    message: d.message.length > 2048 ? `${d.message.slice(0, 2000)} [display truncated]` : d.objectIds.length > 100 ? `${d.code}: showing 100 of ${d.objectIds.length} objects` : d.message,
    objectIds: d.objectIds.slice(0, 100), ...(d.atMs === undefined ? {} : { atMs: d.atMs }), ...(d.operationIndex === undefined ? {} : { operationIndex: d.operationIndex }) }));
}
function envelope(command: Command | null, exitCode: number, result: unknown, diagnostics: readonly Diagnostic[] = []): Envelope {
  const out: Envelope = { apiVersion: 1, command, ok: exitCode === 0, exitCode, diagnostics: boundedDiagnostics(diagnostics), result };
  if (!validateShape(command === null ? 'hostError' : 'response', out).valid) throw new Failure(7, [diagnostic('RESPONSE_LIMIT', [], 'Result cannot be represented by the v1 response contract')]);
  return out;
}
function wireRun(r: RunReport) {
  if (r.runOutcome === 'running') throw new Failure(7, [diagnostic('INCOMPLETE')]);
  return { project: r.project, validationOutcome: r.validationOutcome, runOutcome: r.runOutcome, untilMs: r.untilMs, finalTimeMs: r.finalTimeMs, trace: r.trace };
}
function runExit(r: RunReport): number {
  if (r.runOutcome === 'interrupted') return 130;
  if (r.runOutcome === 'resourceLimited' || !r.trace.complete || r.diagnostics.some(d => d.code === 'SETTLING_LIMIT')) return 7;
  if (r.validationOutcome === 'rejected') return 4;
  return r.runOutcome === 'completed' ? 0 : 5;
}
async function execute(command: Command, args: readonly string[]): Promise<Envelope> {
  const { flags: f, positional: p } = parse(command, args);
  if (p[0] === '-' && (f.get('operations') === '-' || f.get('scenario') === '-')) throw new ArgumentError('Only one stdin input is supported');
  const output = f.get('output');
  // Validate response-controlled path length BEFORE publication.
  if (output && resolve(output).length > 4096) throw new ArgumentError('Output path too long');
  if (command === 'library.list') return envelope(command, 0, { profile: limitedMetadata }, [info('PROFILE_STATUS', 'Historical v1 profile.status is proposed-not-implemented; the seven trusted P0 models are implemented. Limited wire metadata is not the full catalog.')]);
  if (command === 'library.describe') {
    const definition = limitedMetadata.definitions.find(d => d.id === p[0]);
    if (!definition) throw new ArgumentError('Unknown definition');
    return envelope(command, 0, { modelSet: limitedMetadata.modelSet, definition });
  }
  if (command === 'new') {
    const value = checked(createProject(f.get('project-id') ?? `p_${randomUUID().replaceAll('-', '')}`, f.get('sheet-id') ?? `s_${randomUUID().replaceAll('-', '')}`, f.get('title') ?? ''), 2);
    const text = checked(serializeProject(value), 2);
    const response = envelope(command, 0, { project: identity(value), outputPath: resolve(output!) });
    const warnings = await publishExclusive(output!, text);
    return envelope(command, 0, response.result, warnings.map(code => ({ ...diagnostic(code), severity: 'warning' })));
  }
  const value = await project(p[0]!);
  if (command === 'inspect') return envelope(command, 0, { project: value });
  if (command === 'validate') {
    const compiled = f.get('scope') === 'run' ? compileProject(value) : undefined;
    const exit = compiled && !compiled.ok ? (compiled.category === 'resource-limit' ? 7 : 4) : 0;
    return envelope(command, exit, { project: identity(value), scope: f.get('scope'), valid: exit === 0 }, compiled?.diagnostics);
  }
  if (command === 'edit.apply') {
    const batch = checked(decodeOperations(await readBounded(f.get('operations')!)), 2);
    const applied = checked(applyOperations(value, batch), 4);
    const dryRun = f.has('dry-run');
    const diagnostics = applied.changes.filter(c => !c.changed).map(c => ({ ...info('NO_OP', 'Operation leaves target content unchanged'), operationIndex: c.operationIndex }));
    const result = { project: identity(applied.project), beforeRevision: value.revision, dryRun, operationCount: batch.operations.length,
      changes: applied.changes.map(c => ({ operationIndex: c.operationIndex, op: c.op, targetId: c.objectIds[0] })), ...(dryRun ? {} : { outputPath: resolve(output!) }) };
    const response = envelope(command, 0, result, diagnostics);
    if (!dryRun) {
      const text = checked(serializeProject(applied.project), 4);
      const warnings = await publishExclusive(output!, text, [p[0]!, f.get('operations')!]);
      if (diagnostics.length + warnings.length > 10000) throw new Failure(7, [diagnostic('PUBLISHED_RESPONSE_LIMIT', [], 'Complete output was published, but cleanup warnings plus operation diagnostics exceed the v1 response bound; inspect the separately named output. No rollback is claimed.')]);
      return envelope(command, 0, result, [...diagnostics, ...warnings.map(code => ({ ...diagnostic(code), severity: 'warning' as const }))]);
    }
    return response;
  }
  const run = checked(createScenarioRun(value, await readBounded(f.get('scenario')!), 'cli_run'), 2);
  if (command === 'verify' && !run.scenario.expect) throw new Failure(2, [diagnostic('EXPECT_REQUIRED')]);
  let interrupted = false;
  const cancel = () => { interrupted = true; run.cancel(); };
  process.on('SIGINT', cancel);
  try {
    if (!run.done()) {
      // Establish an actual bounded unit before announcing the running phase.
      checked(run.drive(1), 7);
      if (!run.done()) process.stderr.write('Running bounded scenario\n');
    }
    while (!run.done()) {
      await yieldLoop();
      if (!run.done()) checked(run.drive(1), 7);
    }
    const report = run.report(), observed = wireRun(report);
    if (command === 'simulate') return envelope(command, interrupted ? 130 : runExit(report), observed, report.diagnostics);
    const verified = verifyReport(report, run.scenario)!;
    const exit = interrupted ? 130 : verified.verificationOutcome === 'passed' ? 0 : verified.verificationOutcome === 'failed' ? 6 : 7;
    return envelope(command, exit, { observed, expectedOutcome: verified.expectedOutcome, verificationOutcome: verified.verificationOutcome, checks: verified.checks },
      exit && !report.diagnostics.some(d => d.severity === 'error') ? [...report.diagnostics, diagnostic(exit === 6 ? 'EXPECTATION_MISMATCH' : 'INCOMPLETE')] : report.diagnostics);
  } finally { process.off('SIGINT', cancel); }
}
const help = `Independent circuit CLI v0.0.0 (own-format core.dc v1)\nCommands:\n  library list\n  library describe DEFINITION\n  new --output FILE [--project-id ID] [--sheet-id ID] [--title TEXT]\n  inspect PROJECT\n  validate PROJECT --scope document|run\n  edit apply PROJECT --operations FILE --output FILE [--dry-run]\n  simulate PROJECT --scenario FILE\n  verify PROJECT --scenario FILE\nInputs may be - for bounded stdin. Outputs must be new, separately named files.\nFunctional commands return one v1 JSON envelope. --help / --version request text.\n`;
const args = process.argv.slice(2);
const identified = identify(args);
async function main() {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '--version')) { process.stdout.write(args[0] === '--help' ? help : '0.0.0\n'); return; }
  let response: Envelope;
  try {
    if (identified.command === null) throw new ArgumentError('Unknown command');
    const rest = args.slice(identified.consumed);
    if (rest.length === 1 && (rest[0] === '--help' || rest[0] === '--version')) { process.stdout.write(rest[0] === '--help' ? help : '0.0.0\n'); return; }
    response = await execute(identified.command, rest);
  } catch (error) {
    const fail = error instanceof Failure ? error : error instanceof ArgumentError ? new Failure(2, [diagnostic('INVALID_ARGUMENTS', [], error.message)]) : error instanceof HostError ? new Failure(7, [diagnostic(error.code, [], error.message)]) : new Failure(7, [diagnostic('HOST_IO', [], `Host operation failed: ${(error as NodeJS.ErrnoException).code ?? 'INTERNAL'}`)]);
    response = envelope(identified.command, fail.exit, null, fail.diagnostics);
  }
  process.exitCode = response.exitCode;
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
// EPIPE/catastrophic termination cannot promise a final protocol envelope.
process.stdout.on('error', () => { process.exitCode = 7; });
await main();
