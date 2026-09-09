/**
 * CONTRACT:VERIFY NEGATIVE CONTROLS.
 *
 * Proves the `contract:verify` gate FAILS when the vendored contract is tampered, stale, or
 * incomplete — WITHOUT ever mutating the real contract/ directory. Every mutation happens in
 * a throwaway temp copy of contract/, and the temp copy is removed afterwards.
 *
 * `contract/verify.mjs` locates its inputs relative to its OWN path (import.meta.url), so
 * running the COPY under a temp dir checks the temp copy, leaving the real one untouched.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REAL_CONTRACT = fileURLToPath(new URL("../contract/", import.meta.url));

/** Copy the real contract/ into a fresh temp dir and return its path. Caller must clean up. */
function stageContractCopy() {
  const dir = mkdtempSync(join(tmpdir(), "contract-verify-"));
  cpSync(REAL_CONTRACT, dir, { recursive: true });
  return dir;
}

/** Run `node <dir>/verify.mjs`; return { code, stdout, stderr } without throwing. */
function runVerify(dir) {
  try {
    const stdout = execFileSync("node", [join(dir, "verify.mjs")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "" };
  }
}

test("contract:verify PASSES over a faithful copy of the vendored contract", () => {
  const dir = stageContractCopy();
  try {
    const { code, stdout } = runVerify(dir);
    assert.equal(code, 0, `expected pass; stdout: ${stdout}`);
    assert.match(stdout, /contract:verify OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NEGATIVE CONTROL: a TAMPERED vendored schema makes contract:verify FAIL", () => {
  const dir = stageContractCopy();
  try {
    // Append a single byte to one schema — enough to change the digest.
    const victim = join(dir, "schemas", "access-verify.schema.json");
    appendFileSync(victim, "\n"); // one trailing newline; still valid JSON text, different bytes
    const { code, stderr, stdout } = runVerify(dir);
    assert.notEqual(code, 0, "a tampered schema must FAIL contract:verify");
    assert.match(
      stderr + stdout,
      /stale or tampered|does NOT match/i,
      `expected a stale/tampered digest failure; got:\n${stderr}${stdout}`,
    );
    // The real contract is untouched (this is the temp copy).
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(REAL_CONTRACT, "version.json"), "utf8")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NEGATIVE CONTROL: a STALE pin (wrong schemas_sha256) makes contract:verify FAIL", () => {
  const dir = stageContractCopy();
  try {
    const pinPath = join(dir, "BACKEND_CONTRACT.json");
    const pin = JSON.parse(readFileSync(pinPath, "utf8"));
    pin.schemas_sha256 = "0".repeat(64); // a plausible-looking but wrong digest
    writeFileSync(pinPath, JSON.stringify(pin, null, 2));
    const { code, stderr, stdout } = runVerify(dir);
    assert.notEqual(code, 0, "a wrong pinned digest must FAIL");
    assert.match(stderr + stdout, /BACKEND_CONTRACT|does NOT match/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NEGATIVE CONTROL: a MISSING pinned file makes contract:verify FAIL loudly", () => {
  const dir = stageContractCopy();
  try {
    unlinkSync(join(dir, "version.json"));
    const { code, stderr, stdout } = runVerify(dir);
    assert.notEqual(code, 0, "a missing version.json must FAIL");
    assert.match(stderr + stdout, /version\.json is missing|incomplete/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NEGATIVE CONTROL: an empty schemas/ dir makes contract:verify FAIL", async () => {
  const { readdirSync } = await import("node:fs");
  const dir = stageContractCopy();
  try {
    // Remove every schema file, leaving the dir present but empty.
    for (const f of readdirSync(join(dir, "schemas"))) unlinkSync(join(dir, "schemas", f));
    const { code, stderr, stdout } = runVerify(dir);
    assert.notEqual(code, 0, "an empty schemas/ must FAIL");
    assert.match(stderr + stdout, /no \*\.schema\.json|empty|incomplete/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
