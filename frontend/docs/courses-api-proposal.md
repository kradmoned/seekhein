# Course API integration

Updated to the confirmed backend contract. `src/lib/courses.ts` centralizes authenticated requests; `src/lib/course-contract.ts` defines response types and request validation.

- GET `/api/courses`: accessible course cards with description, creation timestamp, lab count, and teacher-only student count.
- GET `/api/courses/:id`: course details including labs. No separate nested labs request.
- POST `/api/courses`: JSON title and description only. Title is trimmed, 1–200 characters; description defaults to empty and is limited to 5000 characters. JSON is limited to 16 KiB measured in UTF-8 bytes.
- GET `/api/courses/:id/students`: teacher-owner roster.
- POST `/api/courses/:id/students`: JSON email only, trimmed. Returns membership, including for repeat enrollment. Successful enrollment refreshes the roster and grants access to current and future course labs.
- POST `/api/labs`: existing multipart fields plus exactly one `course_id`.

The dashboard uses roles from `/api/me`. The backend enforces ownership and membership; inaccessible courses and labs return 404, teacher-only routes return 403 for students. Backend validation messages, including 409 ambiguous emails and 422 unknown/nonstudent emails, are displayed without resetting form inputs. Course reads explicitly request no caching; successful backend reads return `Cache-Control: private, no-store`.

Existing direct lab bookmarks and execution endpoints remain supported. No student submission history/results dashboard is implemented; submission persistence is a future backend feature.

Live teacher/student account verification is still required for ownership, enrollment, roster, upload, and course membership enforcement.
