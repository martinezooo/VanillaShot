import { closeMainWindow } from "@raycast/api";

import { runVanillaShootAction } from "./vanillaShoot";

export default async function Command() {
  // Raycast must get out of the way before screencapture draws the crosshair,
  // otherwise the selection lands on top of the Raycast window.
  await closeMainWindow();
  await runVanillaShootAction("capture", "Drag to select a region");
}
