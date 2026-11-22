create table public.sinteria_site_blocks (
  id text primary key check (id ~ '^p[0-6]-b[0-9]{1,3}$'),
  page_id text not null check (page_id ~ '^p[0-6]$'),
  can_hide boolean not null,
  hidden boolean not null default false check (not hidden or can_hide),
  revision uuid
);

alter table public.sinteria_site_fields
  add column block_id text references public.sinteria_site_blocks (id),
  add column photo_hidden boolean not null default false check (not photo_hidden or kind = 'image');
create index on public.sinteria_site_fields (block_id);
grant select (photo_hidden) on public.sinteria_site_fields to anon, authenticated;

create table public.sinteria_site_contacts (
  singleton boolean primary key default true check (singleton),
  revision uuid,
  whatsapp text not null check (whatsapp ~ '^[1-9][0-9]{7,14}$'),
  email text not null check (char_length(email) <= 254),
  facebook text not null default '',
  instagram text not null default '',
  tiktok text not null default '',
  business_name text not null default '',
  business_address text not null default '',
  complaints_url text not null default ''
);
insert into public.sinteria_site_contacts (whatsapp, email, facebook)
values ('51932280554', 'contacto.sinteria@gmail.com', 'https://www.facebook.com/share/1cpzvtEMx2/');

create table public.sinteria_catalogs (
  id uuid primary key default gen_random_uuid(),
  page_id text not null check (page_id ~ '^p[0-6]$'),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  description text not null check (char_length(description) <= 1600),
  published boolean not null default false,
  revision uuid not null default gen_random_uuid()
);
create table public.sinteria_catalog_media (
  catalog_id uuid not null references public.sinteria_catalogs (id) on delete cascade,
  slot smallint not null check (slot between 1 and 4),
  revision uuid not null default gen_random_uuid(),
  photo bytea not null check (octet_length(photo) between 20 and 524288),
  alt text not null check (char_length(alt) <= 200),
  primary key (catalog_id, slot)
);

alter table public.sinteria_site_blocks enable row level security;
alter table public.sinteria_site_contacts enable row level security;
alter table public.sinteria_catalogs enable row level security;
alter table public.sinteria_catalog_media enable row level security;
revoke all on public.sinteria_site_blocks, public.sinteria_site_contacts,
  public.sinteria_catalogs, public.sinteria_catalog_media from public, anon, authenticated;
grant select on public.sinteria_site_blocks, public.sinteria_site_contacts, public.sinteria_catalogs to anon, authenticated;
grant select (catalog_id, slot, revision, alt) on public.sinteria_catalog_media to anon, authenticated;
grant select, update on public.sinteria_site_blocks, public.sinteria_site_contacts to service_role;
grant select, insert, update, delete on public.sinteria_catalogs, public.sinteria_catalog_media to service_role;
create policy "Public blocks" on public.sinteria_site_blocks for select to anon, authenticated using (true);
create policy "Public business contact" on public.sinteria_site_contacts for select to anon, authenticated using (true);
create policy "Published catalogs" on public.sinteria_catalogs for select to anon, authenticated using (published);
create policy "Published catalog photos" on public.sinteria_catalog_media
  for select to anon, authenticated using (
    exists (select 1 from public.sinteria_catalogs c where c.id = catalog_id and c.published)
  );

create table sinteria_web_private.daily_stats (
  day date not null,
  metric text not null check (metric in ('visit','whatsapp')),
  scope text not null check (
    scope ~ '^p[0-6]$' or (metric = 'whatsapp' and scope in ('ventas','reportes'))
  ),
  total integer not null check (total between 1 and 2000),
  primary key (day, metric, scope)
);
grant select, insert, update, delete on sinteria_web_private.daily_stats to service_role;

create function public.sinteria_catalog_list(p_page text) returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(c) || jsonb_build_object('photos', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'slot', m.slot, 'revision', m.revision, 'alt', m.alt) order by m.slot), '[]'::jsonb)
    from public.sinteria_catalog_media m where m.catalog_id = c.id
  )) order by c.title, c.id), '[]'::jsonb)
  from public.sinteria_catalogs c where p_page is null or c.page_id = p_page;
$$;

