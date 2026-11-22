create schema sinteria_web_private;
revoke all on schema sinteria_web_private from public;
grant usage on schema sinteria_web_private to service_role;

create table sinteria_web_private.photo_quota (
  singleton boolean primary key default true check (singleton),
  used_bytes integer not null default 0 check (used_bytes between 0 and 20971520)
);
insert into sinteria_web_private.photo_quota default values;
grant select, update on sinteria_web_private.photo_quota to service_role;

create table public.sinteria_site_fields (
  id text primary key check (id ~ '^p[0-6]-(text|image|price)-[0-9]{1,3}$'),
  page_id text generated always as (split_part(id, '-', 1)) stored,
  kind text generated always as (split_part(id, '-', 2)) stored,
  max_length integer not null check (max_length between 1 and 1600),
  revision uuid,
  value text,
  price_visible boolean not null default false,
  photo bytea check (octet_length(photo) between 20 and 524288),
  photo_alt text check (char_length(photo_alt) <= 200),
  has_photo boolean generated always as (photo is not null) stored,
  display_value text generated always as (
    case when split_part(id, '-', 2) <> 'price' or price_visible then value end
  ) stored,
  check (not price_visible or (kind = 'price' and value is not null)),
  check (photo is null or (kind = 'image' and photo_alt is not null)),
  check (photo_alt is null or photo is not null),
  check (
    value is null
    or (kind = 'text' and char_length(value) between 1 and max_length and btrim(value) <> '')
    or (kind = 'price' and value ~ '^(0|[1-9][0-9]{0,8})$')
  )
);

alter table public.sinteria_site_fields enable row level security;
revoke all on public.sinteria_site_fields from public, anon, authenticated;
grant select (id, page_id, revision, display_value, has_photo, photo_alt)
  on public.sinteria_site_fields to anon, authenticated;
grant select, update on public.sinteria_site_fields to service_role;
create policy "Published site content" on public.sinteria_site_fields
  for select to anon, authenticated using (true);

