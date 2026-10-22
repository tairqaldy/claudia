// Claudia's memory: a short notebook she curates herself, plus the last few dozen messages.
import { PATHS, readJson, writeJson } from "./config.mjs";
import { clip } from "./util.mjs";

const MAX_NOTES = 40;
const MAX_HISTORY = 40;

export function createMemory(path = PATHS.memory) {
  const data = { notes: [], history: [], nextId: 1, ...readJson(path, {}) };
  const save = () => writeJson(path, data);

  return {
    notes: () => data.notes,
    history: () => data.history,

    remember(text) {
      const clean = clip(text, 200);
      if (!clean) return null;
      const dupe = data.notes.find((n) => n.text.toLowerCase() === clean.toLowerCase());
      if (dupe) return dupe;
      const note = { id: data.nextId++, text: clean, on: new Date().toISOString().slice(0, 10) };
      data.notes.push(note);
      if (data.notes.length > MAX_NOTES) data.notes.shift();
      save();
      return note;
    },

    forget(id) {
      const before = data.notes.length;
      data.notes = data.notes.filter((n) => n.id !== Number(id));
      if (data.notes.length === before) return false;
      save();
      return true;
    },

    addMessage(role, text) {
      data.history.push({ role, text: clip(text, 2000), at: Date.now() });
      if (data.history.length > MAX_HISTORY) data.history.splice(0, data.history.length - MAX_HISTORY);
      save();
    },
  };
}
