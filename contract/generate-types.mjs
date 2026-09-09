/**
 * contract:types generator — schemas/**.schema.json  →  src/api/contract.generated.ts
 *
 * Produces ONE exported TypeScript type per vendored schema, named in PascalCase from the
 * schema's file/`$id` (e.g. `broker-status.schema.json` -> `BrokerStatusContract`). The
 * output is DETERMINISTIC (schemas sorted by filename; object properties emitted in schema
 * declaration order; a stable header) so CI can regenerate and `git diff` to prove the
 * committed file is up to date.
 *
 * SUPPORTED SUBSET (matches contract/validate.mjs exactly):
 *   type (incl. unions => a TS union incl. `null`), required (absent => optional `?`),
 *   properties, additionalProperties (false => closed; true/schema => index signature),
 *   items, prefixItems (=> tuple), enum, const, oneOf/anyOf (=> TS unions), $ref (=> the
 *   referenced generated type name), minimum/maximum/format (annotations — no TS effect).
 * An UNSUPPORTED keyword THROWS — the generator refuses to silently drop a constraint, the
 * same discipline the validator uses.
 *
 * This file emits TYPES ONLY; it never asserts assignability. That is done at compile time by
 * src/api/contract.assert.ts, which `tsc -b` checks.
 *
 * USAGE:
 *   node contract/generate-types.mjs            -> writes src/api/contract.generated.ts
 *   node contract/generate-types.mjs --check    -> prints to stdout, writes nothing
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { listSchemaFiles, PROTOCOL_FILE, SCHEMAS_DIR } from "./digest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(HERE, "..", "src", "api", "contract.generated.ts");

/** Keywords the generator understands. Anything else throws (no silent drop). */
const SUPPORTED = new Set([
  "type", "required", "properties", "additionalProperties", "items", "prefixItems",
  "enum", "const", "oneOf", "anyOf", "$ref", "minimum", "maximum", "format",
]);
const IGNORED = new Set([
  "$schema", "$id", "title", "description", "$comment", "examples", "default",
  "deprecated", "readOnly", "writeOnly",
]);

class GenError extends Error {}

/** `broker-runtime-status.schema.json` / `broker-runtime-status` -> `BrokerRuntimeStatusContract`. */
function typeNameFromId(id) {
  const base = id.replace(/\.schema\.json$/, "");
  const pascal = base
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  return `${pascal}Contract`;
}

function assertKnownKeywords(schema, path) {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new GenError(`schema at ${path} must be an object`);
  }
  for (const key of Object.keys(schema)) {
    if (SUPPORTED.has(key) || IGNORED.has(key)) continue;
    throw new GenError(`unsupported schema keyword "${key}" at ${path} — extend generate-types.mjs or remove it`);
  }
}

const JSON_TS = {
  string: "string",
  number: "number",
  integer: "number",
  boolean: "boolean",
  null: "null",
};

/**
 * Render a schema node to a TS type expression.
 * `refNames` maps a "<name>.schema.json" $ref to its generated type name.
 */
function renderType(schema, path, refNames) {
  assertKnownKeywords(schema, path);

  // $ref must be used alone (mirrors the validator's no-siblings rule).
  if (Object.prototype.hasOwnProperty.call(schema, "$ref")) {
    for (const key of Object.keys(schema)) {
      if (key === "$ref" || IGNORED.has(key)) continue;
      throw new GenError(`$ref at ${path} must not be combined with "${key}"`);
    }
    const ref = schema.$ref;
    const name = refNames.get(ref);
    if (!name) throw new GenError(`$ref at ${path} points at unknown sibling "${ref}"`);
    return name;
  }

  // const -> a literal type.
  if (Object.prototype.hasOwnProperty.call(schema, "const")) {
    return literal(schema.const);
  }

  // enum -> a union of literals.
  if (Object.prototype.hasOwnProperty.call(schema, "enum")) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      throw new GenError(`enum at ${path} must be a non-empty array`);
    }
    return unionOf(schema.enum.map((v) => literal(v)));
  }

  // oneOf / anyOf -> a TS union of the branch types.
  for (const comb of ["oneOf", "anyOf"]) {
    if (Object.prototype.hasOwnProperty.call(schema, comb)) {
      const branches = schema[comb];
      if (!Array.isArray(branches) || branches.length === 0) {
        throw new GenError(`${comb} at ${path} must be a non-empty array`);
      }
      return unionOf(branches.map((b, i) => wrapParens(renderType(b, `${path}.${comb}[${i}]`, refNames))));
    }
  }

  // type — single name or union array (union is how nullable is modelled).
  const declared = schema.type;
  const list = declared === undefined ? undefined : Array.isArray(declared) ? declared : [declared];

  const hasObjectKeywords =
    Object.prototype.hasOwnProperty.call(schema, "properties") ||
    Object.prototype.hasOwnProperty.call(schema, "required") ||
    Object.prototype.hasOwnProperty.call(schema, "additionalProperties");
  const hasArrayKeywords =
    Object.prototype.hasOwnProperty.call(schema, "items") ||
    Object.prototype.hasOwnProperty.call(schema, "prefixItems");

  // Build the type expression for each declared JSON type, then union them.
  const parts = [];
  const types = list ?? inferTypes(hasObjectKeywords, hasArrayKeywords, path);
  for (const t of types) {
    if (typeof t !== "string" || !(t in JSON_TS) && t !== "object" && t !== "array") {
      throw new GenError(`type at ${path} has unsupported entry ${JSON.stringify(t)}`);
    }
    if (t === "object") {
      parts.push(renderObject(schema, path, refNames));
    } else if (t === "array") {
      parts.push(renderArray(schema, path, refNames));
    } else {
      parts.push(JSON_TS[t]);
    }
  }
  return unionOf(parts);
}

