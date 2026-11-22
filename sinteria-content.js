export const projectUrl = 'https://pdnalhyhgorcaiosrjsr.supabase.co';
export const publicKey = "sb_publishable_m1WYsylQ5zSboEXnIIoUIA_pUhIenkW";
export const contentApi = projectUrl + '/functions/v1/sinteria-content';

export const photoUrl = (id, revision) => contentApi + '/media/' + id + '/' + revision;

async function loadPublished(pageId) {
  const params = new URLSearchParams({
    select: 'id,revision,display_value,has_photo,photo_alt',
    revision: 'not.is.null'
  });
  if (pageId === 'p0') {
    params.set('or', '(page_id.eq.p0,id.eq.p1-price-0,id.eq.p2-price-0)');
  } else {
    params.set('page_id', 'eq.' + pageId);
  }
  const response = await fetch(projectUrl + '/rest/v1/sinteria_site_fields?' + params, {
    headers: { apikey: publicKey },
    signal: AbortSignal.timeout(4000)
  });
  if (!response.ok) return [];
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

async function applyPublishedContent(main) {
  const rows = await loadPublished(main.dataset.cmsPage);
  const fields = new Map(rows.map(row => [row.id, row]));
  for (const element of main.querySelectorAll('[data-cms-text]')) {
    const field = fields.get(element.dataset.cmsText);
    if (field?.display_value) changeText(element, field.display_value);
  }
  for (const image of main.querySelectorAll('img[data-cms-image]')) {
    const field = fields.get(image.dataset.cmsImage);
    if (field?.has_photo) changePhoto(image, field);
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
}

const publicPage = document.querySelector('main[data-cms-page]');
if (publicPage) {
  // The original document is the fallback when the content service is unavailable.
  applyPublishedContent(publicPage).catch(() => {});
}