create function public.sinteria_public_snapshot(p_page text) returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select jsonb_build_object(
    'contacts', (select to_jsonb(c) from public.sinteria_site_contacts c),
    'fields', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', f.id, 'revision', f.revision, 'display_value', f.display_value,
        'has_photo', f.has_photo, 'photo_alt', f.photo_alt, 'photo_hidden', f.photo_hidden
      )), '[]'::jsonb)
      from public.sinteria_site_fields f
      where (f.page_id = p_page or (p_page = 'p0' and f.id in ('p1-price-0','p2-price-0')))
        and (f.display_value is not null or f.has_photo or f.photo_hidden)
    ),
    'hidden_blocks', (
      select coalesce(jsonb_agg(b.id), '[]'::jsonb) from public.sinteria_site_blocks b
      where b.page_id = p_page and b.hidden
    ),
    'catalogs', case when p_page ~ '^p[0-6]$' then public.sinteria_catalog_list(p_page) else '[]'::jsonb end
  );
$$;

create function public.sinteria_editor_snapshot() returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select jsonb_build_object(
    'contacts', (select to_jsonb(c) from public.sinteria_site_contacts c),
    'fields', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', f.id, 'revision', f.revision, 'value', f.value, 'price_visible', f.price_visible,
        'has_photo', f.has_photo, 'photo_alt', f.photo_alt, 'photo_hidden', f.photo_hidden
      )), '[]'::jsonb) from public.sinteria_site_fields f where f.revision is not null
    ),
    'blocks', (
      select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'revision',b.revision,'hidden',b.hidden)), '[]'::jsonb)
      from public.sinteria_site_blocks b where b.revision is not null
    ),
    'catalogs', public.sinteria_catalog_list(null),
    'photo_bytes', (select used_bytes from sinteria_web_private.photo_quota where singleton)
  );
$$;

create function public.sinteria_write_block(p_id text, p_revision uuid, p_hidden boolean, p_changes jsonb)
returns void language plpgsql security invoker set search_path = ''
as $$
declare
  current_block public.sinteria_site_blocks%rowtype;
  field jsonb;
  key text;
  mode text;
begin
  select * into current_block from public.sinteria_site_blocks where id = p_id for update;
  if not found then
    raise sqlstate 'PT404' using message = 'La tarjeta ya no está disponible.';
  end if;
  if current_block.revision is distinct from p_revision then
    raise sqlstate 'PT409' using message = 'La tarjeta cambió en otra sesión. Vuelve a abrirla.';
  end if;
  perform f.id from public.sinteria_site_fields f
    where f.id in (select item->>'id' from jsonb_array_elements(p_changes) item)
    order by f.id for update;
  for field in select value from jsonb_array_elements(p_changes) loop
    key := field->>'id';
    mode := field->>'mode';
    if not exists (select 1 from public.sinteria_site_fields where id = key and block_id = p_id) then
      raise sqlstate 'PT400' using message = 'Un campo no pertenece a esta tarjeta.';
    end if;
    perform public.sinteria_save_field(key, (field->>'revision')::uuid, field->>'value',
      coalesce((field->>'priceVisible')::boolean, false), field->>'photo', field->>'alt');
    if split_part(key, '-', 2) = 'image' then
      update public.sinteria_site_fields set photo_hidden = (mode = 'hide') where id = key;
    end if;
  end loop;
  update public.sinteria_site_blocks
    set hidden = p_hidden, revision = gen_random_uuid() where id = p_id;
end;
$$;

create function public.sinteria_write_contacts(p_revision uuid, p_values jsonb)
returns void language plpgsql security invoker set search_path = ''
as $$
begin
  update public.sinteria_site_contacts set
    revision = gen_random_uuid(), whatsapp = p_values->>'whatsapp', email = p_values->>'email',
    facebook = p_values->>'facebook', instagram = p_values->>'instagram', tiktok = p_values->>'tiktok',
    business_name = p_values->>'business_name', business_address = p_values->>'business_address',
    complaints_url = p_values->>'complaints_url'
  where singleton and revision is not distinct from p_revision;
  if not found then raise sqlstate 'PT409' using message = 'El contacto cambió en otra sesión. Vuelve a cargarlo.'; end if;
end;
$$;

create function public.sinteria_write_catalog(p_id uuid, p_revision uuid, p_remove boolean,
  p_page text, p_title text, p_description text, p_published boolean, p_photos jsonb)
returns uuid language plpgsql security invoker set search_path = ''
as $$
declare
  item jsonb;
  next_photo bytea;
  number smallint;
  old_bytes integer;
  byte_delta integer := 0;
  current_revision uuid;
