const adminEmail = 'contacto.sinteria@gmail.com';
const origins = new Set(['https://sinteriagroup.com', 'https://www.sinteriagroup.com']);
const projectUrl = Deno.env.get('SUPABASE_URL')!;
const serverKey = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}').default ??
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const publishableKey = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}').default ??
  Deno.env.get('SUPABASE_ANON_KEY')!;

const fieldId = /^p[0-6]-(text|price|image)-\d{1,3}$/;
const revisionId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const maxPhotoBytes = 512 * 1024;
const maxPhotoSide = 1600;
const maxBody = 710_000;

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function serverFetch(path: string, body?: Record<string, unknown>) {
  const headers = new Headers({ apikey: serverKey });
  if (serverKey.startsWith('eyJ')) headers.set('Authorization', 'Bearer ' + serverKey);
  if (body) headers.set('Content-Type', 'application/json');
  return fetch(projectUrl + path, { headers, method: body ? 'POST' : 'GET', body: body && JSON.stringify(body) });
}

async function requireAdmin(request: Request) {
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) throw new RequestError(401, 'Inicia sesión para continuar.');
  const response = await fetch(projectUrl + '/auth/v1/user', {
    headers: { apikey: publishableKey, authorization }
  });
  if (response.status >= 500) throw new RequestError(503, 'El servicio de acceso está temporalmente ocupado.');
  if (!response.ok) throw new RequestError(401, 'La sesión venció. Vuelve a ingresar.');
  const user = await response.json();
  if (user.email !== adminEmail || !user.email_confirmed_at || user.app_metadata?.sinteria_content_admin !== true) {
    throw new RequestError(403, 'Esta cuenta no tiene acceso al panel.');
  }
}

async function readBody(request: Request, limit = maxBody): Promise<Record<string, unknown>> {
  if (!request.body) throw new RequestError(400, 'Faltan los datos de la edición.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let raw = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new RequestError(413, 'La foto supera el tamaño permitido.');
      }
      raw += decoder.decode(value, { stream: true });
    }
    const input = JSON.parse(raw + decoder.decode());
    if (!input || Array.isArray(input) || typeof input !== 'object') {
      throw new RequestError(400, 'Revisa los datos de la edición.');
    }
    return input;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, 'Revisa los datos de la edición.');
  }
}

function webpSize(bytes: Uint8Array) {
  if (bytes.length < 25) return null;

  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readName = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (readName(0) !== 'RIFF' || readName(8) !== 'WEBP' || data.getUint32(4, true) !== bytes.length - 8) return null;

  type ImageSize = { width: number; height: number };
  let size: ImageSize | null = null;
  let canvas: ImageSize | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const name = readName(offset);
    const length = data.getUint32(offset + 4, true);
    const start = offset + 8;
    offset = start + length + (length % 2);
    if (offset > bytes.length) return null;

    if (name === 'VP8X') {
      if (start !== 20 || length !== 10 || (bytes[start] & 0x02)) return null;
      const dimension = (at: number) => 1 + bytes[at] + (bytes[at + 1] << 8) + (bytes[at + 2] << 16);
      canvas = { width: dimension(start + 4), height: dimension(start + 7) };
    } else if (name === 'VP8 ') {
      if (size || length < 10 || bytes[start] & 1 ||
          bytes[start + 3] !== 0x9d || bytes[start + 4] !== 0x01 || bytes[start + 5] !== 0x2a) return null;
      size = {
        width: data.getUint16(start + 6, true) & 0x3fff,
        height: data.getUint16(start + 8, true) & 0x3fff
      };
    } else if (name === 'VP8L') {
      if (size || length < 5 || bytes[start] !== 0x2f) return null;
      const dimensions = data.getUint32(start + 1, true);
      size = { width: (dimensions & 0x3fff) + 1, height: ((dimensions >>> 14) & 0x3fff) + 1 };
    } else if (!['ALPH', 'ICCP', 'EXIF', 'XMP '].includes(name)) {
      return null;
    }
  }

  if (offset !== bytes.length || !size?.width || !size.height) return null;
  if (canvas && (size.width !== canvas.width || size.height !== canvas.height)) return null;
  return size;
}

