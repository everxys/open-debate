alter table debate_resume_jobs
  add column if not exists attempt_count integer not null default 0;

create index if not exists idx_debate_resume_jobs_status_resume_attempt
  on debate_resume_jobs (status, resume_at asc, attempt_count asc, updated_at asc);
