import { closeMainWindow } from "@raycast/api";

import { runVanillaShootAction } from "./vanillaShoot";

export default async function Command() {
  await closeMainWindow();
  await runVanillaShootAction("memory/toggle", "Toggled Vanilla Shoot screen memory");
}