function validatePhoto(base64: unknown) {
  if (base64 === null) return null;
  if (typeof base64 !== 'string' || base64.length > Math.ceil(maxPhotoBytes / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new RequestError(400, 'Sube una foto WebP de hasta 512 KiB.');
  }
  let bytes;
  try {
    bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
  } catch {
    throw new RequestError(400, 'No se pudo leer la foto.');
  }
  const size = webpSize(bytes);
  if (bytes.length > maxPhotoBytes || !size || Math.max(size.width, size.height) > maxPhotoSide) {
    throw new RequestError(400, 'La foto debe ser WebP estática, de hasta 512 KiB y 1,600 píxeles por lado.');
  }
  return base64;
}

function fieldValues(input: Record<string, unknown>) {
  const { id, revision, value, priceVisible, photo, alt } = input;
  const kind = typeof id === 'string' ? fieldId.exec(id)?.[1] : null;
  if (!kind || (revision !== null && (typeof revision !== 'string' || !revisionId.test(revision)))) {
    throw new RequestError(400, 'Revisa el contenido que quieres actualizar.');
  }
  if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 1600 || value.includes('\0'))) {
    throw new RequestError(400, 'Revisa el texto o el precio ingresado.');
  }
  if (kind === 'price' && value !== null && !/^(0|[1-9]\d{0,8})$/.test(value as string)) {
    throw new RequestError(400, 'Ingresa un precio válido con hasta dos decimales.');
  }
  if (kind === 'image' && alt !== null && (typeof alt !== 'string' || alt.length > 200 || alt.includes('\0'))) {
    throw new RequestError(400, 'La descripción de la foto admite hasta 200 caracteres.');
  }
  return {
    id, kind, revision, value: kind === 'image' ? null : value,
    priceVisible: kind === 'price' && value !== null && priceVisible === true,
    photo: kind === 'image' ? validatePhoto(photo) : null,
    alt: kind === 'image' ? alt : null
  };
}

async function rpc(name: string, body: Record<string, unknown>) {
  const response = await serverFetch('/rest/v1/rpc/sinteria_' + name, body);
  if (response.status === 204) return null;
  const result = await response.json();
  if ([400, 404, 409, 413].includes(response.status) && result?.code === 'PT' + response.status) {
    throw new RequestError(response.status, result.message);
  }
  if (result?.code === '23514') throw new RequestError(400, 'El contenido supera los límites del campo.');
  if (!response.ok) throw new Error('Sinteria RPC ' + name + ' returned ' + response.status);
  return result;
}

function saveField(input: Record<string, unknown>) {
  const field = fieldValues(input);
  return rpc('save_field', {
    p_id: field.id, p_revision: field.revision, p_value: field.value,
    p_price_visible: field.priceVisible, p_photo_b64: field.photo, p_alt: field.alt
  });
}

async function getPhoto(id: string, revision: string) {
  if (fieldId.exec(id)?.[1] !== 'image' || !revisionId.test(revision)) {
    return new Response(null, { status: 404 });
  }
  const response = await serverFetch('/rest/v1/rpc/sinteria_read_photo', { p_id: id, p_revision: revision });
  if (!response.ok) throw new Error('Unable to read photo');
  const base64 = await response.json();
  if (!base64) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return new Response(Uint8Array.from(atob(base64), char => char.charCodeAt(0)), {
    headers: {
      'Content-Type': 'image/webp',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=31536000, immutable'
    }
  });
}


const pageId = /^p[0-6]$/;
const blockId = /^p[0-6]-b\d{1,3}$/;
const contactNetworks = {
  facebook: ['facebook.com', 'fb.com'],
  instagram: ['instagram.com'],
  tiktok: ['tiktok.com']
};

function invalid(message = 'Revisa los datos antes de guardar.'): never {
  throw new RequestError(400, message);
}

function revision(value: unknown) {
  if (value !== null && (typeof value !== 'string' || !revisionId.test(value))) invalid();
  return value;
}

function shortText(value: unknown, max: number, required = false) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (required && !value.trim())) invalid();
  return value.trim();
}

function validUrl(value: string, hosts?: string[]) {
  if (!value) return '';
  let address;
  try { address = new URL(value); } catch { invalid('Usa un enlace completo que empiece por https://.'); }
  if (address.protocol !== 'https:' || address.username || address.password ||
      (hosts && (!hosts.some(host => address.hostname === host || address.hostname.endsWith('.' + host)) || address.port))) {
    invalid('Revisa que el enlace pertenezca a la plataforma indicada.');
  }
  return address.href;
}

async function updateEditor(input: Record<string, unknown>) {
  if (input.type === 'block') {
    if (typeof input.id !== 'string' || !blockId.test(input.id) || !Array.isArray(input.fields) || input.fields.length > 30) invalid();
    const changes = input.fields.map(item => {
      if (!item || typeof item !== 'object') invalid();
      const field = fieldValues(item);
      if (field.kind === 'image' && (!['replace', 'hide', 'restore'].includes(item.mode) ||
          (item.mode === 'replace') !== Boolean(field.photo))) invalid();
      return { ...field, mode: item.mode ?? null };
    });
    if (new Set(changes.map(field => field.id)).size !== changes.length) invalid();
    await rpc('write_block', {
      p_id: input.id, p_revision: revision(input.revision), p_hidden: input.hidden === true, p_changes: changes
    });
    return input.id;
  }

  if (input.type === 'contacts') {
    const whatsapp = shortText(input.whatsapp, 20, true).replace(/^\+/, '');
    const email = shortText(input.email, 254, true);
    if (!/^[1-9]\d{7,14}$/.test(whatsapp) || !/^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) {
      invalid('Revisa el número internacional de WhatsApp y el correo.');
    }
    const networks = Object.fromEntries(Object.entries(contactNetworks).map(([key, hosts]) =>
      [key, validUrl(shortText(input[key], 400), hosts)]));
    await rpc('write_contacts', {
      p_revision: revision(input.revision), p_values: {
        whatsapp, email, ...networks, business_name: shortText(input.business_name, 160),
        business_address: shortText(input.business_address, 240),
        complaints_url: validUrl(shortText(input.complaints_url, 400))
      }
    });
    return null;
  }

  if (input.type === 'catalog') {
    const catalogId = revision(input.id);
    const removing = input.remove === true;
    if (removing && !catalogId) invalid();
    if (!removing && (typeof input.page !== 'string' || !pageId.test(input.page))) invalid();
    const photos = removing ? [] : input.photos;
    if (!Array.isArray(photos) || photos.length > 4) invalid();
    const changes = photos.map(item => {
      if (!item || !Number.isInteger(item.slot) || item.slot < 1 || item.slot > 4) invalid();
      return { slot: item.slot, photo: validatePhoto(item.photo), alt: shortText(item.alt, 200) };
    });
    if (new Set(changes.map(item => item.slot)).size !== changes.length) invalid();
    return rpc('write_catalog', {
      p_id: catalogId, p_revision: revision(input.revision), p_remove: removing,
      p_page: removing ? null : input.page, p_title: removing ? null : shortText(input.title, 120, true),
      p_description: removing ? null : shortText(input.description, 1600),
      p_published: !removing && input.published === true, p_photos: changes
    });
  }
  return invalid();
}