-- The Edge Function validates the administrator and checks the WebP container.
-- Only its server role can call these functions.
create function public.sinteria_save_field(
  p_id text,
  p_revision uuid,
  p_value text,
  p_price_visible boolean,
  p_photo_b64 text,
  p_alt text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_field public.sinteria_site_fields%rowtype;
  replacement bytea;
  byte_difference integer;
begin
  select * into current_field from public.sinteria_site_fields
    where id = p_id for update;
  if not found then
    raise sqlstate 'PT404' using message = 'El contenido solicitado no existe.';
  end if;
  if current_field.revision is distinct from p_revision then
    raise sqlstate 'PT409' using message = 'Este campo cambió en otra sesión. Abre de nuevo el editor.';
  end if;

  if current_field.kind = 'image' then
    replacement := decode(p_photo_b64, 'base64');
    byte_difference := coalesce(octet_length(replacement), 0) - coalesce(octet_length(current_field.photo), 0);
    if byte_difference <> 0 then
      update sinteria_web_private.photo_quota
        set used_bytes = used_bytes + byte_difference
        where singleton and used_bytes + byte_difference <= 20971520;
      if not found then
        raise sqlstate 'PT413' using message = 'La biblioteca llegó a 20 MiB. Retira una foto para liberar espacio.';
      end if;
    end if;
  end if;

  update public.sinteria_site_fields
    set value = p_value,
        price_visible = p_price_visible,
        photo = replacement,
        photo_alt = case when replacement is not null then coalesce(p_alt, '') end,
        revision = gen_random_uuid()
    where id = p_id
    returning * into current_field;

  return jsonb_build_object(
    'id', current_field.id,
    'revision', current_field.revision,
    'value', current_field.value,
    'price_visible', current_field.price_visible,
    'has_photo', current_field.has_photo,
    'photo_alt', current_field.photo_alt
  );
end;
$$;

create function public.sinteria_read_photo(p_id text, p_revision uuid) returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select encode(photo, 'base64')
  from public.sinteria_site_fields
  where id = p_id and revision = p_revision and has_photo;
$$;

revoke execute on function public.sinteria_save_field(text, uuid, text, boolean, text, text)
  from public, anon, authenticated;
revoke execute on function public.sinteria_read_photo(text, uuid)
  from public, anon, authenticated;
grant execute on function public.sinteria_save_field(text, uuid, text, boolean, text, text) to service_role;
grant execute on function public.sinteria_read_photo(text, uuid) to service_role;

-- The manifest binds rows to existing site content and fixes the number of uploads.
insert into public.sinteria_site_fields (id, max_length) values
  ('p0-text-0', 180),
  ('p0-text-1', 1600),
  ('p0-image-0', 200),
  ('p0-image-1', 200),
  ('p0-image-2', 200),
  ('p0-text-2', 1600),
  ('p0-text-3', 180),
  ('p0-text-4', 1600),
  ('p0-image-3', 200),
  ('p0-text-5', 180),
  ('p0-text-6', 1600),
  ('p0-image-4', 200),
  ('p0-text-7', 180),
  ('p0-text-8', 1600),
  ('p0-text-9', 180),
  ('p0-text-10', 1600),
  ('p0-image-5', 200),
  ('p0-text-11', 180),
  ('p0-image-6', 200),
  ('p0-text-12', 180),
  ('p0-image-7', 200),
  ('p0-text-13', 180),
  ('p0-text-15', 180),
  ('p0-image-8', 200),
  ('p0-text-16', 180),
  ('p0-text-17', 1600),
  ('p0-image-9', 200),
  ('p0-text-18', 180),
  ('p0-text-19', 1600),
  ('p0-image-10', 200),
  ('p0-text-20', 180),
  ('p0-text-21', 1600),
  ('p0-image-11', 200),
  ('p0-text-22', 180),
  ('p0-text-23', 1600),
  ('p0-image-12', 200),
  ('p0-text-24', 180),
  ('p0-text-25', 1600),
  ('p0-image-13', 200),
  ('p0-text-26', 180),
  ('p0-text-27', 1600),
  ('p1-price-0', 9),
  ('p1-text-0', 180),
  ('p1-text-1', 1600),
  ('p1-image-0', 200),
  ('p1-image-1', 200),
  ('p1-image-2', 200),
  ('p1-text-2', 1600),
  ('p1-text-3', 180),
  ('p1-text-4', 1600),
  ('p1-image-3', 200),
  ('p1-text-5', 180),
  ('p1-text-6', 1600),
  ('p1-image-4', 200),
  ('p1-text-7', 180),
  ('p1-text-8', 1600),
  ('p1-image-5', 200),
  ('p1-text-9', 180),
  ('p1-text-10', 1600),
  ('p1-image-6', 200),
  ('p1-text-11', 180),
  ('p1-text-12', 1600),
  ('p1-image-7', 200),
  ('p1-text-13', 180),
  ('p1-text-14', 1600),
  ('p1-image-8', 200),
  ('p1-text-15', 180),
  ('p1-text-16', 1600),
  ('p1-text-18', 180),
  ('p1-text-19', 1600),
  ('p1-image-9', 200),
  ('p1-text-20', 180),
  ('p1-image-10', 200),
  ('p1-text-21', 180),
  ('p1-image-11', 200),
  ('p1-text-22', 180),
  ('p1-text-24', 180),
  ('p1-text-25', 1600),
  ('p1-image-12', 200),
  ('p1-text-26', 180),
  ('p1-text-27', 1600),
  ('p1-image-13', 200),
  ('p1-text-28', 180),
  ('p1-text-29', 1600),
  ('p1-image-14', 200),
  ('p1-text-30', 180),
  ('p1-text-31', 1600),
  ('p1-image-15', 200),
  ('p1-text-32', 180),
  ('p1-text-33', 1600),
  ('p1-image-16', 200),
  ('p1-text-34', 180),
  ('p1-text-35', 1600),
  ('p1-text-36', 180),
  ('p1-text-37', 1600),
  ('p1-text-38', 1600),
  ('p1-text-39', 1600),
  ('p1-text-40', 1600),
  ('p1-text-41', 1600),
  ('p1-text-42', 1600),
  ('p1-text-43', 1600),
  ('p1-text-44', 1600),
  ('p1-image-17', 200),
  ('p1-text-45', 180),
  ('p1-text-46', 1600),
  ('p2-price-0', 9),
  ('p2-text-0', 180),
  ('p2-text-1', 1600),
  ('p2-image-0', 200),
  ('p2-image-1', 200),
  ('p2-image-2', 200),
  ('p2-text-2', 1600),
  ('p2-text-3', 180),
  ('p2-text-4', 1600),
  ('p2-image-3', 200),
  ('p2-text-5', 180),
  ('p2-text-6', 1600),
  ('p2-image-4', 200),
  ('p2-text-7', 180),
  ('p2-text-8', 1600),
  ('p2-image-5', 200),
  ('p2-text-9', 180),
  ('p2-text-10', 1600),
  ('p2-image-6', 200),
  ('p2-text-11', 180),
  ('p2-text-12', 1600),
  ('p2-image-7', 200),
  ('p2-text-13', 180),
  ('p2-text-14', 1600),
  ('p2-image-8', 200),
  ('p2-text-15', 180),
  ('p2-text-16', 1600),
  ('p2-image-9', 200),
  ('p2-text-18', 180),
  ('p2-text-19', 1600),
  ('p2-image-10', 200),
  ('p2-text-21', 180),
  ('p2-image-11', 200),
  ('p2-text-22', 180),
  ('p2-text-23', 1600),
  ('p2-image-12', 200),
  ('p2-text-24', 180),
  ('p2-text-25', 1600),
  ('p2-image-13', 200),
  ('p2-text-26', 180),
  ('p2-text-27', 1600),
  ('p2-image-14', 200),
  ('p2-text-28', 180),
  ('p2-text-29', 1600),
  ('p2-text-30', 180),
  ('p2-text-31', 1600),
  ('p2-image-15', 200),
  ('p2-text-32', 180),
  ('p2-text-33', 1600),
  ('p2-image-16', 200),
  ('p2-text-34', 180),
  ('p2-text-35', 1600),
  ('p2-image-17', 200),
  ('p2-text-36', 180),
  ('p2-text-37', 1600),
  ('p2-image-18', 200),
  ('p2-text-38', 180),
  ('p2-text-39', 1600),
  ('p2-text-40', 180),
  ('p2-text-41', 1600),
  ('p2-text-42', 1600),
  ('p2-text-43', 1600),
  ('p2-text-44', 1600),
  ('p2-text-45', 1600),
  ('p2-text-46', 1600),
  ('p2-text-47', 1600),
  ('p2-text-48', 1600),
  ('p2-image-19', 200),
  ('p2-text-49', 180),
  ('p2-text-50', 1600),
  ('p3-price-0', 9),
  ('p3-text-0', 180),
  ('p3-text-1', 1600),
  ('p3-text-3', 180),
  ('p3-text-4', 1600),
  ('p3-text-5', 1600),
  ('p3-text-6', 180),
  ('p3-text-7', 1600),
  ('p3-text-8', 180),
  ('p3-text-9', 1600),
  ('p3-text-10', 180),
  ('p3-text-11', 1600),
  ('p3-text-12', 180),
  ('p3-text-13', 1600),
  ('p3-text-15', 180),
  ('p3-text-16', 1600),
  ('p3-text-17', 180),
  ('p3-text-18', 1600),
  ('p3-text-19', 180),
  ('p3-text-20', 1600),
  ('p3-text-21', 1600),
  ('p3-text-22', 1600),
  ('p3-text-23', 1600),
  ('p3-text-24', 180),
  ('p3-text-25', 1600),
  ('p3-text-26', 1600),
  ('p3-text-27', 1600),
  ('p3-text-28', 1600),
  ('p3-text-29', 1600),
  ('p3-text-30', 1600),
  ('p3-text-31', 1600),
  ('p3-text-32', 1600),
  ('p3-text-33', 1600),
  ('p3-text-34', 180),
  ('p4-price-0', 9),
  ('p4-text-0', 180),
  ('p4-text-1', 1600),
  ('p4-text-3', 180),
  ('p4-text-4', 1600),
  ('p4-text-5', 1600),
  ('p4-text-6', 180),
  ('p4-text-7', 1600),
  ('p4-text-8', 180),
  ('p4-text-9', 1600),
  ('p4-text-10', 180),
  ('p4-text-11', 1600),
  ('p4-text-12', 180),
  ('p4-text-13', 1600),
  ('p4-text-15', 180),
  ('p4-text-16', 1600),
  ('p4-text-17', 180),
  ('p4-text-18', 1600),
  ('p4-text-19', 180),
  ('p4-text-20', 1600),
  ('p4-text-21', 1600),
  ('p4-text-22', 1600),
  ('p4-text-23', 1600),
  ('p4-text-24', 180),
  ('p4-text-25', 1600),
  ('p4-text-26', 1600),
  ('p4-text-27', 1600),
  ('p4-text-28', 1600),
  ('p4-text-29', 1600),
  ('p4-text-30', 1600),
  ('p4-text-31', 1600),
  ('p4-text-32', 1600),
  ('p4-text-33', 1600),
  ('p4-text-34', 180),
  ('p5-price-0', 9),
  ('p5-text-0', 180),
  ('p5-text-1', 1600),
  ('p5-text-3', 180),
  ('p5-text-4', 1600),
  ('p5-text-5', 1600),
  ('p5-text-6', 180),
  ('p5-text-7', 1600),
  ('p5-text-8', 180),
  ('p5-text-9', 1600),
  ('p5-text-10', 180),
  ('p5-text-11', 1600),
  ('p5-text-12', 180),
  ('p5-text-13', 1600),
  ('p5-text-15', 180),
  ('p5-text-16', 1600),
  ('p5-text-17', 180),
  ('p5-text-18', 1600),
  ('p5-text-19', 180),
  ('p5-text-20', 1600),
  ('p5-text-21', 1600),
  ('p5-text-22', 1600),
  ('p5-text-23', 1600),
  ('p5-text-24', 180),
  ('p5-text-25', 1600),
  ('p5-text-26', 1600),
  ('p5-text-27', 1600),
  ('p5-text-28', 1600),
  ('p5-text-29', 1600),
  ('p5-text-30', 1600),
  ('p5-text-31', 1600),
  ('p5-text-32', 1600),
  ('p5-text-33', 1600),
  ('p5-text-34', 180),
  ('p6-price-0', 9),
  ('p6-text-0', 180),
  ('p6-text-1', 1600),
  ('p6-text-3', 180),
  ('p6-text-4', 1600),
  ('p6-text-5', 1600),
  ('p6-text-6', 180),
  ('p6-text-7', 1600),
  ('p6-text-8', 180),
  ('p6-text-9', 1600),
  ('p6-text-10', 180),
  ('p6-text-11', 1600),
  ('p6-text-12', 180),
  ('p6-text-13', 1600),
  ('p6-text-15', 180),
  ('p6-text-16', 1600),
  ('p6-text-17', 180),
  ('p6-text-18', 1600),
  ('p6-text-19', 180),
  ('p6-text-20', 1600),
  ('p6-text-21', 1600),
  ('p6-text-22', 1600),
  ('p6-text-23', 1600),
  ('p6-text-24', 180),
  ('p6-text-25', 1600),
  ('p6-text-26', 1600),
  ('p6-text-27', 1600),
  ('p6-text-28', 1600),
  ('p6-text-29', 1600),
  ('p6-text-30', 1600),
  ('p6-text-31', 1600),
  ('p6-text-32', 1600),
  ('p6-text-33', 1600),
  ('p6-text-34', 180);