begin
  perform pg_advisory_xact_lock(215306730);
  if p_id is not null then
    select revision into current_revision from public.sinteria_catalogs where id = p_id;
    if not found then raise sqlstate 'PT404' using message = 'El catálogo ya no existe.'; end if;
    if current_revision is distinct from p_revision then
      raise sqlstate 'PT409' using message = 'El catálogo cambió en otra sesión. Vuelve a cargarlo.';
    end if;
  end if;
  if p_remove then
    select -coalesce(sum(octet_length(photo)), 0)::integer into byte_delta
      from public.sinteria_catalog_media where catalog_id = p_id;
    delete from public.sinteria_catalogs where id = p_id;
  else
    if p_id is null then
      if (select count(*) from public.sinteria_catalogs) >= 12 then
        raise sqlstate 'PT413' using message = 'Llegaste al máximo de 12 catálogos.';
      end if;
      insert into public.sinteria_catalogs (page_id, title, description, published)
        values (p_page, p_title, p_description, p_published) returning id into p_id;
    else
      update public.sinteria_catalogs set page_id = p_page, title = p_title, description = p_description,
        published = p_published, revision = gen_random_uuid() where id = p_id;
    end if;
    for item in select value from jsonb_array_elements(p_photos) loop
      number := (item->>'slot')::smallint;
      next_photo := decode(item->>'photo','base64');
      select coalesce(octet_length(m.photo), 0) into old_bytes
        from public.sinteria_catalog_media m where m.catalog_id = p_id and m.slot = number;
      byte_delta := byte_delta + coalesce(octet_length(next_photo),0) - coalesce(old_bytes,0);
      if next_photo is null then
        delete from public.sinteria_catalog_media where catalog_id = p_id and slot = number;
      else
        insert into public.sinteria_catalog_media (catalog_id, slot, photo, alt)
        values (p_id, number, next_photo, coalesce(item->>'alt',''))
        on conflict (catalog_id, slot) do update set photo = excluded.photo, alt = excluded.alt, revision = gen_random_uuid();
      end if;
    end loop;
  end if;
  if byte_delta <> 0 then
    update sinteria_web_private.photo_quota set used_bytes = used_bytes + byte_delta
      where singleton and used_bytes + byte_delta <= 20971520;
    if not found then
      raise sqlstate 'PT413' using message = 'Las fotos llegaron a 20 MiB. Retira una antes de subir otra.';
    end if;
  end if;
  return p_id;
end;
$$;

create function public.sinteria_read_catalog_photo(p_id uuid, p_slot smallint, p_revision uuid, p_private boolean)
returns text language sql stable security invoker set search_path = ''
as $$
  select encode(m.photo,'base64') from public.sinteria_catalog_media m
  join public.sinteria_catalogs c on c.id = m.catalog_id
  where m.catalog_id = p_id and m.slot = p_slot and m.revision = p_revision and (c.published or p_private);
$$;

create function public.sinteria_record_stat(p_metric text, p_scope text) returns void
language plpgsql security invoker set search_path = ''
as $$
declare
  today date := (now() at time zone 'America/Lima')::date;
  events integer;
begin
  perform pg_advisory_xact_lock(215306731);
  select coalesce(sum(total),0)::integer into events from sinteria_web_private.daily_stats where day=today;
  if events >= 2000 then return; end if;
  if events = 0 then delete from sinteria_web_private.daily_stats where day < today - 179; end if;
  insert into sinteria_web_private.daily_stats(day,metric,scope,total) values(today,p_metric,p_scope,1)
  on conflict(day,metric,scope) do update set total=sinteria_web_private.daily_stats.total + 1;
end;
$$;

create function public.sinteria_read_stats(p_days integer) returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(data)), '[]'::jsonb) from (
    select metric, scope, sum(total)::integer as total
    from sinteria_web_private.daily_stats
    where day >= (now() at time zone 'America/Lima')::date - least(greatest(p_days, 1), 30) + 1
    group by metric, scope
  ) data;
$$;

revoke execute on function public.sinteria_catalog_list(text), public.sinteria_public_snapshot(text),
 public.sinteria_editor_snapshot(), public.sinteria_write_block(text,uuid,boolean,jsonb),
 public.sinteria_write_contacts(uuid,jsonb), public.sinteria_write_catalog(uuid,uuid,boolean,text,text,text,boolean,jsonb),
 public.sinteria_read_catalog_photo(uuid,smallint,uuid,boolean), public.sinteria_record_stat(text,text),
 public.sinteria_read_stats(integer) from public, anon, authenticated;
