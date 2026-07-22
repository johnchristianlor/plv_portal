-- Private mobile push mapping. Only Cloudflare Functions use this table.
create table if not exists public.push_subscriptions (
  subscription_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  announcements boolean not null default true,
  academic_results boolean not null default true,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_id_idx
  on public.push_subscriptions (user_id)
  where enabled = true;

alter table public.push_subscriptions enable row level security;
revoke all on table public.push_subscriptions from anon, authenticated;
grant all on table public.push_subscriptions to service_role;
