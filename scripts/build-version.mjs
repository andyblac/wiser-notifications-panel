import {readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";

const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;
const BETA = /^(\d+\.\d+\.\d+-beta)\.(\d+)$/;
const DEVELOPMENT = /^(\d+\.\d+\.\d+)-dev\.(\d+)$/;
const BETA_DEVELOPMENT = /^(\d+\.\d+\.\d+-beta\.\d+)-dev\.(\d+)$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export default function buildVersion({
  dev = false,
  final = false,
  preserve = false,
  root = process.cwd(),
  releaseTag,
} = {}) {
  const packagePath = resolve(root, "package.json");
  const packageData = JSON.parse(readFileSync(packagePath, "utf8"));
  const packageVersion = packageData.version;
  let version = packageVersion;
  if (dev) {
    const release = RELEASE.exec(packageVersion);
    const beta = BETA.exec(packageVersion);
    const development = DEVELOPMENT.exec(packageVersion);
    const betaDevelopment = BETA_DEVELOPMENT.exec(packageVersion);
    if (betaDevelopment) version = `${betaDevelopment[1]}-dev.${BigInt(betaDevelopment[2]) + 1n}`;
    else if (development) version = `${development[1]}-dev.${BigInt(development[2]) + 1n}`;
    else if (beta) version = `${beta[1]}.${BigInt(beta[2]) + 1n}-dev.1`;
    else if (release) version = `${release[1]}.${release[2]}.${BigInt(release[3]) + 1n}-beta.1-dev.1`;
    else throw new Error(`Cannot create a dev build from version ${packageVersion}`);
  } else if (!preserve) {
    const development = DEVELOPMENT.exec(packageVersion);
    const betaDevelopment = BETA_DEVELOPMENT.exec(packageVersion);
    const beta = BETA.exec(packageVersion);
    if (final && betaDevelopment) version = betaDevelopment[1].replace(/-beta\.\d+$/, "");
    else if (final && beta) version = beta[1].replace(/-beta$/, "");
    else if (betaDevelopment) version = betaDevelopment[1];
    else if (development) version = development[1];
  }
  if (!SEMVER.test(version)) throw new Error(`Release builds require a semantic version, received ${packageVersion}`);
  if (releaseTag && releaseTag !== `v${version}`) throw new Error(`Release tag ${releaseTag} does not match package version v${version}`);
  const resourceUrl = `/wiser/wiser-notifications-panel.js?v=${version}`;
  return {
    version,
    resourceUrl,
    complete(outputDirectory) {
      writeFileSync(resolve(outputDirectory, "build-info.json"), `${JSON.stringify({version, resourceUrl}, null, 2)}\n`);
      if (version !== packageVersion) {
        packageData.version = version;
        writeFileSync(packagePath, `${JSON.stringify(packageData, null, 2)}\n`);
      }
    },
  };
}

