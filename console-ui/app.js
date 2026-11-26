/* Campaign Ops approval console. Plain JavaScript, no build step.
   Every string that came from the AI or an ad account is escaped before it
   touches the page. Nothing is drawn on a timer: the page asks for fresh data
   every few seconds and redraws only when something actually changed. */
(function () {
  'use strict';

  const KEY_NAME = 'campaign-ops-console-key';
  const PICK_NAME = 'campaign-ops-console-account';
  const POLL_MS = 2500;
  const root = document.getElementById('app');
  const modalEl = document.getElementById('modal');
  const toastsEl = document.getElementById('toasts');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const S = {
    key: null,
    data: null,
    sig: '',
    dirty: false,
    booted: false,
    seenPending: null,
    applied: null,
    confirm: null,
    notes: {},
    busy: false,
    timer: null,
    tab: 'approve',
    selected: null,
    insights: {},
    modal: null,
    focus: null,
    focusShown: false,
    rowScroll: 0,
    showSelected: true,
  };

  const ICON = {
    arrow: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    lock: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    unlock: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.6-1.7"/></svg>',
    pen: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>',
    pulse: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l2.5-6 5 12 2.5-6h4"/></svg>',
    book: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4z"/><path d="M5 17a3 3 0 0 1 3-3h11"/></svg>',
    chat: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5z"/></svg>',
  };

  const MODE = { sandbox: 'Sandbox', google_ads_test: 'Google Ads test', google_ads: 'Live' };
  const NUMBERS = { synthetic: 'Synthetic data', simulated: 'Simulated numbers', live: 'Real numbers' };
  const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
  const STATUS_WORDS = {
    approved: 'already approved',
    applied: 'already applied',
    rejected: 'rejected',
    expired: 'expired',
    blocked: 'blocked by the guardrails',
    rolled_back: 'already undone',
    conflict: 'stopped by a conflict',
    failed: 'failed',
    verify_failed: 'applied, but its verification failed',
  };

  // ---------- helpers ----------

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function plural(n, one, many) {
    return n === 1 ? one : many || `${one}s`;
  }

  function countWord(n) {
    return n >= 0 && n < WORDS.length ? WORDS[n] : String(n);
  }

  function load(name) {
    try { return localStorage.getItem(name); } catch (e) { return null; }
  }

  function store(name, value) {
    try {
      if (value == null) localStorage.removeItem(name);
      else localStorage.setItem(name, value);
    } catch (e) { /* storage blocked: keep it in memory only */ }
  }

  /** #key=... comes from npm run console. #p=P-0007 comes from an approve link in the chat. */
  function readHash() {
    const h = location.hash || '';
    const key = /(?:^|[#&])key=([A-Za-z0-9_-]+)/.exec(h);
    const p = /(?:^|[#&])p=(P-\d{4,})/.exec(h);
    if (key) {
      S.key = key[1];
      store(KEY_NAME, S.key);
    }
    if (p) {
      S.focus = p[1];
      S.focusShown = false;
      S.tab = 'approve';
    }
    if (key || p) {
      try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
    }
    if (!S.key) S.key = load(KEY_NAME);
  }

  function saveKey(key) {
    S.key = key;
    store(KEY_NAME, key);
  }

  function forgetKey() {
    S.key = null;
    store(KEY_NAME, null);
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Console-Token': S.key || '' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (res.status === 401) {
      const err = new Error('That console key did not work.');
      err.auth = true;
      throw err;
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
    return data;
  }

  function sameDay(a, b) {
    return a.toDateString() === b.toDateString();
  }

  function clock(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return sameDay(d, new Date()) ? t : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${t}`;
  }

  function dayOf(dateText) {
    const d = new Date(`${dateText}T12:00:00`);
    return Number.isNaN(d.getTime()) ? dateText : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function untilText(ms) {
    const d = new Date(ms);
    const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const today = new Date();
    if (sameDay(d, today)) return `${t} today`;
    const tomorrow = new Date(today.getTime() + 86_400_000);
    if (sameDay(d, tomorrow)) return `${t} tomorrow`;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${t}`;
  }

  function money(n) {
    return `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function kwLabel(k) {
    if (k.matchType === 'EXACT') return `[${k.text}]`;
    if (k.matchType === 'PHRASE') return `"${k.text}"`;
    return k.text;
  }

  function toast(message, bad) {
    const el = document.createElement('div');
    el.className = bad ? 'toast bad' : 'toast';
    el.textContent = message;
    toastsEl.appendChild(el);
    setTimeout(() => el.remove(), bad ? 7000 : 4200);
  }

  function accounts() {
    return (S.data && Array.isArray(S.data.accounts)) ? S.data.accounts : [];
  }

  function accountById(id) {
    return accounts().find((a) => a.id === id);
  }

  function isLive(a) {
    return Boolean(a && a.access && a.access.required);
  }

  function maxWindowHours() {
    const p = S.data && S.data.policy;
    return (p && p.live && p.live.maxWindowHours) || 8;
  }

  function approvalMinutes() {
    const p = S.data && S.data.policy;
    return (p && p.approvals && p.approvals.approvalTtlMinutes) || 30;
  }

  function ensureSelected() {
    const list = accounts();
    if (!list.length) return;
    if (S.selected && accountById(S.selected)) return;
    const saved = load(PICK_NAME);
    const pick = (saved && list.find((a) => a.id === saved)) || list.find((a) => a.mode === 'google_ads') || list.find((a) => a.mode === 'google_ads_test') || list[0];
    S.selected = pick.id;
  }

  function isTyping() {
    const el = document.activeElement;
    return Boolean(S.modal) || Boolean(el && el.matches && el.matches('input') && root.contains(el));
  }

  function confirmFor(act, id) {
    return Boolean(S.confirm && S.confirm.act === act && S.confirm.id === id);
  }

  function isGoogleItself(e) {
    return /recommendation|google support/i.test(String(e.client || ''));
  }

  // ---------- account tabs ----------

  function modeChip(a) {
    return `<span class="mode mode-${esc(a.mode)}">${esc(MODE[a.mode] || a.mode)}</span>`;
  }

  function healthHtml(a) {
    const ins = S.insights[a.id];
    if (!ins || (!ins.data && ins.loading) || (!ins.data && !ins.error)) return '<span class="health"><span class="dot" aria-hidden="true"></span>Checking</span>';
    if (!ins.data) return '<span class="health warn"><span class="dot" aria-hidden="true"></span>Could not check</span>';
    const bits = [];
    const p = ins.data.pulse;
    if (p && !p.error) {
      const n = p.alarms.length;
      bits.push(n ? `<span class="health bad"><span class="dot" aria-hidden="true"></span>${n} Pulse ${plural(n, 'alarm')}</span>` : '<span class="health good"><span class="dot" aria-hidden="true"></span>Pulse quiet</span>');
    }
    const w = ins.data.witness;
    if (w && !w.error) {
      const record = w.source === 'sandbox_change_history' ? 'its record' : 'Google';
      const label = { clean: `Matches ${record}`, attention: `Check ${record}`, alarm: 'Unapproved change', unavailable: 'No record to check' }[w.verdict] || w.verdict;
      const cls = { clean: 'good', attention: 'warn', alarm: 'bad' }[w.verdict] || '';
      bits.push(`<span class="health ${cls}"><span class="dot" aria-hidden="true"></span>${esc(label)}</span>`);
    }
    return bits.join('');
  }

  function lockHtml(a) {
    if (!isLive(a)) return `<div class="acct-lock"><span class="lock is-plain">${a.mode === 'sandbox' ? 'Practice account. Changes need your approval.' : 'Test account. Changes need your approval and never spend money.'}</span></div>`;
    if (a.access.open) {
      return `<div class="acct-lock"><span class="lock is-open">${ICON.unlock}Changes allowed until ${esc(clock(a.access.until))}</span><button class="btn btn-quiet btn-small" data-act="window-close" data-id="${esc(a.id)}">Lock now</button></div>`;
    }
    return `<div class="acct-lock"><span class="lock is-locked">${ICON.lock}Read-only</span><button class="btn btn-quiet btn-small" data-act="window" data-id="${esc(a.id)}">Open change window</button></div>`;
  }

  function accountsHtml() {
    const list = accounts();
    if (!list.length) return '';
    return `<section class="accounts" data-pane="watch" aria-label="Accounts"><div class="accounts-row">${list
      .map((a) => {
        const sel = a.id === S.selected;
        return `<div class="acct${sel ? ' is-selected' : ''}">
          <button class="acct-pick" data-act="select" data-id="${esc(a.id)}" aria-pressed="${sel}">
            <span class="acct-title"><span class="acct-name">${esc(a.name)}</span><span class="acct-id">${esc(a.id)}</span></span>
            <span class="acct-meta">${modeChip(a)}<span>${esc(NUMBERS[a.numbers] || '')}</span></span>
            <span class="acct-health">${healthHtml(a)}</span>
          </button>
          ${lockHtml(a)}
        </div>`;
      })
      .join('')}</div></section>`;
  }

  // ---------- headline ----------

  function heroHtml(d) {
    const pending = d.counts.pending;
    const paused = d.killSwitch.on;
    let title;
    if (pending > 0) title = `${countWord(pending)} ${plural(pending, 'change is', 'changes are')} waiting for your signature.`;
    else if (paused) title = 'All changes are paused.';
    else title = 'Nothing is waiting for you.';
    const n = d.counts;
    const small = (k) => (k >= 0 && k < 10 ? ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][k] : String(k));
    const lead = n.appliedToday === 0 ? 'None' : countWord(n.appliedToday);
    const bits = [
      `<strong>${esc(lead)}</strong> applied in the last 24 hours.`,
      `Guardrails stopped <strong>${esc(small(n.blocked))}</strong> ${plural(n.blocked, 'attempt')}.`,
      d.audit.ok ? `Audit chain intact across <strong>${esc(d.audit.count)}</strong> entries.` : `<span class="bad">Audit chain broken: ${esc(d.audit.problem || 'unknown problem')}</span>`,
    ];
    for (const a of accounts()) {
      if (isLive(a) && a.access.open) bits.push(`<span class="open">Change window open for ${esc(a.name)} until ${esc(clock(a.access.until))}.</span>`);
    }
    return `<section class="hero" data-pane="approve">
      <h1 class="hero-title${paused && !pending ? ' is-paused' : ''}">${esc(title)}</h1>
      <p class="hero-sub">${bits.join(' ')}</p>
    </section>`;
  }

  // ---------- the slip ----------

  function riskTag(risk) {
    const label = { low: 'Low risk', medium: 'Medium risk', high: 'High risk' }[risk] || risk;
    return `<span class="risk risk-${esc(risk)}"><span class="dot" aria-hidden="true"></span>${esc(label)}</span>`;
  }

  function redline(p) {
    const c = p.change;
    const d = p.diff || [];
    if (c.type === 'set_campaign_budget' || c.type === 'set_campaign_status' || c.type === 'set_ad_status') {
      const row = d[0] || {};
      return `<div class="redline">
        <span class="field">${esc(row.field)}</span>
        <div class="values">
          <del class="was">${esc(row.before)}</del>
          <span class="arrow">${ICON.arrow}</span>
          <ins class="now">${esc(row.after)}</ins>
          ${row.delta ? `<span class="delta">${esc(row.delta)}</span>` : ''}
        </div>
      </div>`;
    }
    if (c.type === 'add_negative_keywords' || c.type === 'remove_negative_keywords') {
      const adding = c.type === 'add_negative_keywords';
      return `<div class="redline">
        <span class="field">${adding ? 'Searches to exclude' : 'Exclusions to remove'}</span>
        <ul class="kw">${c.keywords.map((k) => `<li class="${adding ? 'add' : 'remove'}"><span class="sign" aria-hidden="true">${adding ? '+' : '−'}</span>${esc(kwLabel(k))}</li>`).join('')}</ul>
      </div>`;
    }
    if (c.type === 'update_ad_text') {
      return `<div class="redline">
        <span class="field">Ad copy</span>
        <div class="copy">${d.map((row) => `<div class="copyline"><span class="copyfield">${esc(row.field)}</span><del>${esc(row.before)}</del><ins>${esc(row.after)}</ins></div>`).join('')}</div>
      </div>`;
    }
    return '';
  }

  function checkList(p) {
    const order = { fail: 0, warn: 1, pass: 2 };
    const marks = { pass: '✓', warn: '!', fail: '✕' };
    // The live-account notice above the checks shows the window as it is now, so the check taken at proposal time is left out here.
    const sorted = (p.checks || []).filter((c) => c.id !== 'live_access').sort((a, b) => order[a.status] - order[b.status]);
    return `<ul class="checks">${sorted
      .map((c) => {
        const wide = c.status !== 'pass' || (c.detail && c.detail.length > 70);
        return `<li class="check ${esc(c.status)}${wide ? ' is-wide' : ''}">
          <span class="mark" aria-label="${esc(c.status)}">${marks[c.status] || ''}</span>
          <span><span class="label">${esc(c.label)}</span>${c.detail ? `<span class="detail">${esc(c.detail)}</span>` : ''}</span>
        </li>`;
      })
      .join('')}</ul>`;
  }

  function liveNotice(p) {
    const a = accountById(p.accountId);
    if (!isLive(a)) return '';
    if (a.access.open) {
      return `<div class="notice ok"><p>Live account. A change window is open until ${esc(clock(a.access.until))}, so this can be applied as soon as you approve it.</p></div>`;
    }
    return `<div class="notice"><p>Live account, real money. You can approve now, but nothing is applied until you open a change window.</p><button class="btn btn-quiet btn-small" data-act="window" data-id="${esc(a.id)}">Open change window</button></div>`;
  }

  function slip(p, isNew) {
    const confirming = confirmFor('approve', p.id);
    const focused = S.focus === p.id;
    const a = accountById(p.accountId);
    const many = accounts().length > 1;
    const ttl = approvalMinutes();
    const fine = p.rollbackOf
      ? `Approving lets the AI restore the state before ${esc(p.rollbackOf)}, once, within ${ttl} minutes.`
      : `Approving lets the AI apply this once, within ${ttl} minutes. It is checked again right before it is applied, and you can undo it afterwards.`;
    return `<article class="slip${isNew ? ' is-new' : ''}${focused ? ' is-focus' : ''}" id="slip-${esc(p.id)}" aria-label="Proposal ${esc(p.id)}">
      ${focused ? `<p class="from-chat">${ICON.chat}You opened this from the chat.</p>` : ''}
      <div class="slip-head"><span class="pid">${esc(p.id)}</span><span>${esc(p.typeLabel)}</span><span class="grow"></span>${riskTag(p.risk)}</div>
      <div class="slip-body">
        ${many && a ? `<p class="slip-account"><span>${esc(a.name)}</span>${modeChip(a)}</p>` : ''}
        <p class="slip-target">${esc(p.targetLabel)}</p>
        ${redline(p)}
        ${p.change.type === 'set_campaign_status' || p.change.type === 'set_ad_status' ? `<p class="slip-summary">${esc(p.summary)}</p>` : ''}
        <p class="slip-why">${esc(p.reason)}</p>
        <p class="slip-byline">Proposed by ${esc(p.requestedBy)} at ${esc(clock(p.createdAt))}. Expires at ${esc(clock(p.expiresAt))} if nobody decides.</p>
        ${liveNotice(p)}
        ${checkList(p)}
      </div>
      <div class="decide">
        <p class="decide-label">Your decision</p>
        <div class="decide-row">
          <button class="btn btn-sign${confirming ? ' is-confirm' : ''}" data-act="approve" data-id="${esc(p.id)}" data-risk="${esc(p.risk)}">${confirming ? 'Confirm approval' : 'Approve change'}</button>
          <button class="btn btn-quiet" data-act="reject" data-id="${esc(p.id)}">Reject</button>
          <input class="note" data-note="${esc(p.id)}" maxlength="300" placeholder="Note for the record (optional)" aria-label="Note for ${esc(p.id)}" value="${esc(S.notes[p.id] || '')}">
        </div>
        <p class="fine">${confirming ? 'High risk. Press Confirm approval to sign it. ' : ''}${fine}</p>
      </div>
    </article>`;
  }

  // ---------- decisions, stopped, audit ----------

  function stateLine(p) {
    switch (p.status) {
      case 'applied':
        return '<span class="state ok">✓ Applied and verified</span>';
      case 'approved': {
        const a = accountById(p.accountId);
        return isLive(a) && !a.access.open
          ? '<span class="state warn">Approved. Waiting for a change window.</span>'
          : '<span class="state info">Approved. Waiting for the AI to apply it.</span>';
      }
      case 'rolled_back':
        return `<span class="state muted">Undone by ${esc(p.rolledBackBy)}</span>`;
      case 'rejected':
        return '<span class="state muted">Rejected</span>';
      case 'expired':
        return '<span class="state muted">Expired</span>';
      case 'conflict':
        return '<span class="state warn">Not applied: the live value changed</span>';
      case 'verify_failed':
        return '<span class="state bad">Applied, but verification failed</span>';
      case 'failed':
        return '<span class="state bad">Failed</span>';
      default:
        return `<span class="state muted">${esc(String(p.status).replace(/_/g, ' '))}</span>`;
    }
  }

  function signature(p) {
    if (p.approval && p.approval.at) return `<p class="signature">Signed by ${esc(p.approval.by)} at ${esc(clock(p.approval.at))}</p>`;
    if (p.rejection && p.rejection.at) return `<p class="signature muted">Rejected by ${esc(p.rejection.by)} at ${esc(clock(p.rejection.at))}</p>`;
    return '';
  }

  function recentList(items) {
    if (!items.length) {
      return '<div class="empty"><p>No decisions yet.</p><p>Approved, applied and undone changes show up here.</p></div>';
    }
    return `<ul class="list">${items
      .slice(0, 12)
      .map((p) => {
        const canUndo = p.status === 'applied' && !p.rollbackOf && !p.rolledBackBy;
        const acct = accountById(p.accountId);
        const locked = isLive(acct) && !acct.access.open;
        const confirming = confirmFor('undo', p.id);
        const when = p.appliedAt || (p.approval && p.approval.at) || (p.rejection && p.rejection.at) || p.createdAt;
        const note = (p.approval && p.approval.note) || (p.rejection && p.rejection.note);
        return `<li id="row-${esc(p.id)}"${S.focus === p.id ? ' class="is-focus"' : ''}>
          <span class="pid">${esc(p.id)}</span>
          <div>
            <p class="what">${esc(p.summary)}</p>
            <p class="sub">${stateLine(p)}${note ? ` <span>Note: ${esc(note)}</span>` : ''}${p.error && p.status !== 'expired' ? ` <span>${esc(p.error)}</span>` : ''}</p>
            ${signature(p)}
          </div>
          <div class="end">
            <span class="when">${esc(clock(when))}</span>
            ${canUndo && locked ? '<span class="state muted">Undo needs a change window</span>' : ''}
            ${canUndo && !locked ? `<button class="btn btn-quiet btn-small${confirming ? ' is-confirm' : ''}" data-act="undo" data-id="${esc(p.id)}">${confirming ? 'Confirm undo' : 'Undo'}</button>` : ''}
          </div>
        </li>`;
      })
      .join('')}</ul>`;
  }

  function firstFailure(p) {
    const failed = (p.checks || []).filter((c) => c.status === 'fail');
    return failed.length ? failed.map((c) => c.detail || c.label).join(' ') : '';
  }

  function stoppedList(items) {
    if (!items.length) {
      return '<div class="empty"><p>No blocked attempts yet.</p><p>When the AI proposes something that breaks a rule, it lands here with the reason.</p></div>';
    }
    return `<ul class="list stopped">${items
      .slice(0, 6)
      .map(
        (p) => `<li>
          <span class="pid">${esc(p.id)}</span>
          <div><p class="what">${esc(p.summary)}</p><p class="sub">${esc(firstFailure(p))}</p></div>
          <span class="when">${esc(clock(p.createdAt))}</span>
        </li>`,
      )
      .join('')}</ul>`;
  }

  const AUDIT_LABELS = {
    proposal_created: 'Proposed',
    proposal_blocked: 'Stopped by guardrails',
    approved: 'Approved',
    rejected: 'Rejected',
    apply_refused: 'Apply refused',
    conflict: 'Conflict detected',
    apply_failed: 'Apply failed',
    applied: 'Applied and verified',
    verify_failed: 'Verification failed',
    rollback_requested: 'Undo requested',
    rolled_back: 'Undone',
    expired: 'Expired',
    kill_switch_on: 'Paused all changes',
    kill_switch_off: 'Resumed changes',
    tamper_detected: 'Tampering detected',
    change_window_opened: 'Opened a change window',
    change_window_closed: 'Locked a live account early',
    setup_changes: 'Setup built the sample campaigns',
  };

  function auditList(audit) {
    if (!audit.recent.length) return '<div class="empty"><p>The audit log is empty.</p><p>Every proposal, decision and change is recorded here.</p></div>';
    return `<ul class="list audit">${audit.recent
      .map((e) => {
        const acct = e.details && e.details.account ? ` for ${esc(e.details.account)}` : '';
        return `<li>
          <span class="seq">${esc(e.seq)}</span>
          <div>
            <p class="what">${esc(AUDIT_LABELS[e.type] || e.type)}${e.proposalId ? ` ${esc(e.proposalId)}` : ''}${acct}</p>
            <p class="sub">${esc(e.actor)}, ${esc(clock(e.ts))}</p>
            <p class="hash">${esc(String(e.hash || '').slice(0, 16))}</p>
          </div>
        </li>`;
      })
      .join('')}</ul>`;
  }

  // ---------- Pulse ----------

  function stripChart(al) {
    const e = al.evidence;
    if (!e || !Array.isArray(e.dates) || !e.dates.length) return '';
    const n = e.dates.length;
    const W = 420;
    const H = 104;
    const leadTop = 8;
    const leadH = 22;
    const barTop = 42;
    const base = H - 6;
    const spend = al.kind === 'spend_spike' || al.kind === 'stopped_spending';
    const series = (spend ? e.cost : e.clicks).map((v) => Number(v) || 0);
    const max = Math.max(1, ...series);
    const slot = W / n;
    const bw = Math.max(3, slot * 0.58);
    const from = Math.min(Math.max(0, Number(e.highlightFrom) || 0), n);
    const warm = al.severity !== 'high';
    const parts = [];
    parts.push(`<rect class="band${warm ? ' warm' : ''}" x="${(from * slot).toFixed(1)}" y="0" width="${((n - from) * slot).toFixed(1)}" height="${H}" rx="4"/>`);
    for (let i = 0; i < n; i++) {
      const h = Math.max(series[i] > 0 ? 1.5 : 0, (series[i] / max) * (base - barTop));
      const x = i * slot + (slot - bw) / 2;
      const label = spend ? `${dayOf(e.dates[i])}: ${money(series[i])} spent` : `${dayOf(e.dates[i])}: ${series[i]} clicks, ${e.conversions[i]} leads`;
      parts.push(`<rect class="bar${i >= from ? (warm ? ' warm' : ' hot') : ''}" x="${x.toFixed(1)}" y="${(base - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5"><title>${esc(label)}</title></rect>`);
    }
    parts.push(`<line class="baseline" x1="0" x2="${W}" y1="${base}" y2="${base}"/>`);
    if (!spend) {
      const conv = e.conversions.map((v) => Number(v) || 0);
      const maxC = Math.max(1, ...conv);
      for (let i = 0; i < n; i++) {
        const cx = (i * slot + slot / 2).toFixed(1);
        if (conv[i] > 0) parts.push(`<circle class="lead" cx="${cx}" cy="${(leadTop + leadH - (conv[i] / maxC) * leadH).toFixed(1)}" r="3.2"/>`);
        else if (i >= from) parts.push(`<circle class="lead zero" cx="${cx}" cy="${leadTop + leadH}" r="3.6"/>`);
      }
    }
    const aria = spend ? `Daily spend for ${n} days. The highlighted days triggered the alarm.` : `Daily clicks and leads for ${n} days. The highlighted days triggered the alarm.`;
    const legend = spend
      ? '<span><span class="key bar"></span>Spend per day</span>'
      : `<span><span class="key bar"></span>Clicks per day</span><span><span class="key lead"></span>Leads</span>${al.kind === 'tracking_outage' ? '<span><span class="key zero"></span>No leads recorded</span>' : ''}`;
    return `<div class="figure">
      <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">${parts.join('')}</svg>
      <div class="axis"><span>${esc(dayOf(e.dates[0]))}</span><span>${esc(dayOf(e.dates[n - 1]))}</span></div>
      <div class="legend">${legend}</div>
    </div>`;
  }

  function alarmHtml(al) {
    return `<div class="alarm ${esc(al.severity)}">
      <p class="alarm-title"><span class="dot" aria-hidden="true"></span><span>${esc(al.title)}</span></p>
      ${al.odds ? `<span class="odds">Chance by luck: ${esc(al.odds)}</span>` : ''}
      <p class="alarm-detail">${esc(al.detail)}</p>
      ${stripChart(al)}
      <ul class="steps">${(al.nextSteps || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
    </div>`;
  }

  function pulseHtml(ins) {
    if (!ins.data) {
      return `<h3 class="part-title">Pulse</h3>${ins.error ? `<p class="error-text">${esc(ins.error)}</p>` : '<p class="loading">Reading the daily numbers.</p>'}`;
    }
    const p = ins.data.pulse;
    if (p.error) return `<h3 class="part-title">Pulse</h3><p class="error-text">Pulse could not run: ${esc(p.error)}</p>`;
    const n = p.alarms.length;
    const head = `<h3 class="part-title">Pulse<span class="end">${n ? `${n} ${plural(n, 'alarm')}` : 'All quiet'}</span></h3>`;
    const lead = `<p class="part-lead">Day-by-day checks a monthly report misses, over the last ${esc(p.period.days)} days. Pulse never changes anything.</p>`;
    const notes = (p.notes || []).filter((t) => !/^Pulse never changes/.test(t)).map((t) => `<p class="small-note">${esc(t)}</p>`).join('');
    if (!n) return `${head}${lead}<p class="quiet-line">✓ No tracking outages, stalled campaigns, spend spikes or lead drops.</p>${notes}`;
    return `${head}${lead}${p.alarms.map(alarmHtml).join('')}${notes}`;
  }

  // ---------- the witness: Campaign Ops against the platform's own record ----------

  function ledger(w, recordName) {
    const W = 420;
    const H = 84;
    const pad = 10;
    const yTop = 14;
    const yBot = 70;
    const end = Date.parse(w.checkedAt);
    const start = end - w.days * 86_400_000;
    const x = (iso) => {
      const t = Date.parse(iso);
      const f = Math.min(1, Math.max(0, (t - start) / (end - start)));
      return pad + f * (W - 2 * pad);
    };
    const parts = [];
    for (let i = 0; i <= w.days; i++) {
      const xi = (pad + (i / w.days) * (W - 2 * pad)).toFixed(1);
      parts.push(`<line class="tick${i === w.days ? ' today' : ''}" x1="${xi}" x2="${xi}" y1="${yTop - 5}" y2="${yTop + 5}"/>`);
      parts.push(`<line class="tick${i === w.days ? ' today' : ''}" x1="${xi}" x2="${xi}" y1="${yBot - 5}" y2="${yBot + 5}"/>`);
    }
    parts.push(`<line class="lane" x1="${pad}" x2="${W - pad}" y1="${yTop}" y2="${yTop}"/>`);
    parts.push(`<line class="lane" x1="${pad}" x2="${W - pad}" y1="${yBot}" y2="${yBot}"/>`);
    if (w.setup && w.setup.count && w.setup.from) {
      const a = x(w.setup.from);
      const b = x(w.setup.to || w.setup.from);
      parts.push(`<rect class="band-setup" x="${(Math.min(a, b) - 4).toFixed(1)}" y="${yBot - 6}" width="${Math.max(8, Math.abs(b - a) + 8).toFixed(1)}" height="12" rx="3"><title>${esc(`${w.setup.count} setup ${plural(w.setup.count, 'change')}`)}</title></rect>`);
    }
    for (const e of w.outside || []) {
      parts.push(`<circle class="${isGoogleItself(e) ? 'mk-google' : 'mk-outside'}" cx="${x(e.at).toFixed(1)}" cy="${yBot}" r="4.6"><title>${esc(`${e.summary}. ${e.actor}, ${e.client}, ${clock(e.at)}`)}</title></circle>`);
    }
    for (const m of w.matches || []) parts.push(`<line class="stitch" x1="${x(m.appliedAt).toFixed(1)}" y1="${yTop}" x2="${x(m.googleAt).toFixed(1)}" y2="${yBot}"/>`);
    for (const m of w.matches || []) {
      parts.push(`<circle class="mk-ink" cx="${x(m.appliedAt).toFixed(1)}" cy="${yTop}" r="5"><title>${esc(`${m.proposalId} applied ${clock(m.appliedAt)}`)}</title></circle>`);
      parts.push(`<circle class="mk-ink" cx="${x(m.googleAt).toFixed(1)}" cy="${yBot}" r="5"><title>${esc(`${recordName} recorded ${m.proposalId} at ${clock(m.googleAt)}`)}</title></circle>`);
    }
    for (const m of w.missing || []) {
      const xm = x(m.appliedAt).toFixed(1);
      parts.push(`<line class="stub" x1="${xm}" x2="${xm}" y1="${yTop}" y2="${(yTop + yBot) / 2}"/><circle class="mk-caution" cx="${xm}" cy="${yTop}" r="5"><title>${esc(`${m.proposalId}: no entry yet`)}</title></circle>`);
    }
    for (const m of w.pending || []) {
      const xm = x(m.appliedAt).toFixed(1);
      parts.push(`<line class="stub wait" x1="${xm}" x2="${xm}" y1="${yTop}" y2="${(yTop + yBot) / 2}"/><circle class="mk-hollow" cx="${xm}" cy="${yTop}" r="5"><title>${esc(`${m.proposalId}: too recent to check`)}</title></circle>`);
    }
    for (const e of w.unexplained || []) {
      const xe = x(e.at).toFixed(1);
      parts.push(`<circle class="ring" cx="${xe}" cy="${yBot}" r="8.5"/><circle class="mk-stop" cx="${xe}" cy="${yBot}" r="5"><title>${esc(`Not approved: ${e.summary}, ${clock(e.at)}`)}</title></circle>`);
    }
    const legend = [];
    if ((w.matches || []).length) legend.push('<span><span class="key ink"></span>Approved and recorded</span>');
    if ((w.unexplained || []).length) legend.push('<span><span class="key stop"></span>Robot key, no approval</span>');
    if ((w.missing || []).length) legend.push('<span><span class="key missing"></span>No entry yet</span>');
    if ((w.outside || []).some((e) => !isGoogleItself(e))) legend.push('<span><span class="key outside"></span>A person or another tool</span>');
    if ((w.outside || []).some(isGoogleItself)) legend.push('<span><span class="key google"></span>Google itself</span>');
    if (w.setup && w.setup.count) legend.push('<span><span class="key setup"></span>Setup</span>');
    const aria = `${w.robot.matched} of ${w.robot.total} robot changes match approvals. ${w.outsideCount} changes by others.`;
    return `<div class="figure ledger-figure">
      <div class="axis"><span>Approved in Campaign Ops</span><span>Last ${esc(w.days)} days</span></div>
      <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria)}">${parts.join('')}</svg>
      <div class="axis"><span>Recorded by ${esc(recordName)}</span><span></span></div>
      <div class="axis"><span>${esc(new Date(start).toLocaleDateString([], { month: 'short', day: 'numeric' }))}</span><span>Now</span></div>
      ${legend.length ? `<div class="legend">${legend.join('')}</div>` : ''}
    </div>`;
  }

  function wItem(kind, textHtml, meta) {
    return `<li><span class="key ${kind}"></span><span>${textHtml}<span class="meta">${esc(meta)}</span></span></li>`;
  }

  function wBlock(title, cls, items, more) {
    if (!items.length) return '';
    return `<p class="wlist-title${cls ? ` ${cls}` : ''}">${esc(title)}</p><ul class="wlist">${items.join('')}</ul>${more > 0 ? `<p class="small-note">And ${more} more.</p>` : ''}`;
  }

  function witnessHtml(a, ins) {
    const sandbox = a.mode === 'sandbox';
    const recordName = sandbox ? 'the sandbox' : 'Google';
    const title = sandbox ? "Checked against the sandbox's own record" : "Checked against Google's own record";
    if (!ins.data) {
      return `<h3 class="part-title">${esc(title)}</h3>${ins.error ? `<p class="error-text">${esc(ins.error)}</p>` : '<p class="loading">Reading the change history.</p>'}`;
    }
    const w = ins.data.witness;
    if (w.error) return `<h3 class="part-title">${esc(title)}</h3><p class="error-text">Could not check: ${esc(w.error)}</p>`;
    const mark = { clean: '✓', attention: '!', alarm: '✕', unavailable: '?' }[w.verdict] || '?';
    const un = (w.unexplained || []).length;
    const miss = (w.missing || []).length;
    const verdictText = {
      clean: w.robot && w.robot.matched ? `Every change made with the robot key matches an approval here.` : `No changes made with the robot key in the last ${w.days} days.`,
      attention: `${countWord(miss)} applied ${plural(miss, 'change has', 'changes have')} no entry in ${recordName}'s record yet.`,
      alarm: `${countWord(un)} ${plural(un, 'change was', 'changes were')} made with the robot key and ${plural(un, 'matches', 'match')} no approval. Check who has the key.`,
    }[w.verdict] || w.headline;
    const outsideLine = w.outsideCount ? `${countWord(w.outsideCount)} ${plural(w.outsideCount, 'change was', 'changes were')} made by people or other tools outside Campaign Ops.` : '';
    let out = `<h3 class="part-title">${esc(title)}</h3>
      <p class="part-lead">${sandbox ? 'The sandbox keeps a change history the same way Google Ads does.' : 'Google Ads keeps its own history of every change: who made it, with which tool, and when.'} Every change made with the robot key should match an approval here.</p>
      <div class="verdict ${esc(w.verdict)}"><span class="seal ${esc(w.verdict)}" aria-hidden="true">${mark}</span><div><p>${esc(verdictText)}</p>${outsideLine && w.available ? `<span class="verdict-sub">${esc(outsideLine)}</span>` : ''}</div></div>`;
    if (!w.available) return out;
    out += ledger(w, recordName);
    out += wBlock('Made with the robot key, with no approval', 'bad', (w.unexplained || []).map((e) => wItem('stop', esc(e.summary), `${clock(e.at)}, ${e.client}`)), 0);
    out += wBlock(`Applied here, not in ${recordName}'s record yet`, 'warn', (w.missing || []).map((m) => wItem('missing', `${esc(m.proposalId)}: ${esc(m.summary)}`, `Applied ${clock(m.appliedAt)}`)), 0);
    out += wBlock('Too recent to check', '', (w.pending || []).map((m) => wItem('outside', `${esc(m.proposalId)}: ${esc(m.summary)}`, `Applied ${clock(m.appliedAt)}. The record can take a few minutes. Check again shortly.`)), 0);
    out += wBlock('Matched', '', (w.matches || []).slice(0, 5).map((m) => wItem('ink', `${esc(m.proposalId)}: ${esc(m.summary)}`, `Applied ${clock(m.appliedAt)}. Recorded by ${recordName} ${clock(m.googleAt)}${m.events > 1 ? `, ${m.events} entries` : ''}.`)), (w.matches || []).length - 5);
    out += wBlock(
      'Made outside Campaign Ops',
      '',
      (w.outside || []).slice(0, 6).map((e) => wItem(isGoogleItself(e) ? 'google' : 'outside', `${esc(e.summary)}${isGoogleItself(e) ? '<span class="tag-google">Changed by Google itself</span>' : ''}`, `${e.actor}, ${e.client}, ${clock(e.at)}`)),
      (w.outsideCount || 0) - Math.min(6, (w.outside || []).length),
    );
    if (w.setup && w.setup.count) out += `<p class="small-note">${esc(w.setup.count)} ${plural(w.setup.count, 'change')} by the setup script are expected, so they do not count as unapproved.</p>`;
    if (w.note) out += `<p class="small-note">${esc(w.note)}</p>`;
    return out;
  }

  function watchHtml() {
    const a = accountById(S.selected) || accounts()[0];
    if (!a) return '';
    const ins = S.insights[a.id] || {};
    const d = ins.data;
    const checked = ins.loading ? 'Checking now.' : d ? `Checked at ${clock(d.checkedAt)}.` : 'Not checked yet.';
    return `<section class="watch" data-pane="watch" aria-labelledby="h-watch">
      <div class="watch-head">
        <h2 class="watch-title" id="h-watch">Watching ${esc(a.name)} ${modeChip(a)}</h2>
        <p class="watch-checked"><span>${esc(checked)}</span><button class="link" data-act="insights" data-id="${esc(a.id)}"${ins.loading ? ' disabled' : ''}>Check again</button></p>
      </div>
      <div class="watch-part">${pulseHtml(ins)}</div>
      <div class="watch-part">${witnessHtml(a, ins)}</div>
    </section>`;
  }

  // ---------- frame ----------

  function topHtml(d) {
    const kill = d.killSwitch;
    const confirming = confirmFor('resume', 'all');
    const power = kill.on
      ? `<span class="power-state is-paused"><span class="dot" aria-hidden="true"></span>Changes paused</span>${kill.forcedByEnv ? '' : `<button class="btn btn-sign btn-small${confirming ? ' is-confirm' : ''}" data-act="resume" data-id="all">${confirming ? 'Confirm resume' : 'Resume changes'}</button>`}`
      : '<span class="power-state"><span class="dot" aria-hidden="true"></span>Changes on</span><button class="btn btn-stop btn-small" data-act="pause" data-id="all"><span>Pause<span class="wide-only"> all changes</span></span></button>';
    return `<header class="top"><div class="top-inner">
      <div class="wordmark"><span class="wordmark-name">Campaign Ops</span><span class="wordmark-sub">Approval console</span></div>
      <div class="power">${power}</div>
    </div></header>`;
  }

  function footNote(d) {
    const modes = accounts().map((a) => a.mode);
    const bits = [`Campaign Ops ${d.app.version}. Scope: ${d.scope}.`];
    if (modes.includes('sandbox')) bits.push('Sandbox data is synthetic.');
    if (modes.includes('google_ads_test')) bits.push('Google Ads test accounts never show ads, so their numbers are simulated.');
    if (modes.includes('google_ads')) bits.push('Live accounts stay read-only until you open a change window.');
    bits.push('Fair Housing checks are a screening aid, not legal advice.');
    return bits.join(' ');
  }

  function anyAlarm() {
    return accounts().some((a) => {
      const i = S.insights[a.id];
      if (!i || !i.data) return false;
      const p = i.data.pulse;
      const w = i.data.witness;
      return Boolean((p && p.alarms && p.alarms.length) || (w && w.verdict === 'alarm'));
    });
  }

  function tabbarHtml(d) {
    const pending = d.counts.pending;
    const tab = (id, label, icon, extra) => `<button class="tab" role="tab" aria-selected="${S.tab === id}" data-act="tab" data-id="${id}">${icon}<span>${label}</span>${extra}</button>`;
    return `<nav class="tabbar" role="tablist" aria-label="Sections">
      ${tab('approve', 'Approve', ICON.pen, pending ? `<span class="badge">${esc(pending)}</span>` : '')}
      ${tab('watch', 'Watch', ICON.pulse, anyAlarm() ? '<span class="pip" aria-label="Something needs a look"></span>' : '')}
      ${tab('record', 'Record', ICON.book, '')}
    </nav>`;
  }

  function render() {
    const d = S.data;
    if (!d) return;
    S.dirty = false;
    ensureSelected();
    const pending = d.proposals.filter((p) => p.status === 'pending_approval');
    const stopped = d.proposals.filter((p) => p.status === 'blocked');
    const recent = d.proposals.filter((p) => p.status !== 'pending_approval' && p.status !== 'blocked');

    const newIds = new Set();
    if (S.seenPending) pending.forEach((p) => { if (!S.seenPending.has(p.id)) newIds.add(p.id); });
    S.seenPending = new Set(pending.map((p) => p.id));

    const oldRow = root.querySelector('.accounts-row');
    if (oldRow) S.rowScroll = oldRow.scrollLeft;
    root.dataset.tab = S.tab;
    root.innerHTML = `
      ${topHtml(d)}
      ${d.killSwitch.on ? `<div class="paused" role="alert"><p class="paused-inner">All changes are paused. The AI can still propose, but nothing can be applied${d.killSwitch.forcedByEnv ? ' while CAMPAIGN_OPS_KILL_SWITCH is set' : ' until you resume'}.</p></div>` : ''}
      ${accountsHtml()}
      ${heroHtml(d)}
      <div class="layout">
        <div class="main">
          <section data-pane="approve" aria-labelledby="h-pending">
            <h2 class="block-title" id="h-pending">Waiting for you <span class="count">${pending.length || ''}</span></h2>
            ${pending.length ? pending.map((p) => slip(p, newIds.has(p.id))).join('') : '<div class="empty"><p>Nothing to approve.</p><p>When the AI proposes a change, it appears here within a few seconds. Approve links in the chat open it directly.</p></div>'}
          </section>
          <section data-pane="approve" aria-labelledby="h-recent">
            <h2 class="block-title" id="h-recent">Decisions and changes</h2>
            ${recentList(recent)}
          </section>
        </div>
        <div class="aside">
          ${watchHtml()}
          <section data-pane="record" aria-labelledby="h-stopped">
            <h2 class="block-title" id="h-stopped">Stopped by guardrails <span class="count">${stopped.length || ''}</span></h2>
            ${stoppedList(stopped)}
          </section>
          <section data-pane="record" aria-labelledby="h-audit">
            <h2 class="block-title" id="h-audit">Audit log <span class="end chain ${d.audit.ok ? 'ok' : 'bad'}">${d.audit.ok ? '✓ Chain intact' : '✕ Chain broken'}</span></h2>
            ${auditList(d.audit)}
          </section>
          <p class="foot" data-pane="record">${esc(footNote(d))}</p>
        </div>
      </div>
      ${tabbarHtml(d)}`;
    document.title = pending.length ? `(${pending.length}) Campaign Ops approval console` : 'Campaign Ops approval console';
    keepAccountInView();
    applyFocus();
  }

  /** On a phone the account tabs scroll sideways: keep the place, and show the watched account at first. */
  function keepAccountInView() {
    const row = root.querySelector('.accounts-row');
    if (!row || row.scrollWidth <= row.clientWidth) return;
    const card = row.querySelector('.acct.is-selected');
    if (S.showSelected && card) {
      row.scrollLeft += card.getBoundingClientRect().left - row.getBoundingClientRect().left - 16;
      S.showSelected = false;
    } else {
      row.scrollLeft = S.rowScroll;
    }
  }

  /** Brings the proposal from an approve link into view, once. */
  function applyFocus() {
    if (!S.focus || S.focusShown) return;
    S.focusShown = true;
    const p = S.data.proposals.find((x) => x.id === S.focus);
    if (!p) {
      toast(`${S.focus} is not in the recent list.`, true);
      S.focus = null;
      return;
    }
    if (p.status !== 'pending_approval') toast(`${p.id} is ${STATUS_WORDS[p.status] || String(p.status).replace(/_/g, ' ')}. Nothing to approve.`);
    const el = document.getElementById(p.status === 'pending_approval' ? `slip-${p.id}` : `row-${p.id}`);
    if (el) el.scrollIntoView({ block: 'center', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  }

  // ---------- change window dialog ----------

  function sameName(a, b) {
    const n = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
    return n(a) !== '' && n(a) === n(b);
  }

  function hourOptions(max) {
    const opts = [1, 2, 4, 8].filter((h) => h <= max);
    if (!opts.includes(max)) opts.push(max);
    return opts;
  }

  function openModal(id) {
    const a = accountById(id);
    if (!a) return;
    S.modal = { accountId: id, hours: Math.min(2, maxWindowHours()), typed: '', error: '', busy: false, returnTo: document.activeElement };
    renderModal();
    const input = document.getElementById('dlg-confirm');
    if (input) input.focus();
  }

  function closeModal() {
    const back = S.modal && S.modal.returnTo;
    S.modal = null;
    renderModal();
    if (back && document.body.contains(back)) back.focus();
    if (S.dirty) render();
  }

  function renderModal() {
    const m = S.modal;
    if (!m) {
      modalEl.innerHTML = '';
      return;
    }
    const a = accountById(m.accountId);
    if (!a) {
      S.modal = null;
      modalEl.innerHTML = '';
      return;
    }
    const ok = sameName(m.typed, a.name) && !m.busy;
    modalEl.innerHTML = `<div class="scrim" data-act="modal-close"></div>
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
        <h2 class="dialog-title" id="dlg-title">Open a change window</h2>
        <p class="lead-strong">${esc(a.name)} (${esc(a.id)}) is a live account that spends real money.</p>
        <p>While the window is open, changes you approve can be applied. Every change still needs its own approval, and Pause all changes still stops everything.</p>
        <fieldset class="seg"><legend>How long</legend><div class="seg-row">${hourOptions(maxWindowHours())
          .map((h) => `<button type="button" class="seg-btn" data-hours="${h}" aria-pressed="${h === m.hours}">${h} h</button>`)
          .join('')}</div></fieldset>
        <p class="until">Changes allowed until ${esc(untilText(Date.now() + m.hours * 3_600_000))}.</p>
        <label class="confirm-label" for="dlg-confirm">Type the account name to confirm<span>${esc(a.name)}</span></label>
        <input class="confirm-input" id="dlg-confirm" autocomplete="off" spellcheck="false" value="${esc(m.typed)}">
        ${m.error ? `<p class="dialog-error" role="alert">${esc(m.error)}</p>` : ''}
        <div class="dialog-actions">
          <button type="button" class="btn btn-sign" data-act="window-open"${ok ? '' : ' disabled'}>${m.busy ? 'Opening' : 'Open change window'}</button>
          <button type="button" class="btn btn-quiet" data-act="modal-close">Cancel</button>
        </div>
      </div>`;
  }

  async function submitWindow() {
    const m = S.modal;
    if (!m || m.busy) return;
    const a = accountById(m.accountId);
    if (!a || !sameName(m.typed, a.name)) return;
    m.busy = true;
    m.error = '';
    renderModal();
    try {
      await api('POST', `/api/accounts/${encodeURIComponent(m.accountId)}/window`, { hours: m.hours, confirm: m.typed });
      closeModal();
      toast(`Change window open for ${a.name}. Approved changes can be applied now.`);
      await refresh(true);
    } catch (e) {
      if (e.auth) {
        S.modal = null;
        renderModal();
        forgetKey();
        renderGate(e.message);
        return;
      }
      m.busy = false;
      m.error = e.message;
      renderModal();
      const input = document.getElementById('dlg-confirm');
      if (input) input.focus();
    }
  }

  modalEl.addEventListener('click', (ev) => {
    const hours = ev.target.closest('[data-hours]');
    if (hours && S.modal) {
      S.modal.hours = Number(hours.dataset.hours);
      renderModal();
      const again = modalEl.querySelector(`[data-hours="${S.modal.hours}"]`);
      if (again) again.focus();
      return;
    }
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'modal-close') closeModal();
    if (btn.dataset.act === 'window-open') submitWindow();
  });

  modalEl.addEventListener('input', (ev) => {
    if (!S.modal || ev.target.id !== 'dlg-confirm') return;
    S.modal.typed = ev.target.value;
    const a = accountById(S.modal.accountId);
    const btn = modalEl.querySelector('[data-act="window-open"]');
    if (btn && a) btn.disabled = !(sameName(S.modal.typed, a.name) && !S.modal.busy);
  });

  modalEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.id === 'dlg-confirm') {
      ev.preventDefault();
      submitWindow();
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && S.modal) closeModal();
  });

  // ---------- Pulse and witness data ----------

  async function loadInsights(id, refresh) {
    const cur = S.insights[id] || {};
    if (cur.loading) return;
    S.insights[id] = { data: cur.data, loading: true };
    softRender();
    try {
      const data = await api('GET', `/api/insights?account=${encodeURIComponent(id)}${refresh ? '&refresh=1' : ''}`);
      S.insights[id] = { data };
    } catch (e) {
      if (e.auth) {
        forgetKey();
        renderGate(e.message);
        return;
      }
      S.insights[id] = { data: cur.data, error: e.message };
    }
    softRender();
  }

  async function loadAllInsights() {
    const list = accounts().slice().sort((a, b) => (a.id === S.selected ? -1 : b.id === S.selected ? 1 : 0));
    for (const a of list) await loadInsights(a.id, false);
  }

  /** When a change is applied, look again, so the witness shows it. */
  function noticeApplied(data) {
    const now = new Set();
    for (const p of data.proposals) if (p.appliedAt) now.add(`${p.id}|${p.accountId}|${p.appliedAt}`);
    if (S.applied) {
      const touched = new Set();
      now.forEach((k) => { if (!S.applied.has(k)) touched.add(k.split('|')[1]); });
      touched.forEach((accountId) => setTimeout(() => loadInsights(accountId, false), 4000));
    }
    S.applied = now;
  }

  function softRender() {
    if (isTyping()) S.dirty = true;
    else render();
  }

  // ---------- actions ----------

  function setConfirm(act, id) {
    S.confirm = { act, id };
    render();
  }

  async function act(action, id, button) {
    if (action === 'select') {
      S.selected = id;
      store(PICK_NAME, id);
      if (!S.insights[id]) loadInsights(id, false);
      render();
      return;
    }
    if (action === 'tab') {
      S.tab = id;
      render();
      window.scrollTo(0, 0);
      return;
    }
    if (action === 'insights') {
      loadInsights(id, true);
      return;
    }
    if (action === 'window') {
      openModal(id);
      return;
    }
    if (S.busy) return;
    const needsConfirm = (action === 'approve' && button && button.dataset.risk === 'high') || action === 'undo' || action === 'resume';
    if (needsConfirm && !confirmFor(action, id)) {
      setConfirm(action, id);
      return;
    }
    S.confirm = null;
    S.busy = true;
    if (button) button.disabled = true;
    try {
      if (action === 'approve') {
        await api('POST', `/api/proposals/${encodeURIComponent(id)}/approve`, { note: S.notes[id] || undefined });
        delete S.notes[id];
        if (S.focus === id) S.focus = null;
        const p = S.data.proposals.find((x) => x.id === id);
        const a = p && accountById(p.accountId);
        toast(isLive(a) && !a.access.open ? `Approved ${id}. Open a change window so it can be applied.` : `Approved ${id}. The AI can apply it now.`);
      } else if (action === 'reject') {
        await api('POST', `/api/proposals/${encodeURIComponent(id)}/reject`, { note: S.notes[id] || undefined });
        delete S.notes[id];
        if (S.focus === id) S.focus = null;
        toast(`Rejected ${id}.`);
      } else if (action === 'undo') {
        const res = await api('POST', `/api/proposals/${encodeURIComponent(id)}/undo`, {});
        if (res.ok) toast(`Undone. ${id} was reverted by ${res.rollback.id}.`);
        else toast(res.message || 'Undo did not complete.', true);
      } else if (action === 'pause') {
        await api('POST', '/api/kill-switch', { on: true });
        toast('All changes paused.');
      } else if (action === 'resume') {
        await api('POST', '/api/kill-switch', { on: false });
        toast('Changes resumed.');
      } else if (action === 'window-close') {
        await api('POST', `/api/accounts/${encodeURIComponent(id)}/window/close`, {});
        const a = accountById(id);
        toast(`${a ? a.name : id} is read-only again.`);
      }
    } catch (e) {
      if (e.auth) {
        forgetKey();
        renderGate(e.message);
        return;
      }
      toast(e.message, true);
    } finally {
      S.busy = false;
    }
    await refresh(true);
  }

  root.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (S.confirm && !(btn && btn.dataset.act === S.confirm.act && btn.dataset.id === S.confirm.id)) {
      S.confirm = null;
      if (!btn) {
        render();
        return;
      }
    }
    if (!btn) return;
    act(btn.dataset.act, btn.dataset.id, btn);
  });

  root.addEventListener('input', (ev) => {
    const el = ev.target;
    if (el.matches && el.matches('input[data-note]')) S.notes[el.dataset.note] = el.value;
  });

  // ---------- key gate ----------

  function renderGate(message) {
    stopPolling();
    root.dataset.tab = 'approve';
    root.innerHTML = `<main class="gate">
      <h1>Campaign Ops</h1>
      <p>Enter your console key to review and approve changes.</p>
      <p>Run <code>npm run console</code> on the computer running Campaign Ops. It opens this page with your key already filled in, and the browser remembers it.</p>
      <form id="gate-form" autocomplete="off">
        <label for="gate-key">Console key</label>
        <input id="gate-key" name="key" type="password" required minlength="16" spellcheck="false">
        <button class="btn btn-sign" type="submit">Open console</button>
      </form>
      ${message ? `<p class="error">${esc(message)}</p>` : ''}
    </main>`;
    document.getElementById('gate-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const value = document.getElementById('gate-key').value.trim();
      if (!value) return;
      saveKey(value);
      refresh(true);
    });
    document.getElementById('gate-key').focus();
  }

  // ---------- data ----------

  function dataSignature(data) {
    const copy = Object.assign({}, data);
    delete copy.serverTime;
    return JSON.stringify(copy);
  }

  async function refresh(force) {
    if (!S.key) return renderGate('');
    try {
      const data = await api('GET', '/api/state');
      const sig = dataSignature(data);
      const changed = sig !== S.sig;
      noticeApplied(data);
      S.data = data;
      S.sig = sig;
      ensureSelected();
      const first = !S.booted;
      S.booted = true;
      if (force || first || ((changed || S.dirty) && !isTyping())) render();
      else if (changed) S.dirty = true;
      if (first) loadAllInsights();
      startPolling();
    } catch (e) {
      if (e.auth) {
        forgetKey();
        renderGate(e.message);
      } else {
        toast(`Cannot reach Campaign Ops: ${e.message}`, true);
      }
    }
  }

  function startPolling() {
    if (S.timer) return;
    S.timer = setInterval(() => {
      if (!document.hidden && !S.busy) refresh(false);
    }, POLL_MS);
  }

  function stopPolling() {
    clearInterval(S.timer);
    S.timer = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.key) refresh(false);
  });

  window.addEventListener('hashchange', () => {
    readHash();
    if (S.data) {
      render();
    }
  });

  readHash();
  refresh(true);
})();
