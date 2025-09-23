import { readFileSync } from "fs";
import { join } from "path";

// 👇 Use __filename and __dirname — built-in CommonJS globals
const packageJson = JSON.parse(
  readFileSync(join(__dirname, "../../package.json"), "utf-8")
);

export function getVersion() {
  return packageJson.version;
}