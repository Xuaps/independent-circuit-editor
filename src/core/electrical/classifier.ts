/** Internal bounded multigraph classifier; vertex indices are conductor-net indices. */
export const GRAPH_LIMITS = Object.freeze({ vertices: 60000, edges: 40000, work: 1000000 });
export type Edge = readonly [number, number];
export type Classification = 'supported' | 'unsupported' | 'resource-limit' | 'invalid';
export function classifyLoads(n: number, edges: readonly Edge[], positive: number, negative: number, workLimit: number = GRAPH_LIMITS.work): Classification {
  if (!Number.isInteger(n) || n < 2 || !Number.isInteger(positive) || !Number.isInteger(negative) || positive < 0 || negative < 0 || positive >= n || negative >= n || positive === negative) return 'invalid';
  if (n > GRAPH_LIMITS.vertices || edges.length > GRAPH_LIMITS.edges || !Number.isSafeInteger(workLimit) || workLimit < 0) return 'resource-limit';
  let work = 0;
  const budget = Math.min(workLimit, GRAPH_LIMITS.work);
  const adj: { v: number; e: number }[][] = Array.from({ length: n }, () => []);
  for (let e = 0; e < edges.length; e++) {
    if (++work > budget) return 'resource-limit';
    const [a, b] = edges[e]!;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= n || b >= n) return 'invalid';
    if (a !== b) { adj[a]!.push({ v: b, e }); adj[b]!.push({ v: a, e }); }
  }
  const discovery = new Int32Array(n), low = new Int32Array(n);
  let clock = 1;
  const stack: { v: number; parent: number; edge: number; next: number }[] = [{ v: positive, parent: -1, edge: -1, next: 0 }];
  discovery[positive] = low[positive] = clock;
  const edgeStack: number[] = [], blocks: number[][] = [];
  while (stack.length) {
    if (++work > budget) return 'resource-limit';
    const f = stack[stack.length - 1]!;
    if (f.next < adj[f.v]!.length) {
      const a = adj[f.v]![f.next++]!;
      if (a.e === f.edge) continue;
      if (!discovery[a.v]) {
        edgeStack.push(a.e); discovery[a.v] = low[a.v] = ++clock;
        stack.push({ v: a.v, parent: f.v, edge: a.e, next: 0 });
      } else if (discovery[a.v]! < discovery[f.v]!) {
        edgeStack.push(a.e); low[f.v] = Math.min(low[f.v]!, discovery[a.v]!);
      }
    } else {
      stack.pop();
      if (f.parent >= 0) {
        low[f.parent] = Math.min(low[f.parent]!, low[f.v]!);
        if (low[f.v]! >= discovery[f.parent]!) {
          const vertices = new Set<number>();
          let e: number;
          do {
            if (++work > budget) return 'resource-limit';
            e = edgeStack.pop()!; const [a, b] = edges[e]!; vertices.add(a); vertices.add(b);
          } while (e !== f.edge);
          blocks.push([...vertices]);
        }
      }
    }
  }
  if (!discovery[negative]) return 'supported';
  // Incidence forest: all original vertices plus one vertex per non-loop block.
  const tree: number[][] = Array.from({ length: n + blocks.length }, () => []);
  for (let b = 0; b < blocks.length; b++) for (const v of blocks[b]!) {
    if (++work > budget) return 'resource-limit';
    tree[n + b]!.push(v); tree[v]!.push(n + b);
  }
  const parent = new Int32Array(tree.length).fill(-1), queue = [positive]; parent[positive] = positive;
  for (let i = 0; i < queue.length && parent[negative] === -1; i++) for (const v of tree[queue[i]!]!) {
    if (++work > budget) return 'resource-limit';
    if (parent[v] === -1) { parent[v] = queue[i]!; queue.push(v); }
  }
  let count = 0;
  for (let v = negative; v !== positive; v = parent[v]!) {
    if (++work > budget) return 'resource-limit';
    if (v >= n) { if (blocks[v - n]!.length >= 3) return 'unsupported'; count++; }
  }
  return count >= 2 ? 'unsupported' : 'supported';
}
