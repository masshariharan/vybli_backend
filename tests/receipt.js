'use strict';

// Delivery receipts: what a push carries so the phone can ack the second tick
// without a sign-in. Pure — no database, no server.
const assert = require('node:assert/strict');
const receipt = require('../src/utils/deliveryReceipt');

const SECRET = 'test-secret';
const good = receipt.sign('user_1', 'msg_1', SECRET);

assert.equal(receipt.verify('user_1', 'msg_1', good, SECRET), true, 'its own receipt verifies');
assert.equal(receipt.verify('user_1', 'msg_2', good, SECRET), false, 'not onto another message');
assert.equal(receipt.verify('user_2', 'msg_1', good, SECRET), false, 'not for another recipient');
assert.equal(receipt.verify('user_1', 'msg_1', good, 'other-secret'), false, 'not under another key');
assert.equal(receipt.verify('user_1', 'msg_1', good.slice(0, -1), SECRET), false, 'not truncated');
assert.equal(receipt.verify('user_1', 'msg_1', undefined, SECRET), false, 'not missing');
assert.equal(receipt.verify('', 'msg_1', good, SECRET), false, 'not without a recipient');

console.log('receipt: ok');
