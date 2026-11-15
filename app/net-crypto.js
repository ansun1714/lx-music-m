/* 纯 JS 加密工具（v3.6.0）
 * 网易搜索需要 AES-128-ECB(eapi)，QQ 搜索需要 zzcSign（SHA1 取位 + XOR + base64）。
 * WebView 里没有 node:crypto，这里给出与 lxserver 完全一致的纯 JS 实现。
 * 只做加密，不做解密——搜索只需要发请求。
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- 字节工具
  function utf8Bytes(str) {
    var s = String(str), out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var c2 = s.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
            0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
          i++;
        } else out.push(0xef, 0xbf, 0xbd);
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return out;
  }

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function bytesToBase64(bytes) {
    var out = '', i, n;
    for (i = 0; i + 2 < bytes.length; i += 3) {
      n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    var rest = bytes.length - i;
    if (rest === 1) {
      n = bytes[i] << 16;
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==';
    } else if (rest === 2) {
      n = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
    }
    return out;
  }

  function hex8(n) {
    return ('00000000' + (n >>> 0).toString(16)).slice(-8);
  }
  /* MD5 的状态字按小端字节序输出，直接用 hex8 会得到「word 反序」的错误结果 */
  function hex8le(n) {
    var s = '';
    for (var i = 0; i < 4; i++) s += ('0' + ((n >>> (i * 8)) & 0xff).toString(16)).slice(-2);
    return s;
  }
  function bytesToHex(bytes, upper) {
    var s = '', i;
    for (i = 0; i < bytes.length; i++) s += ('0' + bytes[i].toString(16)).slice(-2);
    return upper ? s.toUpperCase() : s;
  }

  // ---------------------------------------------------------------- MD5
  /* 与 source-api.js 的 md5 同源实现；这里单独一份，供平台层直接用 */
  var MD5_K = [], MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  for (var mi = 0; mi < 64; mi++) MD5_K[mi] = Math.floor(Math.abs(Math.sin(mi + 1)) * 4294967296) | 0;

  function md5(str) {
    var bytes = utf8Bytes(str), len = bytes.length;
    var words = [], i;
    for (i = 0; i < len; i++) words[i >> 2] = (words[i >> 2] | 0) | (bytes[i] << ((i % 4) * 8));
    words[len >> 2] = (words[len >> 2] | 0) | (0x80 << ((len % 4) * 8));
    var total = (((len + 8) >> 6) + 1) * 16;
    while (words.length < total) words.push(0);
    words[total - 2] = (len * 8) | 0;
    words[total - 1] = Math.floor(len / 536870912) | 0;

    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (var off = 0; off < words.length; off += 16) {
      var A = a0, B = b0, C = c0, D = d0, f, g, tmp;
      for (i = 0; i < 64; i++) {
        if (i < 16) { f = (B & C) | (~B & D); g = i; }
        else if (i < 32) { f = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { f = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { f = C ^ (B | ~D); g = (7 * i) % 16; }
        tmp = D; D = C; C = B;
        var sum = (A + f + MD5_K[i] + (words[off + g] | 0)) | 0;
        var sh = MD5_S[(i >> 4) * 4 + (i % 4)];
        B = (B + ((sum << sh) | (sum >>> (32 - sh)))) | 0;
        A = tmp;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    return hex8le(a0) + hex8le(b0) + hex8le(c0) + hex8le(d0);
  }

  // ---------------------------------------------------------------- SHA-1
  function sha1(str) {
    var bytes = utf8Bytes(str), len = bytes.length;
    var words = [], i;
    for (i = 0; i < len; i++) words[i >> 2] = (words[i >> 2] | 0) | (bytes[i] << (24 - (i % 4) * 8));
    words[len >> 2] = (words[len >> 2] | 0) | (0x80 << (24 - (len % 4) * 8));
    var total = (((len + 8) >> 6) + 1) * 16;
    while (words.length < total) words.push(0);
    words[total - 1] = len * 8;

    var H = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
    for (var off = 0; off < words.length; off += 16) {
      var w = [];
      for (i = 0; i < 16; i++) w[i] = words[off + i] | 0;
      for (i = 16; i < 80; i++) {
        var x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
        w[i] = (x << 1) | (x >>> 31);
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f, k;
      for (i = 0; i < 80; i++) {
        if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
        else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
        else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
        else { f = b ^ c ^ d; k = 0xca62c1d6; }
        var t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
        e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0;
      H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0;
    }
    return H.map(function (n) { return hex8(n); }).join('');
  }

  // ---------------------------------------------------------------- AES-128-ECB
  var SBOX = [
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
    0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
    0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
    0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
    0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
    0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
    0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
  ];
  var RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

  function xtime(x) { return ((x << 1) ^ ((x & 0x80) ? 0x1b : 0)) & 0xff; }
  function gmul(a, b) {
    var r = 0;
    while (b) {
      if (b & 1) r ^= a;
      a = xtime(a);
      b >>= 1;
    }
    return r & 0xff;
  }

  function expandKey(key) {
    var w = [], i;
    for (i = 0; i < 4; i++) w.push([key[i * 4], key[i * 4 + 1], key[i * 4 + 2], key[i * 4 + 3]]);
    for (i = 4; i < 44; i++) {
      var t = w[i - 1].slice();
      if (i % 4 === 0) {
        t.push(t.shift());
        for (var j = 0; j < 4; j++) t[j] = SBOX[t[j]];
        t[0] ^= RCON[(i / 4) - 1];
      }
      w.push([w[i - 4][0] ^ t[0], w[i - 4][1] ^ t[1], w[i - 4][2] ^ t[2], w[i - 4][3] ^ t[3]]);
    }
    return w;
  }

  function encryptBlock(input, w) {
    var s = [], c, r;
    for (c = 0; c < 4; c++) s.push([input[c * 4], input[c * 4 + 1], input[c * 4 + 2], input[c * 4 + 3]]);
    for (c = 0; c < 4; c++) for (r = 0; r < 4; r++) s[c][r] ^= w[c][r];
    for (var round = 1; round <= 10; round++) {
      for (c = 0; c < 4; c++) for (r = 0; r < 4; r++) s[c][r] = SBOX[s[c][r]];
      for (r = 1; r < 4; r++) {
        var row = [s[0][r], s[1][r], s[2][r], s[3][r]];
        for (c = 0; c < 4; c++) s[c][r] = row[(c + r) % 4];
      }
      if (round !== 10) {
        for (c = 0; c < 4; c++) {
          var a0 = s[c][0], a1 = s[c][1], a2 = s[c][2], a3 = s[c][3];
          s[c][0] = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3;
          s[c][1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3;
          s[c][2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3);
          s[c][3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2);
        }
      }
      for (c = 0; c < 4; c++) for (r = 0; r < 4; r++) s[c][r] ^= w[round * 4 + c][r];
    }
    var out = [];
    for (c = 0; c < 4; c++) out.push(s[c][0], s[c][1], s[c][2], s[c][3]);
    return out;
  }

  /* AES-128-ECB + PKCS7，返回大写 hex（网易 eapi 需要这种格式） */
  function aesEcbHex(text, keyText) {
    var key = utf8Bytes(keyText);
    if (key.length !== 16) throw new Error('AES-128 需要 16 字节密钥');
    var data = utf8Bytes(text), pad = 16 - (data.length % 16), i;
    for (i = 0; i < pad; i++) data.push(pad);
    var w = expandKey(key), out = [];
    for (i = 0; i < data.length; i += 16) {
      out = out.concat(encryptBlock(data.slice(i, i + 16), w));
    }
    return bytesToHex(out, true);
  }

  // ---------------------------------------------------------------- QQ zzcSign
  var PART_1 = [23, 14, 6, 36, 16, 40, 7, 19];
  var PART_2 = [16, 1, 32, 12, 19, 27, 8, 5];
  var SCRAMBLE = [89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64,
    242, 133, 143, 161, 121, 179];

  function zzcSign(text) {
    var hash = sha1(text);
    var part1 = PART_1.map(function (i) { return hash[i]; }).join('');
    var part2 = PART_2.map(function (i) { return hash[i]; }).join('');
    var bytes = SCRAMBLE.map(function (v, i) {
      return v ^ parseInt(hash.slice(i * 2, i * 2 + 2), 16);
    });
    // 与 lxserver 一致：base64 后去掉 / + =（base64 不会产出反斜杠）
    var b64 = bytesToBase64(bytes).replace(/[\/+=]/g, '');
    return ('zzc' + part1 + b64 + part2).toLowerCase();
  }

  window.LXNetCrypto = {
    sha1: sha1,
    md5: md5,
    aesEcbHex: aesEcbHex,
    zzcSign: zzcSign,
    bytesToBase64: bytesToBase64,
    utf8Bytes: utf8Bytes
  };
})();
