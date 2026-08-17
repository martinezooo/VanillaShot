import { open, showHUD } from "@raycast/api";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * VanillaShot exposes a closed set of `vanillashot://` verbs. Opening one launches the app if it
 * is not already running, so no separate daemon or port is involved.
 */
export type VanillaShotAction = "capture" | "show" | "memory/start" | "memory/stop" | "memory/toggle";

export const runVanillaShotAction = async (action: VanillaShotAction, hud: string): Promise<void> => {
  await open(`vanillashot://${action}`);
  await showHUD(hud);
};

// Kept in sync with memory_data_dir() in src-tauri/src/memory/mod.rs, including
// the pre-rename locations so an older install still resolves.
const MEMORY_DIR_CANDIDATES = [
  join(homedir(), "Pictures", "VanillaShot Memory"),
  join(homedir(), "Pictures", "Vanilla Shoot Memory"),
  join(homedir(), "Pictures", "AYE Memory"),
  join(homedir(), "Pictures", "Vulshot Memory"),
  join(homedir(), "Library", "Application Support", "com.vulshot", "memory"),
];

export const memoryDatabasePath = (): string | null => {
  for (const dir of MEMORY_DIR_CANDIDATES) {
    const dbPath = join(dir, "memory.db");
    if (existsSync(dbPath)) {
      return dbPath;
    }
  }

  return null;
};
