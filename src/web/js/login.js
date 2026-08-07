/**
 * The password prompt, when posi3 is reachable over the network.
 *
 * Its own page rather than a modal over the app: everything behind the guard
 * answers 401, so an app that loaded and then discovered it could fetch
 * nothing would be a screenful of dashes. This is the only page the server
 * serves without authentication, and it does exactly one thing.
 *
 * A `fetch` rather than a form submit — the CSP sets `form-action 'none'`,
 * and a JSON body is what the mutation guard requires anyway.
 */

const pw = document.getElementById('pw');
const msg = document.getElementById('msg');
const go = document.getElementById('go');

async function submit() {
  const password = pw.value;
  if (!password) {
    msg.textContent = 'Enter the password set in posi3’s Settings.';
    msg.className = 'hint warn-text';
    return;
  }
  go.disabled = true;
  msg.className = 'hint';
  msg.textContent = 'Checking…';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body && body.ok) {
      // `replace`, not `assign`: the back button must not return to a login
      // page that would now bounce straight forward again.
      window.location.replace('/');
      return;
    }
    msg.className = 'hint err-text';
    msg.textContent = (body && body.error && body.error.message) || 'That password was not accepted.';
  } catch (err) {
    msg.className = 'hint err-text';
    msg.textContent = `Could not reach posi3: ${err.message}`;
  } finally {
    go.disabled = false;
    pw.select();
  }
}

go.addEventListener('click', submit);
pw.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit(); });
