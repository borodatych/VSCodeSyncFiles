export interface ParsedPullArgs {
  command: "pull" | "pull-all";
  cwd: string;
  workspace?: string;
  /** Overrides env `VSCODESYNC_TOKEN` when set. */
  token?: string;
}

export interface ParsedAuthArgs {
  command: "auth";
  provider: string;
  clientId: string | undefined;
  deviceCode: boolean;
}

export interface ParsedGlobal {
  help: boolean;
  version: boolean;
  command?: "status" | "pull" | "pull-all" | "auth";
  pull?: ParsedPullArgs;
  status?: { cwd: string };
  auth?: ParsedAuthArgs;
}

export function parseArgv(argv: string[]): ParsedGlobal {
  const args = [...argv];
  const out: ParsedGlobal = { help: false, version: false };

  if (args.includes("--help") || args.includes("-h")) {
    out.help = true;
    return out;
  }
  if (args.includes("--version") || args.includes("-V")) {
    out.version = true;
    return out;
  }

  const cmd = args[0];
  if (cmd === "status") {
    out.command = "status";
    out.status = { cwd: parseCwd(args.slice(1)) };
    return out;
  }
  if (cmd === "auth") {
    out.command = "auth";
    let provider = "onedrive";
    let clientId: string | undefined;
    let deviceCode = false;
    const rest = args.slice(1);
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if ((a === "--provider" || a === "-p") && rest[i + 1]) {
        provider = rest[++i] ?? provider;
        continue;
      }
      if (a === "--client-id" && rest[i + 1]) {
        clientId = rest[++i];
        continue;
      }
      if (a === "--device-code") {
        deviceCode = true;
        continue;
      }
    }
    out.auth = { command: "auth", provider, clientId, deviceCode };
    return out;
  }
  if (cmd === "pull" || cmd === "pull-all") {
    out.command = cmd;
    let cwd = process.cwd();
    let workspace: string | undefined;
    let token: string | undefined;
    const rest = args.slice(1);
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--cwd" && rest[i + 1]) {
        cwd = rest[++i] ?? cwd;
        continue;
      }
      if ((a === "--workspace" || a === "-w") && rest[i + 1]) {
        workspace = rest[++i]?.trim();
        continue;
      }
      if (a === "--token" && rest[i + 1]) {
        token = rest[++i];
        continue;
      }
    }
    out.pull = {
      command: cmd,
      cwd,
      workspace: workspace?.length ? workspace : undefined,
      token: token?.trim() ? token.trim() : undefined,
    };
    return out;
  }

  return out;
}

function parseCwd(rest: string[]): string {
  let cwd = process.cwd();
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--cwd" && rest[i + 1]) {
      cwd = rest[++i] ?? cwd;
    }
  }
  return cwd;
}