grant execute on function public.sinteria_catalog_list(text), public.sinteria_public_snapshot(text)
 to anon, authenticated, service_role;
grant execute on function public.sinteria_editor_snapshot(), public.sinteria_write_block(text,uuid,boolean,jsonb),
 public.sinteria_write_contacts(uuid,jsonb), public.sinteria_write_catalog(uuid,uuid,boolean,text,text,text,boolean,jsonb),
 public.sinteria_read_catalog_photo(uuid,smallint,uuid,boolean), public.sinteria_record_stat(text,text),
 public.sinteria_read_stats(integer) to service_role;
insert into public.sinteria_site_blocks (id, page_id, can_hide) values
  ('p0-b1', 'p0', false),
  ('p0-b2', 'p0', false),
  ('p0-b3', 'p0', true),
  ('p0-b4', 'p0', true),
  ('p0-b5', 'p0', false),
  ('p0-b6', 'p0', true),
  ('p0-b7', 'p0', true),
  ('p0-b8', 'p0', true),
  ('p0-b9', 'p0', false),
  ('p0-b10', 'p0', true),
  ('p0-b11', 'p0', true),
  ('p0-b12', 'p0', true),
  ('p0-b13', 'p0', true),
  ('p0-b14', 'p0', false),
  ('p0-b15', 'p0', false),
  ('p1-b1', 'p1', false),
  ('p1-b2', 'p1', false),
  ('p1-b3', 'p1', true),
  ('p1-b4', 'p1', true),
  ('p1-b5', 'p1', true),
  ('p1-b6', 'p1', true),
  ('p1-b7', 'p1', true),
  ('p1-b8', 'p1', true),
  ('p1-b9', 'p1', false),
  ('p1-b10', 'p1', true),
  ('p1-b11', 'p1', true),
  ('p1-b12', 'p1', true),
  ('p1-b13', 'p1', false),
  ('p1-b14', 'p1', false),
  ('p1-b15', 'p1', true),
  ('p1-b16', 'p1', true),
  ('p1-b17', 'p1', true),
  ('p1-b18', 'p1', false),
  ('p1-b19', 'p1', true),
  ('p1-b20', 'p1', true),
  ('p1-b21', 'p1', true),
  ('p1-b22', 'p1', true),
  ('p1-b23', 'p1', false),
  ('p2-b1', 'p2', false),
  ('p2-b2', 'p2', false),
  ('p2-b3', 'p2', true),
  ('p2-b4', 'p2', true),
  ('p2-b5', 'p2', true),
  ('p2-b6', 'p2', true),
  ('p2-b7', 'p2', true),
  ('p2-b8', 'p2', true),
  ('p2-b9', 'p2', false),
  ('p2-b10', 'p2', false),
  ('p2-b11', 'p2', true),
  ('p2-b12', 'p2', true),
  ('p2-b13', 'p2', true),
  ('p2-b14', 'p2', true),
  ('p2-b15', 'p2', false),
  ('p2-b16', 'p2', true),
  ('p2-b17', 'p2', true),
  ('p2-b18', 'p2', true),
  ('p2-b19', 'p2', false),
  ('p2-b20', 'p2', true),
  ('p2-b21', 'p2', true),
  ('p2-b22', 'p2', true),
  ('p2-b23', 'p2', true),
  ('p2-b24', 'p2', false),
  ('p3-b1', 'p3', false),
  ('p3-b2', 'p3', false),
  ('p3-b3', 'p3', true),
  ('p3-b4', 'p3', true),
  ('p3-b5', 'p3', true),
  ('p3-b6', 'p3', true),
  ('p3-b7', 'p3', true),
  ('p3-b8', 'p3', true),
  ('p3-b9', 'p3', false),
  ('p3-b10', 'p3', false),
  ('p3-b11', 'p3', true),
  ('p3-b12', 'p3', true),
  ('p3-b13', 'p3', true),
  ('p3-b14', 'p3', true),
  ('p3-b15', 'p3', false),
  ('p4-b1', 'p4', false),
  ('p4-b2', 'p4', false),
  ('p4-b3', 'p4', true),
  ('p4-b4', 'p4', true),
  ('p4-b5', 'p4', true),
  ('p4-b6', 'p4', true),
  ('p4-b7', 'p4', true),
  ('p4-b8', 'p4', true),
  ('p4-b9', 'p4', false),
  ('p4-b10', 'p4', false),
  ('p4-b11', 'p4', true),
  ('p4-b12', 'p4', true),
  ('p4-b13', 'p4', true),
  ('p4-b14', 'p4', true),
  ('p4-b15', 'p4', false),
  ('p5-b1', 'p5', false),
  ('p5-b2', 'p5', false),
  ('p5-b3', 'p5', true),
  ('p5-b4', 'p5', true),
  ('p5-b5', 'p5', true),
  ('p5-b6', 'p5', true),
  ('p5-b7', 'p5', true),
  ('p5-b8', 'p5', true),
  ('p5-b9', 'p5', false),
  ('p5-b10', 'p5', false),
  ('p5-b11', 'p5', true),
  ('p5-b12', 'p5', true),
  ('p5-b13', 'p5', true),
  ('p5-b14', 'p5', true),
  ('p5-b15', 'p5', false),
  ('p6-b1', 'p6', false),
  ('p6-b2', 'p6', false),
  ('p6-b3', 'p6', true),
  ('p6-b4', 'p6', true),
  ('p6-b5', 'p6', true),
  ('p6-b6', 'p6', true),
  ('p6-b7', 'p6', true),
  ('p6-b8', 'p6', true),
  ('p6-b9', 'p6', false),
  ('p6-b10', 'p6', false),
  ('p6-b11', 'p6', true),
  ('p6-b12', 'p6', true),
  ('p6-b13', 'p6', true),
  ('p6-b14', 'p6', true),
  ('p6-b15', 'p6', false);

