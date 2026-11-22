import { catalogPhotoUrl, contentApi, photoUrl, projectUrl, publicKey } from './sinteria-content.js?v=2';

const get = id => document.getElementById(id);
const pageSelect = get('page');
const blockSearch = get('block-search');
const blockForm = get('block-form');
const catalogForm = get('catalog-form');
const contactsForm = get('contacts-form');
const signOut = get('sign-out');
const workspace = get('workspace');
const loginForm = get('login-form');
const sessionKey = 'sinteria-content-session';
const params = new URLSearchParams(location.search);
const photoFormats = new Set(['image/jpeg', 'image/png', 'image/webp']);
const previewUrls = new Map();
let session = readSession();
let pages = [];
let state;
let fields = new Map();
let blocks = new Map();
let activeBlock;
let activeCatalog;
let saving = false;
let refreshing;

class ServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readSession() {
  try { return JSON.parse(sessionStorage.getItem(sessionKey)); }
  catch { return null; }
}

function storeSession(next) {
  session = next;
  try {
    if (session) sessionStorage.setItem(sessionKey, JSON.stringify(session));
    else sessionStorage.removeItem(sessionKey);
  } catch {
    // A browser that blocks storage can still use the current session.
  }
}

function message(target, text = '', error = false) {
  const element = get(target);
  element.textContent = text;
  element.dataset.error = String(error);
}

async function request(url, options) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(28000) });
  } catch {
    throw new ServiceError(503, 'El servicio no está disponible. Intenta de nuevo.');
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ServiceError(response.status, data?.message || 'El servicio no pudo completar la solicitud.');
  return data;
}

function authToken(grant, body) {
  return request(projectUrl + '/auth/v1/token?grant_type=' + grant, {
    method: 'POST', headers: { apikey: publicKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
}

function sessionDetails(data) {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at ?? Math.floor(Date.now() / 1000) + data.expires_in
  };
}

async function authHeaders() {
  if (session?.expires_at < Date.now() / 1000 + 30) {
    const previous = session;
    refreshing ??= authToken('refresh_token', { refresh_token: previous.refresh_token }).then(renewed => {
      if (session === previous) storeSession(sessionDetails(renewed));
    }).catch(error => {
      if (error.status === 400) throw new ServiceError(401, 'La sesión venció. Vuelve a ingresar.');
      throw error;
    }).finally(() => { refreshing = null; });
    await refreshing;
  }
  if (!session?.access_token) throw new ServiceError(401, 'Inicia sesión para continuar.');
  return { apikey: publicKey, Authorization: 'Bearer ' + session.access_token, 'Content-Type': 'application/json' };
}

async function admin(path, body) {
  return request(contentApi + path, {
    method: body ? 'POST' : 'GET',
    headers: await authHeaders(),
    body: body ? JSON.stringify(body) : undefined
  });
}

function updateState(next) {
  state = next;
  fields = new Map(state.fields.map(row => [row.id, row]));
  blocks = new Map(state.blocks.map(row => [row.id, row]));
}

function el(name, text = '') {
  const node = document.createElement(name);
  node.textContent = text;
  return node;
}

function releasePreview(container) {
  for (const field of container.querySelectorAll('.photo-control')) {
    const url = previewUrls.get(field);
    if (url) URL.revokeObjectURL(url);
    previewUrls.delete(field);
  }
}

function showLogin(error = '') {
  storeSession(null);
  releasePreview(blockForm);
  releasePreview(catalogForm);
  workspace.hidden = signOut.hidden = get('loading').hidden = true;
  get('login').hidden = false;
  message('login-status', error, Boolean(error));
}

async function openWorkspace() {
  const [manifest, initial] = await Promise.all([request('/sinteria-fields.json?v=2'), admin('/editor')]);
  pages = manifest;
  updateState(initial);
  for (const select of [pageSelect, catalogForm.elements.page]) {
    select.replaceChildren(...pages.map(page => new Option(page.name, page.id)));
  }
  pageSelect.value = pages.some(page => page.id === params.get('pagina')) ? params.get('pagina') : 'p0';
  blockSearch.value = '';
  activeBlock = params.get('tarjeta');
  get('login').hidden = get('loading').hidden = true;
  workspace.hidden = signOut.hidden = false;
  openView('content');
}

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  const submit = loginForm.querySelector('button');
  const password = get('password');
  submit.disabled = true;
  message('login-status', 'Ingresando…');
  try {
    const data = await authToken('password', { email: get('email').value.trim(), password: password.value });
    storeSession(sessionDetails(data));
    await openWorkspace();
  } catch (error) {
    showLogin(error.status === 400 || error.status === 401 ? 'Revisa tu correo y contraseña.' : error.message);
  } finally {
    password.value = '';
    submit.disabled = false;
  }
});

