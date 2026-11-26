export const commands = ['library.list', 'library.describe', 'new', 'inspect', 'validate', 'edit.apply', 'simulate', 'verify'] as const;
export type Command = typeof commands[number];
export class ArgumentError extends Error {}
const specs = new Map<Command, { positional: number; flags: readonly string[]; required: readonly string[] }>([
  ['library.list', { positional: 0, flags: [], required: [] }],
  ['library.describe', { positional: 1, flags: [], required: [] }],
  ['new', { positional: 0, flags: ['output', 'project-id', 'sheet-id', 'title'], required: ['output'] }],
  ['inspect', { positional: 1, flags: [], required: [] }],
  ['validate', { positional: 1, flags: ['scope'], required: ['scope'] }],
  ['edit.apply', { positional: 1, flags: ['operations', 'output', 'dry-run'], required: ['operations', 'output'] }],
  ['simulate', { positional: 1, flags: ['scenario'], required: ['scenario'] }],
  ['verify', { positional: 1, flags: ['scenario'], required: ['scenario'] }]
]);
export function identify(args: readonly string[]): { command: Command | null; consumed: number } {
  const [first, second] = args;
  if (first === 'library' && (second === 'list' || second === 'describe')) return { command: `library.${second}`, consumed: 2 };
  if (first === 'edit' && second === 'apply') return { command: 'edit.apply', consumed: 2 };
  return { command: commands.includes(first as Command) && !first!.includes('.') ? first as Command : null, consumed: 1 };
}
export function parse(command: Command, args: readonly string[]) {
  const spec = specs.get(command)!; const flags = new Map<string, string>(); const positional: string[] = [];
  if (args.length > 32 || args.some(a => a.length > 4096)) throw new ArgumentError('Argument bounds exceeded');
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (!spec.flags.includes(key) || flags.has(key)) throw new ArgumentError(`Unknown or duplicate option: ${arg}`);
      if (key === 'dry-run') flags.set(key, 'true');
      else {
        const value = args[++i];
        if (!value || value.startsWith('--')) throw new ArgumentError(`Missing option value: ${arg}`);
        flags.set(key, value);
      }
    } else positional.push(arg);
  }
  if (positional.length !== spec.positional || spec.required.some(k => !flags.has(k))) throw new ArgumentError('Missing or extra arguments');
  if (command === 'validate' && !['document', 'run'].includes(flags.get('scope')!)) throw new ArgumentError('Invalid scope');
  return { positional, flags };
}
