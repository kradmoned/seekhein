import { uploadSuccess } from './lab-validation'
import { api } from './api'
import { courseBody, enrollmentBody, courseUpload, type Course, type CourseDetail, type CourseStudent, type Enrollment } from './course-contract'
export type { Course, CourseDetail, CourseStudent } from './course-contract'
export const coursePath = (id: string) => `/api/courses/${encodeURIComponent(id)}`
export const coursesApi = {
  list: (signal: AbortSignal) => api<Course[]>('/api/courses', { signal, cache: 'no-store' }),
  get: (id: string, signal: AbortSignal) => api<CourseDetail>(coursePath(id), { signal, cache: 'no-store' }),
  students: (id: string, signal: AbortSignal) => api<CourseStudent[]>(`${coursePath(id)}/students`, { signal, cache: 'no-store' }),
  create: (title: string, description: string) => api<{ id: string }>('/api/courses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: courseBody(title, description) }),
  enroll: (id: string, email: string, signal?: AbortSignal) => api<Enrollment>(`${coursePath(id)}/students`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: enrollmentBody(email), signal }),
  upload: (id: string, body: FormData) => api<unknown>('/api/labs', { method: 'POST', body: courseUpload(id, body) }).then(uploadSuccess),
}