signOut.addEventListener('click', () => {
  const token = session?.access_token;
  showLogin();
  if (token) request(projectUrl + '/auth/v1/logout?scope=local', {
    method: 'POST', headers: { apikey: publicKey, Authorization: 'Bearer ' + token }
  }).catch(() => {});
});

function currentPage() {
  return pages.find(page => page.id === pageSelect.value);
}

function blockFields(group) {
  const map = new Map(currentPage().fields.map(field => [field.id, field]));
  return group.fields.map(id => map.get(id));
}

function cardTitle(group) {
  return fields.get(group.titleField)?.value ?? group.title;
}

function fieldImage(field, saved = fields.get(field.id)) {
  return saved?.has_photo ? photoUrl(field.id, saved.revision) : field.original.src;
}

function simplify(value) {
  return value.toLocaleLowerCase('es-PE').normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

function itemButton(title, detail, src, selected, action) {
  const button = el('button');
  button.type = 'button';
  button.className = 'record-select';
  button.setAttribute('aria-current', String(selected));
  if (src) {
    const image = el('img');
    image.alt = '';
    image.loading = 'lazy';
    image.src = src;
    button.append(image);
  }
  const labels = el('span');
  labels.append(el('strong', title), el('small', detail));
  button.append(labels);
  button.addEventListener('click', action);
  return button;
}

function goToEditor(id) {
  if (matchMedia('(max-width: 690px)').matches) {
    get(id).scrollIntoView({ block: 'start' });
    get(id).querySelector('h2')?.focus({ preventScroll: true });
  }
}

function drawBlocks(keepSelection = false) {
  const page = currentPage();
  const query = simplify(blockSearch.value.trim());
  const visible = page.groups.filter(group => {
    const text = blockFields(group).filter(field => field.kind === 'text').map(field => fields.get(field.id)?.value ?? field.original);
    return simplify([group.title, cardTitle(group), group.section, group.tag, ...text].join(' ')).includes(query);
  });
  const chosen = visible.find(group => group.id === activeBlock) ?? visible[0];
  if (!keepSelection) drawBlock(chosen);

  const grouped = new Map();
  for (const group of visible) {
    if (!grouped.has(group.section)) grouped.set(group.section, []);
    grouped.get(group.section).push(group);
  }
  const list = get('block-list');
  list.replaceChildren();
  for (const [section, groups] of grouped) {
    list.append(el('h3', section));
    for (const group of groups) {
      const photo = blockFields(group).find(field => field.kind === 'image');
      const context = [group.tag || (group.card ? 'Tarjeta' : 'Encabezado de sección'),
        blocks.get(group.id)?.hidden ? 'Oculta' : ''].filter(Boolean).join(' · ');
      const button = itemButton(cardTitle(group), context, photo && fieldImage(photo), activeBlock === group.id, () => {
        activeBlock = group.id;
        for (const item of list.querySelectorAll('button')) item.setAttribute('aria-current', String(item === button));
        drawBlock(group);
        goToEditor('block-editor');
      });
      list.append(button);
    }
  }
  if (!visible.length) list.append(el('p', 'No hay resultados para esta búsqueda.'));
}

function rememberPreview(control, image, url) {
  const previous = previewUrls.get(control);
  if (previous) URL.revokeObjectURL(previous);
  previewUrls.set(control, url);
  image.src = url;
  image.hidden = false;
}

function photoControl({ label, url, alt = '', key, catalog = false, hidden = false, privatePhoto = false }) {
  const control = get('photo-template').content.firstElementChild.cloneNode(true);
  control.dataset.photo = key;
  control.querySelector('legend').textContent = hidden ? label + ' · Foto oculta' : label;
  const image = control.querySelector('img');
  const file = control.querySelector('[type=file]');
  const mode = control.querySelector('[data-photo-mode]');
  control.querySelector('[data-alt]').value = alt;
  if (url && !privatePhoto) {
    image.src = url;
    image.hidden = false;
  } else if (url) {
    authHeaders().then(headers => fetch(url, { headers })).then(response => {
      if (!response.ok) throw new Error('No se pudo cargar la foto del borrador.');
      return response.blob();
    }).then(blob => {
      if (control.isConnected && mode.value === 'keep') rememberPreview(control, image, URL.createObjectURL(blob));
    }).catch(() => {});
  }
  const choices = [['Conservar como está','keep'], ['Subir una foto','replace']];
  if (!catalog || url) choices.push(['Quitar foto','hide']);
  if (!catalog) choices.push(['Restaurar foto original','restore']);
  mode.replaceChildren(...choices.map(([text, value]) => new Option(text, value)));
  mode.addEventListener('change', () => {
    control.querySelector('[data-upload-fields]').hidden = mode.value !== 'replace';
    if (mode.value !== 'replace') file.value = '';
  });
  file.addEventListener('change', () => {
    if (file.files[0]?.size <= 20 * 1024 * 1024 && photoFormats.has(file.files[0].type)) {
      rememberPreview(control, image, URL.createObjectURL(file.files[0]));
    }
  });
  return control;
}

function textControl(field) {
  const label = el('label', field.editorLabel || field.label);
  const text = el(field.maxLength > 180 ? 'textarea' : 'input');
  text.dataset.field = field.id;
  text.maxLength = field.maxLength;
  text.value = fields.get(field.id)?.value ?? field.original;
  text.required = true;
  if (text.tagName === 'TEXTAREA') text.rows = 3;
  label.append(text);
  return label;
}

function priceControl(field) {
  const box = el('fieldset');
  box.className = 'record';
  const saved = fields.get(field.id);
  const amount = el('input');
  amount.inputMode = 'decimal';
  amount.maxLength = 10;
  amount.dataset.field = field.id;
  amount.value = saved?.value == null ? '' : (Number(saved.value) / 100).toFixed(2);
  const label = el('label', 'Monto en soles');
  label.append(amount);
  const check = el('label', ' Mostrar precio en la web');
  check.className = 'check';
  const toggle = el('input');
  toggle.type = 'checkbox';
  toggle.dataset.priceVisible = '';
  toggle.checked = saved?.price_visible === true;
  check.prepend(toggle);
  box.append(el('legend', 'Precio del servicio'), label, check);
  return box;
}

function drawBlock(group) {
  activeBlock = group?.id;
  releasePreview(blockForm);
  blockForm.hidden = !group;
  get('empty-block').hidden = Boolean(group);
  if (!group) return;
  message('block-status');
  const page = currentPage();
  get('block-location').textContent = [page.name, group.section, group.tag].filter(Boolean).join(' › ');
  get('block-heading').textContent = cardTitle(group);
  get('open-block').href = page.file + '#' + group.anchor;
  get('block-visible-label').hidden = !group.card;
  get('block-visible').checked = blocks.get(group.id)?.hidden !== true;
  const definitions = blockFields(group);
  // Show the image controls alongside the fields that appear on the same card.
  const images = definitions.filter(field => field.kind === 'image');
  const written = definitions.filter(field => field.kind !== 'image');
  const items = images.map(field => photoControl({
    label: field.editorLabel, key: field.id, url: fieldImage(field), hidden: fields.get(field.id)?.photo_hidden,
    alt: fields.get(field.id)?.photo_alt ?? field.original.alt
  }));
  items.push(...written.map(field => field.kind === 'price' ? priceControl(field) : textControl(field)));
  get('block-fields').replaceChildren(...items);
}

function drawCatalogs() {
  const count = state.catalogs.length;
  get('catalog-count').textContent = count + ' de 12 catálogos';
  get('new-catalog').disabled = count >= 12;
  get('catalog-list').replaceChildren(...state.catalogs.map(entry => {
    const current = pages.find(page => page.id === entry.page_id);
    return itemButton(entry.title, current.name + ' · ' + (entry.published ? 'Publicado' : 'Borrador'),
      entry.published && entry.photos[0] ? catalogPhotoUrl(entry.id, entry.photos[0]) : null,
      activeCatalog === entry.id, () => {
        activeCatalog = entry.id;
        drawCatalogs();
        drawCatalog(entry);
        goToEditor('catalog-editor');
      });
  }));
}

function drawCatalog(entry) {
  activeCatalog = entry?.id;
  releasePreview(catalogForm);
  message('catalog-status');
  get('catalog-heading').textContent = entry ? entry.title : 'Nuevo catálogo';
  catalogForm.elements.title.value = entry?.title ?? '';
  catalogForm.elements.description.value = entry?.description ?? '';
  catalogForm.elements.page.value = entry?.page_id ?? pageSelect.value;
  catalogForm.elements.published.checked = entry?.published === true;
  get('delete-catalog').hidden = !entry;
  get('photo-usage').textContent = 'Fotos del catálogo: hasta 4. Biblioteca compartida: ' +
    new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2 }).format(state.photo_bytes / 1048576) + ' de 20 MiB.';
  get('catalog-photos').replaceChildren(...[1, 2, 3, 4].map(number => {
    const saved = entry?.photos.find(photo => photo.slot === number);
    return photoControl({
      label: 'Foto ' + number, key: String(number), catalog: true, alt: saved?.alt ?? '',
      url: saved ? catalogPhotoUrl(entry.id, saved) : null, privatePhoto: entry && !entry.published
    });
  }));
}

