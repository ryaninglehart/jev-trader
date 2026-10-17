import { invariant } from "./validation";

/** Read-only bounded retries. Never drain incomplete logs or advance past a gap. */
export async function completeTradePoll(feed: { lastBlock: number; poll(block: number): Promise<void> }, block: number, pause: (ms: number) => Promise<unknown> = Bun.sleep) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await feed.poll(block);
    if (feed.lastBlock === block) return;
    invariant(feed.lastBlock < block, "trade feed advanced beyond requested block");
    if (attempt < 2) await pause(250 * (attempt + 1));
  }
  throw new Error("trade log poll incomplete after bounded retries; refusing incomplete frame");
}
