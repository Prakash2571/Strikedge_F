/**
 * contract:verify — the vendored-contract integrity gate.
 *
 * WHAT IT PROVES
 *   1. All three pinned files exist: version.json, BACKEND_CONTRACT.json, and at least one
 *      schema under schemas/. A missing file FAILS loudly (this is a vendored, pinned
 *      contract — an absent file is a broken pin, not "nothing to check").
 *   2. The digest recomputed over the vendored schemas/** with the vendored digest.mjs
 *      equals schemas_sha256 in BOTH version.json AND BACKEND_CONTRACT.json. A stale or
 *      tampered vendored schema (any byte changed, added or removed) changes the digest and
 *      therefore FAILS here.
 *   3. contract_version agrees between version.json and BACKEND_CONTRACT.json.
 *
 * WHY THIS EXISTS
 *   The frontend pins the backend contract by COMMIT SHA + DIGEST, so a normal build never
 *   depends on an unpinned, mutable fetch of the backend's main. This script is the
 *   mechanical half of that pin: it makes an out-of-date or corrupted vendored copy fail the
 *   build instead of silently drifting.
 *
 *   It cannot verify that BACKEND_CONTRACT.json.backend_sha points at the RIGHT commit — the
 *   digest is content-addressed and would pass regardless of the SHA. That is a human /
 *   orchestrator step, called out at the top of contract/README.md.
 *
 * USAGE: node contract/verify.mjs   (exit 0 = pass, non-zero = fail; loud messages)
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { computeSchemasDigest, listSchemaFiles } from "./digest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION_PATH = resolve(HERE, "version.json");
const PIN_PATH = resolve(HERE, "BACKEND_CONTRACT.json");
const SCHEMAS_DIR = resolve(HERE, "schemas");

function fail(msg) {
  console.error(`contract:verify FAIL — ${msg}`);
  process.exit(1);
}

function readJson(path, label) {
  if (!existsSync(path)) fail(`${label} is missing at ${path}. The vendored contract is incomplete.`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`${label} at ${path} is not valid JSON: ${err.message}`);
  }
}

// (1) Presence — every pinned file must exist.
const version = readJson(VERSION_PATH, "contract/version.json");
const pin = readJson(PIN_PATH, "contract/BACKEND_CONTRACT.json");

if (!existsSync(SCHEMAS_DIR)) fail(`contract/schemas is missing. The vendored contract is incomplete.`);
const schemaFiles = listSchemaFiles(SCHEMAS_DIR);
if (schemaFiles.length === 0) fail(`contract/schemas contains no *.schema.json files. The vendored contract is empty.`);

// (2) Digest — recompute over the vendored schemas and compare to BOTH pins.
const { digest, files } = computeSchemasDigest(SCHEMAS_DIR);

const versionDigest = version.schemas_sha256;
const pinDigest = pin.schemas_sha256;

if (typeof versionDigest !== "string") fail(`version.json is missing a string "schemas_sha256".`);
if (typeof pinDigest !== "string") fail(`BACKEND_CONTRACT.json is missing a string "schemas_sha256".`);

if (digest !== versionDigest) {
  fail(
    `computed digest over ${files.length} vendored schema(s) does NOT match version.json.\n` +
      `  computed:      ${digest}\n` +
      `  version.json:  ${versionDigest}\n` +
      `The vendored contract is stale or tampered. Re-vendor from the backend and re-pin.`,
  );
}
if (digest !== pinDigest) {
  fail(
    `computed digest does NOT match BACKEND_CONTRACT.json.schemas_sha256.\n` +
      `  computed:            ${digest}\n` +
      `  BACKEND_CONTRACT:    ${pinDigest}\n` +
      `The pin disagrees with the vendored schemas. Re-pin.`,
  );
}

// (3) contract_version must agree between the two pin files.
if (typeof version.contract_version !== "string") fail(`version.json is missing a string "contract_version".`);
if (typeof pin.contract_version !== "string") fail(`BACKEND_CONTRACT.json is missing a string "contract_version".`);
if (version.contract_version !== pin.contract_version) {
  fail(
    `contract_version disagrees: version.json=${version.contract_version} ` +
      `BACKEND_CONTRACT.json=${pin.contract_version}.`,
  );
}

console.log(`contract:verify OK`);
console.log(`  contract_version: ${version.contract_version}`);
console.log(`  schemas_sha256:   ${digest}`);
console.log(`  backend_repo:     ${pin.backend_repo}`);
console.log(`  backend_sha:      ${pin.backend_sha}`);
console.log(`  schemas verified: ${files.length}`);
