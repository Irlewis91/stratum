-- STRATUM Sync: run this once in your Supabase project (SQL Editor › New query › paste › Run).
-- It creates the list of each producer's synced beats and a private storage bucket for the beat files, with rules so
-- every producer can only ever see and change their own beats.

create table if not exists public.projects (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id         text        not null,
  name       text,
  size       bigint,
  device     text,
  rev        integer     not null default 1,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.projects enable row level security;

drop policy if exists "own beats: read"   on public.projects;
drop policy if exists "own beats: add"    on public.projects;
drop policy if exists "own beats: change" on public.projects;
drop policy if exists "own beats: delete" on public.projects;
create policy "own beats: read"   on public.projects for select to authenticated using (user_id = auth.uid());
create policy "own beats: add"    on public.projects for insert to authenticated with check (user_id = auth.uid());
create policy "own beats: change" on public.projects for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own beats: delete" on public.projects for delete to authenticated using (user_id = auth.uid());

-- Beat files live at projects/<user id>/<beat id>.stratum, up to 50 MB each (the free plan's limit).
insert into storage.buckets (id, name, public, file_size_limit)
values ('projects', 'projects', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

drop policy if exists "own beat files: read"   on storage.objects;
drop policy if exists "own beat files: add"    on storage.objects;
drop policy if exists "own beat files: change" on storage.objects;
drop policy if exists "own beat files: delete" on storage.objects;
create policy "own beat files: read"   on storage.objects for select to authenticated using (bucket_id = 'projects' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own beat files: add"    on storage.objects for insert to authenticated with check (bucket_id = 'projects' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own beat files: change" on storage.objects for update to authenticated using (bucket_id = 'projects' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own beat files: delete" on storage.objects for delete to authenticated using (bucket_id = 'projects' and (storage.foldername(name))[1] = auth.uid()::text);
