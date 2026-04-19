import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  {
    ignores: [
      "main.js",
      "node_modules/**",
      "dist/**",
      "eslint.config.mjs",
      "esbuild.config.mjs",
      "scripts/**",
      "**/*.json",
      "**/*.md",
      "**/*.css",
    ],
  },
  {
    files: ["src/**/*.ts"],
    extends: [...obsidianmd.configs.recommended],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Broken fixer: mangles `constructor` into `Function.prototype.toString` output.
      "obsidianmd/prefer-active-doc": "off",
      // loadData() is typed as any in the Obsidian API — downgrade to warnings.
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      // Fire-and-forget UI handlers are idiomatic in Obsidian plugins; warn, don't block.
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/no-misused-promises": "warn",
      // Obsidian plugins don't list `obsidian` in dependencies; it's a peer.
      "import/no-extraneous-dependencies": "off",
    },
  },
]);
