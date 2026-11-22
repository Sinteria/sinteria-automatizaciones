import { contentApi, photoUrl, projectUrl, publicKey } from './sinteria-content.js';

const byId = id => document.getElementById(id);
const login = byId('login');
const loginForm = byId('login-form');
const workspace = byId('workspace');
const signOut = byId('sign-out');
const pageSelect = byId('page');
const search = byId('field-search');
const fieldList = byId('fields');
const filters = Array.from(byId('filters').querySelectorAll('button'));
const editor = byId('editor');
const preview = byId('image-preview');
const photoInput = byId('photo');
const textInput = byId('text-value');
const priceInput = byId('price-value');
const priceVisible = byId('price-visible');
const photoAlt = byId('photo-alt');
const publish = byId('publish');
const restore = byId('restore');
const editorStatus = byId('editor-status');
const loginStatus = byId('login-status');

const sessionKey = 'sinteria-content-session';
const photoFormats = new Set(['image/jpeg', 'image/png', 'image/webp']);
let session = readSession();
let manifest = [];
let entries = new Map();
let kind = 'text';
let selected = null;
let previewUrl = null;
let saving = false;

class ServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readSession() {
  try {
    return JSON.parse(sessionStorage.getItem(sessionKey));
  } catch {
    return null;
  }
}

function storeSession(next) {
  session = next;
  try {
    if (session) sessionStorage.setItem(sessionKey, JSON.stringify(session));
    else sessionStorage.removeItem(sessionKey);
  } catch {
    // Sign-in also works in browsers that block session storage.
  }
}

function status(element, message = '', error = false) {
  element.textContent = message;
  element.dataset.error = String(error);
}

async function request(url, options) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
  } catch {
    throw new ServiceError(503, 'El servicio no está disponible. Intenta de nuevo.');
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ServiceError(response.status, data?.message || 'El servicio no pudo completar la solicitud.');
  }
  return data;
}

