create table if not exists public.telegram_seen_chats (
  chat_id text primary key,
  title text,
  type text,
  seen_at timestamptz not null default now()
);
alter table public.telegram_seen_chats enable row level security;
comment on table public.telegram_seen_chats is 'แชต Telegram ที่บอทเห็น (เขียนโดย edge function telegram-bot เท่านั้น ไม่เปิดให้ client)';
