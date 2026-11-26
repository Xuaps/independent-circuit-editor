import { readFileSync } from 'node:fs';
import { applyOperations, operationsFor } from '../../src/core/commands';
import { createProject } from '../../src/core/domain/project';
import { type Operation, type Project, type Result } from '../../src/core/domain/types';
import { decodeProject } from '../../src/core/persistence';
export function value<T>(r: Result<T>): T { if (!r.ok) throw new Error(JSON.stringify(r)); return r.value; }
export const empty = () => value(createProject('project', 'sheet'));
export const sample = () => value(decodeProject(readFileSync('design/contracts/examples/selfhold.circuit.json', 'utf8')));
export const edit = (p: Project, ops: readonly Operation[]) => applyOperations(p, operationsFor(p, ops));
