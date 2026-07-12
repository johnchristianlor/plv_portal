-- PLV Supabase storage optimization helper
-- Safe to run the SELECT queries. The UPDATE cleanup at the bottom is optional.

-- 1) Find avatar rows that are wasting database storage.
select
  "studentNo",
  email,
  length(coalesce("avatarUrl", '')) as avatar_text_bytes,
  left("avatarUrl", 40) as avatar_prefix
from public.users
where length(coalesce("avatarUrl", '')) > 700
   or lower(coalesce("avatarUrl", '')) like 'data:image/%'
order by avatar_text_bytes desc;

-- 2) Estimate total avatar text currently stored in public.users.
select
  count(*) filter (where coalesce("avatarUrl", '') <> '') as avatar_rows,
  pg_size_pretty(coalesce(sum(length(coalesce("avatarUrl", ''))), 0)::bigint) as approximate_avatar_text_size,
  pg_size_pretty(coalesce(sum(length(coalesce("avatarUrl", ''))) filter (where lower(coalesce("avatarUrl", '')) like 'data:image/%'), 0)::bigint) as approximate_base64_avatar_size
from public.users;

-- 3) Optional immediate cleanup:
-- This reclaims Supabase database space from old base64 avatars, but those students will need to upload/select an avatar again.
-- Uncomment only if you accept that tradeoff.
-- update public.users
-- set "avatarUrl" = null
-- where lower(coalesce("avatarUrl", '')) like 'data:image/%'
--    or length(coalesce("avatarUrl", '')) > 700;