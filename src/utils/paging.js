'use strict';

/**
 * Offset paging over a list that is ordered by *groups* first — pinned chats
 * before the rest, online people before busy before offline — without ever
 * loading the whole list to sort it.
 *
 * Postgres can order by a column, not by "this enum in an order of my
 * choosing" or "whichever of these two per-side flags applies to the viewer",
 * which is why both of those lists used to be fetched in full and sorted in
 * JavaScript (Chats), or ordered in SQL by the enum's declaration order and
 * then re-sorted within each page (Home) — so page two could start with
 * somebody who belonged above the end of page one.
 *
 * Instead, each group is a *bucket*: its own `where`, queried with its own
 * `orderBy`. The list is the buckets laid end to end, and a page is a window
 * onto that concatenation — counted per bucket, then read only from the
 * buckets the window actually overlaps. Two or three cheap counts and at most
 * one or two short reads per page, however long the list is.
 *
 * Every `orderBy` handed in must end on a unique column (`id`), or two rows
 * that tie can swap places between two requests and one of them turns up on
 * both pages while the other is on neither.
 *
 * @param {object} delegate A Prisma model delegate — `prisma.conversation`.
 * @param {object} options
 * @param {{ where: object, orderBy: object[] }[]} options.buckets In display order.
 * @param {object} [options.include]
 * @param {number} options.skip
 * @param {number} options.take
 * @returns {Promise<{ rows: object[], total: number }>}
 */
async function pageAcrossBuckets(delegate, { buckets, include, skip, take }) {
  const counts = await Promise.all(buckets.map((b) => delegate.count({ where: b.where })));
  const total = counts.reduce((sum, n) => sum + n, 0);

  const reads = [];
  let offset = 0; // where this bucket starts in the concatenated list
  let remaining = take;
  let position = skip; // the next row the page still needs

  for (let i = 0; i < buckets.length && remaining > 0; i += 1) {
    const size = counts[i];
    const end = offset + size;
    if (position < end) {
      const localSkip = position - offset;
      const localTake = Math.min(remaining, size - localSkip);
      reads.push(
        delegate.findMany({
          where: buckets[i].where,
          orderBy: buckets[i].orderBy,
          include,
          skip: localSkip,
          take: localTake,
        })
      );
      remaining -= localTake;
      position += localTake;
    }
    offset = end;
  }

  const rows = (await Promise.all(reads)).flat();
  return { rows, total };
}

module.exports = { pageAcrossBuckets };
