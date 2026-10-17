'use strict';
// Midrar web app. Every number shown is fetched from the server (which computes it from logged entries).
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const S = {
    lang: 'ar', theme: 'auto', user: null, meta: null, needsSetup: false, route: 'home', branch: 'all',
    days: 7, per: 7, sel: 0, error: '', form: null,
  };
  try {
    const l = localStorage.getItem('midrar-lang'); if (l === 'en' || l === 'ar') S.lang = l;
    const t = localStorage.getItem('midrar-theme'); if (t === 'light' || t === 'dark') S.theme = t;
  } catch { /* storage unavailable: defaults are fine */ }

  const L = (ar, en) => (S.lang === 'en' ? en : ar);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const N = (n, d = 0) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
  const kgT = (x, d = 1) => `${N(x, d)} ${L('كجم', 'kg')}`;
  const sar = (x) => `${N(x, 0)} ${L('ريال', 'SAR')}`;
  const LEAF = '<svg width="34" height="34" viewBox="0 0 40 40" aria-hidden="true"><path d="M20 36C8 30 6 16 20 4c14 12 12 26 0 32z" fill="#1F6F6B"/><path d="M20 34V14" stroke="#fff" stroke-width="2.5" fill="none"/></svg>';
  const C = ['#1F6F6B', '#E2725B', '#C9A24D', '#6F86B8', '#8A7BB0'];

  const TYPES = {
    plate: [['بقايا صحون', 'Plate leftovers'], ['ما يُترك في الأطباق', 'What guests leave on plates']],
    prep: [['فائض تحضير', 'Prep surplus'], ['طعام حُضّر ولم يُقدَّم', 'Food prepared but never served']],
    spoilage: [['تلف مخزون', 'Spoiled stock'], ['مواد فسدت قبل الاستخدام', 'Ingredients spoiled before use']],
  };
  const MEALS = { breakfast: ['إفطار', 'Breakfast'], lunch: ['غداء', 'Lunch'], dinner: ['عشاء', 'Dinner'], break: ['فسحة', 'Break'], snack: ['وجبة خفيفة', 'Snack'] };
  const LEVEL = { high: ['مرتفع', 'High'], medium: ['متوسط', 'Medium'], low: ['منخفض', 'Low'], none: ['لا هدر متوقع', 'No waste expected'], unknown: ['—', '—'] };
  const ADVICE = {
    portion: ['أغلب هدر هذا الصنف بقايا أطباق: جرّبوا تصغير الحصة أو تقديمها على دفعتين.', "Most of this item's waste is plate leftovers: try smaller portions or serving in two rounds."],
    prep: ['أغلب هدر هذا الصنف فائض تحضير: قلّلوا كمية التحضير أو حضّروا على دفعات صغيرة.', "Most of this item's waste is prep surplus: prepare less, or in smaller batches."],
    stock: ['أغلب هدر هذا الصنف تلف مخزون: راجعوا كميات الطلب وطبّقوا الأقدم أولًا.', "Most of this item's waste is spoiled stock: review order quantities and use oldest first."],
  };
  const ERR = {
    bad_credentials: ['البريد أو كلمة المرور غير صحيحة', 'Wrong email or password'],
    too_many_attempts: ['محاولات كثيرة، حاول بعد 10 دقائق', 'Too many attempts, try again in 10 minutes'],
    weak_password: ['كلمة المرور يجب ألا تقل عن 8 أحرف', 'Password must be at least 8 characters'],
    invalid_email: ['البريد الإلكتروني غير صحيح', 'Invalid email address'],
    missing_fields: ['أكمل الحقول المطلوبة', 'Please fill in the required fields'],
    invalid_kg: ['أدخل وزنًا صحيحًا أكبر من صفر', 'Enter a valid weight above zero'],
    invalid_items: ['اختر صنفًا واحدًا على الأقل', 'Choose at least one item'],
    invalid_branch: ['الفرع غير صحيح', 'Invalid branch'],
    invalid_day: ['التاريخ غير صحيح (آخر 60 يومًا فقط)', 'Invalid date (last 60 days only)'],
    invalid_price: ['سعر الكيلو غير صحيح', 'Invalid price per kg'],
    invalid_charity: ['اختر جمعية', 'Choose a charity'],
    invalid_target: ['نسبة الخفض غير صحيحة', 'Invalid reduction target'],
    duplicate: ['موجود مسبقًا', 'Already exists'],
    has_real_data: ['لا يمكن تحميل البيانات التجريبية لوجود بيانات حقيقية', 'Demo data cannot be loaded because real data already exists'],
    user_has_entries: ['لهذا المستخدم تسجيلات، لا يمكن حذفه', 'This user has entries and cannot be deleted'],
    cannot_delete_self: ['لا يمكنك حذف حسابك', 'You cannot delete your own account'],
    forbidden: ['ليست لديك صلاحية', 'You do not have permission'],
    already_setup: ['تم الإعداد مسبقًا', 'Setup is already complete'],
  };
  const errText = (e) => (ERR[e && e.key] ? L(...ERR[e.key]) : L('حدث خطأ، حاول مرة أخرى', 'Something went wrong, please try again'));

  /* ---------------------------------------------------------------- api */
  async function api(method, url, body) {
    const r = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await r.json(); } catch { /* not json */ }
    if (!r.ok) {
      const e = new Error((data && data.error) || 'error');
      e.key = e.message; e.status = r.status;
      if (r.status === 401 && S.user && url !== '/api/login') { S.user = null; S.meta = null; render(); }
      throw e;
    }
    return data;
  }
  const bq = () => (S.user && S.user.role === 'admin' && S.branch !== 'all' ? 'branch=' + S.branch : '');
  const U = (path, extra = '') => { const p = [extra, bq()].filter(Boolean).join('&'); return path + (p ? '?' + p : ''); };

  /* ------------------------------------------------------------ helpers */
  const items = () => (S.meta ? S.meta.items : []);
  const activeItems = () => items().filter((i) => i.active);
  const iname = (id) => { const i = items().find((x) => x.id === id); return i ? (S.lang === 'en' ? i.name_en : i.name_ar) : '?'; };
  const bname = (id) => { const b = S.meta.branches.find((x) => x.id === id); return b ? b.name : '?'; };
  const cname = (id) => { const c = S.meta.charities.find((x) => x.id === id); return c ? c.name : '?'; };
  const loc = () => (S.lang === 'en' ? 'en-US' : 'ar-u-nu-latn');
  const wd = (day) => new Intl.DateTimeFormat(loc(), { weekday: 'long', timeZone: 'UTC' }).format(new Date(day + 'T00:00:00Z'));
  const dshort = (day) => new Intl.DateTimeFormat(loc(), { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(day + 'T00:00:00Z'));
  const isAdmin = () => S.user && S.user.role === 'admin';
  const multiBranch = () => S.meta && S.meta.branches.length > 1;
  const mealNow = () => { const h = new Date().getHours(); return h < 10 ? 'breakfast' : h < 12 ? 'break' : h < 16 ? 'lunch' : h < 18 ? 'snack' : 'dinner'; };
  const toast = (m) => { const t = $('#toast'); t.textContent = m; t.className = 's'; clearTimeout(toast.t); toast.t = setTimeout(() => { t.className = ''; }, 2600); };
  const seg = (act, list, cur) => `<div class="seg" role="group">${list.map(([v, label]) => `<button type="button" data-act="${act}" data-v="${v}" aria-pressed="${String(cur) === String(v)}">${esc(label)}</button>`).join('')}</div>`;
  const delta = (pct) => (pct === null || pct === undefined ? '' : `<span class="${pct <= 0 ? 'pos' : 'neg'}">${pct > 0 ? '+' : pct < 0 ? '−' : ''}${N(Math.abs(pct), 1)}%</span>`);

  function newForm() {
    const first = S.meta ? S.meta.branches[0] : null;
    return {
      items: [], kg: '', type: 'plate', meal: mealNow(), day: S.meta.today, branch: first ? first.id : null,
      photoUrl: null, ai: null, aiTop: null, prepared: '',
    };
  }
  function resetPhoto() {
    if (S.form && S.form.photoUrl) URL.revokeObjectURL(S.form.photoUrl);
    if (S.form) { S.form.photoUrl = null; S.form.ai = null; S.form.aiTop = null; }
  }

  /* ----------------------------------------------------- shared widgets */
  function donut(rows, label, nameOf) {
    let a = 0;
    const grad = rows.map((r, i) => { const s = `${C[i % C.length]} ${a}% ${a + r.pct}%`; a += r.pct; return s; }).join(',');
    return `<div class="row" style="gap:18px;flex-wrap:nowrap"><div class="dn" style="background:conic-gradient(${grad || 'var(--mint) 0 100%'})"><span>${label}</span></div>
      <div class="lg">${rows.map((r, i) => `<div><span><i style="background:${C[i % C.length]}"></i>${esc(nameOf(r))}</span><b>${N(r.pct, 1)}%</b></div>`).join('')}</div></div>`;
  }
  function bars(rows, nameOf, scale = 1) {
    return rows.map((r) => `<div class="hb"><span>${esc(nameOf(r))}</span><div class="pb"><i style="width:${Math.min(100, r.pct * scale)}%"></i></div><b>${N(r.pct, 1)}%</b></div>`).join('');
  }
  const empty = (msg) => `<div class="empty">${esc(msg)}</div>`;
  const notReady = (d, what) => `<div class="note">${esc(L(
    `نحتاج ${d.need_days} أيام تسجيل على الأقل لعرض ${what}. لديكم الآن ${d.have_days} يومًا.`,
    `At least ${d.need_days} logged days are needed to show ${what}. You have ${d.have_days} so far.`))}</div>`;

  /* ---------------------------------------------------------------- auth */
  function authView() {
    const setup = S.needsSetup;
    return `<div class="auth"><div class="card">
      <div class="logo">${LEAF}<div><b>${L('مدرار', 'Midrar')}</b><small>MIDRAR</small></div></div>
      <h1 style="font-size:22px">${setup ? L('إعداد مدرار لأول مرة', 'First-time setup') : L('تسجيل الدخول', 'Sign in')}</h1>
      ${setup ? `<p class="mut" style="margin:0">${L('أنشئ حساب المدير وأول فرع. يمكنك إضافة بقية الفروع والموظفين لاحقًا من الإعدادات.', 'Create the admin account and your first branch. You can add more branches and staff later in Settings.')}</p>` : ''}
      ${S.error ? `<div class="err" role="alert">${esc(S.error)}</div>` : ''}
      <form data-form="${setup ? 'setup' : 'login'}" class="stack">
        ${setup ? `
          <div class="field"><label for="f-org">${L('اسم الجهة', 'Organisation name')}</label><input id="f-org" name="org_name" required maxlength="120"></div>
          <div class="field"><label for="f-br">${L('اسم الفرع الأول', 'First branch name')}</label><input id="f-br" name="branch_name" required maxlength="80"></div>
          <div class="field"><label for="f-city">${L('المدينة', 'City')}</label><input id="f-city" name="city" maxlength="80"></div>
          <div class="field"><label for="f-name">${L('اسمك', 'Your name')}</label><input id="f-name" name="name" required maxlength="120"></div>` : ''}
        <div class="field"><label for="f-email">${L('البريد الإلكتروني', 'Email')}</label><input id="f-email" name="email" type="email" required autocomplete="username" dir="ltr"></div>
        <div class="field"><label for="f-pw">${L('كلمة المرور', 'Password')}</label><input id="f-pw" name="password" type="password" required minlength="${setup ? 8 : 1}" autocomplete="${setup ? 'new-password' : 'current-password'}" dir="ltr"></div>
        <button class="btn">${setup ? L('إنشاء الحساب', 'Create account') : L('دخول', 'Sign in')}</button>
      </form>
      <div class="row between"><button class="pill" type="button" data-act="lang">${S.lang === 'en' ? 'العربية' : 'English'}</button>
      <button class="pill" type="button" data-act="theme">${themeLabel()}</button></div>
    </div></div>`;
  }
  const themeLabel = () => (S.theme === 'dark' ? L('داكن', 'Dark') : S.theme === 'light' ? L('فاتح', 'Light') : L('تلقائي', 'Auto'));

  /* --------------------------------------------------------------- shell */
  const ROUTES = [['home', ['الرئيسية', 'Home']], ['log', ['تسجيل الهدر', 'Log waste']], ['data', ['البيانات', 'Data']], ['rec', ['التوصيات', 'Recommendations']], ['impact', ['قبل وبعد', 'Before & after']], ['settings', ['الإعدادات', 'Settings']]];
  function headerHtml() {
    return `<div class="bar"><div class="logo">${LEAF}<div><b>${L('مدرار', 'Midrar')}</b><small>MIDRAR</small></div></div>
      <nav class="nav" aria-label="${L('التنقل', 'Navigation')}">${ROUTES.map(([r, n]) => `<button type="button" data-act="go" data-v="${r}" ${S.route === r ? 'aria-current="page"' : ''}>${esc(L(...n))}</button>`).join('')}</nav>
      <div class="tools">
        ${isAdmin() && multiBranch() ? `<select class="pill" data-change="branch" aria-label="${L('الفرع', 'Branch')}"><option value="all">${L('كل الفروع', 'All branches')}</option>${S.meta.branches.map((b) => `<option value="${b.id}" ${String(S.branch) === String(b.id) ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select>` : ''}
        <span class="who">${esc(S.user.name)}</span>
        <button class="pill" type="button" data-act="lang">${S.lang === 'en' ? 'العربية' : 'English'}</button>
        <button class="pill" type="button" data-act="logout">${L('خروج', 'Sign out')}</button>
      </div></div>`;
  }
  function demoBanner() {
    if (!S.meta || !S.meta.has_demo) return '';
    return `<div class="alert" role="note"><span><b>${L('وضع العرض:', 'Demo mode:')}</b> ${L('البيانات الظاهرة تجريبية وليست حقيقية.', 'the data shown is sample data, not real.')}</span>${isAdmin() ? `<button class="btn sm ghost" type="button" data-act="demo-clear">${L('مسح البيانات التجريبية', 'Remove demo data')}</button>` : ''}</div>`;
  }

  /* -------------------------------------------------------------- render */
  let token = 0;
  function applyLocale() {
    const h = document.documentElement;
    h.lang = S.lang; h.dir = S.lang === 'en' ? 'ltr' : 'rtl';
    if (S.theme === 'auto') delete h.dataset.theme; else h.dataset.theme = S.theme;
  }
  async function render(opts = {}) {
    const my = ++token;
    applyLocale();
    const app = $('#app');
    if (!S.user) { app.innerHTML = authView(); return; }
    if (!$('#main')) app.innerHTML = '<div class="top" id="hdr"></div><main id="main"></main>';
    $('#hdr').innerHTML = headerHtml();
    const y = window.scrollY;
    let html;
    try { html = await PAGES[S.route](); }
    catch (e) { html = `<div class="err" role="alert">${esc(errText(e))}</div>`; }
    if (my !== token) return;
    $('#main').innerHTML = demoBanner() + html;
    if (opts.keep) window.scrollTo(0, y); else window.scrollTo(0, 0);
  }

  /* --------------------------------------------------------------- pages */
  const PAGES = {};

  PAGES.home = async () => {
    const admin = isAdmin();
    const [dash, imp, fc, rec, off, ent, lb] = await Promise.all([
      api('GET', U('/api/dashboard', 'days=7')), api('GET', U('/api/impact', 'days=7')), api('GET', U('/api/forecast')),
      api('GET', U('/api/recommendations')), api('GET', U('/api/offers')), api('GET', U('/api/entries', 'limit=5')),
      admin ? api('GET', '/api/leaderboard') : Promise.resolve(null),
    ]);
    const hasData = S.meta.entry_count > 0;
    const activeTrials = rec.trials.filter((t) => t.status === 'active').length;
    const saving = imp.saving_sar;

    const hero = `<section class="hero"><div>
      <h1>${hasData ? L('نحوّل أرقام الهدر الغذائي إلى قرارات توفّر المال', 'We turn food-waste numbers into decisions that save money') : L('ابدأ بتسجيل أول هدر', 'Start by logging your first waste entry')}</h1>
      <p>${hasData
        ? L('مدرار يرصد الهدر ويتنبأ به ويقترح التغيير ويقيس أثره بالريال، للمطاعم والمدارس والجامعات والمستشفيات.', 'Midrar tracks waste, forecasts it, recommends changes and measures the impact in riyals, for restaurants, schools, universities and hospitals.')
        : L('لا توجد بيانات بعد. كل رقم في هذا الموقع يُحسب من تسجيلاتكم الفعلية، وتبدأ التنبؤات والتوصيات بالظهور بعد بضعة أيام من التسجيل.', 'There is no data yet. Every number here is calculated from your own entries, and forecasts and recommendations appear after a few days of logging.')}</p>
      <div class="row"><button class="btn" type="button" data-act="go" data-v="log">${L('سجّل هدرًا الآن', 'Log waste now')}</button>
      ${hasData ? `<button class="btn ghost" type="button" data-act="go" data-v="data">${L('شاهد البيانات', 'View data')}</button>` : (admin ? `<button class="btn ghost" type="button" data-act="demo-load">${L('تحميل بيانات تجريبية للعرض', 'Load demo data for a presentation')}</button>` : '')}</div></div>
      <div class="side"><small>${L('الهدر آخر 7 أيام', 'Waste, last 7 days')}</small><b>${kgT(dash.total_kg)}</b>
        <small>${L('التوفير مقارنة بالأسبوع السابق', 'Savings vs previous week')}</small>
        <b>${saving === null ? '—' : (saving >= 0 ? '' : '−') + sar(Math.abs(saving))}</b>
        ${saving === null ? `<small>${L('يظهر بعد اكتمال أسبوعين من التسجيل', 'Shown once two weeks of data exist')}</small>` : ''}</div></section>`;

    const facts = `<section class="sec"><h2>${L('لماذا هذا مهم', 'Why this matters')}</h2><div class="grid k4">
      <div class="card"><div class="big">${L('40 مليار', '40 bn')}</div><span class="mut">${L('ريال تُهدر سنويًا من الغذاء في المملكة', 'SAR of food wasted per year in the Kingdom')}</span></div>
      <div class="card"><div class="big">184 ${L('كجم', 'kg')}</div><span class="mut">${L('يهدرها الفرد الواحد سنويًا', 'wasted per person per year')}</span></div>
      <div class="card"><div class="big">33%</div><span class="mut">${L('من الغذاء يُفقد أو يُهدر (تقدير 2018: 33.1%)', 'of food is lost or wasted (2018 estimate: 33.1%)')}</span></div>
      <div class="card"><div class="big">50%</div><span class="mut">${L('خفض مستهدف بحلول 2030 ضمن البرنامج الوطني', 'reduction targeted by 2030 under the National Program')}</span></div></div>
      <div class="src">${L('المصادر:', 'Sources:')} <a href="https://www.arabnews.com/node/1654461/amp" target="_blank" rel="noopener">Arab News (2020)</a> · <a href="https://gulfnews.com/world/gulf/saudi/rice-bread-and-flour-top-food-waste-in-saudi-arabia-1.101765111" target="_blank" rel="noopener">Gulf News (2024)</a> · <a href="https://saudipedia.com/en/the-national-program-to-reduce-food-loss-and-waste" target="_blank" rel="noopener">Saudipedia</a></div></section>`;

    const steps = [
      ['الالتقاط', 'Capture', 'صوّر البقايا أو اختر الأصناف يدويًا وأدخل الوزن.', 'Photograph leftovers or pick items by hand, and enter the weight.'],
      ['التصنيف', 'Classify', 'نموذج الذكاء الاصطناعي يقترح الصنف وأنت تؤكده.', 'The AI model suggests the item and you confirm it.'],
      ['التنبؤ', 'Forecast', 'متوسط نفس اليوم في آخر 4 أسابيع.', 'Average of the same weekday over the last 4 weeks.'],
      ['التوصية', 'Recommend', 'تجارب تقليل بقواعد واضحة، ثم قياس قبل وبعد.', 'Rule-based reduction trials, then a before/after measurement.'],
      ['إعادة التوزيع', 'Redistribute', 'سجّل الفائض الصالح وجهّزه للجمعيات.', 'Record edible surplus and line it up for charities.'],
      ['التنافس', 'Compete', 'نقاط وترتيب بين الفروع.', 'Points and a ranking across branches.'],
    ];
    const how = `<section class="sec"><h2>${L('كيف يعمل مدرار', 'How Midrar works')}</h2><div class="grid">${steps.map((s, i) => `<div class="card"><span class="badge">${i + 1}</span> <b>${esc(L(s[0], s[1]))}</b><p class="mut" style="margin:6px 0 0">${esc(L(s[2], s[3]))}</p></div>`).join('')}</div></section>`;

    const kpi = `<section class="sec"><h2>${L('نظرة تشغيلية', 'Operations overview')}${multiBranch() && admin ? ` <span class="mut small">· ${S.branch === 'all' ? L('كل الفروع', 'All branches') : esc(bname(Number(S.branch)))}</span>` : ''}</h2>
      <div class="grid k4"><div class="card"><div class="mut">${L('إجمالي الهدر (7 أيام)', 'Total waste (7 days)')}</div><div class="big">${kgT(dash.total_kg)}</div><div class="small">${dash.delta_pct === null ? L('لا توجد فترة سابقة للمقارنة', 'No previous period to compare') : L('عن الأسبوع السابق: ', 'vs previous week: ') + '' }${delta(dash.delta_pct)}</div></div>
      <div class="card"><div class="mut">${L('التكلفة المالية للهدر', 'Financial cost of waste')}</div><div class="big">${sar(dash.cost_sar)}</div><div class="small mut">${L('بسعر', 'at')} ${N(S.meta.org.price_per_kg, 2)} ${L('ريال/كجم', 'SAR/kg')}</div></div>
      <div class="card"><div class="mut">${L('التوفير مقارنة بالأسبوع السابق', 'Savings vs previous week')}</div><div class="big ${saving === null ? '' : saving >= 0 ? 'pos' : 'neg'}">${saving === null ? '—' : (saving >= 0 ? '' : '−') + sar(Math.abs(saving))}</div><div class="small mut">${saving !== null && saving < 0 ? L('الهدر زاد عن الأسبوع السابق', 'Waste went up vs last week') : L('يعتمد على اكتمال التسجيل', 'Depends on complete logging')}</div></div>
      <div class="card"><div class="mut">${L('تجارب التقليل الجارية', 'Active reduction trials')}</div><div class="big">${activeTrials}</div></div></div></section>`;

    const hi = fc.ready ? fc.days.find((d) => d.level === 'high') : null;
    const alert = !fc.ready ? `<div class="alert calm"><span>${L('التنبيهات الاستباقية تبدأ بعد تسجيل ', 'Proactive alerts start after ')}${fc.need_days}${L(' أيام (لديكم ', ' logged days (you have ')}${fc.have_days}${L(').', ').')}</span></div>`
      : hi ? `<div class="alert"><span><b>${L('تنبيه استباقي', 'Proactive alert')}:</b> ${esc(L(
        `يوم ${wd(hi.day)} يُتوقع أن يكون هدر ${iname(hi.top_item)} مرتفعًا، قلّلوا التحضير بنسبة ${hi.reduce_pct}%.`,
        `On ${wd(hi.day)} waste of ${iname(hi.top_item)} is expected to be high. Reduce preparation by ${hi.reduce_pct}%.`))}</span><button class="btn sm ghost" type="button" data-act="go" data-v="rec">${L('عرض التوصيات', 'View recommendations')}</button></div>`
        : `<div class="alert calm"><span>${L('لا توجد أيام مرتفعة الهدر متوقعة هذا الأسبوع.', 'No high-waste days are expected this week.')}</span></div>`;

    const fday = fc.ready ? fc.days[Math.min(S.sel, 6)] : null;
    const fcCard = `<div class="card"><h2>${L('التنبؤ بالهدر', 'Waste forecast')}</h2>${!fc.ready ? notReady(fc, L('التنبؤ', 'the forecast')) : `
      <div class="hs">${fc.days.map((d, i) => `<button class="day" type="button" data-act="sel" data-v="${i}" aria-pressed="${S.sel === i}"><b>${esc(wd(d.day))}</b><span class="badge ${d.level}">${esc(L(...LEVEL[d.level]))}</span></button>`).join('')}</div>
      <div class="stack" style="margin-top:12px">${fday.level === 'none' || fday.kg === null ? `<p style="margin:0">${L('لا يُتوقع هدر في هذا اليوم (عادةً لا تسجيلات فيه).', 'No waste expected on this day (normally nothing is logged).')}</p>`
        : `<p style="margin:0"><b>${esc(iname(fday.top_item))}</b> · ${L('المتوقع لهذا اليوم', 'expected for this day')}: ${kgT(fday.kg)} ${L('مقابل متوسط', 'vs average')} ${kgT(fday.mean)}</p>
        ${fday.reduce_pct > 0 ? `<p style="margin:0">${L('خفض التحضير المقترح:', 'Suggested prep reduction:')} <b>${fday.reduce_pct}%</b></p>` : ''}`}
        <p class="mut small" style="margin:0">${L(`الطريقة: متوسط نفس اليوم خلال آخر ${fc.window_days} يومًا من تسجيلكم. لا تشمل الطقس ولا الإجازات بعد، وتتحسن بزيادة البيانات.`, `Method: average of the same weekday over the last ${fc.window_days} logged days. It does not include weather or holidays yet, and improves with more data.`)}</p></div>`}</div>`;

    const offerForm = `<form data-form="offer" class="formgrid" style="margin-top:14px">
      <div class="field"><label for="o-item">${L('الصنف', 'Item')}</label><select id="o-item" name="item_id" required>${activeItems().map((i) => `<option value="${i.id}">${esc(S.lang === 'en' ? i.name_en : i.name_ar)}</option>`).join('')}</select></div>
      <div class="field"><label for="o-kg">${L('الكمية (كجم)', 'Quantity (kg)')}</label><input id="o-kg" name="kg" type="number" step="0.1" min="0.1" required inputmode="decimal"></div>
      <div class="field"><label for="o-ch">${L('الجمعية', 'Charity')}</label><select id="o-ch" name="charity_id" required>${S.meta.charities.filter((c) => c.active).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
      ${admin && multiBranch() ? `<div class="field"><label for="o-br">${L('الفرع', 'Branch')}</label><select id="o-br" name="branch_id">${S.meta.branches.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></div>` : ''}
      <button class="btn sm">${L('تسجيل طلب', 'Record request')}</button></form>`;
    const hasCharity = S.meta.charities.some((c) => c.active);
    const offCard = `<div class="card"><h2>${L('إعادة التوزيع', 'Redistribution')}</h2>
      <p class="mut small" style="margin:0 0 10px">${L('يسجّل هذا القسم الفائض الصالح وحالته. التواصل مع الجمعية يتم يدويًا حاليًا.', 'This records edible surplus and its status. Contacting the charity is done manually for now.')}</p>
      ${off.offers.length ? off.offers.slice(0, 5).map((o) => `<div class="li"><span>${esc(iname(o.item_id))} · ${kgT(o.kg)}<br><small class="mut">${esc(cname(o.charity_id))} · ${esc(bname(o.branch_id))}</small></span>
        <span class="row">${o.status === 'requested' ? `<button class="btn sm" type="button" data-act="offer" data-id="${o.id}" data-v="collected">${L('تم الاستلام', 'Collected')}</button><button class="btn sm ghost" type="button" data-act="offer" data-id="${o.id}" data-v="cancelled">${L('إلغاء', 'Cancel')}</button>` : `<span class="badge">${o.status === 'collected' ? L('تم الاستلام', 'Collected') : L('ملغي', 'Cancelled')}</span>`}</span></div>`).join('') : empty(L('لا توجد طلبات بعد.', 'No requests yet.'))}
      ${hasCharity ? offerForm : `<div class="note" style="margin-top:12px">${admin ? L('أضف جمعية من الإعدادات لتسجيل الطلبات.', 'Add a charity in Settings to record requests.') : L('لم تُضف جمعيات بعد، اطلب من المدير إضافتها.', 'No charities yet, ask the admin to add one.')}</div>`}</div>`;

    const lbCard = lb ? `<div class="card"><h2>${L('لوحة الترتيب', 'Leaderboard')}</h2>${lb.rows.length > 1 ? `<table><tr><th>#</th><th>${L('الفرع', 'Branch')}</th><th>${L('النقاط', 'Points')}</th></tr>${lb.rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td><b>${r.points}</b> <span class="mut small">(${L('تسجيلات', 'entries')} ${r.entries_7d} · ${L('خفض', 'cut')} ${r.reduction_pct}% · ${L('تجارب', 'trials')} ${r.active_trials})</span></td></tr>`).join('')}</table>` : empty(L('أضف فرعًا ثانيًا من الإعدادات لتبدأ المنافسة.', 'Add a second branch in Settings to start the competition.'))}
      <p class="mut small" style="margin:10px 0 0">${L('النقاط = تسجيلات آخر 7 أيام × 2 + نسبة الخفض عن الأسبوع السابق × 5 + 50 لكل تجربة جارية.', 'Points = entries in the last 7 days × 2 + week-over-week % reduction × 5 + 50 per active trial.')}</p></div>` : '';

    const recent = `<div class="card"><h2>${L('آخر التسجيلات', 'Recent entries')}</h2>${ent.entries.length ? ent.entries.map((e) => `<div class="li"><span>${e.item_ids.map(iname).map(esc).join('، ')} · <b>${kgT(e.kg)}</b><br><small class="mut">${esc(dshort(e.day))} · ${esc(L(...TYPES[e.waste_type][0]))} · ${esc(L(...MEALS[e.meal]))}${multiBranch() ? ' · ' + esc(bname(e.branch_id)) : ''}${e.source === 'ai' ? ' · AI' : ''}</small></span>
      ${admin ? `<button class="btn sm danger" type="button" data-act="del-entry" data-id="${e.id}" aria-label="${L('حذف', 'Delete')}">${L('حذف', 'Delete')}</button>` : ''}</div>`).join('') : empty(L('لا توجد تسجيلات بعد.', 'No entries yet.'))}</div>`;

    return hero + (hasData ? '' : '') + facts + how + kpi + alert + `<div class="grid">${fcCard}${offCard}</div>` + (lbCard ? lbCard : '') + recent;
  };

  PAGES.log = async () => {
    if (!S.form) S.form = newForm();
    const f = S.form;
    const ai = S.meta.ai;
    let aiBlock;
    if (!ai.available) {
      aiBlock = `<div class="cam"><b>${L('نموذج الذكاء الاصطناعي لم يُضف بعد', 'The AI model has not been added yet')}</b><span class="mut small">${L('اختر الأصناف يدويًا أدناه. عند إضافة النموذج سيظهر هنا خيار التصوير والتعرّف التلقائي.', 'Choose items by hand below. Once the model is added, photo capture and automatic recognition will appear here.')}</span></div>`;
    } else {
      const res = f.ai && f.ai.status === 'done' ? f.ai.preds.slice(0, 3).map((p) => {
        const it = window.MidrarAI.matchItem(p.label, items());
        return `<span class="badge">${esc(p.label)} · ${Math.round(p.p * 100)}%${it ? '' : ' · ' + L('غير مربوط بصنف', 'not mapped to an item')}</span>`;
      }).join(' ') : '';
      aiBlock = `<div class="cam">${f.photoUrl ? `<img src="${f.photoUrl}" alt="${L('صورة البقايا', 'Photo of leftovers')}">` : `<span class="mut">${L('صوّر السلة فقط. تُعالج الصورة على جهازك ولا تُرفع ولا تُخزَّن.', 'Photograph the bin only. The photo is analysed on your device and is never uploaded or stored.')}</span>`}
        ${f.ai && f.ai.status === 'running' ? `<b>${L('جارٍ التحليل…', 'Analysing…')}</b>` : ''}
        ${f.ai && f.ai.status === 'error' ? `<div class="err">${L('تعذّر تشغيل النموذج. اختر الأصناف يدويًا.', 'The model could not run. Choose items by hand.')}</div>` : ''}
        ${res ? `<div class="row" style="justify-content:center">${res}</div>${f.aiTop ? '' : `<span class="small mut">${L('النتيجة غير مؤكدة، اختر الصنف يدويًا.', 'The result is uncertain, please choose the item by hand.')}</span>`}` : ''}
        <div class="row" style="justify-content:center"><label class="btn sm alt" style="display:inline-flex;align-items:center;cursor:pointer">${f.photoUrl ? L('صورة أخرى', 'Another photo') : L('التقاط / اختيار صورة', 'Take / choose a photo')}<input class="visually-hidden" type="file" accept="image/*" capture="environment" data-change="photo"></label>
        ${f.photoUrl ? `<button class="btn sm ghost" type="button" data-act="clear-photo">${L('إزالة الصورة', 'Remove photo')}</button>` : ''}</div></div>`;
    }
    const branchSel = isAdmin() && multiBranch() ? `<div class="field"><label for="l-br">${L('الفرع', 'Branch')}</label><select id="l-br" data-bind="branch">${S.meta.branches.map((b) => `<option value="${b.id}" ${f.branch === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>` : '';
    return `<div class="stack"><h1>${L('تسجيل الهدر', 'Log waste')}</h1><div class="mut">${L('اختر الأصناف، أدخل الوزن، وحدّد نوع الهدر.', 'Choose the items, enter the weight and pick the waste type.')}</div></div>
    <form data-form="entry" class="stack">
      <div class="card stack">${aiBlock}</div>
      <div class="card stack"><h2 style="margin:0">${L('الأصناف', 'Items')} <span class="mut small">${L('(يمكن اختيار أكثر من صنف، ويُوزَّع الوزن عليها بالتساوي)', '(you can pick several; the weight is shared equally)')}</span></h2>
        <div class="row">${activeItems().map((i) => `<button type="button" class="chip" data-act="item" data-v="${i.id}" aria-pressed="${f.items.includes(i.id)}">${esc(S.lang === 'en' ? i.name_en : i.name_ar)}</button>`).join('')}</div></div>
      <div class="card stack"><div class="field"><label for="l-kg">${L('الوزن (كجم)', 'Weight (kg)')}</label><input id="l-kg" class="wt" type="number" inputmode="decimal" step="0.1" min="0.1" max="5000" data-bind="kg" value="${esc(f.kg)}" placeholder="0.0" required></div></div>
      <div class="card stack"><h2 style="margin:0">${L('نوع الهدر', 'Waste type')}</h2><div class="rad">${Object.keys(TYPES).map((k) => `<button type="button" data-act="type" data-v="${k}" aria-pressed="${f.type === k}"><b>${esc(L(...TYPES[k][0]))}</b><small>${esc(L(...TYPES[k][1]))}</small></button>`).join('')}</div></div>
      <div class="card"><div class="formgrid">
        <div class="field"><label for="l-meal">${L('الوجبة', 'Meal')}</label><select id="l-meal" data-bind="meal">${Object.keys(MEALS).map((k) => `<option value="${k}" ${f.meal === k ? 'selected' : ''}>${esc(L(...MEALS[k]))}</option>`).join('')}</select></div>
        ${branchSel}
        <div class="field"><label for="l-day">${L('التاريخ', 'Date')}</label><input id="l-day" type="date" data-bind="day" value="${esc(f.day)}" max="${esc(S.meta.today)}"></div></div></div>
      <button class="btn" style="min-height:54px">${L('تأكيد وحفظ', 'Confirm and save')}</button>
    </form>
    <form data-form="prepared" class="card stack"><h2 style="margin:0">${L('الكمية المحضّرة (اختياري)', 'Food prepared (optional)')}</h2>
      <p class="mut small" style="margin:0">${L('أدخل إجمالي الطعام المحضّر في اليوم لتظهر نسبة الهدر من إجمالي الطعام في صفحة البيانات.', "Enter the day's total food prepared so the waste share of total food appears on the Data page.")}</p>
      <div class="formgrid"><div class="field"><label for="p-kg">${L('الكمية المحضّرة (كجم) للتاريخ والفرع أعلاه', 'Food prepared (kg) for the date and branch above')}</label><input id="p-kg" name="kg" type="number" step="0.1" min="0.1" inputmode="decimal" data-bind="prepared" value="${esc(f.prepared)}"></div><button class="btn sm">${L('حفظ', 'Save')}</button></div></form>`;
  };

  PAGES.data = async () => {
    const d = await api('GET', U('/api/dashboard', 'days=' + S.days));
    const head = `<div class="stack"><h1>${L('لوحة البيانات', 'Data dashboard')}</h1>${seg('days', [[7, L('آخر 7 أيام', 'Last 7 days')], [30, L('آخر 30 يومًا', 'Last 30 days')]], S.days)}</div>`;
    if (!d.entries) return head + `<div class="card">${empty(L('لا توجد تسجيلات في هذه الفترة.', 'No entries in this period.'))}</div>`;
    const maxKg = Math.max(...d.series.map((s) => s.kg), 0.1);
    return head + `<div class="grid k4">
      <div class="card"><div class="mut">${L('إجمالي الهدر', 'Total waste')}</div><div class="big">${kgT(d.total_kg)}</div><div class="small">${d.delta_pct === null ? '' : L('عن الفترة السابقة: ', 'vs previous period: ')}${delta(d.delta_pct)}</div></div>
      <div class="card"><div class="mut">${L('التكلفة المالية للهدر', 'Financial cost of waste')}</div><div class="big">${sar(d.cost_sar)}</div></div>
      <div class="card"><div class="mut">${L('نسبة الهدر من إجمالي الطعام', 'Waste as share of all food')}</div><div class="big">${d.waste_share_pct === null ? '—' : N(d.waste_share_pct, 1) + '%'}</div>${d.waste_share_pct === null ? `<div class="small mut">${L('تظهر عند إدخال الكمية المحضّرة', 'Shown once food prepared is entered')}</div>` : ''}</div>
      <div class="card"><div class="mut">${L('متوسط الهدر اليومي', 'Average daily waste')}</div><div class="big">${kgT(d.avg_per_day)}</div><div class="small mut">${d.entries} ${L('تسجيل', 'entries')}</div></div></div>
    <div class="grid"><div class="card"><h2>${L('أكثر الأصناف هدرًا', 'Most wasted items')}</h2>${bars(d.by_item, (r) => iname(r.item_id), 1.6)}</div>
      ${isAdmin() && S.branch === 'all' && d.by_branch.length > 1 ? `<div class="card"><h2>${L('الفروع الأكثر هدرًا', 'Branches with most waste')}</h2>${bars(d.by_branch, (r) => bname(r.branch_id), 1.6)}</div>` : ''}</div>
    <div class="grid"><div class="card"><h2>${L('الهدر حسب المصدر', 'Waste by source')}</h2>${donut(d.by_type, `${N(d.total_kg, 0)}<br><small>${L('كجم', 'kg')}</small>`, (r) => L(...TYPES[r.key][0]))}</div>
      <div class="card"><h2>${L('الهدر حسب الوجبة', 'Waste by meal')}</h2>${donut(d.by_meal, L('الوجبات', 'Meals'), (r) => L(...MEALS[r.key]))}</div></div>
    <div class="card"><h2>${L('الهدر اليومي (كجم)', 'Daily waste (kg)')}</h2><div class="cols">${d.series.map((s) => `<div title="${esc(dshort(s.day))}: ${N(s.kg, 1)}">${d.days <= 7 ? N(s.kg, 1) : ''}<i style="height:${Math.round((s.kg / maxKg) * 140)}px"></i></div>`).join('')}</div>
      <div class="collab">${d.series.map((s, i) => `<span>${d.days <= 7 ? esc(wd(s.day).slice(0, 5)) : (i % 5 === 0 ? esc(dshort(s.day)) : '')}</span>`).join('')}</div></div>`;
  };

  PAGES.rec = async () => {
    const r = await api('GET', U('/api/recommendations'));
    const rc = r.recommendations;
    const head = `<div class="stack"><h1>${L('التوصيات الذكية', 'Smart recommendations')}</h1><div class="mut">${L('مبنية على بيانات الهدر الفعلية لآخر 4 أسابيع. التوصية فرضية تُجرَّب ثم يُقاس أثرها.', 'Based on your actual waste data of the last 4 weeks. A recommendation is a hypothesis: you test it, then measure it.')}</div></div>`;
    const list = !rc.ready ? notReady(rc, L('التوصيات', 'recommendations')) : rc.items.length === 0
      ? `<div class="card">${empty(L('لا توجد توصيات جديدة الآن: لا صنف يتجاوز 10% من الهدر، أو أن التجارب الجارية تغطي الأصناف الرئيسية.', 'No new recommendations right now: no item exceeds 10% of waste, or active trials already cover the main items.'))}</div>`
      : `<div class="grid">${rc.items.map((x) => `<div class="card stack"><div class="row between"><h3>${esc(L('تقليل هدر ', 'Reduce waste of ') + iname(x.item_id))}</h3><span class="badge">${N(x.share_pct, 1)}% ${L('من الهدر', 'of waste')}</span></div>
        <p style="margin:0">${esc(L(...ADVICE[x.advice]))}</p>
        <div class="note">${L('الهدف:', 'Target:')} <b>${x.target_pct}%</b> ${L('خفض لمدة أسبوعين', 'reduction for two weeks')} · ${L('توفير أسبوعي تقديري', 'estimated weekly saving')} <b>${sar(x.est_weekly_saving_sar)}</b><br><small class="mut">${L('هذا هدف وليس تنبؤًا، والقياس الفعلي يظهر في صفحة قبل وبعد.', 'This is a target, not a prediction. The measured result appears on the Before & after page.')}</small></div>
        ${isAdmin() ? `<div class="row"><button class="btn" type="button" data-act="trial-start" data-item="${x.item_id}" data-pct="${x.target_pct}">${L('تطبيق التوصية', 'Apply recommendation')}</button><button class="btn ghost" type="button" data-act="trial-ignore" data-item="${x.item_id}" data-pct="${x.target_pct}">${L('تجاهل', 'Ignore')}</button></div>` : `<p class="mut small" style="margin:0">${L('تطبيق التوصيات من صلاحية المدير.', 'Applying recommendations is up to the admin.')}</p>`}</div>`).join('')}</div>`;
    return head + list + trialsCard(r.trials);
  };

  function trialsCard(trials) {
    if (!trials.length) return '';
    return `<div class="card"><h2>${L('التجارب', 'Trials')}</h2><div style="overflow-x:auto"><table><tr><th>${L('الصنف', 'Item')}</th><th>${L('الحالة', 'Status')}</th><th>${L('منذ', 'Since')}</th><th>${L('قبل (كجم/يوم)', 'Before (kg/day)')}</th><th>${L('الآن (كجم/يوم)', 'Now (kg/day)')}</th><th>${L('النتيجة', 'Result')}</th><th></th></tr>
      ${trials.map((t) => `<tr><td>${esc(iname(t.item_id))}</td><td><span class="badge">${t.status === 'active' ? L('جارية', 'Active') : L('متوقفة', 'Stopped')}</span></td><td>${esc(dshort(t.started_day))}</td><td>${N(t.impact.baseline_kg_day, 2)}</td><td>${N(t.impact.current_kg_day, 2)}</td>
      <td>${t.impact.measuring ? `<span class="mut">${L('قيد القياس (تحتاج 3 أيام)', 'Measuring (needs 3 days)')}</span>` : `<b class="${t.impact.reduction_pct >= 0 ? 'pos' : 'neg'}">${t.impact.reduction_pct >= 0 ? '' : '+'}${N(-t.impact.reduction_pct, 1)}%</b> · ${t.impact.saving_sar >= 0 ? '' : '−'}${sar(Math.abs(t.impact.saving_sar))}`}</td>
      <td>${isAdmin() && t.status === 'active' ? `<button class="btn sm ghost" type="button" data-act="trial-stop" data-id="${t.id}">${L('إيقاف', 'Stop')}</button>` : ''}</td></tr>`).join('')}</table></div></div>`;
  }

  PAGES.impact = async () => {
    const [c, r] = await Promise.all([api('GET', U('/api/impact', 'days=' + S.per)), api('GET', U('/api/recommendations'))]);
    const head = `<div class="stack"><h1>${L('قبل وبعد', 'Before & after')}</h1>${seg('per', [[7, L('أسبوعي', 'Weekly')], [30, L('شهري', 'Monthly')]], S.per)}</div>`;
    if (!c.has_prev) return head + `<div class="note">${L('تظهر المقارنة بعد وجود تسجيلات في الفترة السابقة أيضًا.', 'The comparison appears once the previous period also has entries.')}</div>` + trialsCard(r.trials);
    const max = Math.max(c.prev_kg, c.cur_kg, 0.1);
    const s = c.saving_sar;
    return head + `<div class="grid"><div class="card"><h2>${L('الهدر قبل وبعد (كجم)', 'Waste before and after (kg)')}</h2>
      <div class="cmp"><div>${N(c.prev_kg, 1)}<i style="height:${Math.round((c.prev_kg / max) * 140)}px"></i><span class="mut small">${L('الفترة السابقة', 'Previous period')}</span></div><div>${N(c.cur_kg, 1)}<i style="height:${Math.round((c.cur_kg / max) * 140)}px"></i><span class="mut small">${L('الفترة الحالية', 'Current period')}</span></div></div></div>
      <div class="card stack"><div><div class="mut">${L('التوفير المالي', 'Financial savings')}</div><div class="big ${s >= 0 ? 'pos' : 'neg'}">${s >= 0 ? '' : '−'}${sar(Math.abs(s))}</div></div>
        <div class="mut">${c.delta_pct === null ? '' : L('نسبة التغير في الهدر: ', 'Change in waste: ')}${delta(c.delta_pct)}</div>
        <div class="note small">${L('المقارنة بين فترتين متتاليتين من تسجيلاتكم. تتأثر بعدد أيام العمل واكتمال التسجيل، لذا تُقرأ مع نتائج التجارب أدناه.', 'This compares two consecutive periods of your own entries. It is affected by working days and how complete the logging is, so read it together with the trial results below.')}</div></div></div>` + trialsCard(r.trials);
  };

  PAGES.settings = async () => {
    const admin = isAdmin();
    const [users] = await Promise.all([admin ? api('GET', '/api/users') : Promise.resolve(null)]);
    const ai = S.meta.ai;
    const sec = (title, body) => `<section class="card stack"><h2 style="margin:0">${title}</h2>${body}</section>`;
    const lang = sec(L('اللغة والمظهر', 'Language and appearance'), `<div class="row"><button class="chip" type="button" data-act="lang" aria-pressed="${S.lang === 'ar'}" data-v="ar">العربية</button><button class="chip" type="button" data-act="lang" aria-pressed="${S.lang === 'en'}" data-v="en">English</button>
      <button class="chip" type="button" data-act="theme-set" data-v="auto" aria-pressed="${S.theme === 'auto'}">${L('تلقائي', 'Auto')}</button><button class="chip" type="button" data-act="theme-set" data-v="light" aria-pressed="${S.theme === 'light'}">${L('فاتح', 'Light')}</button><button class="chip" type="button" data-act="theme-set" data-v="dark" aria-pressed="${S.theme === 'dark'}">${L('داكن', 'Dark')}</button></div>`);
    const aiSec = sec(L('نموذج الذكاء الاصطناعي', 'AI model'), ai.available
      ? `<p style="margin:0"><span class="badge">${L('مُضاف', 'Installed')}</span> ${L('الأصناف التي يتعرف عليها النموذج:', 'Classes the model recognises:')}</p>
         <div class="stack">${ai.labels.map((l) => { const it = window.MidrarAI.matchItem(l, items()); return `<div class="li"><span dir="auto">${esc(l)}</span><span class="${it ? 'pos' : 'neg'}">${it ? '✓ ' + esc(S.lang === 'en' ? it.name_en : it.name_ar) : L('غير مربوط بأي صنف', 'not mapped to any item')}</span></div>`; }).join('')}</div>
         <p class="mut small" style="margin:0">${L('لربط صنف بفئة في النموذج، اكتب اسم الفئة في حقل «فئة النموذج» للصنف أدناه.', 'To link an item to a model class, type the class name in the item\'s “Model class” field below.')}</p>`
      : `<p style="margin:0"><span class="badge high">${L('غير مُضاف', 'Not installed')}</span></p>
         <p class="mut" style="margin:0">${L('عند إنهاء النموذج: صدّره من Teachable Machine بصيغة TensorFlow.js وانسخ الملفات الثلاثة (model.json وmetadata.json وweights.bin) إلى المجلد public/model ثم حدّث الصفحة. لا حاجة لأي تعديل في الكود.', 'When your model is ready: export it from Teachable Machine as TensorFlow.js and copy the three files (model.json, metadata.json, weights.bin) into the public/model folder, then refresh. No code changes needed.')}</p>`);
    let adminSecs = '';
    if (admin) {
      adminSecs = sec(L('الجهة والتسعير', 'Organisation and pricing'), `<form data-form="org" class="formgrid"><div class="field"><label for="s-org">${L('اسم الجهة', 'Organisation name')}</label><input id="s-org" name="name" value="${esc(S.meta.org.name)}" required maxlength="120"></div>
        <div class="field"><label for="s-price">${L('تكلفة الكيلو من الطعام (ريال)', 'Cost per kg of food (SAR)')}</label><input id="s-price" name="price_per_kg" type="number" step="0.01" min="0" value="${esc(S.meta.org.price_per_kg)}" required></div><button class="btn sm">${L('حفظ', 'Save')}</button></form>
        <p class="mut small" style="margin:0">${L('يُستخدم هذا السعر لتحويل الهدر والتوفير إلى ريال. قدّره من متوسط تكلفة مشترياتكم.', 'This price converts waste and savings into riyals. Estimate it from your average purchasing cost.')}</p>`)
      + sec(L('الأصناف', 'Items'), `${items().map((i) => `<form data-form="item-edit" data-id="${i.id}" class="formgrid" style="padding-bottom:10px;border-bottom:1px solid var(--line)">
          <div class="field"><label>${L('بالعربية', 'Arabic')}</label><input name="name_ar" value="${esc(i.name_ar)}" required maxlength="60"></div>
          <div class="field"><label>English</label><input name="name_en" value="${esc(i.name_en)}" maxlength="60" dir="ltr"></div>
          <div class="field"><label>${L('فئة النموذج', 'Model class')}</label><input name="ai_label" value="${esc(i.ai_label || '')}" maxlength="60" dir="ltr" placeholder="${esc(i.name_en)}"></div>
          <div class="row"><button class="btn sm">${L('حفظ', 'Save')}</button><button class="btn sm ghost" type="button" data-act="item-active" data-id="${i.id}" data-v="${i.active ? 0 : 1}">${i.active ? L('إخفاء', 'Hide') : L('إظهار', 'Show')}</button></div></form>`).join('')}
        <form data-form="item-add" class="formgrid"><div class="field"><label>${L('صنف جديد (عربي)', 'New item (Arabic)')}</label><input name="name_ar" required maxlength="60"></div><div class="field"><label>English</label><input name="name_en" maxlength="60" dir="ltr"></div><button class="btn sm">${L('إضافة', 'Add')}</button></form>`)
      + sec(L('الفروع', 'Branches'), `${S.meta.branches.map((b) => `<form data-form="branch-edit" data-id="${b.id}" class="formgrid"><div class="field"><label>${L('الاسم', 'Name')}</label><input name="name" value="${esc(b.name)}" required maxlength="80"></div><div class="field"><label>${L('المدينة', 'City')}</label><input name="city" value="${esc(b.city || '')}" maxlength="80"></div><button class="btn sm">${L('حفظ', 'Save')}</button></form>`).join('')}
        <form data-form="branch-add" class="formgrid"><div class="field"><label>${L('فرع جديد', 'New branch')}</label><input name="name" required maxlength="80"></div><div class="field"><label>${L('المدينة', 'City')}</label><input name="city" maxlength="80"></div><button class="btn sm">${L('إضافة', 'Add')}</button></form>`)
      + sec(L('الجمعيات', 'Charities'), `${S.meta.charities.map((c) => `<div class="li"><span>${esc(c.name)}${c.active ? '' : ` <span class="badge">${L('مخفية', 'Hidden')}</span>`}</span><button class="btn sm ghost" type="button" data-act="charity-active" data-id="${c.id}" data-v="${c.active ? 0 : 1}">${c.active ? L('إخفاء', 'Hide') : L('إظهار', 'Show')}</button></div>`).join('')}
        <form data-form="charity-add" class="formgrid"><div class="field"><label>${L('جمعية جديدة', 'New charity')}</label><input name="name" required maxlength="80"></div><button class="btn sm">${L('إضافة', 'Add')}</button></form>`)
      + sec(L('المستخدمون', 'Users'), `${users.users.map((u) => `<div class="li"><span>${esc(u.name)} <span class="mut small" dir="ltr">${esc(u.email)}</span><br><small class="mut">${u.role === 'admin' ? L('مدير', 'Admin') : L('موظف', 'Staff') + ' · ' + esc(u.branch_id ? bname(u.branch_id) : '')}</small></span>${u.id === S.user.id ? '' : `<button class="btn sm danger" type="button" data-act="user-del" data-id="${u.id}">${L('حذف', 'Delete')}</button>`}</div>`).join('')}
        <form data-form="user-add" class="formgrid"><div class="field"><label>${L('الاسم', 'Name')}</label><input name="name" required maxlength="120"></div><div class="field"><label>${L('البريد', 'Email')}</label><input name="email" type="email" required dir="ltr"></div><div class="field"><label>${L('كلمة مرور مؤقتة', 'Temporary password')}</label><input name="password" type="text" minlength="8" required dir="ltr"></div>
          <div class="field"><label>${L('الدور', 'Role')}</label><select name="role"><option value="staff">${L('موظف (فرع واحد)', 'Staff (one branch)')}</option><option value="admin">${L('مدير', 'Admin')}</option></select></div>
          <div class="field"><label>${L('فرع الموظف', "Staff member's branch")}</label><select name="branch_id">${S.meta.branches.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</select></div><button class="btn sm">${L('إضافة', 'Add')}</button></form>`)
      + sec(L('البيانات', 'Data'), `<div class="row"><a class="btn sm" href="/api/export.csv" download>${L('تصدير كل التسجيلات (CSV)', 'Export all entries (CSV)')}</a>
        ${S.meta.has_demo ? `<button class="btn sm danger" type="button" data-act="demo-clear">${L('مسح البيانات التجريبية', 'Remove demo data')}</button>` : (S.meta.entry_count === 0 ? `<button class="btn sm ghost" type="button" data-act="demo-load">${L('تحميل بيانات تجريبية للعرض', 'Load demo data')}</button>` : '')}</div>
        <p class="mut small" style="margin:0">${L('البيانات التجريبية متاحة فقط قبل تسجيل أي بيانات حقيقية، ويمكن مسحها بضغطة واحدة.', 'Demo data is only available before any real entry exists, and can be removed in one click.')}</p>`);
    }
    const pw = sec(L('الحساب', 'Account'), `<form data-form="password" class="formgrid"><div class="field"><label>${L('كلمة المرور الحالية', 'Current password')}</label><input name="current" type="password" required autocomplete="current-password" dir="ltr"></div><div class="field"><label>${L('كلمة المرور الجديدة', 'New password')}</label><input name="next" type="password" minlength="8" required autocomplete="new-password" dir="ltr"></div><button class="btn sm">${L('تغيير', 'Change')}</button></form>`);
    return `<div class="stack"><h1>${L('الإعدادات', 'Settings')}</h1></div>` + lang + aiSec + adminSecs + pw;
  };

  /* -------------------------------------------------------------- events */
  async function boot() {
    try {
      const st = await api('GET', '/api/status');
      S.needsSetup = st.needs_setup;
      if (!S.needsSetup) await loadSession();
    } catch { /* not logged in */ }
    syncRoute();
    render();
  }
  async function loadSession() {
    try {
      S.meta = await api('GET', '/api/meta');
      S.user = S.meta.user;
      if (!S.form) S.form = newForm();
    } catch { S.user = null; S.meta = null; }
  }
  async function refreshMeta() { S.meta = await api('GET', '/api/meta'); S.user = S.meta.user; }
  function syncRoute() {
    const r = (location.hash || '').replace('#', '');
    S.route = ROUTES.some(([k]) => k === r) ? r : 'home';
  }
  function go(r) { if (location.hash === '#' + r) { S.route = r; render(); } else location.hash = r; }
  window.addEventListener('hashchange', () => { syncRoute(); if (S.user) render(); });

  const ACTS = {
    go: (el) => go(el.dataset.v),
    lang: (el) => { S.lang = el.dataset.v || (S.lang === 'en' ? 'ar' : 'en'); try { localStorage.setItem('midrar-lang', S.lang); } catch { /* ignore */ } if (S.form && S.meta) S.form = { ...S.form }; render({ keep: true }); },
    theme: () => { S.theme = S.theme === 'auto' ? 'dark' : S.theme === 'dark' ? 'light' : 'auto'; saveTheme(); render({ keep: true }); },
    'theme-set': (el) => { S.theme = el.dataset.v; saveTheme(); render({ keep: true }); },
    logout: async () => {
      try { await api('POST', '/api/logout', {}); } catch { /* ignore */ }
      resetPhoto(); S.user = null; S.meta = null; S.form = null; S.error = ''; S.needsSetup = false; S.branch = 'all'; S.route = 'home';
      history.replaceState(null, '', location.pathname);
      render();
    },
    sel: (el) => { S.sel = Number(el.dataset.v); render({ keep: true }); },
    days: (el) => { S.days = Number(el.dataset.v); render({ keep: true }); },
    per: (el) => { S.per = Number(el.dataset.v); render({ keep: true }); },
    item: (el) => { const id = Number(el.dataset.v), a = S.form.items; S.form.items = a.includes(id) ? a.filter((x) => x !== id) : [...a, id]; render({ keep: true }); },
    type: (el) => { S.form.type = el.dataset.v; render({ keep: true }); },
    'clear-photo': () => { resetPhoto(); render({ keep: true }); },
    offer: async (el) => { await act(() => api('PUT', '/api/offers/' + el.dataset.id, { status: el.dataset.v })); },
    'del-entry': async (el) => { if (!confirm(L('حذف هذا التسجيل؟', 'Delete this entry?'))) return; await act(async () => { await api('DELETE', '/api/entries/' + el.dataset.id); await refreshMeta(); }); },
    'trial-start': (el) => act(() => api('POST', '/api/trials', { item_id: Number(el.dataset.item), target_pct: Number(el.dataset.pct), branch_id: S.branch }), L('بدأت التجربة، وسنقيس الأثر', 'Trial started, we will measure the impact')),
    'trial-ignore': (el) => act(() => api('POST', '/api/trials', { item_id: Number(el.dataset.item), target_pct: Number(el.dataset.pct), branch_id: S.branch, ignore: true })),
    'trial-stop': (el) => act(() => api('POST', `/api/trials/${el.dataset.id}/stop`, {}), L('أُوقفت التجربة', 'Trial stopped')),
    'item-active': (el) => act(async () => { await api('PUT', '/api/items/' + el.dataset.id, { active: Number(el.dataset.v) === 1 }); await refreshMeta(); }),
    'charity-active': (el) => act(async () => { await api('PUT', '/api/charities/' + el.dataset.id, { active: Number(el.dataset.v) === 1 }); await refreshMeta(); }),
    'user-del': (el) => { if (confirm(L('حذف هذا المستخدم؟', 'Delete this user?'))) return act(() => api('DELETE', '/api/users/' + el.dataset.id)); },
    'demo-load': (el) => act(async () => { el.disabled = true; await api('POST', '/api/demo', {}); await refreshMeta(); }, L('تم تحميل البيانات التجريبية', 'Demo data loaded')),
    'demo-clear': () => { if (confirm(L('مسح كل البيانات التجريبية؟', 'Remove all demo data?'))) return act(async () => { await api('DELETE', '/api/demo'); S.branch = 'all'; await refreshMeta(); }, L('تم المسح', 'Removed')); },
  };
  function saveTheme() { try { localStorage.setItem('midrar-theme', S.theme); } catch { /* ignore */ } }
  async function act(fn, okMsg) {
    try { await fn(); if (okMsg) toast(okMsg); await render({ keep: true }); }
    catch (e) { toast(errText(e)); }
  }

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    const fn = ACTS[el.dataset.act];
    if (fn) { if (el.tagName === 'A') return; ev.preventDefault(); fn(el); }
  });

  document.addEventListener('input', (ev) => {
    const el = ev.target.closest('[data-bind]');
    if (el && S.form) S.form[el.dataset.bind] = el.dataset.bind === 'branch' ? Number(el.value) : el.value;
  });

  document.addEventListener('change', async (ev) => {
    const el = ev.target.closest('[data-change]');
    if (!el) return;
    if (el.dataset.change === 'branch') { S.branch = el.value; render({ keep: true }); }
    if (el.dataset.change === 'photo') await onPhoto(el);
  });

  async function onPhoto(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!/^image\//.test(file.type) || file.size > 20e6) { toast(L('اختر صورة صالحة', 'Choose a valid image')); return; }
    resetPhoto();
    S.form.photoUrl = URL.createObjectURL(file);
    S.form.ai = { status: 'running' };
    render({ keep: true });
    try {
      const img = new Image();
      img.src = S.form.photoUrl;
      await img.decode();
      const preds = await window.MidrarAI.classify(img);
      const top = preds[0];
      S.form.ai = { status: 'done', preds: preds.slice(0, 5) };
      const it = top && top.p >= 0.5 ? window.MidrarAI.matchItem(top.label, items()) : null;
      if (it) { S.form.aiTop = it.id; if (!S.form.items.includes(it.id)) S.form.items.push(it.id); }
    } catch { S.form.ai = { status: 'error' }; }
    render({ keep: true });
  }

  const FORMS = {
    login: async (fd) => {
      const r = await api('POST', '/api/login', { email: fd.get('email'), password: fd.get('password') });
      S.user = r.user; await loadSession(); S.error = '';
    },
    setup: async (fd) => {
      await api('POST', '/api/setup', Object.fromEntries(fd));
      S.needsSetup = false; await loadSession(); S.error = '';
    },
    entry: async () => {
      const f = S.form;
      if (!f.items.length) throw Object.assign(new Error('invalid_items'), { key: 'invalid_items' });
      const body = { kg: f.kg, waste_type: f.type, meal: f.meal, item_ids: f.items, branch_id: f.branch, day: f.day };
      if (f.ai && f.ai.status === 'done') {
        body.ai_labels = f.ai.preds.slice(0, 3);
        body.ai_corrected = !(f.aiTop && f.items.length === 1 && f.items[0] === f.aiTop);
      }
      await api('POST', '/api/entries', body);
      resetPhoto();
      S.form = { ...newForm(), type: f.type, meal: f.meal, branch: f.branch, day: f.day };
      await refreshMeta();
      toast(L('تم حفظ التسجيل', 'Entry saved'));
    },
    prepared: async () => {
      await api('POST', '/api/prepared', { kg: S.form.prepared, branch_id: S.form.branch, day: S.form.day });
      S.form.prepared = ''; toast(L('تم حفظ الكمية المحضّرة', 'Prepared amount saved'));
    },
    offer: async (fd) => {
      await api('POST', '/api/offers', Object.fromEntries(fd));
      toast(L('سُجّل الطلب', 'Request recorded'));
    },
    org: async (fd) => { await api('PUT', '/api/org', Object.fromEntries(fd)); await refreshMeta(); toast(L('تم الحفظ', 'Saved')); },
    'item-add': async (fd) => { await api('POST', '/api/items', Object.fromEntries(fd)); await refreshMeta(); toast(L('تمت الإضافة', 'Added')); },
    'item-edit': async (fd, form) => { await api('PUT', '/api/items/' + form.dataset.id, Object.fromEntries(fd)); await refreshMeta(); toast(L('تم الحفظ', 'Saved')); },
    'branch-add': async (fd) => { await api('POST', '/api/branches', Object.fromEntries(fd)); await refreshMeta(); toast(L('تمت الإضافة', 'Added')); },
    'branch-edit': async (fd, form) => { await api('PUT', '/api/branches/' + form.dataset.id, Object.fromEntries(fd)); await refreshMeta(); toast(L('تم الحفظ', 'Saved')); },
    'charity-add': async (fd) => { await api('POST', '/api/charities', Object.fromEntries(fd)); await refreshMeta(); toast(L('تمت الإضافة', 'Added')); },
    'user-add': async (fd) => { await api('POST', '/api/users', Object.fromEntries(fd)); toast(L('تمت إضافة المستخدم', 'User added')); },
    password: async (fd) => { await api('POST', '/api/password', Object.fromEntries(fd)); toast(L('تم تغيير كلمة المرور', 'Password changed')); },
  };

  document.addEventListener('submit', async (ev) => {
    const form = ev.target.closest('form[data-form]');
    if (!form) return;
    ev.preventDefault();
    const name = form.dataset.form;
    const btn = form.querySelector('button:not([type])');
    if (btn) btn.disabled = true;
    try {
      await FORMS[name](new FormData(form), form);
      S.error = '';
      if (name === 'login' || name === 'setup') { syncRoute(); S.form = S.meta ? newForm() : null; }
      await render({ keep: name !== 'login' && name !== 'setup' });
    } catch (e) {
      if (name === 'login' || name === 'setup') { S.error = errText(e); await render(); } else { toast(errText(e)); if (btn) btn.disabled = false; }
    }
  });

  boot();
})();
