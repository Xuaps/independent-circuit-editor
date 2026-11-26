import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import common from '../../design/contracts/v1/common.schema.json';
import project from '../../design/contracts/v1/project.schema.json';
import operations from '../../design/contracts/v1/operations.schema.json';
import scenario from '../../design/contracts/v1/scenario.schema.json';
import profile from '../../design/contracts/v1/profile.schema.json';
import response from '../../design/contracts/v1/response.schema.json';
import hostError from './host-error.schema.json';

// common is a definition container, not a constrained input document.
const schemas = { project, operations, scenario, profile, response, hostError };
export type ContractKind = keyof typeof schemas;
// A shape-validation token, NOT a complete domain interface. T02 owns domain
// types and hostile-input decoding. Callers must not cast this into a model.
declare const validatedShape: unique symbol;
export type ValidatedShape<K extends ContractKind> = Readonly<Record<string, unknown>> & { readonly [validatedShape]: K };
export type ShapeResult<K extends ContractKind> =
  | { readonly valid: true; readonly data: ValidatedShape<K>; readonly errors: readonly [] }
  | { readonly valid: false; readonly errors: readonly ErrorObject[] };

const ajv = new Ajv2020({
  strict: true, strictTypes: false, allowUnionTypes: true, allErrors: true,
  validateFormats: false, coerceTypes: false, useDefaults: false, removeAdditional: false,
  // No loadSchema/compileAsync: unknown refs fail locally, never fetch.
});
ajv.addSchema(common);
for (const schema of Object.values(schemas)) ajv.addSchema(schema);
const validators = Object.fromEntries(Object.entries(schemas).map(([kind, schema]) => {
  const validator = ajv.getSchema(schema.$id);
  if (!validator) throw new Error(`Unregistered contract: ${kind}`);
  return [kind, validator];
})) as Record<ContractKind, ValidateFunction>;

export function validateCommonValue(kind: 'observableValue' | 'diagnostic', data: unknown): { valid: boolean; errors: readonly ErrorObject[] } {
  const validator = ajv.getSchema(`${common.$id}#/$defs/${kind}`);
  if (!validator) throw new Error(`Unregistered common definition: ${kind}`);
  const valid = validator(data) === true;
  return { valid, errors: structuredClone(validator.errors ?? []) };
}

/** Already-decoded bounded data only. No parsing, cloning or semantic validation. */
export function validateShape<K extends ContractKind>(kind: K, data: unknown): ShapeResult<K> {
  // Reject unsupported kinds at runtime too (JavaScript/unchecked callers).
  if (!Object.hasOwn(validators, kind)) throw new TypeError(`Unsupported input contract: ${kind}`);
  const validator = validators[kind];
  if (validator(data)) return { valid: true, data: data as ValidatedShape<K>, errors: [] };
  // Ajv replaces errors on each call; retain an independent diagnostic receipt.
  return { valid: false, errors: structuredClone(validator.errors ?? []) };
}

// Hostile *bounded JSON-data* input path, deliberately separate from the trusted
// detailed API above. Only these three roots are admitted: response has `contains`,
// whose unsuccessful per-item errors can accumulate even with allErrors:false.
// The reachable input schemas have only fixed-size oneOf/anyOf alternatives and
// no contains; fail-fast exits at the first invalid array item/property. Schema
// maxItems/maxProperties run before item/property validation. Never clone unused
// errors or return input-dependent paths/params to hostile callers.
export type BoundedContractKind = 'project' | 'operations' | 'scenario';
const boundedAjv = new Ajv2020({
  strict: true, strictTypes: false, allowUnionTypes: true, allErrors: false,
  messages: false, verbose: false, validateFormats: false,
  coerceTypes: false, useDefaults: false, removeAdditional: false,
});
boundedAjv.addSchema(common);
for (const kind of ['project', 'operations', 'scenario'] as const) boundedAjv.addSchema(schemas[kind]);
const boundedValidators = Object.fromEntries((['project', 'operations', 'scenario'] as const).map(kind => {
  const validator = boundedAjv.getSchema(schemas[kind].$id);
  if (!validator) throw new Error(`Unregistered bounded contract: ${kind}`);
  return [kind, validator];
})) as Record<BoundedContractKind, ValidateFunction>;
/** errorCount is a scalar audit receipt, not exhaustive diagnostics. No clone/cast. */
export function validateShapeBounded(kind: BoundedContractKind, data: unknown): { readonly valid: boolean; readonly errorCount: number } {
  if (!Object.hasOwn(boundedValidators, kind)) throw new TypeError(`Unsupported bounded contract: ${kind}`);
  const validator = boundedValidators[kind];
  const valid = validator(data) === true;
  const errorCount = validator.errors?.length ?? 0;
  // Do not retain invalid input's paths/params across calls.
  validator.errors = null;
  return { valid, errorCount };
}
