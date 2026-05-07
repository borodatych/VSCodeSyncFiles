import { describe, expect, it } from "vitest";
import { suggestMachineNameFrom } from "../../src/ui/machineNameSuggest.js";

describe("suggestMachineNameFrom", () => {
  it("локально — hostname", () => {
    expect(
      suggestMachineNameFrom({
        remoteName: undefined,
        codespaceName: undefined,
        githubRepository: undefined,
        vscodeRemoteAuthority: undefined,
        hostname: "MY-PC",
      }),
    ).toBe("my-pc");
  });

  it("WSL wsl+ubuntu-22.04", () => {
    expect(
      suggestMachineNameFrom({
        remoteName: "wsl+Ubuntu-22.04",
        codespaceName: undefined,
        githubRepository: undefined,
        vscodeRemoteAuthority: undefined,
        hostname: "x",
      }),
    ).toBe("wsl-ubuntu-22-04");
  });

  it("Codespaces + GITHUB_REPOSITORY", () => {
    expect(
      suggestMachineNameFrom({
        remoteName: "codespaces",
        codespaceName: undefined,
        githubRepository: "acme/My Project",
        vscodeRemoteAuthority: undefined,
        hostname: "x",
      }),
    ).toBe("codespace-my-project");
  });

  it("Codespaces + имя codespace", () => {
    expect(
      suggestMachineNameFrom({
        remoteName: "codespaces",
        codespaceName: "humorous-octo-99",
        githubRepository: undefined,
        vscodeRemoteAuthority: undefined,
        hostname: "x",
      }),
    ).toBe("codespace-humorous-octo-99");
  });

  it("SSH — host из authority", () => {
    const hostJson = JSON.stringify({ hostName: "buildbox.local" });
    const b64 = Buffer.from(hostJson, "utf8").toString("base64").replace(/=+$/, "");
    const authority = `ssh-remote+${b64}`;
    expect(
      suggestMachineNameFrom({
        remoteName: "ssh-remote",
        codespaceName: undefined,
        githubRepository: undefined,
        vscodeRemoteAuthority: authority,
        hostname: "x",
      }),
    ).toBe("ssh-buildbox-local");
  });

  it("dev-container", () => {
    expect(
      suggestMachineNameFrom({
        remoteName: "dev-container",
        codespaceName: undefined,
        githubRepository: undefined,
        vscodeRemoteAuthority: undefined,
        hostname: "x",
      }),
    ).toBe("devcontainer");
  });
});
