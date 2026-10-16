import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defaultConfig, type DatasetHeader, type EngineConfig, type JevSettings } from "../src/research/types";
import { validateConfig, validateHeader, invariant } from "../src/research/validation";

export function args(allowed: string[]) {
  const result: Record<string, string> = {};
  const input = process.argv.slice(2);
  for (let i = 0; i < input.length; i += 2) {
    const key = input[i]!, value = input[i + 1];
    invariant(key.startsWith("--") && allowed.includes(key.slice(2)) && value && !value.startsWith("--"), `invalid arguments: ${key}; expected --name value`);
    invariant(result[key.slice(2)] === undefined, `duplicate argument: ${key}`);
    result[key.slice(2)] = value;
  }
  return result;
}

export function settings(path: string) {
  const s = JSON.parse(readFileSync(path, "utf8")) as { dataset: DatasetHeader; engine?: Partial<EngineConfig>; jev?: JevSettings };
  const config = { ...defaultConfig, ...s.engine };
  validateHeader(s.dataset); validateConfig(config);
  return { header: s.dataset, config, jev: s.jev };
}

export function output(path: string | undefined, value: unknown) {
  const text = JSON.stringify(value, null, 2) + "\n";
  if (!path) { console.log(text); return; }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { flag: "wx" });
  renameSync(temporary, path);
  console.log(`Report: ${path}`);
}

export function protectOutput(path: string | undefined, inputs: (string | undefined)[]) {
  if (path) for (const input of inputs) invariant(!input || resolve(input) !== resolve(path), "report output must not overwrite an input, configuration or journal");
}
