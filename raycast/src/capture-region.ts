import { closeMainWindow } from "@raycast/api";

import { runAyeAction } from "./aye";

export default async function Command() {
  // Raycast must get out of the way before screencapture draws the crosshair,
  // otherwise the selection lands on top of the Raycast window.
  await closeMainWindow();
  await runAyeAction("capture", "Drag to select a region");
}
