import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { classifyLoads, type Edge } from '../../src/core/electrical/classifier';
/** Independent tiny exhaustive oracle. No production helper supplies its verdict. */
function oracle(n: number, edges: readonly Edge[]): boolean {
  function visit(v: number, seen: Set<number>, depth: number): boolean {
    if (v === n - 1) return depth >= 2;
    for (const [a,b] of edges) {
      const next = a === v ? b : b === v ? a : -1;
      if (next < 0 || seen.has(next)) continue;
      if (visit(next, new Set([...seen, next]), depth + 1)) return true;
    }
    return false;
  }
  return visit(0, new Set([0]), 0);
}
describe('bounded block-path classifier', () => {
  it('agrees with independent exhaustive simple paths, seed20261117/500', () => {
    fc.assert(fc.property(fc.integer({ min: 2, max: 7 }).chain(n => fc.tuple(fc.constant(n), fc.array(fc.tuple(fc.integer({ min: 0, max: n-1 }), fc.integer({ min: 0, max: n-1 })), { maxLength: 15 }))), ([n, edges]) => {
      expect(classifyLoads(n, edges, 0, n-1)).toBe(oracle(n, edges) ? 'unsupported' : 'supported');
    }), { seed: 20261117, numRuns: 500, verbose: true });
  });
  const cases: [string, number, Edge[], string][] = [
    ['parallel multiedges',2,[[0,1],[0,1]],'supported'],
    ['selfloops',2,[[0,0],[0,1],[1,1]],'supported'],
    ['series',3,[[0,1],[1,2]],'unsupported'],
    ['hidden series',3,[[0,2],[0,1],[1,2]],'unsupported'],
    ['long chain',5,[[0,1],[1,2],[2,3],[3,4]],'unsupported'],
    ['off trunk cycle',5,[[0,4],[0,1],[1,2],[2,0]],'supported'],
    ['dead end',4,[[0,3],[0,1],[1,2]],'supported'],
    ['disconnected rails',4,[[0,1],[1,2],[2,0]],'supported'],
    ['bridge trunk',5,[[0,1],[1,2],[2,3],[3,1],[3,4]],'unsupported'],
    ['parallel blocks in series',3,[[0,1],[0,1],[1,2],[1,2]],'unsupported']
  ];
  it.each(cases)('%s', (_name,n,edges,expected) => expect(classifyLoads(n,edges,0,n-1)).toBe(expected));
  it('traverses deep allowed graphs iteratively', () => {
    const edges: Edge[] = Array.from({length: 39999}, (_,i) => [i,i+1]);
    expect(classifyLoads(40000,edges,0,39999)).toBe('unsupported');
  });
  it('rejects limits before graph expansion and honors work exhaustion', () => {
    expect(classifyLoads(60001,[],0,1)).toBe('resource-limit');
    expect(classifyLoads(2,Array.from({length:40001},()=>[0,1]),0,1)).toBe('resource-limit');
    expect(classifyLoads(2,[[0,1]],0,1,0)).toBe('resource-limit');
    expect(classifyLoads(2,[[0,2]],0,1)).toBe('invalid');
  });
});
