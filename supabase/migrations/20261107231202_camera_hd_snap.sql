alter table public.camera_devices add column if not exists snap_req_at timestamptz, add column if not exists snap_at timestamptz;
create or replace function public.camera_snap(p_id uuid) returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if (select app_role()) not in ('admin','staff') then raise exception 'FORBIDDEN'; end if;
  update public.camera_devices set snap_req_at = now(), watch_until = greatest(coalesce(watch_until, now()), now() + interval '45 seconds') where id = p_id and enabled;
end $$;
revoke all on function public.camera_snap(uuid) from public, anon;
grant execute on function public.camera_snap(uuid) to authenticated;
