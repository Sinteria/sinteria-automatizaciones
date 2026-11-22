const key = 'sinteria-cookie-settings-v1';
const duration = 180 * 24 * 60 * 60 * 1000;

function loadChoice() {
  try {
    const choice = JSON.parse(localStorage.getItem(key));
    if (typeof choice?.stats === 'boolean' && Date.now() < choice.until) return choice.stats;
    localStorage.removeItem(key);
  } catch {
    // Start without statistics if storage is unavailable or the choice is invalid.
  }
  return null;
}

export function setUpConsent(page, endpoint) {
  let choice = loadChoice();
  let visited = false;
  const banner = document.createElement('section');
  banner.className = 'cms-consent';
  banner.setAttribute('aria-labelledby', 'cms-consent-title');
  banner.hidden = choice !== null;
  banner.innerHTML = '<h2 id="cms-consent-title">Cookies y privacidad</h2>' +
    '<p>Guardamos tu elección en este navegador. Con tu permiso podemos contar visitas y clics en WhatsApp.</p>' +
    '<div class="cms-consent-options" hidden>' +
      '<label><input type="checkbox" checked disabled> Preferencia esencial</label>' +
      '<label><input type="checkbox" data-stats-choice> Estadísticas opcionales</label>' +
      '<a href="/legal.html#cookies">Qué se guarda</a>' +
    '</div>' +
    '<div class="cms-consent-actions"><button type="button" data-consent="allow">Aceptar estadísticas</button>' +
      '<button type="button" data-consent="deny">Rechazar estadísticas</button>' +
      '<button type="button" data-consent="configure" aria-expanded="false">Personalizar</button>' +
      '<button type="button" data-consent="save" hidden>Guardar elección</button>' +
    '</div>';
  document.body.append(banner);

  const options = banner.querySelector('.cms-consent-options');
  const checkbox = banner.querySelector('[data-stats-choice]');
  const configure = banner.querySelector('[data-consent="configure"]');
  const save = banner.querySelector('[data-consent="save"]');
  let returnFocus = null;

  function count(metric, scope) {
    if (choice !== true || !page) return;
    fetch(endpoint, {
      method: 'POST',
      body: JSON.stringify({ metric, scope }),
      keepalive: true,
      credentials: 'omit',
      referrerPolicy: 'no-referrer'
    }).catch(() => {});
  }

  function countVisit() {
    if (!visited && choice === true && page) {
      visited = true;
      count('visit', page);
    }
  }

  function showOptions(show) {
    options.hidden = save.hidden = !show;
    configure.setAttribute('aria-expanded', String(show));
    checkbox.checked = choice === true;
  }

  banner.addEventListener('click', event => {
    const action = event.target.closest('[data-consent]')?.dataset.consent;
    if (!action) return;
    if (action === 'configure') {
      showOptions(options.hidden);
      if (!options.hidden) checkbox.focus();
      return;
    }
    choice = action === 'allow' || (action === 'save' && checkbox.checked);
    try {
      localStorage.setItem(key, JSON.stringify({ stats: choice, until: Date.now() + duration }));
    } catch {
      // Honor the choice for the current page even without browser storage.
    }
    banner.hidden = true;
    showOptions(false);
    returnFocus?.focus();
    countVisit();
  });

  function openPreferences(event) {
    const link = event.target.closest('[data-cookie-settings]');
    if (!link) return false;
    event.preventDefault();
    returnFocus = link;
    banner.hidden = false;
    showOptions(true);
    checkbox.focus();
    return true;
  }

  function handleLink(event) {
    const anchor = event.target.closest('a[data-wa-service]');
    if (anchor?.hostname === 'wa.me') count('whatsapp', anchor.dataset.waService);
  }

  document.addEventListener('click', event => {
    if (!openPreferences(event)) handleLink(event);
  });
  document.addEventListener('auxclick', event => {
    if (event.button === 1) handleLink(event);
  });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key == null) {
      choice = loadChoice();
      if (!banner.hidden) showOptions(!options.hidden);
      countVisit();
    }
  });
  countVisit();
}
