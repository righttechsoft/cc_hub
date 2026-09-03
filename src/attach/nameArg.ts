// Pure argv parsing for cc-attach's --name flag, extracted from cli.ts for unit testing (cli.ts
// itself is a standalone wrapper with no test coverage of its own). Does NOT validate the name's
// format — cli.ts applies core/identity.ts's INSTANCE_NAME_RE (after lowercasing, and after
// falling back to the CC_HUB_NAME env var when --name is absent).
export interface ParsedNameArg {
  name: string | undefined;
  rest: string[];
}

// Consumes the FIRST `--name <value>` or `--name=<value>` occurrence from argv, returning the raw
// value and the remaining args in original order (so `rest` still passes straight through to
// `claude` unchanged — the whole point is that claude never sees --name).
export function parseNameArg(argv: string[]): ParsedNameArg {
  const rest: string[] = [];
  let name: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (name === undefined && arg === '--name' && i + 1 < argv.length) {
      name = argv[i + 1];
      i += 1;
      continue;
    }

    if (name === undefined && arg.startsWith('--name=')) {
      name = arg.slice('--name='.length);
      continue;
    }

    rest.push(arg);
  }

  return { name, rest };
}
