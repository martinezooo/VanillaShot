import { closeMainWindow } from "@raycast/api";

import { runVanillaShotAction } from "./vanillaShot";

export default async function Command() {
  // Raycast must get out of the way before screencapture draws the crosshair,
  // otherwise the selection lands on top of the Raycast window.
  await closeMainWindow();
  await runVanillaShotAction("capture", "Drag to select a region");
}
