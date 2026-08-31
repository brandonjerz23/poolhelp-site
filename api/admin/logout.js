const { json, sessionCookie, handler } = require('../_lib');

module.exports = handler(async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  // The one state-changing route that does not need a session still needs the
  // CSRF header: without it any page could silently sign an admin out.
  if (req.headers['x-ph-admin'] !== '1') return json(res, 400, { error: 'bad_request' });
  // Max-Age=0 expires the cookie regardless of whether one was valid.
  return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', 0) });
});
