/* Campaign Ops approval console. Plain JavaScript, no build step.
   Every string that came from the AI or the account is escaped before it
   touches the page. */
(function () {
  'use strict';

  const KEY_NAME = 'campaign-ops-console-key';
  const POLL_MS = 2500;
  const root = document.getElementById('app');
  const toastsEl = document.getElementById('toasts');

  const S = {
    key: null,
    data: null,
    seenPending: null,
    confirm: null,
    confirmTimer: null,
    notes: {},
    busy: false,
    timer: null,
  };

  const ARROW = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

  // ---------- helpers ----------

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function readKey() {
    const m = /(?:^|[#&])key=([A-Za-z0-9_-]+)/.exec(location.hash || '');
    if (m) {
      S.key = m[1];
      try { localStorage.setItem(KEY_NAME, S.key); } catch (e) { /* storage blocked: keep in memory */ }
      try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
      return;
    }
    try { S.key = localStorage.getItem(KEY_NAME); } catch (e) { S.key = null; }
  }

  function saveKey(key) {
    S.key = key;
    try { localStorage.setItem(KEY_NAME, key); } catch (e) { /* ignore */ }
  }

  function forgetKey() {
    S.key = null;
    try { localStorage.removeItem(KEY_NAME); } catch (e) { /* ignore */ }
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

  function clock(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${t}`;
  }

  function ago(iso) {
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    return clock(iso);
  }

  function expiresIn(iso) {
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return 'Expiring now.';
    const m = Math.round(ms / 60000);
    if (m < 60) return `Expires in ${m} min.`;
    return `Expires in ${Math.round(m / 60)} h.`;
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

  // ---------- pieces ----------

  function riskTag(risk) {
    const label = { low: 'Low risk', medium: 'Medium risk', high: 'High risk' }[risk] || risk;
    return `<span class="risk risk-${esc(risk)}"><span class="dot" aria-hidden="true"></span>${esc(label)}</span>`;
  }

  function redline(p) {
    const c = p.change;
    const d = p.diff || [];
    if (c.type === 'set_campaign_budget' || c.type === 'set_campaign_status') {
      const row = d[0] || {};
      return `<div class="redline">
        <span class="field">${esc(row.field)}</span>
        <div class="values">
          <del class="was num">${esc(row.before)}</del>
          <span class="arrow">${ARROW}</span>
          <ins class="now num">${esc(row.after)}</ins>
          ${row.delta ? `<span class="delta num">${esc(row.delta)}</span>` : ''}
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
    const sorted = p.checks.slice().sort((a, b) => order[a.status] - order[b.status]);
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

  function confirmFor(act, id) {
    return S.confirm && S.confirm.act === act && S.confirm.id === id;
  }

  function slip(p, isNew) {
    const confirming = confirmFor('approve', p.id);
    const approveLabel = confirming ? 'Confirm approval' : 'Approve change';
    const isUndo = Boolean(p.rollbackOf);
    return `<article class="slip${isNew ? ' is-new' : ''}" aria-label="Proposal ${esc(p.id)}">
      <div class="slip-head">
        <span class="pid">${esc(p.id)}</span>
        <span class="type">${esc(p.typeLabel)}</span>
        <span class="grow"></span>
        ${riskTag(p.risk)}
      </div>
      <p class="target">${esc(p.targetLabel)}</p>
      ${redline(p)}
      ${p.change.type === 'set_campaign_status' ? `<p class="summary">${esc(p.summary)}</p>` : ''}
      <p class="why">${esc(p.reason)}</p>
      <p class="byline">Proposed by ${esc(p.requestedBy)}, ${esc(ago(p.createdAt))}. ${esc(expiresIn(p.expiresAt))}${isUndo ? ` Restores the state before ${esc(p.rollbackOf)}.` : ''}</p>
      ${checkList(p)}
      <div class="actions">
        <button class="btn btn-sign${confirming ? ' is-confirm' : ''}" data-act="approve" data-id="${esc(p.id)}" data-risk="${esc(p.risk)}">${approveLabel}</button>
        <button class="btn btn-quiet" data-act="reject" data-id="${esc(p.id)}">Reject</button>
        <input class="note" data-note="${esc(p.id)}" maxlength="300" placeholder="Note for the record (optional)" aria-label="Note for ${esc(p.id)}" value="${esc(S.notes[p.id] || '')}">
      </div>
    </article>`;
  }

  function firstFailure(p) {
    const failed = p.checks.filter((c) => c.status === 'fail');
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

  function stateLine(p) {
    switch (p.status) {
      case 'applied':
        return '<span class="state ok">✓ Applied and verified</span>';
      case 'approved':
        return '<span class="state info">Approved. Waiting for the AI to apply it.</span>';
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
        return `<span class="state muted">${esc(p.status)}</span>`;
    }
  }

  function recentList(items) {
    if (!items.length) {
      return '<div class="empty"><p>No decisions yet.</p><p>Approved, applied and undone changes show up here.</p></div>';
    }
    return `<ul class="list">${items
      .slice(0, 10)
      .map((p) => {
        const canUndo = p.status === 'applied' && !p.rollbackOf && !p.rolledBackBy;
        const confirming = confirmFor('undo', p.id);
        const when = p.appliedAt || (p.approval && p.approval.at) || (p.rejection && p.rejection.at) || p.createdAt;
        const note = (p.approval && p.approval.note) || (p.rejection && p.rejection.note);
        return `<li>
          <span class="pid">${esc(p.id)}</span>
          <div>
            <p class="what">${esc(p.summary)}</p>
            <p class="sub">${stateLine(p)}${note ? ` <span>Note: ${esc(note)}</span>` : ''}${p.error && p.status !== 'expired' ? ` <span>${esc(p.error)}</span>` : ''}</p>
          </div>
          <div class="end">
            <span class="when">${esc(clock(when))}</span>
            ${canUndo ? `<button class="btn btn-quiet btn-small${confirming ? ' is-confirm' : ''}" data-act="undo" data-id="${esc(p.id)}">${confirming ? 'Confirm undo' : 'Undo'}</button>` : ''}
          </div>
        </li>`;
      })
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
  };

  function auditList(audit) {
    if (!audit.recent.length) return '<div class="empty"><p>The audit log is empty.</p><p>Every proposal, decision and change is recorded here.</p></div>';
    return `<ul class="list audit">${audit.recent
      .map(
        (e) => `<li>
          <span class="seq">${esc(e.seq)}</span>
          <div>
            <p class="what">${esc(AUDIT_LABELS[e.type] || e.type)}${e.proposalId ? ` ${esc(e.proposalId)}` : ''}</p>
            <p class="sub">${esc(e.actor)}, ${esc(clock(e.ts))}</p>
            <p class="hash">${esc(String(e.hash || '').slice(0, 16))}</p>
          </div>
        </li>`,
      )
      .join('')}</ul>`;
  }

  // ---------- screens ----------

  function renderGate(message) {
    stopPolling();
    root.innerHTML = `<main class="gate">
      <h1>Campaign Ops</h1>
      <p>Enter your console key to review and approve changes.</p>
      <p>Run <code>npm run console</code> on the computer running Campaign Ops. It prints a link that opens this page with your key already filled in.</p>
      <form id="gate-form" autocomplete="off">
        <label for="gate-key">Console key</label>
        <input id="gate-key" name="key" type="password" required minlength="16" spellcheck="false">
        <button class="btn btn-sign" type="submit">Open console</button>
      </form>
      ${message ? `<p class="error">${esc(message)}</p>` : ''}
    </main>`;
    const form = document.getElementById('gate-form');
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const value = document.getElementById('gate-key').value.trim();
      if (!value) return;
      saveKey(value);
      refresh(true);
    });
    document.getElementById('gate-key').focus();
  }

  function render() {
    const d = S.data;
    if (!d) return;
    const kill = d.killSwitch;
    const pending = d.proposals.filter((p) => p.status === 'pending_approval');
    const stopped = d.proposals.filter((p) => p.status === 'blocked');
    const recent = d.proposals.filter((p) => !['pending_approval', 'blocked'].includes(p.status));

    const newIds = new Set();
    if (S.seenPending) pending.forEach((p) => { if (!S.seenPending.has(p.id)) newIds.add(p.id); });
    S.seenPending = new Set(pending.map((p) => p.id));

    const confirmingResume = confirmFor('resume', 'all');
    const switchHtml = kill.on
      ? `<span class="live is-paused"><span class="dot" aria-hidden="true"></span>Changes paused</span>
         ${kill.forcedByEnv ? '' : `<button class="btn btn-sign btn-small${confirmingResume ? ' is-confirm' : ''}" data-act="resume" data-id="all">${confirmingResume ? 'Confirm resume' : 'Resume changes'}</button>`}`
      : `<span class="live"><span class="dot" aria-hidden="true"></span>Changes live</span>
         <button class="btn btn-stop btn-small" data-act="pause" data-id="all">Pause all changes</button>`;

    const n = d.counts;
    const statusBits = [
      `<strong>${n.pending}</strong> ${n.pending === 1 ? 'change is' : 'changes are'} waiting for you.`,
      `<strong>${n.appliedToday}</strong> applied in the last 24 hours.`,
      `Guardrails stopped <strong>${n.blocked}</strong> ${n.blocked === 1 ? 'attempt' : 'attempts'}.`,
      d.audit.ok ? `Audit chain intact across <strong>${d.audit.count}</strong> entries.` : `<span class="bad">Audit chain broken: ${esc(d.audit.problem || 'unknown problem')}</span>`,
    ];

    root.innerHTML = `
      <header class="bar">
        <div class="bar-inner">
          <div class="brand"><span class="brand-name">Campaign Ops</span><span class="brand-sub">Approval console</span></div>
          <div class="account">${d.mode === 'sandbox' ? '<span class="mode">Sandbox data</span>' : ''}<span>${esc(d.account ? d.account.name : '')}</span></div>
          <div class="switch">${switchHtml}</div>
        </div>
      </header>
      ${kill.on ? `<div class="banner" role="alert"><div class="banner-inner"><p>All changes are paused. The AI can still propose, but nothing can be applied${kill.forcedByEnv ? ' while CAMPAIGN_OPS_KILL_SWITCH is set' : ' until you resume'}.</p></div></div>` : ''}
      <main class="page">
        <p class="status-line">${statusBits.join(' ')}</p>
        <div class="columns">
          <div>
            <section aria-labelledby="h-pending">
              <h2 id="h-pending">Waiting for you <span class="count">${pending.length || ''}</span></h2>
              ${pending.length ? pending.map((p) => slip(p, newIds.has(p.id))).join('') : '<div class="empty"><p>Nothing to approve.</p><p>When the AI proposes a change, it appears here within a few seconds.</p></div>'}
            </section>
            <section aria-labelledby="h-recent">
              <h2 id="h-recent">Decisions and changes</h2>
              ${recentList(recent)}
            </section>
          </div>
          <div>
            <section aria-labelledby="h-stopped">
              <h2 id="h-stopped">Stopped by guardrails <span class="count">${stopped.length || ''}</span></h2>
              ${stoppedList(stopped)}
            </section>
            <section aria-labelledby="h-audit">
              <h2 id="h-audit">Audit log <span class="chain ${d.audit.ok ? 'ok' : 'bad'}">${d.audit.ok ? '✓ Chain intact' : '✕ Chain broken'}</span></h2>
              ${auditList(d.audit)}
            </section>
          </div>
        </div>
        <p class="foot">Campaign Ops ${esc(d.app.version)}. Scope: ${esc(d.scope)}. ${d.mode === 'sandbox' ? 'Sandbox data is synthetic. ' : ''}Fair Housing checks are a screening aid, not legal advice.</p>
      </main>`;
  }

  // ---------- actions ----------

  function setConfirm(act, id) {
    S.confirm = { act, id };
    clearTimeout(S.confirmTimer);
    S.confirmTimer = setTimeout(() => {
      S.confirm = null;
      render();
    }, 6000);
    render();
  }

  async function act(action, id, button) {
    if (S.busy) return;
    const needsConfirm =
      (action === 'approve' && button && button.dataset.risk === 'high') || action === 'undo' || action === 'resume';
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
        toast(`Approved ${id}. The AI can apply it now.`);
      } else if (action === 'reject') {
        await api('POST', `/api/proposals/${encodeURIComponent(id)}/reject`, { note: S.notes[id] || undefined });
        delete S.notes[id];
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
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    act(btn.dataset.act, btn.dataset.id, btn);
  });

  root.addEventListener('input', (ev) => {
    const el = ev.target;
    if (el.matches && el.matches('input[data-note]')) S.notes[el.dataset.note] = el.value;
  });

  // ---------- polling ----------

  async function refresh(force) {
    if (!S.key) return renderGate('');
    const active = document.activeElement;
    const typing = active && active.matches && active.matches('input[data-note]');
    try {
      S.data = await api('GET', '/api/state');
      if (force || !typing) render();
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

  readKey();
  refresh(true);
})();
