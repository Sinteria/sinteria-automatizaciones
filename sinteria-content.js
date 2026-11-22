import { setUpConsent } from './sinteria-consent.js';

export const projectUrl = 'https://pdnalhyhgorcaiosrjsr.supabase.co';
export const publicKey = "sb_publishable_m1WYsylQ5zSboEXnIIoUIA_pUhIenkW";
export const contentApi = projectUrl + '/functions/v1/sinteria-content';

export const photoUrl = (id, revision) => contentApi + '/media/' + id + '/' + revision;
export const catalogPhotoUrl = (id, photo) => contentApi + '/catalog-media/' + id + '/' + photo.slot + '/' + photo.revision;

async function loadPublished(pageId) {
  const response = await fetch(projectUrl + '/rest/v1/rpc/sinteria_public_snapshot', {
    method: 'POST',
    headers: { apikey: publicKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_page: pageId }),
    signal: AbortSignal.timeout(4000)
  });
  if (!response.ok) return null;
  return response.json();
}

function changeText(element, text) {
  const gradient = element.querySelector('.gradient-text');
  if (!gradient) {
    element.textContent = text;
    return;
  }

  const words = text.trim().split(/\s+/);
  const accentWords = Math.min(gradient.textContent.trim().split(/\s+/).length, words.length);
  const accent = gradient.cloneNode(false);
  accent.textContent = words.splice(-accentWords).join(' ');
  const lead = words.join(' ');
  const separateLine = Boolean(element.querySelector('br'));
  element.replaceChildren();
  if (lead) {
    element.append(lead);
    element.append(separateLine ? document.createElement('br') : ' ');
  }
  element.append(accent);
}

function changePhoto(element, field) {
  const url = photoUrl(field.id, field.revision);
  const galleryLink = element.closest('a.image-open');
  const originals = new Map([
    [element, new Map(['src', 'srcset', 'sizes', 'alt'].map(attr => [attr, element.getAttribute(attr)]))]
  ]);
  if (galleryLink) {
    originals.set(galleryLink, new Map(['href', 'data-full', 'data-caption'].map(attr => [attr, galleryLink.getAttribute(attr)])));
  }
  element.addEventListener('error', () => {
    for (const [node, attributes] of originals) {
      for (const [name, value] of attributes) {
        if (value === null) node.removeAttribute(name);
        else node.setAttribute(name, value);
      }
    }
  }, { once: true });

  element.alt = field.photo_alt ?? element.alt;
  element.removeAttribute('srcset');
  element.removeAttribute('sizes');
  element.src = url;
  if (galleryLink) {
    galleryLink.href = url;
    galleryLink.dataset.full = url;
    galleryLink.dataset.caption = field.photo_alt || galleryLink.dataset.caption;
  }
}

const currency = new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' });

function localText(element, search, replacement) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    walker.currentNode.data = walker.currentNode.data.replace(search, replacement);
  }
}

function displayPhone(number) {
  return number.startsWith('51') && number.length === 11
    ? '+51 ' + number.slice(2, 5) + ' ' + number.slice(5, 8) + ' ' + number.slice(8)
    : '+' + number;
}

function applyContacts(contact) {
  if (!contact) return;
  const phone = displayPhone(contact.whatsapp);
  for (const anchor of document.querySelectorAll('a[href^="https://wa.me/"]')) {
    if (contact.whatsapp !== '51932280554') {
      const url = new URL(anchor.href);
      url.pathname = '/' + contact.whatsapp;
      anchor.href = url.href;
      localText(anchor, '+51 932 280 554', phone);
    }
  }
  for (const anchor of document.querySelectorAll('a[href^="mailto:contacto.sinteria@gmail.com"]')) {
    if (contact.email === 'contacto.sinteria@gmail.com') continue;
    anchor.href = anchor.href.replace('contacto.sinteria@gmail.com', contact.email);
    localText(anchor, 'contacto.sinteria@gmail.com', contact.email);
  }
  const facebook = document.querySelector('footer a[href*="facebook.com"]');
  if (facebook) {
    if (contact.facebook) facebook.href = contact.facebook;
    else { facebook.dataset.cmsSocial = ''; facebook.hidden = true; }
  }
  const socialParent = facebook?.parentElement?.tagName === 'LI'
    ? facebook.parentElement.parentElement : document.querySelector('.cms-legal-links');
  if (socialParent) {
    for (const [key, label] of [['instagram', 'Instagram'], ['tiktok', 'TikTok']]) {
      if (!contact[key]) continue;
      const link = document.createElement('a');
      link.textContent = label;
      link.href = contact[key];
      link.target = '_blank';
      link.rel = 'noopener';
      if (socialParent.matches('ul, ol')) {
        const item = document.createElement('li');
        item.append(link);
        socialParent.append(item);
      } else {
        socialParent.append(link);
      }
    }
  }
  if (contact.business_name) {
    document.querySelectorAll('[data-cms-business-name]').forEach(node => { node.textContent = contact.business_name; });
  }
  if (contact.business_address) {
    document.querySelectorAll('[data-cms-business-address]').forEach(node => {
      node.textContent = contact.business_address;
      node.closest('[data-cms-legal-detail]').hidden = false;
    });
  }
  if (contact.complaints_url) {
    for (const anchor of document.querySelectorAll('[data-cms-complaint]')) {
      anchor.href = contact.complaints_url;
      anchor.textContent = 'Abrir Libro de Reclamaciones';
    }
    const instructions = document.querySelector('[data-cms-complaint-copy]');
    if (instructions) instructions.textContent = 'Abre el Libro de Reclamaciones para presentar tu queja o reclamo.';
  }
}

