/*
 * BarcodeRender - dependency-free EAN-13 / EAN-8 / UPC-A / UPC-E renderer.
 * Works in Node (module.exports) and browsers (global BarcodeRender).
 *
 * encode(digits, symbology) -> number[] of modules (1 = bar). symbology: EAN_13|EAN_8|UPC_A|UPC_E.
 *   Digits include the check digit (EAN_13:13, EAN_8:8, UPC_A:12, UPC_E:8 = number system + 6 body + check;
 *   UPC_E also accepts 6 digits = body only, number system 0). Throws on bad length / non-digits.
 *   The check digit is not verified (so invalid codes can be drawn); use checkDigitOk().
 * toSVG(digits, symbology, {moduleWidth=2, height=80, quietZone=10, text=true}) -> string
 * toGray(digits, symbology, {moduleWidth=3, height=120, quietZone=10, blur=0, noise=0 (0..255 amplitude),
 *   contrast=1, rotateDeg=0, seed=1}) -> {width,height,data:Uint8ClampedArray}
 * toY4M(gray, {frames=10, width=640, height=480}) -> Buffer (I420, centered, nearest-neighbour upscaled)
 * CLI: node tools/barcode-render.js y4m|svg <digits> <symbology> <out> [frames]
 */
(function (root) {
  'use strict';
  var L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  var G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
  var R = L.map(function (s) { return s.replace(/[01]/g, function (c) { return c === '0' ? '1' : '0'; }); });
  var EAN13_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
  var UPCE_PARITY0 = ['GGGLLL', 'GGLGLL', 'GGLLGL', 'GGLLLG', 'GLGGLL', 'GLLGGL', 'GLLLGG', 'GLGLGL', 'GLGLLG', 'GLLGLG'];
  var LENGTHS = { EAN_13: 13, EAN_8: 8, UPC_A: 12, UPC_E: 8 };

  function bits(s) { return s.split('').map(Number); }
  function pat(d, kind) { return kind === 'L' ? L[d] : kind === 'G' ? G[d] : R[d]; }

  function encode(digits, symbology) {
    digits = String(digits);
    if (!LENGTHS[symbology]) throw new Error('Unknown symbology: ' + symbology);
    if (!/^\d+$/.test(digits)) throw new Error('Digits only');
    if (symbology === 'UPC_E' && digits.length === 6) digits = '0' + digits + '0';
    if (digits.length !== LENGTHS[symbology]) throw new Error(symbology + ' needs ' + LENGTHS[symbology] + ' digits');
    var d = digits.split('').map(Number), s = '';
    var i;
    if (symbology === 'UPC_A') { d.unshift(0); symbology = 'EAN_13'; }
    if (symbology === 'EAN_13') {
      var par = EAN13_PARITY[d[0]];
      s = '101';
      for (i = 0; i < 6; i++) s += pat(d[1 + i], par[i]);
      s += '01010';
      for (i = 7; i < 13; i++) s += pat(d[i], 'R');
      s += '101';
    } else if (symbology === 'EAN_8') {
      s = '101';
      for (i = 0; i < 4; i++) s += pat(d[i], 'L');
      s += '01010';
      for (i = 4; i < 8; i++) s += pat(d[i], 'R');
      s += '101';
    } else {
      if (d[0] > 1) throw new Error('UPC_E number system must be 0 or 1');
      var p = UPCE_PARITY0[d[7]];
      if (d[0] === 1) p = p.replace(/[LG]/g, function (c) { return c === 'L' ? 'G' : 'L'; });
      s = '101';
      for (i = 0; i < 6; i++) s += pat(d[1 + i], p[i]);
      s += '010101';
    }
    return bits(s);
  }

  function upceExpand(d8) {
    var b = d8.slice(1, 7), ns = d8[0], l = b[5], m;
    if (l <= 2) m = b[0] + b[1] + l + '0000' + b[2] + b[3] + b[4];
    else if (l === '3') m = b[0] + b[1] + b[2] + '00000' + b[3] + b[4];
    else if (l === '4') m = b[0] + b[1] + b[2] + b[3] + '00000' + b[4];
    else m = b.slice(0, 5) + '0000' + l;
    return ns + m;
  }
  function checkSum(body) { // body without check digit, length n; weights 3,1 from the right
    var sum = 0;
    for (var i = body.length - 1, w = 3; i >= 0; i--, w = 4 - w) sum += +body[i] * w;
    return (10 - sum % 10) % 10;
  }
  function checkDigitOk(digits, symbology) {
    digits = String(digits);
    if (symbology === 'UPC_E') {
      if (digits.length === 6) digits = '0' + digits + '0';
      var full = upceExpand(digits);
      return checkSum(full) === +digits[7];
    }
    return checkSum(digits.slice(0, -1)) === +digits[digits.length - 1];
  }

  function toSVG(digits, symbology, opts) {
    opts = opts || {};
    var mw = opts.moduleWidth || 2, h = opts.height || 80, q = opts.quietZone == null ? 10 : opts.quietZone;
    var m = encode(digits, symbology), w = (m.length + 2 * q) * mw, path = '', i = 0;
    while (i < m.length) {
      if (m[i]) {
        var j = i; while (j < m.length && m[j]) j++;
        path += 'M' + (q + i) * mw + ' 0h' + (j - i) * mw + 'v' + h + 'h-' + (j - i) * mw + 'z';
        i = j;
      } else i++;
    }
    var th = opts.text === false ? 0 : 14;
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + (h + th) + '" viewBox="0 0 ' + w + ' ' + (h + th) +
      '"><rect width="100%" height="100%" fill="#fff"/><path d="' + path + '" fill="#000"/>' +
      (th ? '<text x="' + w / 2 + '" y="' + (h + 11) + '" font-family="monospace" font-size="11" text-anchor="middle">' + digits + '</text>' : '') + '</svg>';
  }

  function prng(seed) {
    var a = (seed || 1) >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function boxBlur(data, w, h, r) {
    var tmp = new Float32Array(w * h), out = new Uint8ClampedArray(w * h), x, y, k, s, n;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      s = 0; n = 0;
      for (k = -r; k <= r; k++) if (x + k >= 0 && x + k < w) { s += data[y * w + x + k]; n++; }
      tmp[y * w + x] = s / n;
    }
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      s = 0; n = 0;
      for (k = -r; k <= r; k++) if (y + k >= 0 && y + k < h) { s += tmp[(y + k) * w + x]; n++; }
      out[y * w + x] = s / n;
    }
    return out;
  }

  function rotate(data, w, h, deg) {
    var rad = deg * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
    var nw = Math.ceil(Math.abs(w * c) + Math.abs(h * s)), nh = Math.ceil(Math.abs(w * s) + Math.abs(h * c));
    var out = new Uint8ClampedArray(nw * nh).fill(255), x, y;
    for (y = 0; y < nh; y++) for (x = 0; x < nw; x++) {
      var dx = x - nw / 2, dy = y - nh / 2;
      var sx = c * dx + s * dy + w / 2 - 0.5, sy = -s * dx + c * dy + h / 2 - 0.5;
      if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) continue;
      var x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      var x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
      out[y * nw + x] = data[y0 * w + x0] * (1 - fx) * (1 - fy) + data[y0 * w + x1] * fx * (1 - fy) +
        data[y1 * w + x0] * (1 - fx) * fy + data[y1 * w + x1] * fx * fy;
    }
    return { width: nw, height: nh, data: out };
  }

  function toGray(digits, symbology, opts) {
    opts = opts || {};
    var mw = opts.moduleWidth || 3, bh = opts.height || 120, q = opts.quietZone == null ? 10 : opts.quietZone;
    var m = encode(digits, symbology), w = (m.length + 2 * q) * mw, h = bh + 2 * q * mw;
    var data = new Uint8ClampedArray(w * h).fill(255), x, y;
    for (x = 0; x < m.length * mw; x++) {
      if (!m[Math.floor(x / mw)]) continue;
      for (y = q * mw; y < q * mw + bh; y++) data[y * w + q * mw + x] = 0;
    }
    var res = { width: w, height: h, data: data };
    if (opts.rotateDeg) res = rotate(res.data, w, h, opts.rotateDeg);
    if (opts.blur) res.data = boxBlur(res.data, res.width, res.height, Math.round(opts.blur));
    var contrast = opts.contrast == null ? 1 : opts.contrast, i;
    if (contrast !== 1) for (i = 0; i < res.data.length; i++) res.data[i] = 128 + (res.data[i] - 128) * contrast;
    if (opts.noise) {
      var rnd = prng(opts.seed);
      for (i = 0; i < res.data.length; i++) res.data[i] += (rnd() * 2 - 1) * opts.noise;
    }
    return res;
  }

  function toY4M(gray, opts) {
    opts = opts || {};
    var W = opts.width || 640, H = opts.height || 480, frames = opts.frames || 10;
    var scale = Math.max(1, Math.floor(Math.min(W * 0.8 / gray.width, H * 0.8 / gray.height)));
    if (gray.width * scale > W || gray.height * scale > H) scale = Math.min(W / gray.width, H / gray.height);
    var sw = Math.floor(gray.width * scale), sh = Math.floor(gray.height * scale);
    var ox = Math.floor((W - sw) / 2), oy = Math.floor((H - sh) / 2);
    var Y = Buffer.alloc(W * H, 255), x, y;
    for (y = 0; y < sh; y++) for (x = 0; x < sw; x++)
      Y[(oy + y) * W + ox + x] = gray.data[Math.min(gray.height - 1, Math.floor(y / scale)) * gray.width + Math.min(gray.width - 1, Math.floor(x / scale))];
    var cs = (W >> 1) * (H >> 1), header = Buffer.from('YUV4MPEG2 W' + W + ' H' + H + ' F30:1 Ip A1:1 C420jpeg\n');
    var frame = Buffer.concat([Buffer.from('FRAME\n'), Y, Buffer.alloc(cs, 128), Buffer.alloc(cs, 128)]);
    var parts = [header];
    for (var f = 0; f < frames; f++) parts.push(frame);
    return Buffer.concat(parts);
  }

  var api = { encode: encode, toSVG: toSVG, toGray: toGray, toY4M: toY4M, checkDigitOk: checkDigitOk, prng: prng };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BarcodeRender = api;

  if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
    var a = process.argv.slice(2), fs = require('fs');
    if (a.length < 4 || (a[0] !== 'y4m' && a[0] !== 'svg')) {
      console.error('usage: barcode-render.js y4m|svg <digits> <symbology> <out> [frames]'); process.exit(2);
    }
    if (a[0] === 'svg') fs.writeFileSync(a[3], toSVG(a[1], a[2]));
    else fs.writeFileSync(a[3], toY4M(toGray(a[1], a[2]), { frames: +a[4] || 10 }));
  }
})(typeof self !== 'undefined' ? self : this);
