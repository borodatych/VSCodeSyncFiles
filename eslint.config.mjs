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
    /**
     * F12 — command registration lives in `src/commands/**`.
     *
     * It used to be spread across 129 sites in `src/commands` and 40 in
     * `src/ui`, 27 of which sat in one 1115-line junk drawer covering seven
     * unrelated domains. "Where is this command handled?" had no answer you
     * could grep for in one place.
     *
     * The seven files listed below are exempt on purpose: each is a panel or a
     * feature that owns the single command opening it, and moving that command
     * away from its panel would be worse, not better.
     */
    files: ["src/ui/**/*.ts", "src/startup/**/*.ts"],
    ignores: [
      "src/ui/commandCenter.ts",
      "src/ui/passkeyCommands.ts",
      "src/ui/providerMigrationUi.ts",
      "src/ui/providerSetupGuide.ts",
      "src/ui/quickTransferUi.ts",
      "src/ui/settingsPanel.ts",
      "src/ui/trustedTeammatesUi.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.object.name='vscode'][callee.object.property.name='commands'][callee.property.name='registerCommand']",
          message:
            "Register commands in src/commands/** (see src/commands/palette/* for the domain groups). A panel that owns its own opener can be added to the ignore list in eslint.config.mjs, with a reason.",
        },
      ],
    },
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
