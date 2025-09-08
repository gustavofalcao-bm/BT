// assets/js/app.js
(function () {
  // ==== Navegação + Spinner (já existia) ====
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
    setTimeout(() => { try { fn(); } finally { spinner.classList.remove('is-active'); } }, delay);
  }
  navButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-section');
      if (!target) return;
      setActive(btn);
      withSpinner(() => showSection(target), 500);
      if (target === 'noc') {
        // Dispara atualização quando entrar no NOC
        loadNocData().catch(console.error);
      }
    });
  });
  showSection('overview');

  // ==== Config API Movidesk ====
  // RECOMENDADO (produção): usar PROXY_URL que injeta o token no servidor e habilita CORS.
  // Exemplo de proxy: Cloudflare Worker/Netlify Function que recebe os parâmetros OData e chama a API real.
  const PROXY_URL = ''; // ex.: 'https://seu-proxy.example.com/tickets'

  // TESTE RÁPIDO (não recomendado em produção): URL direta COM token (expondo credencial).
  // Atenção: pode falhar por CORS se o domínio do seu Pages não estiver autorizado.
  const DIRECT_URL_BASE = 'https://api.movidesk.com/public/v1/tickets';

  // Sua query base do Postman (sem $top/$skip; iremos acrescentar paginação dinamicamente)
  const BASE_QUERY =
    "token=a1632c07-b66f-4c5c-aad6-c898c59cf276" + // substitua SOMENTE para teste rápido; evite commitar
    "&$select=justification,lastUpdate,resolvedIn,status,category,subject,createdDate,protocol,ownerTeam,owner,createdBy,origin,serviceFull,serviceFirstLevel,serviceSecondLevel,serviceThirdLevel,slaSolutionTime,slaResponseTime,slaAgreement,slaAgreementRule,slaSolutionDate,slaResponseDate,clients,stoppedTime,stoppedTimeWorkingTime" +
    "&$expand=createdBy,owner,actions($select=description,type,status,justification),clients($expand=organization)" +
    "&$filter=ownerTeam ne 'Conecta %2B'" +
    "&$orderby=createdDate desc";

  // Janela de dados (opcional): reduza a abrangência para evitar muitas páginas
  // Exemplo: últimos 30 dias
  const DATE_UTC_30D = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const TIME_FILTER = ` and createdDate ge ${DATE_UTC_30D}`; // concatena ao $filter OData

  // Regra simplificada de "aberto" (ajuste se necessário conforme seus status)
  function isOpen(status) {
    if (!status) return true;
    const s = String(status).toLowerCase();
    // Ajuste: incluir os nomes reais de status "fechado"/"resolvido" do seu ambiente
    return !(s.includes('fech') || s.includes('closed') || s.includes('resol'));
  }

  async function fetchPage(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function fetchTicketsPaginated({ useProxy = false }) {
    const pageSize = 1000; // limite por request recomendado
    // Monta filtro com recorte temporal
    const queryWithTime = BASE_QUERY.replace("&$filter=", "&$filter=") + TIME_FILTER;

    let all = [];
    for (let skip = 0; ; skip += pageSize) {
      const pageQuery = `${queryWithTime}&$top=${pageSize}&$skip=${skip}`;
      const url = useProxy && PROXY_URL
        ? `${PROXY_URL}?${pageQuery}` // proxy deve repassar query e injetar token no servidor
        : `${DIRECT_URL_BASE}?${pageQuery}`; // chamada direta (token exposto)

      const chunk = await fetchPage(url);
      if (!Array.isArray(chunk)) break;
      all = all.concat(chunk);
      if (chunk.length < pageSize) break; // última página
      // Se necessário, inserir delay para respeitar limites de requisição
      await new Promise(r => setTimeout(r, 400)); // 0,4s por página
    }
    return all;
  }

  function splitSLA(tickets) {
    const now = Date.now();
    let inSLA = 0, outSLA = 0;
    for (const t of tickets) {
      const open = isOpen(t.status);
      if (!open) continue; // regra inicial: contar SLA só para abertos
      const due = t.slaSolutionDate ? Date.parse(t.slaSolutionDate) : NaN;
      if (!isNaN(due) && now > due) outSLA++;
      else inSLA++;
    }
    return { inSLA, outSLA };
  }

  function groupByClient(tickets, maxItems = 10) {
    const map = new Map();
    for (const t of tickets) {
      if (!Array.isArray(t.clients)) continue;
      for (const c of t.clients) {
        // Preferir organization.businessName; fallback para c.businessName/corporateName
        const org = c.organization && (c.organization.businessName || c.organization.corporateName);
        const name = org || c.businessName || c.corporateName || 'Cliente s/ nome';
        map.set(name, (map.get(name) || 0) + 1);
      }
    }
    return [...map.entries()]
      .sort((a, b) => b[21] - a[21])
      .slice(0, maxItems);
  }

  function fillKPIs({ total, inSLA, outSLA }) {
    const elIn = document.getElementById('noc-in-sla');
    const elOut = document.getElementById('noc-out-sla');
    const elTot = document.getElementById('noc-total');
    const elInMeta = document.getElementById('noc-in-sla-meta');
    const elOutMeta = document.getElementById('noc-out-sla-meta');
    const elTotMeta = document.getElementById('noc-total-meta');
    if (elIn) elIn.textContent = String(inSLA);
    if (elOut) elOut.textContent = String(outSLA);
    if (elTot) elTot.textContent = String(total);
    const ts = new Date().toLocaleString();
    if (elInMeta) elInMeta.textContent = `Atualizado em ${ts}`;
    if (elOutMeta) elOutMeta.textContent = `Atualizado em ${ts}`;
    if (elTotMeta) elTotMeta.textContent = `Atualizado em ${ts}`;
  }

  function fillByClient(list) {
    const ul = document.getElementById('noc-by-client');
    if (!ul) return;
    ul.innerHTML = '';
    for (const [name, count] of list) {
      const li = document.createElement('li');
      li.textContent = `${name}: ${count}`;
      ul.appendChild(li);
    }
  }

  async function loadNocData() {
    withSpinner(async () => {
      try {
        // Em produção, use { useProxy: true } e configure PROXY_URL
        const tickets = await fetchTicketsPaginated({ useProxy: false });
        const { inSLA, outSLA } = splitSLA(tickets);
        fillKPIs({ total: tickets.length, inSLA, outSLA });
        fillByClient(groupByClient(tickets));
      } catch (err) {
        console.error('Erro ao carregar NOC:', err);
        fillKPIs({ total: 0, inSLA: 0, outSLA: 0 });
        fillByClient([]);
      }
    }, 300);
  }

  // Opcional: carregar NOC já na primeira visita
  // loadNocData().catch(console.error);
})();