function drawContacts() {
  for (const input of contactsForm.querySelectorAll('input[name]')) input.value = state.contacts[input.name] ?? '';
  message('contacts-status');
}

async function stats() {
  const days = get('stats-days').value;
  message('stats-status', 'Cargando estadísticas…');
  try {
    const rows = await admin('/stats?days=' + days);
    if (get('stats-days').value !== days) return;
    const totals = new Map(rows.map(row => [row.metric + '-' + row.scope, row.total]));
    const list = [...pages.map(page => ({ id: page.id, label: page.name })), { id: 'ventas', label: 'Ventas y pedidos' }, { id: 'reportes', label: 'Dashboard y reportes' }];
    const values = list.map(item => ({ ...item, visits: totals.get('visit-' + item.id) ?? 0, clicks: totals.get('whatsapp-' + item.id) ?? 0 }));
    const format = value => new Intl.NumberFormat('es-PE').format(value);
    get('visits-total').textContent = format(values.reduce((sum, item) => sum + item.visits, 0));
    get('clicks-total').textContent = format(values.reduce((sum, item) => sum + item.clicks, 0));
    const ordered = values.sort((a, b) => b.clicks - a.clicks || b.visits - a.visits);
    const top = ordered.find(item => item.id !== 'p0' && item.clicks > 0);
    const tied = ordered.filter(item => item.id !== 'p0' && item.clicks === top?.clicks);
    get('top-service').textContent = tied.length > 1 ? 'Empate · ' + tied.map(item => item.label).join(' y ') : top?.label ?? 'Aún sin clics';
    get('stats-table').replaceChildren(...ordered.map(item => {
      const row = el('tr');
      const name = el('th', item.label);
      name.scope = 'row';
      row.append(name, el('td', format(item.visits)), el('td', format(item.clicks)));
      return row;
    }));
    message('stats-status');
  } catch (error) {
    if (error.status === 401 || error.status === 403) showLogin('Vuelve a iniciar sesión.');
    else message('stats-status', error.message, true);
  }
}

