/**
 * Подсказка имени машины для онбординга без зависимости от vscode (тестируемо).
 */

export interface MachineNameSuggestInput {
  /** vscode.env.remoteName */
  remoteName: string | undefined;
  /** process.env.CODESPACE_NAME */
  codespaceName: string | undefined;
  /** process.env.GITHUB_REPOSITORY owner/repo */
  githubRepository: string | undefined;
  /** vscode-remote URI authority, напр. ssh-remote+BASE64 */
  vscodeRemoteAuthority: string | undefined;
  /** os.hostname() */
  hostname: string | undefined;
}

function sanitizeToken(raw: string): string {
  const t = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return t.length > 0 ? t : "machine";
}

function decodeSshHostFromAuthority(authority: string): string | undefined {
  const prefix = "ssh-remote+";
  if (!authority.startsWith(prefix)) {
    return undefined;
  }
  let b64 = authority.slice(prefix.length);
  try {
    while (b64.length % 4 !== 0) {
      b64 += "=";
    }
    const json = Buffer.from(b64, "base64").toString("utf8");
    const o = JSON.parse(json) as { hostName?: string; host?: string };
    const h = o.hostName ?? o.host;
    return typeof h === "string" && h.length > 0 ? h : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Короткое осмысленное имя для UI (история, Quick Transfer); без `/` `\` (проверка в онбординге отдельно).
 */
export function suggestMachineNameFrom(input: MachineNameSuggestInput): string {
  const rn = input.remoteName;

  if (rn?.startsWith("wsl+")) {
    const distro = rn.slice(4);
    return sanitizeToken(`wsl-${distro}`).slice(0, 48);
  }
  if (rn === "wsl") {
    return "wsl";
  }

  if (rn === "codespaces") {
    if (input.githubRepository) {
      const parts = input.githubRepository.split("/");
      let repo = input.githubRepository;
      if (parts.length >= 2) {
        repo = parts[parts.length - 1];
      }
      return sanitizeToken(`codespace-${repo}`).slice(0, 48);
    }
    if (input.codespaceName) {
      return sanitizeToken(`codespace-${input.codespaceName}`).slice(0, 48);
    }
    return "codespace";
  }

  if (rn === "ssh-remote" || rn?.startsWith("ssh-remote")) {
    const auth = input.vscodeRemoteAuthority;
    if (auth) {
      const host = decodeSshHostFromAuthority(auth);
      if (host) {
        return sanitizeToken(`ssh-${host}`).slice(0, 48);
      }
    }
    return "ssh-remote";
  }

  if (rn === "dev-container" || rn?.startsWith("dev-container")) {
    return "devcontainer";
  }

  if (rn?.includes("ssh")) {
    return "ssh-remote";
  }

  if (input.hostname && input.hostname.length > 0) {
    return sanitizeToken(input.hostname).slice(0, 48);
  }

  return "machine";
}
