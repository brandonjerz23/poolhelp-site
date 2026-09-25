const { json, requireAdmin, handler } = require('../_lib');

/** Cheap "am I still signed in?" probe so the UI can restore or bounce. */
module.exports = handler(async (req, res) => {
  const session = requireAdmin(req, res);
  if (!session) return;
  return json(res, 200, {
    email: session.email,
    expiresAt: session.exp ? session.exp * 1000 : null,
    readOnly: Boolean(session.readOnly),
  });
});
