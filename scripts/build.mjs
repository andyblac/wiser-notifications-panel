import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import buildVersion from "./build-version.mjs";

const root = new URL("../", import.meta.url);
const source = readFileSync(new URL("src/wiser-notifications-panel.js", root), "utf8");
const translationNames = [
  "da", "de", "en-US", "en-GB", "es", "fi", "fr", "hu", "nb", "nl", "pt", "sv",
];
const translations = Object.fromEntries(translationNames.map(language => [
  language,
  JSON.parse(readFileSync(new URL(`src/localize/languages/${language}.json`, root), "utf8")),
]));
const dev = process.argv.includes("--dev");
const final = process.argv.includes("--release");
const preserve = process.argv.includes("--test");
if ([dev, final, preserve].filter(Boolean).length > 1) throw new Error("A build cannot use more than one version mode");
const build = buildVersion({
  dev,
  final,
  preserve,
  root:fileURLToPath(root),
  releaseTag:process.env.RELEASE_TAG,
});
const versionToken = "__WISER_NOTIFICATIONS_PANEL_VERSION__";
const translationToken = "__WISER_NOTIFICATIONS_TRANSLATIONS__";
if (!source.includes(versionToken)) throw new Error(`Missing ${versionToken} source token`);
if (!source.includes(translationToken)) throw new Error(`Missing ${translationToken} source token`);
const output = new URL("dist/", root);
mkdirSync(output, {recursive:true});
const bundleSource = source
  .replaceAll(versionToken, build.version)
  .replaceAll(translationToken, JSON.stringify(translations, null, 2));
const bundle = `/*! WISER-CARD-VERSION wiser-notifications-panel ${build.version} */\n${bundleSource}`;
writeFileSync(new URL("wiser-notifications-panel.js", output), bundle);
build.complete(fileURLToPath(output));
console.log(`Built wiser-notifications-panel ${build.version}`);
console.log(`Panel resource: ${build.resourceUrl}`);

