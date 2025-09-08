// assets/js/app.js
(function () {
  const navButtons = document.querySelectorAll('.app-nav__item');
  const sections = document.querySelectorAll('.section');
  const spinner = document.getElementById('global-spinner');

  function showSection(id) {
    sections.forEach(sec => {
      sec.classList.toggle('is-visible', sec.id === id);
    });
  }

  function setActive(btn) {
    navButtons.forEach(b => b.classList.remove('is-active'));
    btn.classList.add('is-active');
  }

  function withSpinner(fn, delay = 500) {
    spinner.classList.add('is-active');
    setTimeout(() => {
      try { fn(); } finally {
        spinner.classList.remove('is-active');
      }
    }, delay);
  }

  navButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-section');
      if (!target) return;
      setActive(btn);
      withSpinner(() => showSection(target), 500);
    });
  });

  // Estado inicial
  showSection('overview');
})();