function openView(view) {
  for (const button of document.querySelectorAll('[data-view]')) {
    const isActive = button.dataset.view === view;
    button.setAttribute('aria-pressed', String(isActive));
    get(button.getAttribute('aria-controls')).hidden = !isActive;
  }
  if (view === 'content') drawBlocks();
  if (view === 'catalogs') {
    drawCatalog(state.catalogs.find(item => item.id === activeCatalog));
    drawCatalogs();
  }
  if (view === 'contacts') drawContacts();
  if (view === 'stats') stats();
}

document.querySelectorAll('[data-view]').forEach(button => {
  button.addEventListener('click', () => { if (!saving) openView(button.dataset.view); });
});
pageSelect.addEventListener('change', () => {
  blockSearch.value = '';
  activeBlock = undefined;
  drawBlocks();
});
blockSearch.addEventListener('input', () => { if (!saving) drawBlocks(); });
get('stats-days').addEventListener('change', stats);
get('new-catalog').addEventListener('click', () => {
  drawCatalog();
  drawCatalogs();
  goToEditor('catalog-editor');
});

async function optimizePhoto(file) {
  if (!file || !photoFormats.has(file.type)) throw new Error('Selecciona una foto JPG, PNG o WebP.');
  if (file.size > 20 * 1024 * 1024) throw new Error('Elige una foto original de hasta 20 MiB.');
  let source;
  try { source = await createImageBitmap(file); }
  catch { throw new Error('No se pudo abrir esa foto. Prueba con otro archivo.'); }
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const longest = Math.max(source.width, source.height);
    const start = Math.min(1600, longest);
    const sizes = [start, ...[1360, 1150, 900].filter(side => side < start)];
    for (const side of sizes) {
      canvas.width = Math.max(1, Math.round(source.width * side / longest));
      canvas.height = Math.max(1, Math.round(source.height * side / longest));
      context.imageSmoothingQuality = 'high';
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      for (const quality of [.91, .84, .76]) {
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
        if (blob?.type === 'image/webp' && blob.size <= 512 * 1024) {
          return btoa(Array.from(new Uint8Array(await blob.arrayBuffer()), byte => String.fromCharCode(byte)).join(''));
        }
      }
    }
  } finally { source.close(); }
  throw new Error('Prueba con una foto de menor tamaño.');
}

