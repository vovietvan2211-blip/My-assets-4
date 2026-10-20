/* Tiny QR code generator (byte mode, error correction M, versions 1-10).
   No dependencies, works offline. Usage:
     const svg = NovaQR.toSvg("https://example.com", { dark: "#000", light: "#fff", margin: 4 });
     const matrix = NovaQR.encode("text"); // array of arrays of booleans */
(function (root) {
  "use strict";

  // Level M tables, index = version (1..10)
  var ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
  var NUM_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
  var MAX_VERSION = 10;

  /* ---------- Reed-Solomon over GF(256), poly 0x11D ---------- */
  var EXP = new Array(512);
  var LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gfMul(a, b) {
    return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
  }

  function rsDivisor(degree) {
    var result = [];
    for (var i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    var root = 1;
    for (var k = 0; k < degree; k++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 2);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ result.shift();
      result.push(0);
      divisor.forEach(function (coef, i) {
        result[i] ^= gfMul(coef, factor);
      });
    });
    return result;
  }

  /* ---------- Capacity helpers ---------- */
  function rawModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  function dataCodewords(ver) {
    return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];
  }

  function alignPositions(ver) {
    if (ver === 1) return [];
    var numAlign = Math.floor(ver / 7) + 2;
    var size = ver * 4 + 17;
    var step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    var result = [6];
    for (var pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  /* ---------- Bit buffer ---------- */
  function utf8Bytes(str) {
    if (typeof TextEncoder !== "undefined") return Array.prototype.slice.call(new TextEncoder().encode(str));
    var s = unescape(encodeURIComponent(str));
    var out = [];
    for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }

  function appendBits(bits, value, len) {
    for (var i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  }

  /* ---------- Build data codewords ---------- */
  function buildCodewords(bytes, ver) {
    var bits = [];
    appendBits(bits, 4, 4); // byte mode
    appendBits(bits, bytes.length, ver < 10 ? 8 : 16);
    bytes.forEach(function (b) { appendBits(bits, b, 8); });

    var capBits = dataCodewords(ver) * 8;
    appendBits(bits, 0, Math.min(4, capBits - bits.length));
    appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
    for (var pad = 0xec; bits.length < capBits; pad ^= 0xec ^ 0x11) appendBits(bits, pad, 8);

    var data = [];
    for (var i = 0; i < bits.length; i += 8) {
      var v = 0;
      for (var j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      data.push(v);
    }
    return data;
  }

  function addEccAndInterleave(data, ver) {
    var nBlocks = NUM_BLOCKS[ver];
    var eccLen = ECC_PER_BLOCK[ver];
    var rawCw = Math.floor(rawModules(ver) / 8);
    var numShort = nBlocks - (rawCw % nBlocks);
    var shortLen = Math.floor(rawCw / nBlocks);
    var blocks = [];
    var divisor = rsDivisor(eccLen);
    for (var i = 0, k = 0; i < nBlocks; i++) {
      var datLen = shortLen - eccLen + (i < numShort ? 0 : 1);
      var dat = data.slice(k, k + datLen);
      k += datLen;
      var ecc = rsRemainder(dat, divisor);
      if (i < numShort) dat.push(0); // placeholder so all blocks line up
      blocks.push(dat.concat(ecc));
    }
    var result = [];
    for (var col = 0; col < blocks[0].length; col++) {
      for (var b = 0; b < blocks.length; b++) {
        if (col !== shortLen - eccLen || b >= numShort) result.push(blocks[b][col]);
      }
    }
    return result;
  }

  /* ---------- Matrix drawing ---------- */
  function makeMatrix(size) {
    var m = [], f = [];
    for (var i = 0; i < size; i++) {
      m.push(new Array(size).fill(false));
      f.push(new Array(size).fill(false));
    }
    return { m: m, f: f, size: size };
  }

  function setFn(q, x, y, dark) {
    q.m[y][x] = dark;
    q.f[y][x] = true;
  }

  function drawFinder(q, cx, cy) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        var x = cx + dx, y = cy + dy;
        if (x >= 0 && x < q.size && y >= 0 && y < q.size) setFn(q, x, y, dist !== 2 && dist !== 4);
      }
    }
  }

  function drawAlign(q, cx, cy) {
    for (var dy = -2; dy <= 2; dy++) {
      for (var dx = -2; dx <= 2; dx++) setFn(q, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  function bchFormat(data) {
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }

  function bchVersion(ver) {
    var rem = ver;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    return (ver << 12) | rem;
  }

  function drawFormat(q, mask) {
    var bits = bchFormat((0 << 3) | mask); // ECC level M = 00
    var size = q.size;
    function bit(i) { return ((bits >>> i) & 1) !== 0; }
    for (var i = 0; i <= 5; i++) setFn(q, 8, i, bit(i));
    setFn(q, 8, 7, bit(6));
    setFn(q, 8, 8, bit(7));
    setFn(q, 7, 8, bit(8));
    for (var j = 9; j < 15; j++) setFn(q, 14 - j, 8, bit(j));
    for (var k = 0; k < 8; k++) setFn(q, size - 1 - k, 8, bit(k));
    for (var l = 8; l < 15; l++) setFn(q, 8, size - 15 + l, bit(l));
    setFn(q, 8, size - 8, true);
  }

  function drawFunctionPatterns(q, ver) {
    var size = q.size;
    for (var i = 0; i < size; i++) {
      setFn(q, 6, i, i % 2 === 0);
      setFn(q, i, 6, i % 2 === 0);
    }
    drawFinder(q, 3, 3);
    drawFinder(q, size - 4, 3);
    drawFinder(q, 3, size - 4);
    var pos = alignPositions(ver);
    var n = pos.length;
    for (var a = 0; a < n; a++) {
      for (var b = 0; b < n; b++) {
        if ((a === 0 && b === 0) || (a === 0 && b === n - 1) || (a === n - 1 && b === 0)) continue;
        drawAlign(q, pos[a], pos[b]);
      }
    }
    drawFormat(q, 0);
    if (ver >= 7) {
      var bits = bchVersion(ver);
      for (var v = 0; v < 18; v++) {
        var dark = ((bits >>> v) & 1) !== 0;
        var x = size - 11 + (v % 3);
        var y = Math.floor(v / 3);
        setFn(q, x, y, dark);
        setFn(q, y, x, dark);
      }
    }
  }

  function drawCodewords(q, cw) {
    var size = q.size;
    var i = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (!q.f[y][x] && i < cw.length * 8) {
            q.m[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  function applyMask(q, mask) {
    for (var y = 0; y < q.size; y++) {
      for (var x = 0; x < q.size; x++) {
        var inv;
        switch (mask) {
          case 0: inv = (x + y) % 2 === 0; break;
          case 1: inv = y % 2 === 0; break;
          case 2: inv = x % 3 === 0; break;
          case 3: inv = (x + y) % 3 === 0; break;
          case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: inv = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: inv = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        }
        if (!q.f[y][x] && inv) q.m[y][x] = !q.m[y][x];
      }
    }
  }

  function penalty(q) {
    var size = q.size, m = q.m, result = 0, x, y, run, i;
    function scoreLine(get) {
      var s = 0, runColor = false, runLen = 0;
      var hist = [0, 0, 0, 0, 0, 0, 0];
      function addHist(len) {
        if (hist[0] === 0) len += size;
        hist.pop();
        hist.unshift(len);
      }
      function countPatterns() {
        var n = hist[1];
        var core = n > 0 && hist[2] === n && hist[3] === n * 3 && hist[4] === n && hist[5] === n;
        return (core && hist[0] >= n * 4 && hist[6] >= n ? 1 : 0) + (core && hist[6] >= n * 4 && hist[0] >= n ? 1 : 0);
      }
      for (var k = 0; k < size; k++) {
        if (get(k) === runColor) {
          runLen++;
          if (runLen === 5) s += 3;
          else if (runLen > 5) s++;
        } else {
          addHist(runLen);
          if (!runColor) s += countPatterns() * 40;
          runColor = get(k);
          runLen = 1;
        }
      }
      // terminate
      addHist(runLen);
      if (runColor) { addHist(0); runLen = 0; }
      addHist(size);
      s += countPatterns() * 40;
      return s;
    }
    for (y = 0; y < size; y++) result += scoreLine(function (k) { return m[y][k]; });
    for (x = 0; x < size; x++) result += scoreLine(function (k) { return m[k][x]; });
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        var c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += 3;
      }
    }
    var dark = 0;
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (m[y][x]) dark++;
    var total = size * size;
    var k2 = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k2 * 10;
    void run; void i;
    return result;
  }

  /* ---------- Public API ---------- */
  function encode(text) {
    var bytes = utf8Bytes(String(text));
    var ver = 1;
    for (; ver <= MAX_VERSION; ver++) {
      var lenBits = ver < 10 ? 8 : 16;
      if (4 + lenBits + bytes.length * 8 <= dataCodewords(ver) * 8) break;
    }
    if (ver > MAX_VERSION) throw new Error("Text is too long for this QR generator");

    var cw = addEccAndInterleave(buildCodewords(bytes, ver), ver);
    var size = ver * 4 + 17;
    var q = makeMatrix(size);
    drawFunctionPatterns(q, ver);
    drawCodewords(q, cw);

    var bestMask = 0, bestScore = Infinity, best = null;
    for (var mask = 0; mask < 8; mask++) {
      applyMask(q, mask);
      drawFormat(q, mask);
      var score = penalty(q);
      if (score < bestScore) {
        bestScore = score;
        bestMask = mask;
        best = q.m.map(function (row) { return row.slice(); });
      }
      applyMask(q, mask); // undo
    }
    void bestMask;
    return best;
  }

  function toSvg(text, opts) {
    opts = opts || {};
    var margin = opts.margin == null ? 4 : opts.margin;
    var dark = opts.dark || "#000000";
    var light = opts.light || "#ffffff";
    var m = encode(text);
    var n = m.length + margin * 2;
    var d = [];
    for (var y = 0; y < m.length; y++) {
      for (var x = 0; x < m.length; x++) {
        if (m[y][x]) d.push("M" + (x + margin) + "," + (y + margin) + "h1v1h-1z");
      }
    }
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + " " + n +
      '" shape-rendering="crispEdges" role="img" aria-label="QR code to join the room">' +
      '<rect width="100%" height="100%" fill="' + light + '"/>' +
      '<path d="' + d.join("") + '" fill="' + dark + '"/></svg>'
    );
  }

  root.NovaQR = { encode: encode, toSvg: toSvg };
  if (typeof module !== "undefined" && module.exports) module.exports = root.NovaQR;
})(typeof window !== "undefined" ? window : globalThis);
