// Shortcuts: instructions you send a session with one tap. Each is a small Markdown file;
// the ones in ~/.claudia/recipes override the built-in ones with the same key.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME, ROOT } from "./config.mjs";

const BUILT_IN = join(ROOT, "recipes");
export const USER_RECIPES = join(HOME, "recipes");

export function parseRecipe(text, fallbackKey) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  const prompt = (m ? m[2] : text).trim();
  if (!prompt) return null;
  return { key: slug(meta.key || fallbackKey), label: meta.label || fallbackKey, order: Number(meta.order ?? 50), prompt };
}

export function loadRecipes() {
  const byKey = new Map();
  for (const dir of [BUILT_IN, USER_RECIPES]) {
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {}
    for (const file of files) {
      const recipe = parseRecipe(readFileSync(join(dir, file), "utf8"), file.slice(0, -3));
      if (recipe) byKey.set(recipe.key, recipe);
    }
  }
  return [...byKey.values()].sort((a, b) => a.order - b.order);
}

export function saveRecipe({ label, prompt, order = 90 }) {
  const key = slug(label);
  mkdirSync(USER_RECIPES, { recursive: true });
  writeFileSync(join(USER_RECIPES, `${key}.md`), `---\nlabel: ${label}\norder: ${order}\n---\n${prompt.trim()}\n`);
  return key;
}

// short and safe for Telegram button data (64 bytes total)
function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "shortcut";
}
