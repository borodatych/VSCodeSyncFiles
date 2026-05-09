/**
 * v2.20.3 — pure resolver for the `vscodesync.aiMerge.endpoint` setting.
 *
 * Three legitimate values:
 *   - `"vscode-lm"` (default) — use the built-in `vscode.lm` API.
 *   - `"ollama"` — POST `{ model, prompt }` to a local Ollama instance.
 *   - `"lm-studio"` — POST `{ messages }` to LM Studio's OpenAI-compatible
 *     local endpoint.
 *   - any other URL — treat as a custom OpenAI-compatible HTTP endpoint
 *     (must start with `http://` or `https://`; localhost-only by default).
 *
 * Caller injects HTTP client; this module only normalises the setting and
 * builds the request shape. Lets unit tests cover endpoint dispatch without
 * spinning up a real LLM.
 */

export type AiMergeEndpointKind =
  | "vscode-lm"
  | "ollama"
  | "lm-studio"
  | "custom";

export interface AiMergeEndpointPlan {
  kind: AiMergeEndpointKind;
  /** The URL the caller should POST to. Empty string when `kind === "vscode-lm"`. */
  url: string;
  /** Convention for the request body shape — caller picks the matching helper. */
  bodyShape: "vscode-lm" | "ollama" | "openai-chat";
  /** When true, caller must strip the request before sending (warn user). */
  warnsExternalNetwork: boolean;
}

const DEFAULT_OLLAMA_URL = "http://localhost:11434/api/generate";
const DEFAULT_LM_STUDIO_URL = "http://localhost:1234/v1/chat/completions";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function resolveAiMergeEndpoint(rawSetting: string | undefined): AiMergeEndpointPlan {
  const raw = (rawSetting ?? "vscode-lm").trim();
  if (raw === "" || raw === "vscode-lm") {
    return {
      kind: "vscode-lm",
      url: "",
      bodyShape: "vscode-lm",
      warnsExternalNetwork: false,
    };
  }
  if (raw === "ollama") {
    return {
      kind: "ollama",
      url: DEFAULT_OLLAMA_URL,
      bodyShape: "ollama",
      warnsExternalNetwork: false,
    };
  }
  if (raw === "lm-studio") {
    return {
      kind: "lm-studio",
      url: DEFAULT_LM_STUDIO_URL,
      bodyShape: "openai-chat",
      warnsExternalNetwork: false,
    };
  }
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return {
      kind: "custom",
      url: raw,
      bodyShape: "openai-chat",
      warnsExternalNetwork: !urlIsLocalhost(raw),
    };
  }
  // Unknown sentinel — fall back to vscode-lm so the user is never silently
  // sending content somewhere they didn't intend.
  return {
    kind: "vscode-lm",
    url: "",
    bodyShape: "vscode-lm",
    warnsExternalNetwork: false,
  };
}

function urlIsLocalhost(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return LOCAL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export interface OllamaRequestBody {
  model: string;
  prompt: string;
  stream: false;
}

export interface OpenAiChatMessage {
  role: "user" | "system" | "assistant";
  content: string;
}

export interface OpenAiChatRequestBody {
  model: string;
  messages: OpenAiChatMessage[];
  stream: false;
  temperature?: number;
}

/** Build an Ollama-shaped request body. */
export function buildOllamaBody(model: string, prompt: string): OllamaRequestBody {
  return { model, prompt, stream: false };
}

/** Build an OpenAI-compatible chat-completions request body. */
export function buildOpenAiChatBody(
  model: string,
  systemPrompt: string,
  userPrompt: string,
): OpenAiChatRequestBody {
  return {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    stream: false,
    temperature: 0.2,
  };
}
