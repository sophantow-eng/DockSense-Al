create table public.phone_cams (
  id uuid primary key,
  name text not null,
  owner uuid not null default auth.uid(),
  seen_at timestamptz not null default now()
);
alter table public.phone_cams enable row level security;
create policy phone_cams_read on public.phone_cams for select to authenticated using ((select public.app_role()) in ('admin','staff','viewer'));
create policy phone_cams_ins on public.phone_cams for insert to authenticated with check ((select public.app_role()) in ('admin','staff') and owner = auth.uid());
create policy phone_cams_upd on public.phone_cams for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy phone_cams_del on public.phone_cams for delete to authenticated using (owner = auth.uid());
