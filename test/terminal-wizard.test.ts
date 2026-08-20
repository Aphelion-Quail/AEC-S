import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { TerminalWizardPrompt } from "../src/terminal-wizard.js";

class FakeTtyInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;

  setRawMode(mode: boolean): void {
    this.isRaw = mode;
  }
}

class FakeTtyOutput extends PassThrough {
  readonly isTTY = true;
}

function choose(input: FakeTtyInput, bytes: string): Promise<"first" | "second"> {
  const prompt = new TerminalWizardPrompt(input, new FakeTtyOutput());
  const result = prompt.select("Choose", [
    { value: "first", label: "First" },
    { value: "second", label: "Second" },
  ]);
  process.nextTick(() => input.write(bytes));
  return result;
}

test("raw selection restores a previously paused input stream", async () => {
  const input = new FakeTtyInput();
  input.pause();
  assert.equal(input.readableFlowing, false);
  assert.equal(await choose(input, "\r"), "first");
  assert.equal(input.isRaw, false);
  assert.equal(input.readableFlowing, false);
  input.destroy();
});

test("raw selection restores a flowing raw stream after Ctrl-C", async () => {
  const input = new FakeTtyInput();
  input.isRaw = true;
  input.resume();
  assert.equal(input.readableFlowing, true);
  await assert.rejects(choose(input, "\u0003"), /setup cancelled/);
  assert.equal(input.isRaw, true);
  assert.equal(input.readableFlowing, true);
  input.destroy();
});
