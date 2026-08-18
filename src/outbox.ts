import type { AecSDatabase } from "./db.js";
import { execCommand } from "./exec.js";
import type { ExecResult } from "./exec.js";

const NOTIFICATION_SCRIPT = [
  "on run argv",
  "display notification (item 2 of argv) with title (item 1 of argv)",
  "end run",
].join("\n");

export async function deliverSystemOutboxOnce(
  db: AecSDatabase,
  execute: (command: Parameters<typeof execCommand>[0]) => Promise<ExecResult> = execCommand,
): Promise<number> {
  let delivered = 0;
  for (const message of db.listOutbox(undefined, true)) {
    if (message.channel !== "system" || message.status !== "pending") continue;
    const result = await execute({
      program: "osascript",
      args: ["-e", NOTIFICATION_SCRIPT, message.title, message.body],
      timeoutSeconds: 15,
    });
    if (result.exitCode !== 0) continue;
    db.markOutboxDelivered(message.id);
    delivered += 1;
  }
  return delivered;
}

export async function systemOutboxLoop(db: AecSDatabase, signal?: AbortSignal): Promise<void> {
  while (!signal?.aborted) {
    await deliverSystemOutboxOnce(db);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}
