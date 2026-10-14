// AES decryption in public/common/crypto.js (password-protected Office files), against Node's own AES and the
// FIPS 197 example vectors:  node --test tests/crypto.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../public/common/crypto.js');
const OC = globalThis.L.officeCrypto;
const hex = (s) => Uint8Array.from(s.match(/../g), (b) => parseInt(b, 16));

test('the FIPS 197 example vectors (Appendix C) decrypt to their plaintext', () => {
  const plain = hex('00112233445566778899aabbccddeeff');
  for (const [key, cipher] of [
    ['000102030405060708090a0b0c0d0e0f', '69c4e0d86a7b0430d8cdb78070b4c55a'],
    ['000102030405060708090a0b0c0d0e0f1011121314151617', 'dda97ca4864cdfe06eaf70a0ec0d7191'],
    ['000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', '8ea2b7ca516745bfeafc49904b496089'],
  ]) assert.deepEqual(OC.aesDecrypt(hex(key), hex(cipher), null), plain, `${key.length * 4}-bit key`);
});

test('whatever Node encrypts (ECB and CBC, 128, 192 and 256-bit keys) decrypts to the same bytes', () => {
  for (let round = 0; round < 40; round++) {
    const bits = [128, 192, 256][round % 3], key = crypto.randomBytes(bits / 8), data = crypto.randomBytes(16 * (1 + (round % 7)));
    const iv = round % 2 ? crypto.randomBytes(16) : null;
    const c = crypto.createCipheriv(`aes-${bits}-${iv ? 'cbc' : 'ecb'}`, key, iv);
    c.setAutoPadding(false);
    const enc = Buffer.concat([c.update(data), c.final()]);
    assert.deepEqual(Buffer.from(OC.aesDecrypt(new Uint8Array(key), new Uint8Array(enc), iv && new Uint8Array(iv))), data, `aes-${bits}-${iv ? 'cbc' : 'ecb'}`);
  }
});
