// Copies only the public Dashboard page into the Worker static-assets directory.
// Nothing else from the repository (docs, tests, migrations, Python) is uploaded.
import { mkdirSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "dashboard");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
copyFileSync(join(root, "index.html"), join(out, "index.html"));
console.log("Dashboard assets written to dist/dashboard");
