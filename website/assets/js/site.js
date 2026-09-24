/* iHub Apps marketing site — navigation menus, tabs and screenshot lightbox. */
(function () {
  const nav = document.querySelector('.nav');

  // Dropdown menus: click to toggle, close on outside click or Escape.
  document.querySelectorAll('.nav-links > li > button').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const li = btn.parentElement;
      const wasOpen = li.classList.contains('open');
      document.querySelectorAll('.nav-links > li.open').forEach(o => o.classList.remove('open'));
      if (!wasOpen) li.classList.add('open');
      btn.setAttribute('aria-expanded', String(!wasOpen));
    });
  });
  document.addEventListener('click', () => {
    document.querySelectorAll('.nav-links > li.open').forEach(o => {
      o.classList.remove('open');
      o.querySelector('button')?.setAttribute('aria-expanded', 'false');
    });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.nav-links > li.open').forEach(o => o.classList.remove('open'));
      closeLightbox();
    }
  });

  // Mobile menu toggle.
  const toggle = document.querySelector('.nav-toggle');
  toggle?.addEventListener('click', e => {
    e.stopPropagation();
    const open = nav.classList.toggle('mobile-open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  // Tabs.
  document.querySelectorAll('[data-tabs]').forEach(group => {
    const buttons = group.querySelectorAll('.tabs button');
    const panels = group.querySelectorAll('.tab-panel');
    buttons.forEach((b, i) => {
      b.addEventListener('click', () => {
        buttons.forEach(x => x.setAttribute('aria-selected', 'false'));
        panels.forEach(p => p.classList.remove('active'));
        b.setAttribute('aria-selected', 'true');
        panels[i].classList.add('active');
      });
    });
  });

  // Lightbox for screenshots.
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.setAttribute('role', 'dialog');
  lb.setAttribute('aria-modal', 'true');
  lb.innerHTML = '<img alt="">';
  document.body.appendChild(lb);
  const lbImg = lb.querySelector('img');
  function closeLightbox() {
    lb.classList.remove('open');
  }
  lb.addEventListener('click', closeLightbox);
  document.querySelectorAll('.zoomable img').forEach(img => {
    img.addEventListener('click', () => {
      lbImg.src = img.currentSrc || img.src;
      lbImg.alt = img.alt;
      lb.classList.add('open');
    });
  });

  // Copy buttons for install snippets.
  document.querySelectorAll('[data-copy]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const text = btn.getAttribute('data-copy');
      try {
        await navigator.clipboard.writeText(text);
        const old = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => (btn.textContent = old), 1500);
      } catch {
        /* clipboard unavailable */
      }
    });
  });
})();
