BEGIN;

CREATE TABLE public.courses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id UUID NOT NULL REFERENCES public.profiles(id),
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 5000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, teacher_id)
);
CREATE INDEX courses_teacher_id_idx ON public.courses (teacher_id);

CREATE TABLE public.course_enrollments (
  course_id UUID NOT NULL REFERENCES public.courses(id),
  student_id UUID NOT NULL REFERENCES public.profiles(id),
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (course_id, student_id)
);
CREATE INDEX course_enrollments_student_id_idx
  ON public.course_enrollments (student_id, course_id);

ALTER TABLE public.labs ADD COLUMN course_id UUID;

-- Preserve existing labs in one course per teacher. Enrollment is explicit.
WITH imported_courses AS (
  INSERT INTO public.courses (teacher_id, title, description)
  SELECT DISTINCT teacher_id, 'Imported labs', 'Labs created before courses were introduced.'
  FROM public.labs
  RETURNING id, teacher_id
)
UPDATE public.labs l SET course_id = c.id
FROM imported_courses c WHERE l.teacher_id = c.teacher_id;

ALTER TABLE public.labs
  ALTER COLUMN course_id SET NOT NULL,
  ADD CONSTRAINT labs_course_teacher_fkey
    FOREIGN KEY (course_id, teacher_id) REFERENCES public.courses (id, teacher_id);
CREATE INDEX labs_course_id_idx ON public.labs (course_id);

REVOKE ALL ON public.courses, public.course_enrollments FROM PUBLIC, anon, authenticated;

COMMIT;
