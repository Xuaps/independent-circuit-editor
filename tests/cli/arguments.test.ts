import { expect, it } from 'vitest';
import { commands, identify, parse } from '../../src/cli/arguments';
it('fixed command membership never grants inherited or dotted aliases', () => {
  for (const name of ['constructor','toString','valueOf','__proto__','library.list','edit.apply']) expect(identify([name]).command).toBeNull();
  expect(identify(['library','list'])).toEqual({command:'library.list',consumed:2});
  expect(identify(['edit','apply'])).toEqual({command:'edit.apply',consumed:2});
});
it('all command specs reject unknown/prototype flags, repeats, excess positions and argument bounds', () => {
  for(const command of commands) {
    for(const flag of ['constructor','toString','hasOwnProperty','force']) expect(()=>parse(command,[`--${flag}`,'value'])).toThrow();
    expect(()=>parse(command,Array(33).fill('x'))).toThrow();expect(()=>parse(command,['x'.repeat(4097)])).toThrow();
  }
  expect(()=>parse('new',['--output','x','--output','x'])).toThrow();
  expect(()=>parse('new',['--output',''])).toThrow();
  expect(()=>parse('new',['--output','--title','x'])).toThrow();
  expect(()=>parse('validate',['project','--scope','constructor'])).toThrow();
});
it('new IDs/title are data for shared validation, dry-run is a value-less flag',()=>{
  const r=parse('new',['--output','file','--project-id','constructor','--sheet-id','sheet','--title','$(inert)']);expect(r.flags.get('project-id')).toBe('constructor');
  expect(parse('edit.apply',['project','--operations','ops','--output','out','--dry-run']).flags.has('dry-run')).toBe(true);
});
