// assets/js/app.js
(function () {
  // ===== Navegação e spinner (síncronos para UX estável) =====
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
  function showSpinner() { spinner && spinner.classList.add('is-active'); }
  function hideSpinner() { spinner && spinner.classList.remove('is-active'); }

  navButtons.forEach(btn => {
    btn.addEventListener('pointermove', (e) => {
      btn.style.setProperty('--x', `${e.offsetX}px`);
      btn.style.setProperty('--y', `${e.offsetY}px`);
    });
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-section');
      if (!target) return;
      setActive(btn);
      showSection(target); // troca imediata
      if (target === 'noc') bootstrapNOC();
      if (target === 'servicos') bootstrapServices();
    });
  });
  showSection('overview');

  // ===== Config Movidesk (considere um proxy em produção) =====
  const PROXY_URL = ''; // ex.: 'https://seu-proxy.example.com/tickets' (injeta token e CORS)
  const DIRECT_URL_BASE = 'https://api.movidesk.com/public/v1/tickets'; // teste rápido
  const TOKEN = 'SEU_TOKEN_AQUI'; // NÃO commitar token real em repo público

  const SELECT_FIELDS = [
    'justification','lastUpdate','resolvedIn','status','category','subject','createdDate',
    'protocol','ownerTeam','owner','createdBy','origin','serviceFull','serviceFirstLevel',
    'serviceSecondLevel','serviceThirdLevel','slaSolutionTime','slaResponseTime','slaAgreement',
    'slaAgreementRule','slaSolutionDate','slaResponseDate','clients','stoppedTime','stoppedTimeWorkingTime'
  ].join(',');
  const EXPAND = "createdBy,owner,actions($select=description,type,status,justification),clients($expand=organization)";
  const FILTER_BASE = "ownerTeam ne 'Conecta %2B'";
  const ORDER = "createdDate desc";

  // ===== Estado =====
  const state = {
    allTickets: [],
    monthMode: 'current',
    charts: {},
    nocBootstrapped: false,
    servicesBootstrapped: false
  };

  // ===== Utilitários de data e SLA =====
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
    return !isNaN(t) && t >= +start && t < +end;
  }
  function monthKey(d) {
    const dt = (d instanceof Date) ? d : new Date(d);
    const y = dt.getFullYear(), m = dt.getMonth() + 1;
    return `${y}-${String(m).padStart(2,'0')}`;
  }
  function lastNMonths(n = 6) {
    const arr = [];
    const base = new Date(); base.setDate(1);
    for (let i = n - 1; i >= 0; i--) arr.push(monthKey(new Date(base.getFullYear(), base.getMonth() - i, 1)));
    return arr;
  }
  function isOpen(status) {
    const s = String(status || '').toLowerCase();
    return !(s.includes('fech') || s.includes('closed') || s.includes('resol'));
  }
  function slaOnTime(t) {
    const now = Date.now();
    const due = t.slaSolutionDate ? Date.parse(t.slaSolutionDate) : NaN;
    if (typeof t.resolvedIn === 'number' && typeof t.slaSolutionTime === 'number') return t.resolvedIn <= t.slaSolutionTime;
    if (isOpen(t.status) && !isNaN(due)) return now <= due;
    return false;
  }
  function slaIsOverdue(t) {
    const now = Date.now();
    const due = t.slaSolutionDate ? Date.parse(t.slaSolutionDate) : NaN;
    if (typeof t.resolvedIn === 'number' && typeof t.slaSolutionTime === 'number') return t.resolvedIn > t.slaSolutionTime;
    if (isOpen(t.status) && !isNaN(due)) return now > due;
    return false;
  }

  // ===== Fetch paginado Movidesk =====
  async function fetchPage(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  async function fetchTicketsPaginated({ useProxy = false, sinceISO = null }) {
    const pageSize = 1000;
    let filter = FILTER_BASE;
    if (sinceISO) filter += ` and createdDate ge ${sinceISO}`;
    const queryBase =
      `token=${encodeURIComponent(TOKEN)}&$select=${encodeURIComponent(SELECT_FIELDS)}` +
      `&$expand=${encodeURIComponent(EXPAND)}` +
      `&$filter=${encodeURIComponent(filter)}` +
      `&$orderby=${encodeURIComponent(ORDER)}`;
    let all = [];
    for (let skip = 0; ; skip += pageSize) {
      const pageQuery = `${queryBase}&$top=${pageSize}&$skip=${skip}`;
      const url = useProxy && PROXY_URL ? `${PROXY_URL}?${pageQuery}` : `${DIRECT_URL_BASE}?${pageQuery}`;
      const chunk = await fetchPage(url);
      if (!Array.isArray(chunk) || chunk.length === 0) break;
      all = all.concat(chunk);
      if (chunk.length < pageSize) break;
      await new Promise(r => setTimeout(r, 300));
    }
    return all;
  }

  // ===== Agregações =====
  function groupByClient(tickets, maxItems = 10) {
    const map = new Map();
    for (const t of tickets) {
      if (!Array.isArray(t.clients)) continue;
      for (const c of t.clients) {
        const org = c.organization && (c.organization.businessName || c.organization.corporateName);
        const name = org || c.businessName || c.corporateName || 'Cliente';
        map.set(name, (map.get(name) || 0) + 1);
      }
    }
    return [...map.entries()].sort((a,b)=>b[8]-a[8]).slice(0, maxItems);
  }
  function monthlyIncidentsSeries(tickets, months) {
    const byKey = new Map(months.map(k => [k, 0]));
    for (const t of tickets) {
      const isIncident =
        (t.category && String(t.category).toLowerCase().includes('inciden')) ||
        (t.serviceSecondLevel && String(t.serviceSecondLevel).toLowerCase().includes('inciden'));
      if (!isIncident) continue;
      const key = monthKey(t.createdDate);
      if (byKey.has(key)) byKey.set(key, byKey.get(key) + 1);
    }
    return months.map(k => byKey.get(k) || 0);
  }
  function monthlySlaSeries(tickets, months) {
    const counts = new Map(months.map(k => [k, {on:0, tot:0}]));
    for (const t of tickets) {
      const key = monthKey(t.createdDate);
      if (!counts.has(key)) continue;
      const rec = counts.get(key); rec.tot += 1; if (slaOnTime(t)) rec.on += 1;
    }
    return months.map(k => {
      const {on, tot} = counts.get(k); return tot > 0 ? Math.round((on/tot)*100) : 0;
    });
  }

  // ===== UI helpers =====
  function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = String(text); }
  function fillOverviewNOC({ total, inSLA, outSLA }) {
    setText('ov-noc-in', inSLA); setText('ov-noc-out', outSLA); setText('ov-noc-total', total);
    const ts = new Date().toLocaleString();
    setText('ov-noc-in-meta', `Atualizado em ${ts}`);
    setText('ov-noc-out-meta', `Atualizado em ${ts}`);
    setText('ov-noc-total-meta', `Atualizado em ${ts}`);
  }
  function fillKPIsNOC({ total, inSLA, outSLA }) {
    setText('noc-in-sla', inSLA); setText('noc-out-sla', outSLA); setText('noc-total', total);
    const ts = new Date().toLocaleString();
    setText('noc-in-sla-meta', `Atualizado em ${ts}`);
    setText('noc-out-sla-meta', `Atualizado em ${ts}`);
    setText('noc-total-meta', `Atualizado em ${ts}`);
  }
  function fillByClient(list) {
    const ul = document.getElementById('noc-by-client'); if (!ul) return;
    ul.innerHTML = '';
    const items = list.length ? list : [['—', 0]];
    for (const [name, count] of items) {
      const li = document.createElement('li'); li.textContent = `${name}: ${count}`; ul.appendChild(li);
    }
  }
  function fillOverdueList(tickets, start, end) {
    const ul = document.getElementById('noc-overdue-list'); if (!ul) return;
    ul.innerHTML = '';
    const now = Date.now();
    const items = tickets.filter(t => inRange(t.createdDate, start, end) && slaIsOverdue(t));
    if (!items.length) { const li = document.createElement('li'); li.textContent = 'Sem SLAs fora do prazo nesta janela'; ul.appendChild(li); return; }
    for (const t of items.slice(0, 50)) {
      const client = (t.clients && t.clients && (t.clients.organization?.businessName || t.clients.businessName)) || 'Cliente';
      const due = t.slaSolutionDate ? Date.parse(t.slaSolutionDate) : NaN;
      const lateMs = (typeof t.resolvedIn === 'number' && typeof t.slaSolutionTime === 'number')
        ? Math.max(0, (t.resolvedIn - t.slaSolutionTime) * 60 * 1000)
        : (!isNaN(due) ? Math.max(0, now - due) : 0);
      const lateH = Math.round(lateMs / 3600000);
      const li = document.createElement('li'); li.textContent = `${t.protocol || '—'} — ${client} — atraso ~ ${lateH}h`; ul.appendChild(li);
    }
  }

  // ===== Gráficos (Chart.js) =====
  function hasChartJS() { return typeof window.Chart !== 'undefined'; }
  function chartOrPlaceholder(ctxId, type, data, options) {
    const ctx = document.getElementById(ctxId); if (!ctx) return;
    if (!hasChartJS()) {
      // Placeholder: cria uma imagem vazia via canvas 2D simples
      const ph = ctx.getContext('2d'); ph.fillStyle = '#1d2a44'; ph.fillRect(0,0,ctx.width||600,ctx.height||120);
      ph.fillStyle = '#8aa0c2'; ph.fillText('Gráfico indisponível (Chart.js não carregado)', 10, 20);
      return;
    }
    const existing = state.charts[ctxId];
    if (existing) { existing.data = data; existing.options = options; existing.update(); return; }
    state.charts[ctxId] = new Chart(ctx, { type, data, options });
  }
  function renderCharts(tickets) {
    const months = lastNMonths(6);
    const incidents = monthlyIncidentsSeries(tickets, months);
    const slaPerc = monthlySlaSeries(tickets, months);

    chartOrPlaceholder('chart-incidents', 'bar', {
      labels: months,
      datasets: [{ label: 'Incidentes', data: incidents, backgroundColor: 'rgba(0,181,226,0.35)', borderColor: 'rgba(0,181,226,0.9)', borderWidth: 1 }]
    }, {
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { color: '#e6eefc' } }, x: { ticks: { color: '#e6eefc' } } }
    });

    chartOrPlaceholder('chart-sla', 'line', {
      labels: months,
      datasets: [{ label: '% SLA no prazo', data: slaPerc, fill: false, borderColor: 'rgba(14,75,159,0.9)', backgroundColor: 'rgba(14,75,159,0.3)', tension: 0.25 }]
    }, {
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, max: 100, ticks: { color: '#e6eefc', callback: v => v + '%' } }, x: { ticks: { color: '#e6eefc' } } }
    });
  }

  // ===== Filtro mensal NOC =====
  function setMonthMode(mode) {
    state.monthMode = mode;
    document.querySelectorAll('.btn--toggle').forEach(b => {
      b.classList.toggle('is-selected', b.getAttribute('data-month') === mode);
    });
    const { start, end } = monthRange(mode);
    const lbl = document.getElementById('noc-range-label');
    if (lbl) lbl.textContent = `${start.toLocaleDateString()} — ${end.toLocaleDateString()}`;
    refreshNOC();
  }
  function refreshNOC() {
    const { start, end } = monthRange(state.monthMode);
    const inWindow = state.allTickets.filter(t => inRange(t.createdDate, start, end));
    const opened = inWindow.filter(t => isOpen(t.status));
    const inSLA = opened.filter(t => !slaIsOverdue(t)).length;
    const outSLA = opened.filter(t => slaIsOverdue(t)).length;
    fillKPIsNOC({ total: inWindow.length, inSLA, outSLA });
    fillByClient(groupByClient(inWindow));
    fillOverdueList(inWindow, start, end);
  }
  document.querySelectorAll('.btn--toggle').forEach(b => {
    b.addEventListener('click', () => setMonthMode(b.getAttribute('data-month')));
  });

  // ===== Bootstrap NOC (uma vez) =====
  async function bootstrapNOC() {
    if (state.nocBootstrapped) return;
    state.nocBootstrapped = true;
    showSpinner();
    try {
      // Buscar 6 meses para séries e panorama
      const sinceISO = new Date(Date.now() - 180*24*60*60*1000).toISOString();
      const tickets = await fetchTicketsPaginated({ useProxy: false, sinceISO });
      state.allTickets = Array.isArray(tickets) ? tickets : [];
      // Panorama (mês atual)
      const { start, end } = monthRange('current');
      const inWin = state.allTickets.filter(t => inRange(t.createdDate, start, end));
      const opened = inWin.filter(t => isOpen(t.status));
      const inSLA = opened.filter(t => !slaIsOverdue(t)).length;
      const outSLA = opened.filter(t => slaIsOverdue(t)).length;
      fillOverviewNOC({ total: inWin.length, inSLA, outSLA });
      // Gráficos (séries 6m) — com fallback se Chart.js ausente
      renderCharts(state.allTickets);
      // Definir filtro padrão
      setMonthMode('current');
    } catch (e) {
      console.error('Falha ao carregar NOC, exibindo placeholders:', e);
      // Placeholders para demo
      state.allTickets = [];
      fillOverviewNOC({ total: 42, inSLA: 33, outSLA: 9 });
      // Gráficos placeholder
      renderCharts([
        { createdDate: new Date().toISOString(), category: 'Incidente', resolvedIn: 200, slaSolutionTime: 240 },
        { createdDate: new Date(Date.now()-25*24*3600*1000).toISOString(), category: 'Incidente', resolvedIn: 100, slaSolutionTime: 120 }
      ]);
      setMonthMode('current');
    } finally {
      hideSpinner();
    }
  }

  // ===== Serviços placeholders (20 clientes) =====
  const sampleClients = [
    'ALPHATECH','BETA LOG','CARGLASS','DELTA NET','ELEVARE','FLEXTEL','GIGAFOCUS','HYPERDATA','INFOTEL',
    'JUPITER','KAPPA','LUMENCO','MEGASUPPLY','NIMBUS','OMEGA','PRIMACOM','QUANTIX','RADIANT','SKYCOM','TRUSTIFY'
  ];
  const stages = ['Levantamento','Planejamento','Configuração','Piloto','Treinamento','Go-Live'];
  function rand(min, max) { return Math.floor(Math.random()*(max-min+1))+min; }
  function pick(arr) { return arr[rand(0, arr.length-1)]; }
  function randomDateWithin(days=60) { const now = Date.now(); const offset = rand(-days, days)*24*3600*1000; return new Date(now + offset); }
  function bootstrapServices() {
    if (state.servicesBootstrapped) return;
    state.servicesBootstrapped = true;
    const tbody = document.getElementById('svc-implants-body');
    const tbody2 = document.getElementById('svc-health-body');
    if (tbody) {
      tbody.innerHTML = '';
      for (const c of sampleClients) {
        const start = randomDateWithin(30);
        const eta = new Date(start.getTime() + rand(7,45)*24*3600*1000);
        const sla = `${rand(85, 99)}%`;
        const status = ['Em curso','Aguardando','Atrasado','Concluída'][rand(0,3)];
        const stage = pick(stages);
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${c}</td><td>${status}</td><td>${start.toLocaleDateString()}</td><td>${eta.toLocaleDateString()}</td><td>${sla}</td><td>${stage}</td>`;
        tbody.appendChild(tr);
      }
      // KPIs serviços
      setText('ov-svc-reports', `${rand(18, 28)}/30`);
      setText('ov-svc-deploy-ok', `${rand(10, 18)}`);
      setText('ov-svc-deploy-in', `${rand(5, 15)}`);
    }
    if (tbody2) {
      tbody2.innerHTML = '';
      for (const c of sampleClients) {
        const last = randomDateWithin(20);
        const health = ['Boa','Atenta','Crítica'][rand(0,2)];
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${c}</td><td>${last.toLocaleDateString()}</td><td>${health}</td>`;
        tbody2.appendChild(tr);
      }
    }
  }

})();
