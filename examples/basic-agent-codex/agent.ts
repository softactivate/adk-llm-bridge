import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type * as Adk from "@google/adk";
import {
  CodexAgent,
  EnvCredentialProvider,
  mapPermissionModeToPolicy,
} from "adk-llm-bridge/agents";

// This example maps @google/adk to declaration files for local type-checking.
// Import the runtime ESM build directly so Bun does not execute a .d.ts file.
const adkRuntime = await import(
  new URL(
    [
      "..",
      "..",
      "node_modules",
      "@google",
      "adk",
      "dist",
      "esm",
      "index.js",
    ].join("/"),
    import.meta.url,
  ).href
);

// =============================================================================
// Codex External Agent (via the Codex SDK driver)
// =============================================================================
//
// CodexAgent runs OpenAI Codex as an external ADK agent. It uses the bundled
// CodexSdkDriver (the default for CODEX_AGENT_DEFINITION), which talks to the
// @openai/codex-sdk package and, at runtime, either an OPENAI_API_KEY /
// CODEX_API_KEY credential or a local `codex` CLI binary with native auth.

const credentialProvider = new EnvCredentialProvider();
const workingDirectory = process.cwd();

export const rootAgent = new CodexAgent({
  name: "CodexAssistant",
  description:
    "A general-purpose assistant running OpenAI Codex as an external ADK agent.",
  credentialProvider,
  workingDirectory,
  permissions: {
    // Read-only keeps the smoke run from modifying files. Restrict reachable
    // paths to this example directory.
    ...mapPermissionModeToPolicy("read-only"),
    allowNetwork: false,
    allowedPaths: [workingDirectory],
  },
  instruction: `You are a concise, friendly assistant running as a Codex ADK agent.

Answer the user's question directly. Do not modify files. Keep responses short.`,
});

// =============================================================================
// Smoke script: send ONE simple prompt through an ADK runner.
//
// Typechecks and builds with no credentials. At runtime, if neither an API key
// nor a local codex CLI is available, it prints a clear hint and exits 0 instead
// of crashing.
// =============================================================================

const SMOKE_PROMPT =
  process.env.SMOKE_PROMPT ?? "In one sentence, what is OpenAI Codex?";

function hasCodexCliOnPath(): boolean {
  const executable = process.platform === "win32" ? "codex.exe" : "codex";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir.length > 0 && existsSync(join(dir, executable))) {
      return true;
    }
  }
  return false;
}

function codexCredentialsAvailable(): boolean {
  return Boolean(
    process.env.OPENAI_API_KEY ||
      process.env.CODEX_API_KEY ||
      process.env.CODEX_EXECUTABLE ||
      process.env.CODEX_CLI_PATH ||
      hasCodexCliOnPath(),
  );
}

export async function main(): Promise<void> {
  if (!codexCredentialsAvailable()) {
    console.log("set OPENAI_API_KEY (or local codex CLI) to run this example");
    process.exit(0);
  }

  const { InMemorySessionService, Runner } = adkRuntime as typeof Adk;

  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: "agent",
    userId: "user",
  });
  const runner = new Runner({
    appName: "agent",
    agent: rootAgent,
    sessionService,
  });

  let text = "";
  for await (const event of runner.runAsync({
    userId: "user",
    sessionId: session.id,
    newMessage: { role: "user", parts: [{ text: SMOKE_PROMPT }] },
  })) {
    if (event.errorMessage) {
      console.error(`Codex error: ${event.errorMessage}`);
    }
    for (const part of event.content?.parts ?? []) {
      if (part.text) {
        text += part.text;
      }
    }
  }

  console.log(`Prompt: ${SMOKE_PROMPT}`);
  console.log(`Response: ${text.trim() || "(no text response)"}`);
}

if (import.meta.main) {
  await main();
}
