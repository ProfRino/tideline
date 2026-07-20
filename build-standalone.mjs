import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const directory = dirname(fileURLToPath(import.meta.url));
const template = await readFile(join(directory, "index.html"), "utf8");
const bundle = await readFile(join(directory, "tideline.bundle.js"), "utf8");
const safeBundle = bundle.replaceAll("</script", "<\\/script");
const standalone = template.replace(
  '<script defer src="./tideline.bundle.js"></script>',
  () => `<script>${safeBundle}</script>`,
);

if (standalone === template) {
  throw new Error("The local bundle script tag was not found in index.html.");
}

await writeFile(join(directory, "Tideline-Standalone.html"), standalone, "utf8");
