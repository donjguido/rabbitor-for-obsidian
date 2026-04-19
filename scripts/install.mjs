/**
 * Copies the built plugin files (manifest.json, main.js, styles.css)
 * into an Obsidian vault's plugins directory.
 *
 * Usage:
 *   npm run install-plugin                          # uses OBSIDIAN_VAULT env var
 *   npm run install-plugin -- --vault "C:/path/to/vault"
 */
import { copyFileSync, mkdirSync, existsSync } from "fs";
import { resolve, join } from "path";

const args = process.argv.slice(2);
let vaultPath = process.env.OBSIDIAN_VAULT;

const vaultIdx = args.indexOf("--vault");
if (vaultIdx !== -1 && args[vaultIdx + 1]) {
  vaultPath = args[vaultIdx + 1];
}

if (!vaultPath) {
  console.error(
    "No vault path provided.\n" +
    "Set OBSIDIAN_VAULT env var or pass --vault <path>:\n" +
    '  npm run install-plugin -- --vault "C:/Users/you/Documents/MyVault"'
  );
  process.exit(1);
}

const pluginDir = join(vaultPath, ".obsidian", "plugins", "annotator");
const srcDir = resolve(".");

if (!existsSync(join(vaultPath, ".obsidian"))) {
  console.error(`"${vaultPath}" does not look like an Obsidian vault (no .obsidian folder).`);
  process.exit(1);
}

mkdirSync(pluginDir, { recursive: true });

const files = ["manifest.json", "main.js", "styles.css"];
for (const file of files) {
  const src = join(srcDir, file);
  if (!existsSync(src)) {
    console.error(`Missing ${file} — run "npm run build" first.`);
    process.exit(1);
  }
  copyFileSync(src, join(pluginDir, file));
  console.log(`  ${file} → ${join(pluginDir, file)}`);
}

console.log("\nPlugin installed. Reload Obsidian (Ctrl+R) and enable it in Settings → Community plugins.");
