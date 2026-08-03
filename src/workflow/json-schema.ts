/** JSON Schema compilation and value validation shared by authoring and runs. */

import Ajv, { type ErrorObject, type ValidateFunction } from "ajv"

import type { JsonSchema } from "./types.ts"

const validator = new Ajv({
  allErrors: true,
  strict: false,
  validateFormats: false,
})

const compiled = new WeakMap<object, ValidateFunction<unknown>>()

const describeErrors = (errors: ErrorObject[] | null | undefined): string => {
  if (!errors || errors.length === 0) return "did not match the JSON Schema"
  return errors
    .slice(0, 5)
    .map((error) => {
      const location = error.instancePath === "" ? "$" : `$${error.instancePath}`
      return `${location} ${error.message ?? `violates ${error.keyword}`}`
    })
    .join("; ")
}

/** Compile a schema once and surface Ajv's schema diagnostics as a normal error. */
export const compileJsonSchema = (schema: JsonSchema): ValidateFunction<unknown> => {
  const cached = compiled.get(schema)
  if (cached) return cached
  let validate: ValidateFunction<unknown>
  try {
    validate = validator.compile(schema)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`invalid JSON Schema: ${message}`, { cause: error })
  }
  compiled.set(schema, validate)
  return validate
}

/** Return a compact explanation when a value violates a schema. */
export const explainJsonSchemaMismatch = (
  schema: JsonSchema,
  value: unknown,
): string | undefined => {
  const validate = compileJsonSchema(schema)
  return validate(value) ? undefined : describeErrors(validate.errors)
}
