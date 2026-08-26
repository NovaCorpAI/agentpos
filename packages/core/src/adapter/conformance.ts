/**
 * Conformance: validate emitted surfaces against the pinned OFFICIAL schemas vendored under
 * packages/core/schemas (UCP: 116 files from Universal-Commerce-Protocol/ucp; ACP: schema.feed.json).
 * Used by tests, `agentgate publish` and CI. Never trust our own shape; trust the spec.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import formatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";

// ajv-formats is CJS with a default export; under ESM interop the callable may sit on `.default`.
const addFormats: FormatsPlugin =
  (formatsModule as unknown as { default?: FormatsPlugin }).default ??
  (formatsModule as unknown as FormatsPlugin);

export interface ConformanceResult {
  valid: boolean;
  errors: Array<{ path: string; message: string; keyword: string }>;
}

const SCHEMAS_DIR = fileURLToPath(new URL("../../schemas/", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory()
      ? walk(full)
      : full.endsWith(".json") && !name.startsWith("example")
        ? [full]
        : [];
  });
}

let ajv: Ajv2020 | undefined;
const compiled = new Map<string, ValidateFunction>();

function instance(): Ajv2020 {
  if (ajv) return ajv;
  // strict: false because the official schemas use custom keywords (ucp_request, example, name).
  ajv = new Ajv2020({ strict: false, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  for (const file of walk(SCHEMAS_DIR)) {
    const schema = JSON.parse(readFileSync(file, "utf8")) as { $id?: string };
    if (schema.$id) ajv.addSchema(schema, schema.$id);
  }
  return ajv;
}

function validator(ref: string): ValidateFunction {
  const cached = compiled.get(ref);
  if (cached) return cached;
  const fn: ValidateFunction = instance().compile({ $ref: ref });
  compiled.set(ref, fn);
  return fn;
}

function toResult(valid: boolean, errors: ErrorObject[] | null | undefined): ConformanceResult {
  return {
    valid,
    errors: (errors ?? []).map((e) => ({
      path: e.instancePath || "/",
      message: e.message ?? "",
      keyword: e.keyword,
    })),
  };
}

export const SCHEMA_REFS = {
  ucpBusinessProfile: "https://ucp.dev/schemas/profile.json#/$defs/business_schema",
  acpProductsResponse:
    "https://example.com/schemas/feed/bundle.schema.json#/$defs/ProductsResponse",
  acpProduct: "https://example.com/schemas/feed/bundle.schema.json#/$defs/Product",
} as const;

export function validateUcpBusinessProfile(doc: unknown): ConformanceResult {
  const fn = validator(SCHEMA_REFS.ucpBusinessProfile);
  return toResult(fn(doc) as boolean, fn.errors);
}

export function validateAcpProductsResponse(doc: unknown): ConformanceResult {
  const fn = validator(SCHEMA_REFS.acpProductsResponse);
  return toResult(fn(doc) as boolean, fn.errors);
}

/** Directory with the vendored schemas (for tooling and docs). */
export function schemasDir(): string {
  return SCHEMAS_DIR;
}
