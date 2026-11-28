import { HttpError } from "./http"

export function validateSubmissionLimit(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 2147483647) {
    throw new HttpError(422, "max_submissions must be a positive integer up to 2147483647, or null for unlimited")
  }
  return value
}

export function allowsResubmissions(limit: number | null): boolean {
  return limit === null || limit > 1
}

export function readUploadSubmissionLimit(form: FormData): number | null {
  const values = form.getAll("max_submissions")
  const legacy = form.getAll("allow_resubmissions")
  if (legacy.length > 1 || (legacy.length === 1 && legacy[0] !== "true" && legacy[0] !== "false")) {
    throw new HttpError(422, 'allow_resubmissions must be exactly one "true" or "false" text field')
  }
  if (values.length === 0) {
    if (legacy.length === 1) return legacy[0] === "true" ? null : 1
    throw new HttpError(422, "max_submissions is required")
  }
  const value = values[0]
  if (values.length !== 1 || typeof value !== "string" || !/^(?:[1-9][0-9]*|unlimited)$/.test(value)) {
    throw new HttpError(422, 'max_submissions must be one positive integer text field or "unlimited"')
  }
  const limit = validateSubmissionLimit(value === "unlimited" ? null : Number(value))
  if (legacy.length && (legacy[0] === "true") !== allowsResubmissions(limit)) {
    throw new HttpError(422, "allow_resubmissions conflicts with max_submissions")
  }
  return limit
}
