-- cooking-recipe-note 用のテーブル(Supabase の SQL Editor に貼って Run する)
-- 1人ごとにデータを分け,本人だけが読み書きできるようにする(RLS=行ごとのアクセス制限)

-- レシピ:1レシピ=1行.消したものは deleted=true にして残す(別の端末に「消した」を伝えるため)
create table if not exists public.recipes (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  id         text        not null,
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  deleted    boolean     not null default false,
  primary key (user_id, id)
);

-- 食材庫・XP・表示名など,1人1行
create table if not exists public.user_meta (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  data       jsonb       not null,
  updated_at timestamptz not null default now()
);

alter table public.recipes   enable row level security;
alter table public.user_meta enable row level security;

drop policy if exists "own recipes" on public.recipes;
create policy "own recipes" on public.recipes
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "own meta" on public.user_meta;
create policy "own meta" on public.user_meta
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
