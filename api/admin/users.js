/** Paged, searchable user list. All filtering happens in Postgres. */

const { json, query, requireAdmin, rpc, handler } = require('../_lib');

const SORTS = new Set(['created_at', 'last_sign_in', 'last_sync', 'tests', 'email']);

module.exports = handler(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const q = query(req);

  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 25, 1), 200);
  const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
  const sort = SORTS.has(q.sort) ? q.sort : 'created_at';
  const search = typeof q.search === 'string' ? q.search.slice(0, 200) : null;

  const data = await rpc('admin_users', {
    p_search: search || null,
    p_limit: limit,
    p_offset: offset,
    p_sort: sort,
  });
  return json(res, 200, { ...data, limit, offset, sort });
});