function inferTypes(hasObjectKeywords, hasArrayKeywords, path) {
  if (hasObjectKeywords) return ["object"];
  if (hasArrayKeywords) return ["array"];
  throw new GenError(`node at ${path} has no "type", "$ref", "enum", "const" or combinator — cannot render`);
}

function renderObject(schema, path, refNames) {
  const props = schema.properties ?? {};
  if (typeof props !== "object" || props === null || Array.isArray(props)) {
    throw new GenError(`properties at ${path} must be an object`);
  }
  const required = new Set(
    Object.prototype.hasOwnProperty.call(schema, "required") ? schema.required : [],
  );
  const lines = [];
  for (const [name, sub] of Object.entries(props)) {
    const optional = required.has(name) ? "" : "?";
    const rendered = renderType(sub, `${path}.${name}`, refNames);
    lines.push(`${indentKey(name)}${optional}: ${rendered};`);
  }
  // additionalProperties: false => closed object; true/schema => index signature.
  if (Object.prototype.hasOwnProperty.call(schema, "additionalProperties")) {
    const ap = schema.additionalProperties;
    if (ap === true) {
      lines.push(`[key: string]: unknown;`);
    } else if (typeof ap === "object" && ap !== null) {
      lines.push(`[key: string]: ${renderType(ap, `${path}.additionalProperties`, refNames)};`);
    } else if (ap !== false) {
      throw new GenError(`additionalProperties at ${path} must be boolean or a schema`);
    }
  }
  if (lines.length === 0) return `Record<string, never>`;
  return `{ ${lines.join(" ")} }`;
}

function renderArray(schema, path, refNames) {
  if (Object.prototype.hasOwnProperty.call(schema, "prefixItems")) {
    const tuple = schema.prefixItems.map((s, i) => renderType(s, `${path}[${i}]`, refNames));
    if (Object.prototype.hasOwnProperty.call(schema, "items")) {
      const rest = renderType(schema.items, `${path}.items`, refNames);
      return `[${tuple.join(", ")}, ...${wrapParens(rest)}[]]`;
    }
    return `[${tuple.join(", ")}]`;
  }
  if (Object.prototype.hasOwnProperty.call(schema, "items")) {
    return `${wrapParens(renderType(schema.items, `${path}.items`, refNames))}[]`;
  }
  // array with no item schema: unknown[]
  return `unknown[]`;
}

function literal(v) {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  throw new GenError(`cannot render literal ${JSON.stringify(v)}`);
}

function unionOf(parts) {
  const uniq = [...new Set(parts)];
  return uniq.length === 1 ? uniq[0] : uniq.join(" | ");
}

function wrapParens(t) {
  // Parenthesise a union before applying [] or including in another union branch.
  return /[|&]/.test(t) && !t.startsWith("(") ? `(${t})` : t;
}

