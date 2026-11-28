import type { LabSummary } from './types'

export type Course = { id: string; title: string; description: string; created_at: string; lab_count: number; student_count?: number }
export type CourseDetail = Omit<Course, 'lab_count' | 'student_count'> & { teacher_id: string; labs: LabSummary[] }
export type CourseStudent = { id: string; email: string; full_name: string | null; enrolled_at: string }
export type Enrollment = { course_id: string; student_id: string; enrolled_at: string }

export function courseBody(title: string, description = '') {
  const trimmed = title.trim()
  if (!trimmed || Array.from(trimmed).length > 200) throw Error('Course title must contain 1–200 characters.')
  if (Array.from(description).length > 5000) throw Error('Description must contain at most 5,000 characters.')
  return limitedJson({ title: trimmed, description })
}
export function enrollmentBody(email: string) {
  const trimmed = email.trim()
  if (!trimmed) throw Error('Enter a student email.')
  return limitedJson({ email: trimmed })
}
function limitedJson(value: object) {
  const body = JSON.stringify(value)
  if (new TextEncoder().encode(body).length > 16_384) throw Error('Request exceeds the 16 KiB UTF-8 limit. Shorten the text and try again.')
  return body
}
export function courseUpload(id: string, body: FormData) {
  body.set('course_id', id)
  return body
}
