-- 特斯拉充电地图：账号绑定 NAS 接口
-- 只新建一张表 dokomademap_nas_bindings，不改动小家控、日和账本的任何表、函数和策略。
-- 可以重复执行（已存在就跳过）。请在 Supabase 的 SQL Editor 里执行。

create table if not exists public.dokomademap_nas_bindings (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  nas_url    text not null default '',
  nas_token  text not null default '',
  updated_at timestamptz not null default now()
);

-- 打开行级权限：没有策略允许的操作一律拒绝
alter table public.dokomademap_nas_bindings enable row level security;

-- 读：自己那一行，加上同一个小家（household）里其他成员的那一行，
-- 这样两个人共用一个 NAS，谁存的设置另一个人登录也能自动用上。
-- 只引用小家控的 household_members / is_household_member，不修改它们。
drop policy if exists "dokomademap_nas_select_own" on public.dokomademap_nas_bindings;
create policy "dokomademap_nas_select_own" on public.dokomademap_nas_bindings
  for select to authenticated using (
    auth.uid() = user_id
    or exists (
      select 1 from public.household_members m
      where m.user_id = dokomademap_nas_bindings.user_id
        and public.is_household_member(m.household_id)
    )
  );

-- 建、改、删：只能动自己那一行

drop policy if exists "dokomademap_nas_insert_own" on public.dokomademap_nas_bindings;
create policy "dokomademap_nas_insert_own" on public.dokomademap_nas_bindings
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "dokomademap_nas_update_own" on public.dokomademap_nas_bindings;
create policy "dokomademap_nas_update_own" on public.dokomademap_nas_bindings
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "dokomademap_nas_delete_own" on public.dokomademap_nas_bindings;
create policy "dokomademap_nas_delete_own" on public.dokomademap_nas_bindings
  for delete to authenticated using (auth.uid() = user_id);

-- 未登录的访客（anon）完全不能碰这张表
revoke all on public.dokomademap_nas_bindings from anon;
grant select, insert, update, delete on public.dokomademap_nas_bindings to authenticated;
