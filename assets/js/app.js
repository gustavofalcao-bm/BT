// assets/js/app.js
(function () {
  // ==== Navegação + Spinner ====
  const navButtons = document.querySelectorAll('.app-nav__item');
  const sections = document.querySelectorAll('.section');
  const spinner = document.getElementById('global-spinner');

  function showSection(id) {
    sections.forEach(sec => sec.classList.toggle('is-visible', sec.id === id));
  }
  function setActive(btn) {
    navButtons.forEach(b => b.classList.remove('is-active'));
    btn.classList.add('is-active');
  }
  function withSpinner(fn, delay = 500) {
    spinner.classList.add('is-active');
    setTimeout(() => { Promise.resolve(fn()).finally(() => spinner.classList.remove('is-active')); }, delay);
  }
  navButtons.forEach(btn => {
    btn.addEventListener('pointermove', (e) => {
      btn.style.setProperty('--x', `${e.offsetX}px`);
      btn.style.setProperty('--y', `${e.offsetY}px`);
    });
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-section');
      if (!target) return;
      setActive(btn);
      withSpinner(() => {
        showSection(target);
        if (target === 'noc') ensureNocOnce();
      }, 250);
    });
  });
  showSection('overview');

  // ==== Config API Movidesk ====
  // Produção: usar PROXY_URL e manter token no servidor com CORS liberado para o domínio do dashboard.
  const PROXY_URL = ''; // ex.: 'https://seu-proxy.example.com/tickets'

  // Teste rápido (não recomendado em produção): token exposto (pode falhar por CORS).
  const DIRECT_URL_BASE = 'https://api.movidesk.com/public/v1/tickets';

  // Substitua APENAS para teste rápido; remova do commit público em produção.
  const TOKEN = 'SEU_TOKEN_AQUI';

  // Campos e expand baseados no exemplo
  const SELECT_FIELDS = [
    'justification','lastUpdate','resolvedIn','status','category','subject','createdDate',
    'protocol','ownerTeam','owner','createdBy','origin','serviceFull','serviceFirstLevel',
    'serviceSecondLevel','serviceThirdLevel','slaSolutionTime','slaResponseTime','slaAgreement',
    'slaAgreementRule','slaSolutionDate','slaResponseDate','clients','stoppedTime','stoppedTimeWorkingTime'
  ].join(',');
  const EXPAND = "createdBy,owner,actions($select=description,type,status,justification),clients($expand=organization)";
  const FILTER_BASE = "ownerTeam ne 'Conecta %2B'";
  const ORDER = "createdDate desc";

  // ==== Estado global simples ====
  const state = {
    allTickets: [],
    monthMode: 'current', // 'current' | 'previous'
    charts: { incidents: null, sla: null },
    nocLoaded: false
  };

  // ==== Utilitários de data ====
  function monthRange(mode = 'current') {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const start = mode === 'current' ? new Date(y, m, 1) : new Date(y, m - 1, 1);
    const end = mode === 'current' ? new Date(y, m + 1, 1) : new Date(y, m, 1);
    return { start, end };
  }
  function inRange(dateStr, start, end) {
    const t = Date.parse(dateStr);
    return !isNaN(t) && t >= start.getTime() && t < end.getTime();
  }
  function monthKey(d) {
    const dt = (d instanceof Date) ? d : new Date(d);
    const y = dt.getFullYear();
    const m = dt.getMonth() + 1;
    return `${y}-${String(m).padStart(2,'0')}`;
  }
  function lastNMonths(n = 6) {
    const arr = [];
    const base = new Date();
    base.setDate(1);
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
      arr.push(monthKey(d));
    }
    return arr;
  }

  // ==== Regras de status e SLA ====
  function isOpen(status) {
    const s = String(status || '').toLowerCase();
    return !(s.includes('fech') || s.includes('closed') || s.includes('resol'));
  }
  // SLA on-time por ticket:
  // - se resolvedIn e slaSolutionTime: on-time se resolvedIn <= slaSolutionTime
  // - se aberto: on-time se agora <= slaSolutionDate; senão, overdue
  function slaOnTime(ticket) {
    const now = Date.now();
    const due = ticket.slaSolutionDate ? Date.parse(ticket.slaSolutionDate) : NaN;
    if (typeof ticket.resolvedIn === 'number' && typeof ticket.slaSolutionTime === 'number') {
      return ticket.resolvedIn <= ticket.slaSolutionTime;
    }
    if (isOpen(ticket.status) && !isNaN(due)) {
      return now <= due;
    }
    // sem dados suficientes
    return false;
  }
  function slaIsOverdue(ticket) {
    const now = Date.now();
    const due = ticket.slaSolutionDate ? Date.parse(ticket.slaSolutionDate) : NaN;
    if (typeof ticket.resolvedIn === 'number' && typeof ticket.slaSolutionTime === 'number') {
      return ticket.resolvedIn > ticket
