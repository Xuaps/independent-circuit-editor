import { diagnostic, freeze, type FailureCategory, type Result } from '../domain/types';
export const HARD_LIMITS = Object.freeze({ bytes: 10 * 1024 * 1024, depth: 64, nodes: 500_000, ids: 20_000 });
export type Limits = { bytes: number; depth: number; nodes: number; ids: number };
/** Trusted callers may LOWER budgets, never raise hard ceilings. Input documents cannot select them. */
export function budgets(lower: Partial<Limits> = {}): Limits {
  const out: Limits = { ...HARD_LIMITS };
  for (const key of Object.keys(out) as (keyof Limits)[]) {
    const value = lower[key];
    if (value !== undefined && Number.isSafeInteger(value) && value >= 0) out[key] = Math.min(out[key], value);
  }
  return out;
}
class DecodeError extends Error {
  constructor(readonly code: string, readonly category: FailureCategory, message: string) { super(message); }
}
function fail(code: string, category: FailureCategory, message: string): never { throw new DecodeError(code, category, message); }
/** Counts root as depth 1; each value (container or scalar) as one node; keys are not nodes.
 * Limits checked before descending/allocating a value. Keys/strings bounded by input bytes.
 */
export function parseStrict(input: string | Uint8Array, lower: Partial<Limits> = {}): Result<unknown> {
  try {
    const limit = budgets(lower);
    let text: string;
    if (typeof input === 'string') {
      // Count actual UTF-8 bytes without allocating an encoded copy; reject lone UTF-16 units.
      let bytes = 0;
      for (let i = 0; i < input.length; i++) {
        const c = input.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = input.charCodeAt(++i);
          if (!(next >= 0xdc00 && next <= 0xdfff)) fail('MALFORMED_ENCODING', 'malformed', 'Unpaired UTF-16 surrogate');
          bytes += 4;
        } else if (c >= 0xdc00 && c <= 0xdfff) fail('MALFORMED_ENCODING', 'malformed', 'Unpaired UTF-16 surrogate');
        else bytes += c < 128 ? 1 : c < 2048 ? 2 : 3;
        if (bytes > limit.bytes) fail('RESOURCE_LIMIT', 'resource-limit', 'Input byte ceiling exceeded');
      }
      text = input;
    } else if (input instanceof Uint8Array) {
      if (input.byteLength > limit.bytes) fail('RESOURCE_LIMIT', 'resource-limit', 'Input byte ceiling exceeded');
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input); }
      catch { return { ok: false, category: 'malformed', diagnostics: [diagnostic('MALFORMED_ENCODING')] }; }
    } else return { ok: false, category: 'malformed', diagnostics: [diagnostic('MALFORMED_INPUT')] };
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    let pos = 0, nodes = 0;
    const malformed = (message: string): never => fail('MALFORMED_JSON', 'malformed', `${message} at offset ${pos}`);
    function space() { while (pos < text.length && /[\x20\t\r\n]/.test(text[pos]!)) pos++; }
    function string(): string {
      const start = pos++;
      while (pos < text.length) {
        const c = text.charCodeAt(pos++);
        if (c === 34) {
          let value: string;
          try { value = JSON.parse(text.slice(start, pos)) as string; } catch { return malformed('Invalid string'); }
          for (let i = 0; i < value.length; i++) {
            const unit = value.charCodeAt(i);
            if (unit >= 0xd800 && unit <= 0xdbff) {
              const next = value.charCodeAt(++i);
              if (!(next >= 0xdc00 && next <= 0xdfff)) return malformed('Unpaired surrogate');
            } else if (unit >= 0xdc00 && unit <= 0xdfff) return malformed('Unpaired surrogate');
          }
          return value;
        }
        if (c < 32) return malformed('Control character');
        if (c === 92) {
          const escape = text[pos++];
          if (escape === 'u') {
            if (!/^[0-9a-fA-F]{4}$/.test(text.slice(pos, pos + 4))) return malformed('Invalid Unicode escape');
            pos += 4;
          } else if (!escape || !'"\\/bfnrt'.includes(escape)) return malformed('Invalid escape');
        }
      }
      return malformed('Unterminated string');
    }
    function value(depth: number): unknown {
      if (depth > limit.depth || ++nodes > limit.nodes) fail('RESOURCE_LIMIT', 'resource-limit', 'Decoded depth/node ceiling exceeded');
      space();
      const c = text[pos];
      if (c === '"') return string();
      if (c === '{') {
        pos++; space();
        const obj: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        if (text[pos] === '}') { pos++; return obj; }
        while (true) {
          if (text[pos] !== '"') return malformed('Expected key');
          const key = string();
          if (Object.hasOwn(obj, key)) fail('DUPLICATE_KEY', 'malformed', 'Duplicate decoded object key');
          space(); if (text[pos++] !== ':') return malformed('Expected colon');
          obj[key] = value(depth + 1); space();
          const next = text[pos++];
          if (next === '}') return obj;
          if (next !== ',') return malformed('Expected comma');
          space();
        }
      }
      if (c === '[') {
        pos++; space(); const array: unknown[] = [];
        if (text[pos] === ']') { pos++; return array; }
        while (true) {
          array.push(value(depth + 1)); space(); const next = text[pos++];
          if (next === ']') return array;
          if (next !== ',') return malformed('Expected comma');
        }
      }
      for (const [token, result] of [['true', true], ['false', false], ['null', null]] as const) {
        if (text.startsWith(token, pos)) { pos += token.length; return result; }
      }
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(pos));
      if (!match) return malformed('Expected value');
      pos += match[0].length;
      const n = Number(match[0]);
      // Reject integer-valued lexemes outside safe range, including exponent/fraction spellings.
      if (!Number.isFinite(n) || (Number.isInteger(n) && !Number.isSafeInteger(n))) fail('UNSAFE_NUMBER', 'malformed', 'Nonfinite or unsafe number');
      // A fractional token must not round/underflow to an integer accepted as a
      // revision/time/coordinate. Compare its exact decimal integer spelling.
      if (Number.isInteger(n)) {
        const [mantissa = '', exponent = '0'] = match[0].toLowerCase().split('e');
        const [whole = '', fraction = ''] = mantissa.replace('-', '').split('.');
        let digits = (whole + fraction).replace(/^0+/, '');
        let scale = Number(exponent) - fraction.length;
        while (digits.endsWith('0')) { digits = digits.slice(0, -1); scale++; }
        const exact = digits === '' ? '0' : scale >= 0 && digits.length + scale <= 16 ? digits + '0'.repeat(scale) : null;
        if (exact === null || exact !== String(Math.abs(n))) fail('UNSAFE_NUMBER', 'malformed', 'Decimal value would round to an integer');
      }
      return n;
    }
    const data = value(1); space(); if (pos !== text.length) return malformed('Trailing content');
    return { ok: true, value: freeze(data), diagnostics: [] };
  } catch (error) {
    if (error instanceof DecodeError) return { ok: false, category: error.category, diagnostics: [diagnostic(error.code, [], error.message)] };
    return { ok: false, category: 'malformed', diagnostics: [diagnostic('MALFORMED_INPUT')] };
  }
}
/** Isolate API JSON data with incremental canonical JSON byte accounting BEFORE copying
 * each property/value. No stringify, toJSON or bulk descriptor materialization.
 * Reflection is not a Proxy sandbox: ownKeys/getPrototypeOf/getOwnPropertyDescriptor
 * may run traps. Reflect.ownKeys necessarily allocates one intrinsic key list; reject
 * its entry count before fetching descriptors or building a candidate. Caller memory
 * already exists and is not controlled here. Transport callers should use parseStrict.
 */
