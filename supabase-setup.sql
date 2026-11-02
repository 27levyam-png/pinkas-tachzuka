-- פנקס הוצאות תחזוקה – הגדרת השרת
-- מדביקים את כל הקובץ ב-Supabase → SQL Editor → New query, ולוחצים Run.

-- טבלה אחת לכל הנתונים: דירות, הוצאות, הוצאות קבועות, הגדרות ומשתמשים
create table if not exists public.docs (
  collection text not null,
  id         text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);

alter table public.docs enable row level security;
alter table public.docs replica identity full;
grant select, insert, update, delete on public.docs to authenticated;

-- רק משתמשים מחוברים (אתה והעובדים שפתחת להם משתמש) יכולים לקרוא ולכתוב
drop policy if exists "team read"   on public.docs;
drop policy if exists "team insert" on public.docs;
drop policy if exists "team update" on public.docs;
drop policy if exists "team delete" on public.docs;
create policy "team read"   on public.docs for select to authenticated using (true);
create policy "team insert" on public.docs for insert to authenticated with check (true);
create policy "team update" on public.docs for update to authenticated using (true) with check (true);
create policy "team delete" on public.docs for delete to authenticated using (true);

-- עדכון חי בין המכשירים
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- תיקייה פרטית לקבלות
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

drop policy if exists "team receipts read"   on storage.objects;
drop policy if exists "team receipts insert" on storage.objects;
drop policy if exists "team receipts update" on storage.objects;
drop policy if exists "team receipts delete" on storage.objects;
create policy "team receipts read"   on storage.objects for select to authenticated using (bucket_id = 'receipts');
create policy "team receipts insert" on storage.objects for insert to authenticated with check (bucket_id = 'receipts');
create policy "team receipts update" on storage.objects for update to authenticated using (bucket_id = 'receipts');
create policy "team receipts delete" on storage.objects for delete to authenticated using (bucket_id = 'receipts');