function indentKey(name) {
  // Quote a property name that is not a plain identifier.
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

/**
 * Emit the machine-readable protocol constants from contract/protocol.json as `export const`
 * string literals, so the browser bundle can import them WITHOUT reading the filesystem at
 * runtime. This is what single-sources the CSRF header name: src/api/http.ts imports
 * `CSRF_HEADER` from the generated module, and the committed-generated-file CI check (regen +
 * `git diff --exit-code`) guarantees the frontend constant tracks the vendored contract. A
 * one-sided backend rename changes protocol.json (and the digest), which regenerates this
 * constant and fails the diff / the transport test until the frontend re-vendors deliberately.
 *
 * The constant names map deterministically from the protocol.json keys:
 *   csrf_header          -> CSRF_HEADER
 *   session_cookie_default -> SESSION_COOKIE_DEFAULT
 *   csrf_cookie_suffix   -> CSRF_COOKIE_SUFFIX
 * The `$comment` annotation key is ignored. An unknown key THROWS (the generator refuses to
 * silently drop a protocol constant it does not know how to name), mirroring the schema path.
 */
function renderProtocolConstants(protocolFile = PROTOCOL_FILE) {
  const raw = readFileSync(protocolFile, "utf8");
  const protocol = JSON.parse(raw);
  if (typeof protocol !== "object" || protocol === null || Array.isArray(protocol)) {
    throw new GenError(`protocol.json must be a JSON object`);
  }
  // Deterministic key -> TS-const-name mapping. Anything else is a loud error.
  const KEY_TO_CONST = {
    csrf_header: "CSRF_HEADER",
    session_cookie_default: "SESSION_COOKIE_DEFAULT",
    csrf_cookie_suffix: "CSRF_COOKIE_SUFFIX",
  };
  const lines = [
    `/** Protocol constants from contract/protocol.json (single source of truth — do not hardcode copies). */`,
  ];
  // Emit in a STABLE order (sorted by key) so the generated file is deterministic regardless of
  // JSON key order on disk.
  for (const key of Object.keys(protocol).sort()) {
    if (key === "$comment") continue;
    const constName = KEY_TO_CONST[key];
    if (!constName) {
      throw new GenError(
        `unknown protocol.json key "${key}" — extend generate-types.mjs KEY_TO_CONST to name it, or remove it`,
      );
    }
    const value = protocol[key];
    if (typeof value !== "string") {
      throw new GenError(`protocol.json key "${key}" must be a string, got ${JSON.stringify(value)}`);
    }
    lines.push(`export const ${constName} = ${JSON.stringify(value)} as const;`);
  }
  return lines.join("\n");
}

export function generate(dir = SCHEMAS_DIR, protocolFile = PROTOCOL_FILE) {
  const files = listSchemaFiles(dir);
  // Map every $ref target to its generated type name up front.
  const refNames = new Map();
  const schemas = [];
  for (const file of files) {
    const raw = readFileSync(resolve(dir, file), "utf8");
    const schema = JSON.parse(raw);
    const id = typeof schema.$id === "string" ? schema.$id : file;
    const name = typeNameFromId(id);
    refNames.set(id, name);
    // A schema may be referenced by its FILE name even if $id differs; register both.
    refNames.set(file, name);
    schemas.push({ file, id, name, schema });
  }

  const body = [];
  // Protocol constants FIRST so the CSRF header (and friends) are at the top of the module.
  body.push(renderProtocolConstants(protocolFile));
  body.push("");
  for (const { file, name, schema } of schemas) {
    const title = typeof schema.title === "string" ? schema.title : file;
    const rendered = renderType(schema, name, refNames);
    body.push(`/** ${title} (from contract/schemas/${file}) */`);
    // Prefer `interface` for a plain closed object; otherwise a type alias.
    if (rendered.startsWith("{ ") && rendered.endsWith(" }")) {
      body.push(`export interface ${name} ${rendered}`);
    } else {
      body.push(`export type ${name} = ${rendered};`);
    }
    body.push("");
  }

  const header = [
    "/**",
    " * AUTO-GENERATED FROM THE VENDORED BACKEND CONTRACT — DO NOT HAND-EDIT.",
    " *",
    " * Source: contract/schemas/**.schema.json  (pinned by contract/BACKEND_CONTRACT.json).",
    " * Generator: contract/generate-types.mjs.  Regenerate with `npm run contract:types`.",
    " *",
    " * Every edit here will be overwritten. To change a shape, change the backend serializer,",
    " * update the schema, re-vendor and re-pin (see contract/README.md), then regenerate.",
    " * CI regenerates this file and fails on any diff, so a hand-edit or a stale commit is caught.",
    " */",
    "",
    "/* eslint-disable */",
    "",
  ].join("\n");

  return `${header}${body.join("\n")}`.replace(/\n+$/, "") + "\n";
}

const isCheck = process.argv.includes("--check");
const out = generate();
if (isCheck) {
  process.stdout.write(out);
} else {
  writeFileSync(OUT_PATH, out);
  process.stderr.write(`wrote ${OUT_PATH}\n`);
}
