import type { Profile } from "./auth"
import { pool } from "./db"
import { HttpError, uuidPattern } from "./http"

// Queries using this predicate alias courses as c and bind the verified
// profile ID and database role as $1 and $2.
export const courseAccessSql = `(
  ($2 = 'teacher' AND c.teacher_id = $1)
  OR ($2 = 'student' AND EXISTS (
    SELECT 1 FROM public.course_enrollments e
    WHERE e.course_id = c.id AND e.student_id = $1
  ))
)`

export type Course = {
  id: string
  teacher_id: string
  title: string
  description: string
  created_at: string
}

export async function requireCourse(id: string, user: Profile): Promise<Course> {
  if (!uuidPattern.test(id)) throw new HttpError(400, "Invalid course ID")
  const result = await pool.query<Course>(
    `SELECT c.id, c.teacher_id, c.title, c.description, c.created_at
     FROM public.courses c
     WHERE ${courseAccessSql} AND c.id = $3`,
    [user.id, user.role, id],
  )
  if (!result.rows[0]) throw new HttpError(404, "Course not found")
  return result.rows[0]
}