export function isolateData(input: unknown, lower: Partial<Limits> = {}): Result<unknown> {
  const limit = budgets(lower); let nodes = 0, bytes = 0; const active = new Set<object>();
  function charge(count: number) {
    if (count > limit.bytes - bytes) fail('RESOURCE_LIMIT', 'resource-limit', 'Encoded byte ceiling exceeded');
    bytes += count;
  }
  function stringBytes(text: string) {
    charge(2); // quotes; count escaped UTF-8 without creating an escaped/encoded copy
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = text.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail('MALFORMED_ENCODING', 'malformed', 'Unpaired UTF-16 surrogate');
        charge(4);
      } else if (c >= 0xdc00 && c <= 0xdfff) fail('MALFORMED_ENCODING', 'malformed', 'Unpaired UTF-16 surrogate');
      else charge(c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 2 : c < 32 ? 6 : c < 128 ? 1 : c < 2048 ? 2 : 3);
    }
  }
  function copy(value: unknown, depth: number): unknown {
    if (depth > limit.depth || ++nodes > limit.nodes) fail('RESOURCE_LIMIT', 'resource-limit', 'Decoded depth/node ceiling exceeded');
    if (typeof value === 'string') { stringBytes(value); return value; }
    if (value === null) { charge(4); return null; }
    if (typeof value === 'boolean') { charge(value ? 4 : 5); return value; }
    if (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) {
      charge(String(value).length); return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value !== 'object' || !value || active.has(value)) fail('INVALID_DATA', 'invalid-document', 'Not an acyclic JSON value');
    const array = Array.isArray(value);
    const proto: unknown = Object.getPrototypeOf(value);
    if (!array && proto !== null && proto !== Object.prototype) fail('INVALID_DATA', 'invalid-document', 'Not plain JSON data');
    if (array && value.length > limit.nodes - nodes) fail('RESOURCE_LIMIT', 'resource-limit', 'Array exceeds remaining node budget');
    const keys = Reflect.ownKeys(value);
    const entries = keys.length - (array ? 1 : 0); // array length is the sole allowed nonenumerable
    if (entries > limit.nodes - nodes) fail('RESOURCE_LIMIT', 'resource-limit', 'Object exceeds remaining node budget');
    if (array && entries !== value.length) fail('INVALID_DATA', 'invalid-document', 'Sparse/extended array');
    charge(2); // brackets/braces
    active.add(value);
    const out: Record<string, unknown> | unknown[] = array ? [] : Object.create(null) as Record<string, unknown>;
    let count = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') fail('INVALID_DATA', 'invalid-document', 'Symbol fields are not JSON');
      if (array && key !== String(count)) fail('INVALID_DATA', 'invalid-document', 'Sparse/extended array');
      if (count++) charge(1); // comma
      if (!array) { stringBytes(key); charge(1); } // colon
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc || !desc.enumerable || !Object.hasOwn(desc, 'value')) fail('INVALID_DATA', 'invalid-document', 'Accessor/nonenumerable data');
      const child = copy(desc.value, depth + 1);
      Object.defineProperty(out, key, { value: child, enumerable: true, configurable: true, writable: true });
    }
    active.delete(value); return out;
  }
  try { return { ok: true, value: freeze(copy(input, 1)), diagnostics: [] }; }
  catch (error) {
    return { ok: false, category: error instanceof DecodeError ? error.category : 'invalid-document', diagnostics: [diagnostic(error instanceof DecodeError ? error.code : 'INVALID_DATA')] };
  }
}
