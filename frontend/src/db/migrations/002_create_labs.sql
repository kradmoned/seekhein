BEGIN;

CREATE TABLE public.labs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    teacher_id UUID NOT NULL
        REFERENCES public.profiles(id),

    title TEXT NOT NULL,
    instructions TEXT NOT NULL,
    starter TEXT NOT NULL,
    tests TEXT NOT NULL,
    solution TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT labs_title_not_empty
        CHECK (length(btrim(title)) > 0),

    CONSTRAINT labs_instructions_not_empty
        CHECK (length(btrim(instructions)) > 0),

    CONSTRAINT labs_starter_not_empty
        CHECK (length(btrim(starter)) > 0),

    CONSTRAINT labs_tests_not_empty
        CHECK (length(btrim(tests)) > 0),

    CONSTRAINT labs_solution_not_empty
        CHECK (length(btrim(solution)) > 0)
);

CREATE INDEX labs_teacher_id_idx
    ON public.labs (teacher_id);

REVOKE ALL ON TABLE public.labs FROM anon, authenticated;

COMMIT;