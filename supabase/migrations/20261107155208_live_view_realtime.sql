alter table public.camera_devices add column if not exists local_ip text;
create or replace view public.camera_status as
 select id, name, enabled, last_seen, last_plate, preview_at, local_ip
 from public.camera_devices
 where (select public.app_role()) = any (array['admin','staff','viewer']);

-- ภาพสด: Realtime private channels (live:*) ต้องล็อกอินและมีสิทธิ์
create policy live_receive on realtime.messages for select to authenticated
  using (realtime.topic() like 'live%' and (select public.app_role()) in ('admin','staff','viewer'));
create policy live_send_frames on realtime.messages for insert to authenticated
  with check (realtime.topic() like 'live%' and extension = 'broadcast' and (select public.app_role()) in ('admin','staff'));
create policy live_presence on realtime.messages for insert to authenticated
  with check (realtime.topic() like 'live%' and extension = 'presence' and (select public.app_role()) in ('admin','staff','viewer'));