async function photoChanges(form) {
  const photos = [];
  for (const control of form.querySelectorAll('.photo-control')) {
    const mode = control.querySelector('[data-photo-mode]').value;
    if (mode === 'keep') continue;
    const file = control.querySelector('[type=file]').files[0];
    const alt = control.querySelector('[data-alt]').value.trim();
    photos.push({ key: control.dataset.photo, mode, alt, photo: mode === 'replace' ? await optimizePhoto(file) : null });
  }
  return photos;
}

function priceCents(value, visible) {
  if (!value && !visible) return null;
  if (!/^\d{1,7}(?:[.,]\d{1,2})?$/.test(value)) throw new Error('Ingresa un precio válido en soles, con hasta dos decimales.');
  const [soles, cents = ''] = value.split(/[.,]/);
  return String(Number(soles) * 100 + Number(cents.padEnd(2, '0')));
}

async function save(form, status, payload, done) {
  if (saving) return;
  saving = true;
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  message(status, 'Guardando…');
  try {
    const body = await payload();
    if (body) {
      updateState(await admin('/editor', body));
      done();
      message(status, 'Cambios guardados.');
    } else {
      message(status, 'La edición está al día.');
    }
  } catch (error) {
    if (error.status === 401 || error.status === 403) showLogin('Vuelve a iniciar sesión.');
    else if (error.status === 409) {
      try {
        updateState(await admin('/editor'));
        done();
        message(status, error.message, true);
      } catch { message(status, 'Vuelve a abrir el panel para cargar la edición más reciente.', true); }
    } else message(status, error.message, true);
  } finally {
    submit.disabled = false;
    saving = false;
  }
}