async function authToken(grant, body) {
  return request(projectUrl + '/auth/v1/token?grant_type=' + grant, {
    method: 'POST',
    headers: { apikey: publicKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function sessionDetails(data) {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at ?? Math.floor(Date.now() / 1000) + data.expires_in
  };
}

async function manage(body) {
  if (session?.expires_at < Date.now() / 1000 + 30) {
    const current = session;
    const renewed = await authToken('refresh_token', { refresh_token: current.refresh_token }).catch(error => {
      if (error.status === 400) throw new ServiceError(401, 'La sesión venció. Vuelve a ingresar.');
      throw error;
    });
    if (session !== current) throw new ServiceError(401, 'Inicia sesión para continuar.');
    storeSession(sessionDetails(renewed));
  }
  if (!session?.access_token) throw new ServiceError(401, 'Inicia sesión para continuar.');
  return request(contentApi + '/manage', {
    method: body ? 'POST' : 'GET',
    headers: {
      apikey: publicKey,
      Authorization: 'Bearer ' + session.access_token,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

function normalize(text) {
  return text.toLocaleLowerCase('es-PE').normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

function releasePreview() {
  if (!previewUrl) return;
  URL.revokeObjectURL(previewUrl);
  previewUrl = null;
}

function selectField(field) {
  selected = field;
  for (const button of fieldList.querySelectorAll('button')) {
    button.setAttribute('aria-current', String(button.dataset.id === field?.id));
  }
  releasePreview();
  status(editorStatus);
  editor.hidden = !field;
  byId('empty').hidden = Boolean(field);
  if (!field) return;

  const saved = entries.get(field.id);
  byId('field-title').textContent = field.label;
  byId('field-section').textContent = field.section || '';
  for (const mode of ['text', 'image', 'price']) byId('edit-' + mode).hidden = field.kind !== mode;
  photoInput.value = '';
  if (field.kind === 'text') {
    textInput.maxLength = field.maxLength;
    textInput.value = saved?.value ?? field.original;
  }
  if (field.kind === 'image') {
    const alt = saved?.photo_alt ?? field.original.alt;
    preview.src = saved?.has_photo ? photoUrl(field.id, saved.revision) : field.original.src;
    preview.alt = alt;
    photoAlt.value = alt;
  }
  if (field.kind === 'price') {
    priceInput.value = saved?.value == null ? '' : (Number(saved.value) / 100).toFixed(2);
    priceVisible.checked = saved?.price_visible === true;
  }
  restore.textContent = field.kind === 'image' ? 'Restaurar foto original' : 'Restaurar texto original';
  const canRestore = field.kind === 'text' ? saved?.value != null : field.kind === 'image' && saved?.has_photo;
  restore.hidden = !canRestore;
}

function showFields() {
  const page = manifest.find(item => item.id === pageSelect.value);
  if (!page) return;
  byId('open-page').href = page.file;
  const available = new Set(page.fields.map(field => field.kind));
  if (!available.has(kind)) kind = 'text';
  for (const button of filters) {
    button.disabled = !available.has(button.dataset.kind);
    button.setAttribute('aria-pressed', String(button.dataset.kind === kind));
  }
  const query = normalize(search.value.trim());
  const matches = page.fields.filter(field =>
    field.kind === kind && normalize([field.label, field.section, entries.get(field.id)?.value ?? field.original?.alt ?? field.original].join(' ')).includes(query)
  );
  fieldList.replaceChildren(...matches.map(field => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.id = field.id;
    button.textContent = field.label;
    if (field.section) {
      const section = document.createElement('small');
      section.textContent = field.section;
      button.append(section);
    }
    button.addEventListener('click', () => selectField(field));
    item.append(button);
    return item;
  }));
  selectField(matches.find(field => field.id === selected?.id) ?? matches[0]);
}

function showLogin(message = '') {
  storeSession(null);
  releasePreview();
  workspace.hidden = true;
  signOut.hidden = true;
  byId('loading').hidden = true;
  login.hidden = false;
  status(loginStatus, message, Boolean(message));
}

async function openEditor() {
  const [pages, content] = await Promise.all([request('/sinteria-fields.json'), manage()]);
  manifest = pages;
  entries = new Map(content.map(field => [field.id, field]));
  pageSelect.replaceChildren(...manifest.map(page => new Option(page.name, page.id)));
  search.value = '';
  selected = null;
  kind = 'text';
  showFields();
  login.hidden = true;
  byId('loading').hidden = true;
  workspace.hidden = false;
  signOut.hidden = false;
}

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  const submit = loginForm.querySelector('button[type=submit]');
  const password = byId('password');
  submit.disabled = true;
  status(loginStatus, 'Ingresando…');
  try {
    const data = await authToken('password', { email: byId('email').value.trim(), password: password.value });
    storeSession(sessionDetails(data));
    await openEditor();
  } catch (error) {
    const message = [400, 401].includes(error.status) ? 'Revisa tu correo y contraseña.' :
      error.status === 429 ? 'Hubo demasiados intentos. Espera unos minutos y vuelve a ingresar.' : error.message;
    showLogin(message);
  } finally {
    password.value = '';
    submit.disabled = false;
  }
});

signOut.addEventListener('click', () => {
  const token = session?.access_token;
  showLogin();
  if (!token) return;
  request(projectUrl + '/auth/v1/logout?scope=local', {
    method: 'POST',
    headers: { apikey: publicKey, Authorization: 'Bearer ' + token }
  }).catch(() => {});
});

pageSelect.addEventListener('change', () => {
  search.value = '';
  showFields();
});
search.addEventListener('input', showFields);
for (const button of filters) {
  button.addEventListener('click', () => {
    kind = button.dataset.kind;
    search.value = '';
    showFields();
  });
}

function verifyFile(file) {
  if (!file || !photoFormats.has(file.type)) throw new Error('Selecciona una foto JPG, PNG o WebP.');
  if (file.size > 20 * 1024 * 1024) throw new Error('Elige una foto original que pese menos de 20 MiB.');
}

photoInput.addEventListener('change', () => {
  const file = photoInput.files[0];
  if (!file) return;
  try {
    verifyFile(file);
    releasePreview();
    previewUrl = URL.createObjectURL(file);
    preview.src = previewUrl;
    status(editorStatus);
  } catch (error) {
    selectField(selected);
    status(editorStatus, error.message, true);
  }
});

async function optimizePhoto(file) {
  verifyFile(file);
  let source;
  try {
    source = await createImageBitmap(file);
  } catch {
    throw new Error('No se pudo abrir la foto. Prueba con otro archivo JPG, PNG o WebP.');
  }

  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const start = Math.min(1600, Math.max(source.width, source.height));
    const sizes = new Set([start, ...[1360, 1150, 900].filter(side => side < start)]);
    for (const side of sizes) {
      const scale = side / Math.max(source.width, source.height);
      canvas.width = Math.max(1, Math.round(source.width * scale));
      canvas.height = Math.max(1, Math.round(source.height * scale));
      context.imageSmoothingQuality = 'high';
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      for (const quality of [.91, .84, .76]) {
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
        if (blob?.type === 'image/webp' && blob.size <= 512 * 1024) {
          return btoa(Array.from(new Uint8Array(await blob.arrayBuffer()), byte => String.fromCharCode(byte)).join(''));
        }
      }
    }
  } finally {
    source.close();
  }
  throw new Error('No se pudo optimizar la foto. Prueba con una imagen más pequeña.');
}

function readPrice() {
  const value = priceInput.value.trim();
  if (!value && !priceVisible.checked) return null;
  if (!/^\d{1,7}(?:[.,]\d{1,2})?$/.test(value)) {
    throw new Error('Ingresa un monto válido, con hasta dos decimales.');
  }
  const [soles, cents = ''] = value.split(/[.,]/);
  return String(Number(soles) * 100 + Number(cents.padEnd(2, '0')));
}

async function save(reset = false) {
  if (saving || !selected) return;
  const field = selected;
  const payload = {
    id: field.id,
    revision: entries.get(field.id)?.revision ?? null,
    value: null,
    priceVisible: false,
    photo: null,
    alt: null
  };
  saving = true;
  publish.disabled = restore.disabled = true;
  try {
    if (!reset && field.kind === 'text') {
      payload.value = textInput.value.trim();
      if (!payload.value) throw new Error('Escribe el texto que quieres publicar.');
    }
    if (!reset && field.kind === 'price') {
      payload.value = readPrice();
      payload.priceVisible = priceVisible.checked;
    }
    if (!reset && field.kind === 'image') {
      payload.alt = photoAlt.value.trim();
      status(editorStatus, 'Optimizando foto…');
      payload.photo = await optimizePhoto(photoInput.files[0]);
    }
    status(editorStatus, 'Publicando…');
    const updated = await manage(payload);
    entries.set(field.id, updated);
    if (selected?.id === field.id) {
      selectField(field);
      status(editorStatus, 'Cambios publicados. Actualiza la página pública para verlos.');
    }
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      showLogin('La sesión terminó. Vuelve a ingresar.');
    } else if (selected?.id === field.id) {
      status(editorStatus, error.message, true);
      if (error.status === 409) {
        try {
          const current = await manage();
          entries = new Map(current.map(row => [row.id, row]));
          if (selected?.id === field.id) {
            selectField(field);
            status(editorStatus, 'Este campo cambió en otra sesión. Revisa el valor actual y vuelve a publicar.', true);
          }
        } catch {
          status(editorStatus, 'Abre de nuevo el panel para cargar la edición más reciente.', true);
        }
      }
    }
  } finally {
    saving = false;
    publish.disabled = restore.disabled = false;
  }
}

editor.addEventListener('submit', event => {
  event.preventDefault();
  save();
});
restore.addEventListener('click', () => save(true));

if (session?.refresh_token) openEditor().catch(error => showLogin(error.status >= 500 ? error.message : ''));
else showLogin();
