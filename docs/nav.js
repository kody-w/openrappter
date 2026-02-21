/* OpenRappter v1.4.1 — Shared Navigation JS */

(function () {
  'use strict';

  /* ── Mobile menu toggle ── */
  var menuBtn = document.querySelector('.mobile-menu-btn');
  var navLinks = document.querySelector('.nav-links');
  if (menuBtn && navLinks) {
    menuBtn.addEventListener('click', function () {
      navLinks.classList.toggle('open');
      menuBtn.textContent = navLinks.classList.contains('open') ? '\u2715' : '\u2630';
    });
  }

  /* ── Active link highlighting ── */
  var path = window.location.pathname;
  document.querySelectorAll('.nav-links a[href]').forEach(function (a) {
    var href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('http')) return;
    var file = href.replace('./', '');
    if (
      (file === '' && (path.endsWith('/') || path.endsWith('/index.html'))) ||
      path.endsWith('/' + file)
    ) {
      a.classList.add('active');
    }
  });

  /* ── Code tab switching ── */
  window.switchTab = function (btn, tabId) {
    var container = btn.closest('.code-tabs');
    if (!container) return;
    container.querySelectorAll('.code-tab-btn').forEach(function (b) {
      b.classList.remove('active');
    });
    container.querySelectorAll('.code-tab-content').forEach(function (c) {
      c.classList.remove('active');
    });
    btn.classList.add('active');
    var target = document.getElementById(tabId);
    if (target) target.classList.add('active');
  };

  /* ── Copy-to-clipboard on <pre> blocks ── */
  document.querySelectorAll('pre').forEach(function (pre) {
    if (pre.closest('.terminal-body')) return;
    var btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', function () {
      var text = pre.textContent.replace(/^Copy/, '').trim();
      navigator.clipboard.writeText(text).then(function () {
        btn.textContent = 'Copied!';
        setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
      });
    });
    pre.style.position = 'relative';
    pre.appendChild(btn);
  });
})();
