(() => {
  const query = new URLSearchParams(location.search);
  const requestedTheme = query.get('theme');
  const initialTheme = requestedTheme === 'dark' || (requestedTheme !== 'light' && document.body.dataset.defaultTheme === 'dark') ? 'dark' : 'light';
  const root = document.documentElement;
  const applyTheme = (theme) => {
    root.dataset.tdlTheme = theme;
    document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
      const dark = theme === 'dark';
      button.setAttribute('aria-pressed', String(dark));
      if (button.classList.contains('icon')) {
        button.textContent = '◐';
        button.setAttribute('aria-label', dark ? 'Use light theme' : 'Use dark theme');
      } else {
        button.textContent = dark ? 'Light theme' : 'Dark theme';
      }
    });
  };
  applyTheme(initialTheme);
  document.querySelectorAll('[data-theme-toggle]').forEach((button) => {
    button.addEventListener('click', () => applyTheme(root.dataset.tdlTheme === 'dark' ? 'light' : 'dark'));
  });

  document.querySelectorAll('[data-fixture-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const note = document.querySelector('[data-fixture-note]');
      if (note) {
        note.hidden = false;
        note.focus();
      }
    });
  });

  const rail = document.querySelector('.rail');
  const menuButton = document.querySelector('.menu-btn');
  if (rail && menuButton) {
    const narrow = window.matchMedia('(max-width: 760px)');
    const backdrop = document.createElement('button');
    backdrop.type = 'button';
    backdrop.className = 'rail-backdrop';
    backdrop.setAttribute('aria-label', 'Close navigation');
    backdrop.hidden = true;
    document.body.append(backdrop);

    rail.id ||= 'primary-navigation';
    menuButton.setAttribute('aria-controls', rail.id);
    menuButton.setAttribute('aria-expanded', 'false');

    const closeMenu = ({ restoreFocus = true } = {}) => {
      rail.classList.remove('is-open');
      document.body.classList.remove('mobile-menu-open');
      backdrop.hidden = true;
      menuButton.setAttribute('aria-expanded', 'false');
      menuButton.setAttribute('aria-label', 'Open navigation');
      rail.inert = narrow.matches;
      if (restoreFocus && narrow.matches) menuButton.focus();
    };

    const openMenu = () => {
      rail.inert = false;
      rail.classList.add('is-open');
      document.body.classList.add('mobile-menu-open');
      backdrop.hidden = false;
      menuButton.setAttribute('aria-expanded', 'true');
      menuButton.setAttribute('aria-label', 'Close navigation');
      requestAnimationFrame(() => (rail.querySelector('a[aria-current="page"]') || rail.querySelector('a'))?.focus());
    };

    menuButton.addEventListener('click', () => {
      if (menuButton.getAttribute('aria-expanded') === 'true') closeMenu();
      else openMenu();
    });
    backdrop.addEventListener('click', () => closeMenu());
    rail.addEventListener('click', (event) => {
      if (narrow.matches && event.target.closest('a')) closeMenu({ restoreFocus: false });
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && rail.classList.contains('is-open')) closeMenu();
    });
    narrow.addEventListener('change', () => {
      if (narrow.matches) closeMenu({ restoreFocus: false });
      else {
        rail.inert = false;
        rail.classList.remove('is-open');
        document.body.classList.remove('mobile-menu-open');
        backdrop.hidden = true;
      }
    });
    rail.inert = narrow.matches;
  }
})();