blockForm.addEventListener('submit', event => {
  event.preventDefault();
  const group = currentPage().groups.find(item => item.id === activeBlock);
  if (!group) return;
  save(blockForm, 'block-status', async () => {
    const hidden = group.card && !get('block-visible').checked;
    const version = blocks.get(group.id);
    const definitions = new Map(blockFields(group).map(field => [field.id, field]));
    const changes = [];
    for (const input of blockForm.querySelectorAll('[data-field]')) {
      const field = definitions.get(input.dataset.field);
      const saved = fields.get(field.id);
      const priceVisible = field.kind === 'price' && input.closest('fieldset').querySelector('[data-price-visible]').checked;
      let value = field.kind === 'price' ? priceCents(input.value.trim(), priceVisible) : input.value.trim();
      if (field.kind === 'text' && !value) throw new Error('Escribe un texto para ' + field.editorLabel.toLowerCase() + '.');
      if (field.kind === 'text' && value === field.original) value = null;
      if (value === (saved?.value ?? null) && priceVisible === (saved?.price_visible ?? false)) continue;
      changes.push({ id: field.id, revision: saved?.revision ?? null, value, priceVisible, photo: null, alt: null });
    }
    for (const photo of await photoChanges(blockForm)) {
      changes.push({ ...photo, id: photo.key, revision: fields.get(photo.key)?.revision ?? null, value: null });
    }
    if (!changes.length && hidden === (version?.hidden ?? false)) return null;
    return { type: 'block', id: group.id, revision: version?.revision ?? null, hidden, fields: changes };
  }, () => {
    if (currentPage().groups.includes(group) && activeBlock === group.id) drawBlock(group);
    drawBlocks(true);
  });
});

catalogForm.addEventListener('submit', event => {
  event.preventDefault();
  const entry = state.catalogs.find(item => item.id === activeCatalog);
  save(catalogForm, 'catalog-status', async () => ({
    type: 'catalog', id: entry?.id ?? null, revision: entry?.revision ?? null,
    page: catalogForm.elements.page.value, title: catalogForm.elements.title.value.trim(),
    description: catalogForm.elements.description.value.trim(), published: catalogForm.elements.published.checked,
    photos: (await photoChanges(catalogForm)).map(item => ({ slot: Number(item.key), photo: item.photo, alt: item.alt }))
  }), () => {
    drawCatalog(state.catalogs.find(item => item.id === (state.saved_id ?? entry?.id)));
    drawCatalogs();
  });
});

get('delete-catalog').addEventListener('click', () => {
  const entry = state.catalogs.find(item => item.id === activeCatalog);
  if (!entry || saving || !confirm('¿Borrar «' + entry.title + '» y sus fotos del catálogo?')) return;
  save(catalogForm, 'catalog-status', () => ({ type: 'catalog', id: entry.id, revision: entry.revision, remove: true }), () => {
    drawCatalog(state.catalogs.find(item => item.id === entry.id));
    drawCatalogs();
  });
});

contactsForm.addEventListener('submit', event => {
  event.preventDefault();
  save(contactsForm, 'contacts-status', () => ({
    type: 'contacts', revision: state.contacts.revision,
    ...Object.fromEntries(Array.from(new FormData(contactsForm), ([key, value]) => [key, value.trim()]))
  }), drawContacts);
});

if (session?.refresh_token) openWorkspace().catch(error => showLogin(error.status >= 500 ? error.message : ''));
else showLogin();
