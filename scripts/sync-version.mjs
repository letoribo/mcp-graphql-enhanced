import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const target = join(root, "src/version.ts");

writeFileSync(target, `export const version = ${JSON.stringify(version)};\n`);
console.error(`[sync-version] wrote ${version} -> src/version.ts`);
