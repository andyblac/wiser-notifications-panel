import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import buildVersion from "../scripts/build-version.mjs";

const fixture = version => {
  const root = mkdtempSync(join(tmpdir(), "wiser-notifications-panel-"));
  writeFileSync(join(root, "package.json"), `${JSON.stringify({version})}\n`);
  return root;
};

test("development builds increment the development version", () => {
  const root = fixture("0.1.0-dev.1");
  const build = buildVersion({dev:true, root});
  assert.equal(build.version, "0.1.0-dev.2");
  assert.equal(build.resourceUrl, "/wiser/wiser-notifications-panel.js?v=0.1.0-dev.2");
  build.complete(root);
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"))).version, "0.1.0-dev.2");
});

test("test builds preserve the package version", () => {
  const root = fixture("0.1.0-dev.1");
  const build = buildVersion({preserve:true, root});
  assert.equal(build.version, "0.1.0-dev.1");
  build.complete(root);
  assert.equal(JSON.parse(readFileSync(join(root, "build-info.json"))).version, "0.1.0-dev.1");
});
