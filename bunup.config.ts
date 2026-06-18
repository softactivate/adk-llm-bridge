import { defineConfig } from "bunup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node",
  external: ["@google/adk", "@google/genai", "openai", "@anthropic-ai/sdk"],
  dts: { inferTypes: true },
  sourcemap: "linked",
  clean: true,
  splitting: false,
});
