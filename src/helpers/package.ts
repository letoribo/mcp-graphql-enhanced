import { readFileSync } from "fs";
import { join } from "path";

const packageJson = JSON.parse(
  readFileSync(join(__dirname, "../../package.json"), "utf-8")
);

export function getVersion() {
  return packageJson.version;
}