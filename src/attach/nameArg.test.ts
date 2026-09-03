import { describe, expect, it } from 'vitest';
import { parseNameArg } from './nameArg.js';

describe('parseNameArg', () => {
  it('returns no name and the args unchanged when --name is absent', () => {
    expect(parseNameArg(['--continue', '-r', 'abc'])).toEqual({
      name: undefined,
      rest: ['--continue', '-r', 'abc'],
    });
  });

  it('extracts --name <value>, removing both tokens from rest', () => {
    expect(parseNameArg(['--continue', '--name', 'wb-sync', '-r'])).toEqual({
      name: 'wb-sync',
      rest: ['--continue', '-r'],
    });
  });

  it('extracts --name=<value> form, removing only that one token', () => {
    expect(parseNameArg(['--name=wb-sync', '--continue'])).toEqual({
      name: 'wb-sync',
      rest: ['--continue'],
    });
  });

  it('only consumes the FIRST occurrence — a later literal --name passes through untouched', () => {
    expect(parseNameArg(['--name', 'first', '--name', 'second'])).toEqual({
      name: 'first',
      rest: ['--name', 'second'],
    });
  });

  it('treats a trailing --name with no following value as a passthrough arg (not consumed)', () => {
    expect(parseNameArg(['--continue', '--name'])).toEqual({
      name: undefined,
      rest: ['--continue', '--name'],
    });
  });

  it('returns an empty rest for empty argv', () => {
    expect(parseNameArg([])).toEqual({ name: undefined, rest: [] });
  });

  it('does not validate the value — that is cli.ts\'s job (INSTANCE_NAME_RE, after lowercasing)', () => {
    expect(parseNameArg(['--name', 'NOT-Lowercase!'])).toEqual({ name: 'NOT-Lowercase!', rest: [] });
  });
});
