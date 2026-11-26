/* The OAuth consent page: allowing an AI app to use Campaign Ops needs the owner's passkey. */
(function () {
  'use strict';
  var form = document.getElementById('consent-form');
  var allow = document.getElementById('allow');
  var error = document.getElementById('consent-error');
  if (!form || !allow) return;

  function fromB64url(s) {
    var b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4));
    var out = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
    return out.buffer;
  }
  function toB64url(buf) {
    var u = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  allow.addEventListener('click', function () {
    allow.disabled = true;
    error.textContent = '';
    var handle = form.elements.handle.value;
    fetch('/auth/consent/options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: handle }) })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || 'The server did not answer.');
          return data;
        });
      })
      .then(function (data) {
        var o = data.options;
        var publicKey = {
          challenge: fromB64url(o.challenge),
          rpId: o.rpId,
          timeout: o.timeout,
          userVerification: o.userVerification,
          allowCredentials: (o.allowCredentials || []).map(function (c) {
            return { type: 'public-key', id: fromB64url(c.id), transports: c.transports };
          }),
        };
        return navigator.credentials.get({ publicKey: publicKey }).then(function (cred) {
          var r = cred.response;
          form.elements.challengeId.value = data.challengeId;
          form.elements.assertion.value = JSON.stringify({
            id: cred.id,
            type: cred.type,
            response: {
              clientDataJSON: toB64url(r.clientDataJSON),
              authenticatorData: toB64url(r.authenticatorData),
              signature: toB64url(r.signature),
              userHandle: r.userHandle ? toB64url(r.userHandle) : null,
            },
          });
          var decision = document.createElement('input');
          decision.type = 'hidden';
          decision.name = 'decision';
          decision.value = 'approve';
          form.appendChild(decision);
          form.submit();
        });
      })
      .catch(function (e) {
        error.textContent = e && e.name === 'NotAllowedError' ? 'The passkey was cancelled. Press Allow to try again.' : (e && e.message) || 'Something went wrong. Try again.';
        allow.disabled = false;
      });
  });
})();
