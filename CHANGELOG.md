# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.2] - 2026-06-18

### Fixed

- **Runtime import from the package entry now works again** ([#73]). `0.5.1`'s
  `dist/index.js` was a single `export { ... }` statement referencing ~40
  symbols that were never declared, so `import { Custom } from "adk-llm-bridge"`
  failed at runtime (`Export 'AIGateway' is not defined` on Node, `"Custom" is
  not declared in this file` on Bun). Root cause: the build bundled+minified the
  pure re-export barrel `src/index.ts` into one file with `"sideEffects": false`,
  so dead-code elimination dropped the bindings while keeping the export list.

### Changed

- Build migrated from a hand-rolled `Bun.build()` script to
  [`bunup`](https://bunup.dev), which emits the JS and matching `.d.ts` from one
  plan (no more JS/types structure mismatch).
- Removed `"sideEffects": false` from `package.json`. **Note for consumers:** the
  package no longer asserts it is side-effect-free, so bundlers are more
  conservative when tree-shaking unused re-exports. Registration is still
  explicit (no import-time side effects), so this is safe; it only affects how
  aggressively a downstream bundler can drop unused modules.
- `prepublishOnly` and `ci` now run packaging gates: `publint --strict` and
  `@arethetypeswrong/cli --pack --profile esm-only`.
- Pinned the toolchain to Bun 1.3.14 / Node 25.9.0 via `mise.toml`.
- Examples refreshed to each provider's current model (AI Gateway / Anthropic
  `claude-sonnet-4.6`, OpenAI `gpt-5.5`, xAI `grok-4.3`, OpenRouter
  `z-ai/glm-5.2`) and bumped to depend on `^0.5.2`.

### Removed

- `scripts/build.ts` and `scripts/fix-declaration-imports.mjs` (superseded by
  `bunup`, which emits correct ESM import specifiers).

[0.5.2]: https://github.com/pailat/adk-llm-bridge/releases/tag/v0.5.2
[#73]: https://github.com/pailat/adk-llm-bridge/issues/73
