alter table public.notification_channels add column if not exists company_id uuid references public.companies(id) on delete set null;
comment on column public.notification_channels.company_id is 'ถ้าตั้งค่า = ช่องทางของลูกค้าบริษัทนี้: ได้รับแจ้งและถามบอทได้เฉพาะรถของบริษัทนี้';