async function catalogPhoto(request: Request, id: string, slot: string, version: string, headers: Headers) {
  if (!revisionId.test(id) || !/^[1-4]$/.test(slot) || !revisionId.test(version)) {
    return new Response(null, { status: 404, headers });
  }
  const administrative = Boolean(request.headers.get('Authorization'));
  if (administrative) await requireAdmin(request);
  const encoded = await rpc('read_catalog_photo', {
    p_id: id, p_slot: Number(slot), p_revision: version, p_private: administrative
  });
  if (!encoded) return new Response(null, { status: 404, headers });
  headers.set('Content-Type', 'image/webp');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (!administrative) headers.set('Cache-Control', 'public, max-age=300');
  return new Response(Uint8Array.from(atob(encoded), char => char.charCodeAt(0)), { headers });
}

async function recordStat(request: Request) {
  const { metric, scope } = await readBody(request, 320);
  if (!['visit', 'whatsapp'].includes(metric as string) || typeof scope !== 'string' ||
      !(pageId.test(scope) || (metric === 'whatsapp' && ['ventas', 'reportes'].includes(scope)))) invalid();
  await rpc('record_stat', { p_metric: metric, p_scope: scope });
}

Deno.serve(async request => {
  const path = new URL(request.url).pathname.split('/').filter(Boolean);
  const route = path.slice(path.indexOf('sinteria-content') + 1);
  const [area, id, revision] = route;
  const origin = request.headers.get('Origin');
  const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin' });
  if (origin && origins.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'apikey, authorization, content-type');
  }

  try {
    if (request.method === 'GET' && area === 'media' && route.length === 3) {
      return await getPhoto(id, revision);
    }
    if (!['manage','editor','stats','record','catalog-media'].includes(area)) return new Response(null, { status: 404 });
    if (origin && !origins.has(origin)) return new Response(null, { status: 403, headers });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (area === 'catalog-media' && request.method === 'GET' && route.length === 4) {
      return await catalogPhoto(request, id, revision, route[3], headers);
    }
    if (route.length !== 1) return new Response(null, { status: 404, headers });
    if (area === 'record') {
      if (request.method !== 'POST' || !origin || !origins.has(origin)) return new Response(null, { status: 403, headers });
      await recordStat(request);
      return new Response(null, { status: 204, headers });
    }
    if (!['GET', 'POST'].includes(request.method)) return new Response(null, { status: 405, headers });
    await requireAdmin(request);
    if (area === 'stats') {
      if (request.method !== 'GET') return new Response(null, { status: 405, headers });
      const days = new URL(request.url).searchParams.get('days') === '7' ? 7 : 30;
      return Response.json(await rpc('read_stats', { p_days: days }), { headers });
    }
    if (area === 'editor') {
      let savedId = null;
      if (request.method === 'POST') savedId = await updateEditor(await readBody(request, 4 * maxBody + 10240));
      return Response.json({ ...await rpc('editor_snapshot', {}), saved_id: savedId }, { headers });
    }
    if (request.method === 'POST') {
      return Response.json(await saveField(await readBody(request)), { headers });
    }
    const response = await serverFetch(
      '/rest/v1/sinteria_site_fields?select=id,revision,value,price_visible,has_photo,photo_alt&revision=not.is.null'
    );
    if (!response.ok) throw new Error('Unable to read editor fields');
    return Response.json(await response.json(), { headers });
  } catch (error) {
    if (error instanceof RequestError) return Response.json({ message: error.message }, { status: error.status, headers });
    console.error('Sinteria content request failed', error instanceof Error ? error.message : '');
    return Response.json({ message: 'El servicio está temporalmente ocupado. Intenta de nuevo.' }, { status: 503, headers });
  }
});
