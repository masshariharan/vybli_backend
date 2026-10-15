'use strict';

/**
 * One phone number as a single comparable key: the country code's digits
 * followed by the last ten digits of the number — `919876543210`.
 *
 * The same number has been stored in more than one shape over time
 * (`09876543210`, `9876543210`, `+919876543210`), and a deleted account's
 * number is tombstoned as `deleted_<id>_<number>`. Comparing stored text
 * missed the same number across those shapes; this does not.
 */
function numberKeyOf(dialCode, phone) {
  const national = String(phone ?? '')
    .replace(/^deleted_[^_]*_/, '')
    .replace(/\D/g, '')
    .slice(-10);
  const country = String(dialCode ?? '').replace(/\D/g, '');
  return `${country}${national}`;
}

module.exports = { numberKeyOf };
