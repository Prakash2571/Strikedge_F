/**
 * CONTRACT SCHEMA TESTS — the backend-owned schemas are the AUTHORITY.
 *
 * This suite validates the retained captured fixtures in tests/fixtures/*.json against the
 * VENDORED, PINNED backend schemas (contract/schemas/**) using the VENDORED, dependency-free
 * validator (contract/validate.mjs). The schemas — not the fixtures — are the source of truth
 * (see tests/fixtures/README.md and contract/README.md). The fixtures are retained only as
 * realistic sample payloads to exercise the validator over real bytes and to power the
 * negative controls below.
 *
 * It also proves the gate BITES: deleting or renaming a required field is reported by NAME.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { validate, SchemaError } from "../contract/validate.mjs";

/* ── load the vendored schema registry ─────────────────────────────────────────────── */
const SCHEMAS_DIR = fileURLToPath(new URL("../contract/schemas/", import.meta.url));
const registry = {};
for (const name of readdirSync(SCHEMAS_DIR)) {
  if (name.endsWith(".schema.json")) {
    registry[name] = JSON.parse(readFileSync(new URL(name, `file://${SCHEMAS_DIR}`), "utf8"));
  }
}
const schema = (name) => {
  const s = registry[`${name}.schema.json`];
  if (!s) throw new Error(`no vendored schema for ${name}`);
  return s;
};
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const check = (data, schemaName) => validate(data, schema(schemaName), { registry });

/**
 * Fixture → schema mapping for the retained captured payloads.
 *
 * ALL retained fixtures now validate CLEANLY against the authoritative schema. The two former
 * divergences — `export-status.json` (extra `enabled`/`connected`) and `broker-status.json`
 * (extra `brokers[].session.state`) — are RESOLVED by contract v1.1.0, which now pins those
 * fields (they were always on the wire; only the schema omitted them). No whitelist remains.
 * See tests/fixtures/README.md.
 */
const CLEAN_FIXTURES = {
  "runtime-status": "runtime-status",
  "broker-switch-blockers": "broker-switch-blockers",
  "access-verify": "access-verify",
  "access-status": "access-status",
  "box-status": "box-status",
  "box-execution-control": "box-execution-control",
  "box-config": "box-config",
  "export-status": "export-status",
  "broker-status": "broker-status",
};

test("every clean fixture validates against its authoritative vendored schema", () => {
  for (const [fx, schemaName] of Object.entries(CLEAN_FIXTURES)) {
    const errors = check(fixture(fx), schemaName);
    assert.deepEqual(
      errors,
      [],
      `${fx}.json must satisfy the authoritative schema ${schemaName}.schema.json; got: ` +
        errors.map((e) => `${e.path}: ${e.message}`).join("; "),
    );
  }
});

/* ── NEGATIVE CONTROL: a missing or renamed required field is caught, by NAME ─────────── */

test("NEGATIVE CONTROL: deleting a required field AND renaming another both FAIL by name", () => {
  // A deep clone of a real captured runtime-status payload (validates clean above).
  const base = fixture("runtime-status");
  const mutated = structuredClone(base);

  // (1) DELETE a required top-level field.
  assert.ok("pg_ready" in mutated, "precondition: pg_ready present in the clean fixture");
  delete mutated.pg_ready;

  // (2) RENAME another required top-level field (delete old name, add a bogus new name).
  assert.ok("recovery_ready" in mutated, "precondition: recovery_ready present");
  mutated.recovery_ready_TYPO = mutated.recovery_ready;
  delete mutated.recovery_ready;

  const errors = check(mutated, "runtime-status");
  const byPath = new Map(errors.map((e) => [e.path, e.message]));

  // The deleted field is reported missing, by name.
  assert.equal(
    byPath.get("pg_ready"),
    "required property is missing",
    `expected a "pg_ready" required-missing error; got: ${JSON.stringify(errors)}`,
  );
  // The renamed field: the ORIGINAL name is reported missing…
  assert.equal(
    byPath.get("recovery_ready"),
    "required property is missing",
    `expected a "recovery_ready" required-missing error; got: ${JSON.stringify(errors)}`,
  );
  // …AND the bogus new name is rejected as an additional property (schema is closed).
  assert.equal(
    byPath.get("recovery_ready_TYPO"),
    "additional property is not allowed",
    `expected a "recovery_ready_TYPO" additional-property error; got: ${JSON.stringify(errors)}`,
  );

  // The ORIGINAL, unmutated payload still validates clean — proving the mutation caused it.
  assert.deepEqual(check(base, "runtime-status"), [], "the un-mutated fixture must still be valid");
});

test("NEGATIVE CONTROL (nested): deleting/renaming a required NESTED field FAILS by path", () => {
  const base = fixture("broker-switch-blockers"); // { broker, blockers }
  // Use box-config's nested tunable bounds for a deep path.
  const cfg = structuredClone(fixture("box-config"));
  assert.ok(cfg.tunable?.safety_buffer && "min" in cfg.tunable.safety_buffer, "precondition");
  delete cfg.tunable.safety_buffer.min; // delete a required nested field
  cfg.tunable.safety_buffer.MINIMUM = 0; // rename it to a bogus sibling

  const errors = check(cfg, "box-config");
  const byPath = new Map(errors.map((e) => [e.path, e.message]));
  assert.equal(
    byPath.get("tunable.safety_buffer.min"),
    "required property is missing",
    `expected nested "tunable.safety_buffer.min" missing; got: ${JSON.stringify(errors)}`,
  );
  assert.equal(
    byPath.get("tunable.safety_buffer.MINIMUM"),
    "additional property is not allowed",
    `expected nested "tunable.safety_buffer.MINIMUM" rejected; got: ${JSON.stringify(errors)}`,
  );
  // Sanity: the untouched sibling fixture is unaffected.
  assert.deepEqual(check(base, "broker-switch-blockers"), []);
});

/* ── the validator itself is honest: an unsupported keyword is a LOUD error ────────────── */

test("the vendored validator THROWS on an unsupported schema keyword (never silently skips)", () => {
  assert.throws(
    () => validate({}, { type: "object", minProperties: 1 }, { registry }),
    (err) => err instanceof SchemaError && /minProperties/.test(err.message),
    "an unknown keyword must raise SchemaError, not pass silently",
  );
});

test("the vendored digest over the vendored schemas matches version.json AND the pin", async () => {
  const { computeSchemasDigest } = await import("../contract/digest.mjs");
  const version = JSON.parse(readFileSync(new URL("../contract/version.json", import.meta.url), "utf8"));
  const pin = JSON.parse(
    readFileSync(new URL("../contract/BACKEND_CONTRACT.json", import.meta.url), "utf8"),
  );
  const { digest } = computeSchemasDigest(SCHEMAS_DIR);
  assert.equal(digest, version.schemas_sha256, "digest must match version.json");
  assert.equal(digest, pin.schemas_sha256, "digest must match BACKEND_CONTRACT.json");
  assert.equal(version.contract_version, pin.contract_version, "contract_version must agree");
});
