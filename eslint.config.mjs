import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    ignores: [
      "dist/**",
      "dist-types/**",
      "node_modules/**",
      "*.mjs",
      "scripts/**/*.mjs",
      "tests/integration/runTest.cjs",
      "vitest.config.ts",
      "media/**",
    ],
  },
  {
    // F5 — the core layer stays free of the editor API and of the UI layer.
    // `src/core` is what tests, the CLI and future headless runners import; a
    // single `import * as vscode` there drags the whole editor into scope and
    // makes the module untestable without one. The AI helpers and the
    // gitignore prompt lived in core exactly this way until stage 5.4.
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "vscode",
              message:
                "src/core must not import the editor API. Put the UI-facing part in src/ui and pass what core needs as arguments.",
            },
          ],
          patterns: [
            {
              group: ["../ui/*", "../../ui/*"],
              message: "src/core must not depend on src/ui — invert the dependency.",
            },
          ],
        },
      ],
    },
  },
  {
    rules: {
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
);