function showCatalogs(main, catalogs, contact) {
  if (!catalogs.length) return;
  const section = document.createElement('section');
  section.className = 'cms-catalogs';
  section.id = 'catalogos';
  const inner = document.createElement('div');
  inner.className = 'cms-catalogs-inner';
  const heading = document.createElement('h2');
  heading.textContent = 'Catálogos';
  const grid = document.createElement('div');
  grid.className = 'cms-catalog-grid';
  for (const entry of catalogs) {
    const card = document.createElement('article');
    card.className = 'cms-catalog-card';
    if (entry.photos.length) {
      const images = document.createElement('div');
      images.className = 'cms-catalog-photos';
      for (const photo of entry.photos) {
        const image = document.createElement('img');
        image.src = catalogPhotoUrl(entry.id, photo);
        image.alt = photo.alt || entry.title;
        image.loading = 'lazy';
        const full = document.createElement('a');
        full.href = image.src;
        full.target = '_blank';
        full.rel = 'noopener';
        full.append(image);
        images.append(full);
      }
      card.append(images);
    }
    const title = document.createElement('h3');
    title.textContent = entry.title;
    card.append(title);
    if (entry.description) {
      const description = document.createElement('p');
      description.textContent = entry.description;
      card.append(description);
    }
    const ask = document.createElement('a');
    ask.href = 'https://wa.me/' + contact.whatsapp + '?text=' + encodeURIComponent('Hola, Sinteria. Quisiera información sobre ' + entry.title + '.');
    ask.textContent = 'Consultar por WhatsApp';
    ask.dataset.waService = main.dataset.cmsPage;
    ask.target = '_blank';
    ask.rel = 'noopener';
    card.append(ask);
    grid.append(card);
  }
  inner.append(heading, grid);
  section.append(inner);
  main.append(section);
}

async function applyPublishedContent(main) {
  const snapshot = await loadPublished(main?.dataset.cmsPage ?? 'legal');
  if (!snapshot) return;
  applyContacts(snapshot.contacts);
  if (!main) return;
  const fields = new Map(snapshot.fields.map(row => [row.id, row]));
  const hidden = new Set(snapshot.hidden_blocks);
  for (const element of main.querySelectorAll('[data-cms-block]')) {
    if (hidden.has(element.dataset.cmsBlock)) element.hidden = true;
  }
  for (const element of main.querySelectorAll('[data-cms-text]')) {
    const field = fields.get(element.dataset.cmsText);
    if (field?.display_value) changeText(element, field.display_value);
  }
  for (const image of main.querySelectorAll('img[data-cms-image]')) {
    const field = fields.get(image.dataset.cmsImage);
    if (field?.photo_hidden) {
      const frame = image.closest('[data-cms-photo-frame]');
      if (frame) frame.hidden = true;
    } else if (field?.has_photo) {
      changePhoto(image, field);
    }
  }
  for (const anchor of main.querySelectorAll('[data-cms-price-after]')) {
    const value = fields.get(anchor.dataset.cmsPriceAfter)?.display_value;
    if (value == null) continue;
    const price = document.createElement('p');
    const amount = document.createElement('strong');
    amount.textContent = currency.format(Number(value) / 100);
    price.append(amount);
    anchor.after(price);
  }
  showCatalogs(main, snapshot.catalogs, snapshot.contacts);
}

const publicPage = document.querySelector('main[data-cms-page]');
if (publicPage || document.body.hasAttribute('data-cms-legal')) {
  // The original document is the fallback when the content service is unavailable.
  setUpConsent(publicPage?.dataset.cmsPage, contentApi + '/record');
  applyPublishedContent(publicPage).catch(() => {});
}
