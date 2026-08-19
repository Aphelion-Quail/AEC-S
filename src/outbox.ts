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
  now: () => Date = () => new Date(),
): Promise<number> {
  let delivered = 0;
  const at = now();
  for (const message of db.listDeliverableOutbox("system", at.toISOString())) {
    const claimed = db.claimOutboxDelivery(message.id, at.toISOString(), new Date(at.getTime() + 30_000).toISOString());
    if (!claimed) continue;
    let succeeded = false;
    try {
      const result = await execute({
        program: "osascript",
        args: ["-e", NOTIFICATION_SCRIPT, claimed.title, claimed.body],
        timeoutSeconds: 15,
      });
      succeeded = result.exitCode === 0;
    } catch {
      succeeded = false;
    }
    if (succeeded) {
      db.markOutboxDelivered(claimed.id);
      delivered += 1;
      continue;
    }
    const delayMs = Math.min(5 * 60_000, 5_000 * 2 ** Math.max(0, claimed.attempts - 1));
    db.markOutboxDeliveryFailed(claimed.id, new Date(at.getTime() + delayMs).toISOString());
  }
  return delivered;
}

export async function systemOutboxLoop(db: AecSDatabase, signal?: AbortSignal, delayMs = 5_000): Promise<void> {
  while (!signal?.aborted) {
    try {
      await deliverSystemOutboxOnce(db);
    } catch {
      // Outbox delivery is auxiliary. A transient database, spawn, or macOS
      // notification failure must not terminate the control-plane daemon.
    }
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, delayMs);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}
