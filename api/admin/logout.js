const { json, sessionCookie, handler } = require('../_lib');

module.exports = handler(async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  // Max-Age=0 expires the cookie regardless of whether one was valid.
  return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', 0) });
});
