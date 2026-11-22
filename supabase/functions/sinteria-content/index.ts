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

async function readBody(request: Request): Promise<Record<string, unknown>> {
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
      if (size > maxBody) {
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

  let size: { width: number; height: number } | null = null;
  let canvas: typeof size = null;
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

async function saveField(input: Record<string, unknown>) {
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
  const response = await serverFetch('/rest/v1/rpc/sinteria_save_field', {
    p_id: id,
    p_revision: revision,
    p_value: kind === 'image' ? null : value,
    p_price_visible: kind === 'price' && value !== null && priceVisible === true,
    p_photo_b64: kind === 'image' ? validatePhoto(photo) : null,
    p_alt: kind === 'image' ? alt : null
  });
  const result = await response.json();
  if ([404, 409, 413].includes(response.status) && result.code === 'PT' + response.status) {
    throw new RequestError(response.status, result.message);
  }
  if (result?.code === '23514') throw new RequestError(400, 'El contenido supera los límites del campo.');
  if (!response.ok) throw new Error('Unable to save content');
  return result;
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
    if (area !== 'manage' || route.length !== 1) return new Response(null, { status: 404 });
    if (origin && !origins.has(origin)) return new Response(null, { status: 403, headers });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (!['GET', 'POST'].includes(request.method)) return new Response(null, { status: 405, headers });
    await requireAdmin(request);
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