update public.sinteria_site_fields as f set block_id = v.block_id from (values
  ('p0-text-0', 'p0-b1'),
  ('p0-text-1', 'p0-b1'),
  ('p0-image-0', 'p0-b1'),
  ('p0-image-1', 'p0-b1'),
  ('p0-image-2', 'p0-b1'),
  ('p0-text-2', 'p0-b1'),
  ('p0-text-3', 'p0-b2'),
  ('p0-text-4', 'p0-b2'),
  ('p0-image-3', 'p0-b3'),
  ('p0-text-5', 'p0-b3'),
  ('p0-text-6', 'p0-b3'),
  ('p0-image-4', 'p0-b4'),
  ('p0-text-7', 'p0-b4'),
  ('p0-text-8', 'p0-b4'),
  ('p0-text-9', 'p0-b5'),
  ('p0-text-10', 'p0-b5'),
  ('p0-image-5', 'p0-b6'),
  ('p0-text-11', 'p0-b6'),
  ('p0-image-6', 'p0-b7'),
  ('p0-text-12', 'p0-b7'),
  ('p0-image-7', 'p0-b8'),
  ('p0-text-13', 'p0-b8'),
  ('p0-text-15', 'p0-b9'),
  ('p0-image-8', 'p0-b10'),
  ('p0-text-16', 'p0-b10'),
  ('p0-text-17', 'p0-b10'),
  ('p0-image-9', 'p0-b11'),
  ('p0-text-18', 'p0-b11'),
  ('p0-text-19', 'p0-b11'),
  ('p0-image-10', 'p0-b12'),
  ('p0-text-20', 'p0-b12'),
  ('p0-text-21', 'p0-b12'),
  ('p0-image-11', 'p0-b13'),
  ('p0-text-22', 'p0-b13'),
  ('p0-text-23', 'p0-b13'),
  ('p0-image-12', 'p0-b14'),
  ('p0-text-24', 'p0-b14'),
  ('p0-text-25', 'p0-b14'),
  ('p0-image-13', 'p0-b15'),
  ('p0-text-26', 'p0-b15'),
  ('p0-text-27', 'p0-b15'),
  ('p1-text-0', 'p1-b1'),
  ('p1-text-1', 'p1-b1'),
  ('p1-image-0', 'p1-b1'),
  ('p1-image-1', 'p1-b1'),
  ('p1-image-2', 'p1-b1'),
  ('p1-text-2', 'p1-b1'),
  ('p1-price-0', 'p1-b1'),
  ('p1-text-3', 'p1-b2'),
  ('p1-text-4', 'p1-b2'),
  ('p1-image-3', 'p1-b3'),
  ('p1-text-5', 'p1-b3'),
  ('p1-text-6', 'p1-b3'),
  ('p1-image-4', 'p1-b4'),
  ('p1-text-7', 'p1-b4'),
  ('p1-text-8', 'p1-b4'),
  ('p1-image-5', 'p1-b5'),
  ('p1-text-9', 'p1-b5'),
  ('p1-text-10', 'p1-b5'),
  ('p1-image-6', 'p1-b6'),
  ('p1-text-11', 'p1-b6'),
  ('p1-text-12', 'p1-b6'),
  ('p1-image-7', 'p1-b7'),
  ('p1-text-13', 'p1-b7'),
  ('p1-text-14', 'p1-b7'),
  ('p1-image-8', 'p1-b8'),
  ('p1-text-15', 'p1-b8'),
  ('p1-text-16', 'p1-b8'),
  ('p1-text-18', 'p1-b9'),
  ('p1-text-19', 'p1-b9'),
  ('p1-image-9', 'p1-b10'),
  ('p1-text-20', 'p1-b10'),
  ('p1-image-10', 'p1-b11'),
  ('p1-text-21', 'p1-b11'),
  ('p1-image-11', 'p1-b12'),
  ('p1-text-22', 'p1-b12'),
  ('p1-text-24', 'p1-b13'),
  ('p1-text-25', 'p1-b13'),
  ('p1-image-12', 'p1-b13'),
  ('p1-text-26', 'p1-b14'),
  ('p1-text-27', 'p1-b14'),
  ('p1-image-13', 'p1-b15'),
  ('p1-text-28', 'p1-b15'),
  ('p1-text-29', 'p1-b15'),
  ('p1-image-14', 'p1-b16'),
  ('p1-text-30', 'p1-b16'),
  ('p1-text-31', 'p1-b16'),
  ('p1-image-15', 'p1-b17'),
  ('p1-text-32', 'p1-b17'),
  ('p1-text-33', 'p1-b17'),
  ('p1-image-16', 'p1-b18'),
  ('p1-text-34', 'p1-b18'),
  ('p1-text-35', 'p1-b18'),
  ('p1-text-36', 'p1-b18'),
  ('p1-text-37', 'p1-b19'),
  ('p1-text-38', 'p1-b19'),
  ('p1-text-39', 'p1-b20'),
  ('p1-text-40', 'p1-b20'),
  ('p1-text-41', 'p1-b21'),
  ('p1-text-42', 'p1-b21'),
  ('p1-text-43', 'p1-b22'),
  ('p1-text-44', 'p1-b22'),
  ('p1-image-17', 'p1-b23'),
  ('p1-text-45', 'p1-b23'),
  ('p1-text-46', 'p1-b23'),
  ('p2-text-0', 'p2-b1'),
  ('p2-text-1', 'p2-b1'),
  ('p2-image-0', 'p2-b1'),
  ('p2-image-1', 'p2-b1'),
  ('p2-image-2', 'p2-b1'),
  ('p2-text-2', 'p2-b1'),
  ('p2-price-0', 'p2-b1'),
  ('p2-text-3', 'p2-b2'),
  ('p2-text-4', 'p2-b2'),
  ('p2-image-3', 'p2-b3'),
  ('p2-text-5', 'p2-b3'),
  ('p2-text-6', 'p2-b3'),
  ('p2-image-4', 'p2-b4'),
  ('p2-text-7', 'p2-b4'),
  ('p2-text-8', 'p2-b4'),
  ('p2-image-5', 'p2-b5'),
  ('p2-text-9', 'p2-b5'),
  ('p2-text-10', 'p2-b5'),
  ('p2-image-6', 'p2-b6'),
  ('p2-text-11', 'p2-b6'),
  ('p2-text-12', 'p2-b6'),
  ('p2-image-7', 'p2-b7'),
  ('p2-text-13', 'p2-b7'),
  ('p2-text-14', 'p2-b7'),
  ('p2-image-8', 'p2-b8'),
  ('p2-text-15', 'p2-b8'),
  ('p2-text-16', 'p2-b8'),
  ('p2-image-9', 'p2-b9'),
  ('p2-text-18', 'p2-b9'),
  ('p2-text-19', 'p2-b9'),
  ('p2-image-10', 'p2-b9'),
  ('p2-text-21', 'p2-b10'),
  ('p2-image-11', 'p2-b11'),
  ('p2-text-22', 'p2-b11'),
  ('p2-text-23', 'p2-b11'),
  ('p2-image-12', 'p2-b12'),
  ('p2-text-24', 'p2-b12'),
  ('p2-text-25', 'p2-b12'),
  ('p2-image-13', 'p2-b13'),
  ('p2-text-26', 'p2-b13'),
  ('p2-text-27', 'p2-b13'),
  ('p2-image-14', 'p2-b14'),
  ('p2-text-28', 'p2-b14'),
  ('p2-text-29', 'p2-b14'),
  ('p2-text-30', 'p2-b15'),
  ('p2-text-31', 'p2-b15'),
  ('p2-image-15', 'p2-b16'),
  ('p2-text-32', 'p2-b16'),
  ('p2-text-33', 'p2-b16'),
  ('p2-image-16', 'p2-b17'),
  ('p2-text-34', 'p2-b17'),
  ('p2-text-35', 'p2-b17'),
  ('p2-image-17', 'p2-b18'),
  ('p2-text-36', 'p2-b18'),
  ('p2-text-37', 'p2-b18'),
  ('p2-image-18', 'p2-b19'),
  ('p2-text-38', 'p2-b19'),
  ('p2-text-39', 'p2-b19'),
  ('p2-text-40', 'p2-b19'),
  ('p2-text-41', 'p2-b20'),
  ('p2-text-42', 'p2-b20'),
  ('p2-text-43', 'p2-b21'),
  ('p2-text-44', 'p2-b21'),
  ('p2-text-45', 'p2-b22'),
  ('p2-text-46', 'p2-b22'),
  ('p2-text-47', 'p2-b23'),
  ('p2-text-48', 'p2-b23'),
  ('p2-image-19', 'p2-b24'),
  ('p2-text-49', 'p2-b24'),
  ('p2-text-50', 'p2-b24'),
  ('p3-text-0', 'p3-b1'),
  ('p3-text-1', 'p3-b1'),
  ('p3-price-0', 'p3-b1'),
  ('p3-text-3', 'p3-b2'),
  ('p3-text-4', 'p3-b2'),
  ('p3-text-5', 'p3-b2'),
  ('p3-text-6', 'p3-b3'),
  ('p3-text-7', 'p3-b3'),
  ('p3-text-8', 'p3-b4'),
  ('p3-text-9', 'p3-b4'),
  ('p3-text-10', 'p3-b5'),
  ('p3-text-11', 'p3-b5'),
  ('p3-text-12', 'p3-b6'),
  ('p3-text-13', 'p3-b6'),
  ('p3-text-15', 'p3-b7'),
  ('p3-text-16', 'p3-b7'),
  ('p3-text-17', 'p3-b8'),
  ('p3-text-18', 'p3-b8'),
  ('p3-text-19', 'p3-b9'),
  ('p3-text-20', 'p3-b9'),
  ('p3-text-21', 'p3-b9'),
  ('p3-text-22', 'p3-b9'),
  ('p3-text-23', 'p3-b9'),
  ('p3-text-24', 'p3-b10'),
  ('p3-text-25', 'p3-b10'),
  ('p3-text-26', 'p3-b11'),
  ('p3-text-27', 'p3-b11'),
  ('p3-text-28', 'p3-b12'),
  ('p3-text-29', 'p3-b12'),
  ('p3-text-30', 'p3-b13'),
  ('p3-text-31', 'p3-b13'),
  ('p3-text-32', 'p3-b14'),
  ('p3-text-33', 'p3-b14'),
  ('p3-text-34', 'p3-b15'),
  ('p4-text-0', 'p4-b1'),
  ('p4-text-1', 'p4-b1'),
  ('p4-price-0', 'p4-b1'),
  ('p4-text-3', 'p4-b2'),
  ('p4-text-4', 'p4-b2'),
  ('p4-text-5', 'p4-b2'),
  ('p4-text-6', 'p4-b3'),
  ('p4-text-7', 'p4-b3'),
  ('p4-text-8', 'p4-b4'),
  ('p4-text-9', 'p4-b4'),
  ('p4-text-10', 'p4-b5'),
  ('p4-text-11', 'p4-b5'),
  ('p4-text-12', 'p4-b6'),
  ('p4-text-13', 'p4-b6'),
  ('p4-text-15', 'p4-b7'),
  ('p4-text-16', 'p4-b7'),
  ('p4-text-17', 'p4-b8'),
  ('p4-text-18', 'p4-b8'),
  ('p4-text-19', 'p4-b9'),
  ('p4-text-20', 'p4-b9'),
  ('p4-text-21', 'p4-b9'),
  ('p4-text-22', 'p4-b9'),
  ('p4-text-23', 'p4-b9'),
  ('p4-text-24', 'p4-b10'),
  ('p4-text-25', 'p4-b10'),
  ('p4-text-26', 'p4-b11'),
  ('p4-text-27', 'p4-b11'),
  ('p4-text-28', 'p4-b12'),
  ('p4-text-29', 'p4-b12'),
  ('p4-text-30', 'p4-b13'),
  ('p4-text-31', 'p4-b13'),
  ('p4-text-32', 'p4-b14'),
  ('p4-text-33', 'p4-b14'),
  ('p4-text-34', 'p4-b15'),
  ('p5-text-0', 'p5-b1'),
  ('p5-text-1', 'p5-b1'),
  ('p5-price-0', 'p5-b1'),
  ('p5-text-3', 'p5-b2'),
  ('p5-text-4', 'p5-b2'),
  ('p5-text-5', 'p5-b2'),
  ('p5-text-6', 'p5-b3'),
  ('p5-text-7', 'p5-b3'),
  ('p5-text-8', 'p5-b4'),
  ('p5-text-9', 'p5-b4'),
  ('p5-text-10', 'p5-b5'),
  ('p5-text-11', 'p5-b5'),
  ('p5-text-12', 'p5-b6'),
  ('p5-text-13', 'p5-b6'),
  ('p5-text-15', 'p5-b7'),
  ('p5-text-16', 'p5-b7'),
  ('p5-text-17', 'p5-b8'),
  ('p5-text-18', 'p5-b8'),
  ('p5-text-19', 'p5-b9'),
  ('p5-text-20', 'p5-b9'),
  ('p5-text-21', 'p5-b9'),
  ('p5-text-22', 'p5-b9'),
  ('p5-text-23', 'p5-b9'),
  ('p5-text-24', 'p5-b10'),
  ('p5-text-25', 'p5-b10'),
  ('p5-text-26', 'p5-b11'),
  ('p5-text-27', 'p5-b11'),
  ('p5-text-28', 'p5-b12'),
  ('p5-text-29', 'p5-b12'),
  ('p5-text-30', 'p5-b13'),
  ('p5-text-31', 'p5-b13'),
  ('p5-text-32', 'p5-b14'),
  ('p5-text-33', 'p5-b14'),
  ('p5-text-34', 'p5-b15'),
  ('p6-text-0', 'p6-b1'),
  ('p6-text-1', 'p6-b1'),
  ('p6-price-0', 'p6-b1'),
  ('p6-text-3', 'p6-b2'),
  ('p6-text-4', 'p6-b2'),
  ('p6-text-5', 'p6-b2'),
  ('p6-text-6', 'p6-b3'),
  ('p6-text-7', 'p6-b3'),
  ('p6-text-8', 'p6-b4'),
  ('p6-text-9', 'p6-b4'),
  ('p6-text-10', 'p6-b5'),
  ('p6-text-11', 'p6-b5'),
  ('p6-text-12', 'p6-b6'),
  ('p6-text-13', 'p6-b6'),
  ('p6-text-15', 'p6-b7'),
  ('p6-text-16', 'p6-b7'),
  ('p6-text-17', 'p6-b8'),
  ('p6-text-18', 'p6-b8'),
  ('p6-text-19', 'p6-b9'),
  ('p6-text-20', 'p6-b9'),
  ('p6-text-21', 'p6-b9'),
  ('p6-text-22', 'p6-b9'),
  ('p6-text-23', 'p6-b9'),
  ('p6-text-24', 'p6-b10'),
  ('p6-text-25', 'p6-b10'),
  ('p6-text-26', 'p6-b11'),
  ('p6-text-27', 'p6-b11'),
  ('p6-text-28', 'p6-b12'),
  ('p6-text-29', 'p6-b12'),
  ('p6-text-30', 'p6-b13'),
  ('p6-text-31', 'p6-b13'),
  ('p6-text-32', 'p6-b14'),
  ('p6-text-33', 'p6-b14'),
  ('p6-text-34', 'p6-b15')
) as v(id, block_id) where f.id = v.id;

alter table public.sinteria_site_fields alter column block_id set not null;
