import { closeMainWindow } from "@raycast/api";

import { runAyeAction } from "./aye";

export default async function Command() {
  await closeMainWindow();
  await runAyeAction("memory/toggle", "Toggled AYE screen memory");
}
