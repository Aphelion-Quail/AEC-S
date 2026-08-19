import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

export type WizardChoice<T extends string = string> = {
  value: T;
  label: string;
  description?: string;
};

export interface WizardPrompt {
  write(text: string): void;
  select<T extends string>(message: string, choices: Array<WizardChoice<T>>, defaultIndex?: number): Promise<T>;
  confirm(message: string, defaultYes?: boolean): Promise<boolean>;
  input(message: string, options?: { required?: boolean; defaultValue?: string }): Promise<string>;
}

type TerminalInput = Readable & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
};

type TerminalOutput = Writable & { isTTY?: boolean };

export class TerminalWizardPrompt implements WizardPrompt {
  constructor(
    private readonly inputStream: TerminalInput = process.stdin,
    private readonly outputStream: TerminalOutput = process.stdout,
  ) {}

  write(text: string): void {
    this.outputStream.write(text);
  }

  async select<T extends string>(message: string, choices: Array<WizardChoice<T>>, defaultIndex = 0): Promise<T> {
    if (choices.length === 0) throw new Error("A wizard selection requires at least one choice");
    if (this.inputStream.isTTY && this.outputStream.isTTY && this.inputStream.setRawMode) {
      return await this.rawSelect(message, choices, defaultIndex);
    }
    this.write(`${message}\n`);
    choices.forEach((choice, index) => this.write(`  ${index + 1}. ${choice.label}${choice.description ? ` — ${choice.description}` : ""}\n`));
    while (true) {
      const answer = await this.question(`> [${defaultIndex + 1}] `);
      const selected = answer.trim() === "" ? defaultIndex : Number(answer.trim()) - 1;
      if (Number.isInteger(selected) && selected >= 0 && selected < choices.length) return choices[selected]!.value;
      this.write(`Please choose 1-${choices.length}.\n`);
    }
  }

  async confirm(message: string, defaultYes = true): Promise<boolean> {
    while (true) {
      const answer = (await this.question(`${message} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
      if (answer === "") return defaultYes;
      if (["y", "yes", "是"].includes(answer)) return true;
      if (["n", "no", "否"].includes(answer)) return false;
    }
  }

  async input(message: string, options: { required?: boolean; defaultValue?: string } = {}): Promise<string> {
    while (true) {
      const suffix = options.defaultValue ? ` [${options.defaultValue}]` : "";
      const answer = (await this.question(`${message}${suffix}: `)).trim() || options.defaultValue || "";
      if (!options.required || answer !== "") return answer;
    }
  }

  private async question(message: string): Promise<string> {
    const interface_ = createInterface({ input: this.inputStream, output: this.outputStream, terminal: Boolean(this.outputStream.isTTY) });
    try {
      return await interface_.question(message);
    } finally {
      interface_.close();
    }
  }

  private async rawSelect<T extends string>(
    message: string,
    choices: Array<WizardChoice<T>>,
    defaultIndex: number,
  ): Promise<T> {
    let selected = Math.min(Math.max(defaultIndex, 0), choices.length - 1);
    this.write(`${message}\n\n`);
    const render = (moveUp: boolean) => {
      if (moveUp) this.write(`\u001B[${choices.length}A`);
      choices.forEach((choice, index) => {
        const marker = index === selected ? "›" : " ";
        this.write(`\u001B[2K\r${marker} ${choice.label}${choice.description ? ` — ${choice.description}` : ""}\n`);
      });
    };
    render(false);
    emitKeypressEvents(this.inputStream);
    const wasRaw = this.inputStream.isRaw === true;
    this.inputStream.setRawMode!(true);
    this.inputStream.resume();
    return await new Promise<T>((resolve, reject) => {
      const finish = (value?: T, error?: Error) => {
        this.inputStream.off("keypress", onKeypress);
        if (!wasRaw) this.inputStream.setRawMode!(false);
        this.write("\n");
        if (error) reject(error);
        else resolve(value!);
      };
      const onKeypress = (_character: string, key: { name?: string; ctrl?: boolean }) => {
        if (key.ctrl && key.name === "c") return finish(undefined, new Error("AEC-S setup cancelled"));
        if (key.name === "up") selected = (selected - 1 + choices.length) % choices.length;
        else if (key.name === "down") selected = (selected + 1) % choices.length;
        else if (key.name === "return" || key.name === "enter") return finish(choices[selected]!.value);
        else return;
        render(true);
      };
      this.inputStream.on("keypress", onKeypress);
    });
  }
}
