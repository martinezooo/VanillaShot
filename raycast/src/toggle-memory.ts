import { closeMainWindow } from "@raycast/api";

import { runVanillaShotAction } from "./vanillaShot";

export default async function Command() {
  await closeMainWindow();
  await runVanillaShotAction("memory/toggle", "Toggling VanillaShot screen memory...");
}
