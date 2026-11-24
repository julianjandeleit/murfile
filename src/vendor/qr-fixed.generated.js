// node_modules/@blockchaincommons/multipart-ur/src/error.ts
var MUR_ERROR_CODES = Object.freeze([
  "QrEncode",
  "ImageEncode",
  "SvgRender",
  "InvalidColor",
  "InvalidParameter",
  "GifEncode",
  "FfmpegNotFound",
  "FfmpegFailed",
  "QrCodeTooDense",
  "InsufficientFrames",
  "Io",
  "Ur"
]);
var MurError = class _MurError extends Error {
  /** Always `"MurError"`. */
  name = "MurError";
  /** The reference's variant name; switch on this to handle errors. */
  code;
  /** The variant's fields (see {@link MurErrorDetailsByCode}); frozen. */
  details;
  constructor(code, message, details, cause) {
    super(message, cause === void 0 ? void 0 : { cause });
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
  /** Type guard: is `value` a `MurError` (from any copy of this package)? Narrows to {@link MurErrorTyped}. */
  static isMurError(value) {
    return value instanceof Error && value.name === "MurError" && "code" in value;
  }
  /** Whether this error has `code`; narrows `details` to that code's fields. */
  is(code) {
    return this.code === code;
  }
  /** `QrEncode`: the QR encoder rejected the message (too long for version 40 at this level). */
  static qrEncode(message, cause) {
    return new _MurError(
      "QrEncode",
      `QR encoding failed: ${message}`,
      { message },
      cause
    );
  }
  /** `ImageEncode`: PNG/JPEG encoding or logo decoding failed. */
  static imageEncode(message, cause) {
    return new _MurError(
      "ImageEncode",
      `Image encoding failed: ${message}`,
      { message },
      cause
    );
  }
  /** `SvgRender`: the SVG could not be parsed or rasterised. */
  static svgRender(message, cause) {
    return new _MurError(
      "SvgRender",
      `SVG rendering failed: ${message}`,
      { message },
      cause
    );
  }
  /** `InvalidColor`: a hex string or channel value is not a colour. */
  static invalidColor(message) {
    return new _MurError("InvalidColor", `Invalid color: ${message}`, {
      message
    });
  }
  /** `InvalidParameter`: an argument is outside its domain. */
  static invalidParameter(message) {
    return new _MurError("InvalidParameter", `Invalid parameter: ${message}`, {
      message
    });
  }
  /** `GifEncode`: the GIF encoder failed. */
  static gifEncode(message, cause) {
    return new _MurError(
      "GifEncode",
      `GIF encoding failed: ${message}`,
      { message },
      cause
    );
  }
  /** `FfmpegNotFound`: no `ffmpeg` on `PATH`. */
  static ffmpegNotFound() {
    return new _MurError(
      "FfmpegNotFound",
      "ffmpeg not found on PATH \u2014 install ffmpeg for ProRes output",
      {}
    );
  }
  /** `FfmpegFailed`: `ffmpeg` could not be started or exited with a failure status. */
  static ffmpegFailed(message, options = {}) {
    const details = options.stderr === void 0 ? { message } : { message, stderr: options.stderr };
    return new _MurError(
      "FfmpegFailed",
      `ffmpeg failed: ${message}`,
      details,
      options.cause
    );
  }
  /** `QrCodeTooDense`: the symbol has more modules than the limit allows. */
  static qrCodeTooDense(moduleCount, maxModules) {
    return new _MurError(
      "QrCodeTooDense",
      `QR code too dense: ${moduleCount} modules exceeds limit of ${maxModules} (reduce data size, lower error correction, or increase --max-modules)`,
      { moduleCount, maxModules }
    );
  }
  /** `InsufficientFrames`: fewer frames than the message has fragments. */
  static insufficientFrames(requested, fragments) {
    return new _MurError(
      "InsufficientFrames",
      `insufficient frames: ${requested} requested but message requires at least ${fragments} fragments`,
      { requested, fragments }
    );
  }
  /** `Io`: a file could not be read, written or created. */
  static io(message, options = {}) {
    const details = options.path === void 0 ? { message } : { message, path: options.path };
    return new _MurError(
      "Io",
      `IO error: ${message}`,
      details,
      options.cause
    );
  }
  /** `Ur`: `uniform-resources` rejected the UR or the fragment length. */
  static ur(message, cause) {
    return new _MurError("Ur", `UR error: ${message}`, { message }, cause);
  }
};

// node_modules/@blockchaincommons/multipart-ur/src/qr/types.ts
var QrFailure = class extends Error {
  kind;
  constructor(kind) {
    super(kind);
    this.name = "QrFailure";
    this.kind = kind;
  }
};
var Mode = {
  Numeric: 0,
  Alphanumeric: 1,
  Byte: 2,
  Kanji: 3
};
function versionWidth(version) {
  return version * 4 + 17;
}
function lengthBitsCount(mode, version) {
  if (version <= 9) {
    switch (mode) {
      case Mode.Numeric:
        return 10;
      case Mode.Alphanumeric:
        return 9;
      case Mode.Byte:
      case Mode.Kanji:
        return 8;
    }
  }
  if (version <= 26) {
    switch (mode) {
      case Mode.Numeric:
        return 12;
      case Mode.Alphanumeric:
        return 11;
      case Mode.Byte:
        return 16;
      case Mode.Kanji:
        return 10;
    }
  }
  switch (mode) {
    case Mode.Numeric:
      return 14;
    case Mode.Alphanumeric:
      return 13;
    case Mode.Byte:
      return 16;
    case Mode.Kanji:
      return 12;
  }
}
function dataBitsCount(mode, rawDataLen) {
  switch (mode) {
    case Mode.Numeric:
      return Math.floor((rawDataLen * 10 + 2) / 3);
    case Mode.Alphanumeric:
      return Math.floor((rawDataLen * 11 + 1) / 2);
    case Mode.Byte:
      return rawDataLen * 8;
    case Mode.Kanji:
      return rawDataLen * 13;
  }
}
function modeMax(a, b) {
  if (a === b) return a;
  if (a === Mode.Numeric && b === Mode.Alphanumeric || b === Mode.Byte) return b;
  if (a === Mode.Alphanumeric && b === Mode.Numeric || a === Mode.Byte) return a;
  return Mode.Byte;
}
var DATA_LENGTHS = [
  [152, 128, 104, 72],
  [272, 224, 176, 128],
  [440, 352, 272, 208],
  [640, 512, 384, 288],
  [864, 688, 496, 368],
  [1088, 864, 608, 480],
  [1248, 992, 704, 528],
  [1552, 1232, 880, 688],
  [1856, 1456, 1056, 800],
  [2192, 1728, 1232, 976],
  [2592, 2032, 1440, 1120],
  [2960, 2320, 1648, 1264],
  [3424, 2672, 1952, 1440],
  [3688, 2920, 2088, 1576],
  [4184, 3320, 2360, 1784],
  [4712, 3624, 2600, 2024],
  [5176, 4056, 2936, 2264],
  [5768, 4504, 3176, 2504],
  [6360, 5016, 3560, 2728],
  [6888, 5352, 3880, 3080],
  [7456, 5712, 4096, 3248],
  [8048, 6256, 4544, 3536],
  [8752, 6880, 4912, 3712],
  [9392, 7312, 5312, 4112],
  [10208, 8e3, 5744, 4304],
  [10960, 8496, 6032, 4768],
  [11744, 9024, 6464, 5024],
  [12248, 9544, 6968, 5288],
  [13048, 10136, 7288, 5608],
  [13880, 10984, 7880, 5960],
  [14744, 11640, 8264, 6344],
  [15640, 12328, 8920, 6760],
  [16568, 13048, 9368, 7208],
  [17528, 13800, 9848, 7688],
  [18448, 14496, 10288, 7888],
  [19472, 15312, 10832, 8432],
  [20528, 15936, 11408, 8768],
  [21616, 16816, 12016, 9136],
  [22496, 17728, 12656, 9776],
  [23648, 18672, 13328, 10208]
];
var EC_BYTES_PER_BLOCK = [
  [7, 10, 13, 17],
  [10, 16, 22, 28],
  [15, 26, 18, 22],
  [20, 18, 26, 16],
  [26, 24, 18, 22],
  [18, 16, 24, 28],
  [20, 18, 18, 26],
  [24, 22, 22, 26],
  [30, 22, 20, 24],
  [18, 26, 24, 28],
  [20, 30, 28, 24],
  [24, 22, 26, 28],
  [26, 22, 24, 22],
  [30, 24, 20, 24],
  [22, 24, 30, 24],
  [24, 28, 24, 30],
  [28, 28, 28, 28],
  [30, 26, 28, 28],
  [28, 26, 26, 26],
  [28, 26, 30, 28],
  [28, 26, 28, 30],
  [28, 28, 30, 24],
  [30, 28, 30, 30],
  [30, 28, 30, 30],
  [26, 28, 30, 30],
  [28, 28, 28, 30],
  [30, 28, 30, 30],
  [30, 28, 30, 30],
  [30, 28, 30, 30],
  [30, 28, 30, 30],
  [30, 28, 30, 30],
  [30, 28, 30, 30],
  [30, 28, 30, 30],
  [30, 28, 30, 30],
  [30, 28, 30, 30],
  [30, 28, 30, 30],
  [30, 28, 30, 30],
  [30, 28, 30, 30],
  [30, 28, 30, 30],
  [30, 28, 30, 30]
];
var DATA_BYTES_PER_BLOCK = [
  [
    [19, 1, 0, 0],
    [16, 1, 0, 0],
    [13, 1, 0, 0],
    [9, 1, 0, 0]
  ],
  [
    [34, 1, 0, 0],
    [28, 1, 0, 0],
    [22, 1, 0, 0],
    [16, 1, 0, 0]
  ],
  [
    [55, 1, 0, 0],
    [44, 1, 0, 0],
    [17, 2, 0, 0],
    [13, 2, 0, 0]
  ],
  [
    [80, 1, 0, 0],
    [32, 2, 0, 0],
    [24, 2, 0, 0],
    [9, 4, 0, 0]
  ],
  [
    [108, 1, 0, 0],
    [43, 2, 0, 0],
    [15, 2, 16, 2],
    [11, 2, 12, 2]
  ],
  [
    [68, 2, 0, 0],
    [27, 4, 0, 0],
    [19, 4, 0, 0],
    [15, 4, 0, 0]
  ],
  [
    [78, 2, 0, 0],
    [31, 4, 0, 0],
    [14, 2, 15, 4],
    [13, 4, 14, 1]
  ],
  [
    [97, 2, 0, 0],
    [38, 2, 39, 2],
    [18, 4, 19, 2],
    [14, 4, 15, 2]
  ],
  [
    [116, 2, 0, 0],
    [36, 3, 37, 2],
    [16, 4, 17, 4],
    [12, 4, 13, 4]
  ],
  [
    [68, 2, 69, 2],
    [43, 4, 44, 1],
    [19, 6, 20, 2],
    [15, 6, 16, 2]
  ],
  [
    [81, 4, 0, 0],
    [50, 1, 51, 4],
    [22, 4, 23, 4],
    [12, 3, 13, 8]
  ],
  [
    [92, 2, 93, 2],
    [36, 6, 37, 2],
    [20, 4, 21, 6],
    [14, 7, 15, 4]
  ],
  [
    [107, 4, 0, 0],
    [37, 8, 38, 1],
    [20, 8, 21, 4],
    [11, 12, 12, 4]
  ],
  [
    [115, 3, 116, 1],
    [40, 4, 41, 5],
    [16, 11, 17, 5],
    [12, 11, 13, 5]
  ],
  [
    [87, 5, 88, 1],
    [41, 5, 42, 5],
    [24, 5, 25, 7],
    [12, 11, 13, 7]
  ],
  [
    [98, 5, 99, 1],
    [45, 7, 46, 3],
    [19, 15, 20, 2],
    [15, 3, 16, 13]
  ],
  [
    [107, 1, 108, 5],
    [46, 10, 47, 1],
    [22, 1, 23, 15],
    [14, 2, 15, 17]
  ],
  [
    [120, 5, 121, 1],
    [43, 9, 44, 4],
    [22, 17, 23, 1],
    [14, 2, 15, 19]
  ],
  [
    [113, 3, 114, 4],
    [44, 3, 45, 11],
    [21, 17, 22, 4],
    [13, 9, 14, 16]
  ],
  [
    [107, 3, 108, 5],
    [41, 3, 42, 13],
    [24, 15, 25, 5],
    [15, 15, 16, 10]
  ],
  [
    [116, 4, 117, 4],
    [42, 17, 0, 0],
    [22, 17, 23, 6],
    [16, 19, 17, 6]
  ],
  [
    [111, 2, 112, 7],
    [46, 17, 0, 0],
    [24, 7, 25, 16],
    [13, 34, 0, 0]
  ],
  [
    [121, 4, 122, 5],
    [47, 4, 48, 14],
    [24, 11, 25, 14],
    [15, 16, 16, 14]
  ],
  [
    [117, 6, 118, 4],
    [45, 6, 46, 14],
    [24, 11, 25, 16],
    [16, 30, 17, 2]
  ],
  [
    [106, 8, 107, 4],
    [47, 8, 48, 13],
    [24, 7, 25, 22],
    [15, 22, 16, 13]
  ],
  [
    [114, 10, 115, 2],
    [46, 19, 47, 4],
    [22, 28, 23, 6],
    [16, 33, 17, 4]
  ],
  [
    [122, 8, 123, 4],
    [45, 22, 46, 3],
    [23, 8, 24, 26],
    [15, 12, 16, 28]
  ],
  [
    [117, 3, 118, 10],
    [45, 3, 46, 23],
    [24, 4, 25, 31],
    [15, 11, 16, 31]
  ],
  [
    [116, 7, 117, 7],
    [45, 21, 46, 7],
    [23, 1, 24, 37],
    [15, 19, 16, 26]
  ],
  [
    [115, 5, 116, 10],
    [47, 19, 48, 10],
    [24, 15, 25, 25],
    [15, 23, 16, 25]
  ],
  [
    [115, 13, 116, 3],
    [46, 2, 47, 29],
    [24, 42, 25, 1],
    [15, 23, 16, 28]
  ],
  [
    [115, 17, 0, 0],
    [46, 10, 47, 23],
    [24, 10, 25, 35],
    [15, 19, 16, 35]
  ],
  [
    [115, 17, 116, 1],
    [46, 14, 47, 21],
    [24, 29, 25, 19],
    [15, 11, 16, 46]
  ],
  [
    [115, 13, 116, 6],
    [46, 14, 47, 23],
    [24, 44, 25, 7],
    [16, 59, 17, 1]
  ],
  [
    [121, 12, 122, 7],
    [47, 12, 48, 26],
    [24, 39, 25, 14],
    [15, 22, 16, 41]
  ],
  [
    [121, 6, 122, 14],
    [47, 6, 48, 34],
    [24, 46, 25, 10],
    [15, 2, 16, 64]
  ],
  [
    [122, 17, 123, 4],
    [46, 29, 47, 14],
    [24, 49, 25, 10],
    [15, 24, 16, 46]
  ],
  [
    [122, 4, 123, 18],
    [46, 13, 47, 32],
    [24, 48, 25, 14],
    [15, 42, 16, 32]
  ],
  [
    [117, 20, 118, 4],
    [47, 40, 48, 7],
    [24, 43, 25, 22],
    [15, 10, 16, 67]
  ],
  [
    [118, 19, 119, 6],
    [47, 18, 48, 31],
    [24, 34, 25, 34],
    [15, 20, 16, 61]
  ]
];
var ALIGNMENT_PATTERN_POSITIONS = [
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
  [6, 28, 50, 72, 94],
  [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110],
  [6, 30, 58, 86, 114],
  [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126],
  [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138],
  [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150],
  [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162],
  [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170]
];
var FORMAT_INFO_COORDS_QR_MAIN = [
  [0, 8],
  [1, 8],
  [2, 8],
  [3, 8],
  [4, 8],
  [5, 8],
  [7, 8],
  [8, 8],
  [8, 7],
  [8, 5],
  [8, 4],
  [8, 3],
  [8, 2],
  [8, 1],
  [8, 0]
];
var FORMAT_INFO_COORDS_QR_SIDE = [
  [8, -1],
  [8, -2],
  [8, -3],
  [8, -4],
  [8, -5],
  [8, -6],
  [8, -7],
  [-8, 8],
  [-7, 8],
  [-6, 8],
  [-5, 8],
  [-4, 8],
  [-3, 8],
  [-2, 8],
  [-1, 8]
];
var VERSION_INFO_COORDS_BL = [
  [5, -9],
  [5, -10],
  [5, -11],
  [4, -9],
  [4, -10],
  [4, -11],
  [3, -9],
  [3, -10],
  [3, -11],
  [2, -9],
  [2, -10],
  [2, -11],
  [1, -9],
  [1, -10],
  [1, -11],
  [0, -9],
  [0, -10],
  [0, -11]
];
var VERSION_INFO_COORDS_TR = [
  [-9, 5],
  [-10, 5],
  [-11, 5],
  [-9, 4],
  [-10, 4],
  [-11, 4],
  [-9, 3],
  [-10, 3],
  [-11, 3],
  [-9, 2],
  [-10, 2],
  [-11, 2],
  [-9, 1],
  [-10, 1],
  [-11, 1],
  [-9, 0],
  [-10, 0],
  [-11, 0]
];
var FORMAT_INFOS_QR = [
  21522,
  20773,
  24188,
  23371,
  17913,
  16590,
  20375,
  19104,
  30660,
  29427,
  32170,
  30877,
  26159,
  25368,
  27713,
  26998,
  5769,
  5054,
  7399,
  6608,
  1890,
  597,
  3340,
  2107,
  13663,
  12392,
  16177,
  14854,
  9396,
  8579,
  11994,
  11245
];
var VERSION_INFOS = [
  31892,
  34236,
  39577,
  42195,
  48118,
  51042,
  55367,
  58893,
  63784,
  68472,
  70749,
  76311,
  79154,
  84390,
  87683,
  92361,
  96236,
  102084,
  102881,
  110507,
  110734,
  117786,
  119615,
  126325,
  127568,
  133589,
  136944,
  141498,
  145311,
  150283,
  152622,
  158308,
  161089,
  167017
];

// node_modules/@blockchaincommons/multipart-ur/src/qr/optimize.ts
function encodedLen(segment, version) {
  const byteSize = segment.end - segment.begin;
  const charsCount = segment.mode === Mode.Kanji ? Math.floor(byteSize / 2) : byteSize;
  return 4 + lengthBitsCount(segment.mode, version) + dataBitsCount(segment.mode, charsCount);
}
function totalEncodedLen(segments, version) {
  let total = 0;
  for (const segment of segments) total += encodedLen(segment, version);
  return total;
}
var ECS_END = 0;
var ECS_SYMBOL = 1;
var ECS_NUMERIC = 2;
var ECS_ALPHA = 3;
var ECS_KANJI_HI1 = 4;
var ECS_KANJI_HI2 = 5;
var ECS_KANJI_HI3 = 6;
var ECS_KANJI_LO1 = 7;
var ECS_KANJI_LO2 = 8;
var ECS_BYTE = 9;
function charSetOf(c) {
  if (c === 32 || c === 36 || c === 37 || c === 42 || c === 43 || c >= 45 && c <= 47 || c === 58) {
    return ECS_SYMBOL;
  }
  if (c >= 48 && c <= 57) return ECS_NUMERIC;
  if (c >= 65 && c <= 90) return ECS_ALPHA;
  if (c >= 129 && c <= 159) return ECS_KANJI_HI1;
  if (c >= 224 && c <= 234) return ECS_KANJI_HI2;
  if (c === 235) return ECS_KANJI_HI3;
  if (c === 64 || c >= 91 && c <= 126 || c === 128 || c >= 160 && c <= 191) {
    return ECS_KANJI_LO1;
  }
  if (c >= 192 && c <= 223 || c >= 236 && c <= 252) return ECS_KANJI_LO2;
  return ECS_BYTE;
}
var ST_INIT = 0;
var ST_NUMERIC = 10;
var ST_ALPHA = 20;
var ST_BYTE = 30;
var ST_KANJI_HI12 = 40;
var ST_KANJI_HI3 = 50;
var ST_KANJI = 60;
var ACT_IDLE = 0;
var ACT_NUMERIC = 1;
var ACT_ALPHA = 2;
var ACT_BYTE = 3;
var ACT_KANJI = 4;
var ACT_KANJI_AND_SINGLE_BYTE = 5;
var STATE_TRANSITION = [
  // Init
  [ST_INIT, ACT_IDLE],
  [ST_ALPHA, ACT_IDLE],
  [ST_NUMERIC, ACT_IDLE],
  [ST_ALPHA, ACT_IDLE],
  [ST_KANJI_HI12, ACT_IDLE],
  [ST_KANJI_HI12, ACT_IDLE],
  [ST_KANJI_HI3, ACT_IDLE],
  [ST_BYTE, ACT_IDLE],
  [ST_BYTE, ACT_IDLE],
  [ST_BYTE, ACT_IDLE],
  // Numeric
  [ST_INIT, ACT_NUMERIC],
  [ST_ALPHA, ACT_NUMERIC],
  [ST_NUMERIC, ACT_IDLE],
  [ST_ALPHA, ACT_NUMERIC],
  [ST_KANJI_HI12, ACT_NUMERIC],
  [ST_KANJI_HI12, ACT_NUMERIC],
  [ST_KANJI_HI3, ACT_NUMERIC],
  [ST_BYTE, ACT_NUMERIC],
  [ST_BYTE, ACT_NUMERIC],
  [ST_BYTE, ACT_NUMERIC],
  // Alpha
  [ST_INIT, ACT_ALPHA],
  [ST_ALPHA, ACT_IDLE],
  [ST_NUMERIC, ACT_ALPHA],
  [ST_ALPHA, ACT_IDLE],
  [ST_KANJI_HI12, ACT_ALPHA],
  [ST_KANJI_HI12, ACT_ALPHA],
  [ST_KANJI_HI3, ACT_ALPHA],
  [ST_BYTE, ACT_ALPHA],
  [ST_BYTE, ACT_ALPHA],
  [ST_BYTE, ACT_ALPHA],
  // Byte
  [ST_INIT, ACT_BYTE],
  [ST_ALPHA, ACT_BYTE],
  [ST_NUMERIC, ACT_BYTE],
  [ST_ALPHA, ACT_BYTE],
  [ST_KANJI_HI12, ACT_BYTE],
  [ST_KANJI_HI12, ACT_BYTE],
  [ST_KANJI_HI3, ACT_BYTE],
  [ST_BYTE, ACT_IDLE],
  [ST_BYTE, ACT_IDLE],
  [ST_BYTE, ACT_IDLE],
  // KanjiHi12
  [ST_INIT, ACT_KANJI_AND_SINGLE_BYTE],
  [ST_ALPHA, ACT_KANJI_AND_SINGLE_BYTE],
  [ST_NUMERIC, ACT_KANJI_AND_SINGLE_BYTE],
  [ST_KANJI, ACT_IDLE],
  [ST_KANJI, ACT_IDLE],
  [ST_KANJI, ACT_IDLE],
  [ST_KANJI, ACT_IDLE],
  [ST_KANJI, ACT_IDLE],
  [ST_KANJI, ACT_IDLE],
  [ST_BYTE, ACT_KANJI_AND_SINGLE_BYTE],
  // KanjiHi3
  [ST_INIT, ACT_KANJI_AND_SINGLE_BYTE],
  [ST_ALPHA, ACT_KANJI_AND_SINGLE_BYTE],
  [ST_NUMERIC, ACT_KANJI_AND_SINGLE_BYTE],
  [ST_KANJI, ACT_IDLE],
  [ST_KANJI, ACT_IDLE],
  [ST_KANJI_HI12, ACT_KANJI_AND_SINGLE_BYTE],
  [ST_KANJI_HI3, ACT_KANJI_AND_SINGLE_BYTE],
  [ST_KANJI, ACT_IDLE],
  [ST_BYTE, ACT_KANJI_AND_SINGLE_BYTE],
  [ST_BYTE, ACT_KANJI_AND_SINGLE_BYTE],
  // Kanji
  [ST_INIT, ACT_KANJI],
  [ST_ALPHA, ACT_KANJI],
  [ST_NUMERIC, ACT_KANJI],
  [ST_ALPHA, ACT_KANJI],
  [ST_KANJI_HI12, ACT_IDLE],
  [ST_KANJI_HI12, ACT_IDLE],
  [ST_KANJI_HI3, ACT_IDLE],
  [ST_BYTE, ACT_KANJI],
  [ST_BYTE, ACT_KANJI],
  [ST_BYTE, ACT_KANJI]
];
function parseSegments(data) {
  const segments = [];
  let state = ST_INIT;
  let begin = 0;
  for (let i = 0; i <= data.length; i++) {
    const ecs = i === data.length ? ECS_END : charSetOf(data[i]);
    const [nextState, action] = STATE_TRANSITION[state + ecs];
    state = nextState;
    const oldBegin = begin;
    let mode;
    switch (action) {
      case ACT_IDLE:
        continue;
      case ACT_NUMERIC:
        mode = Mode.Numeric;
        break;
      case ACT_ALPHA:
        mode = Mode.Alphanumeric;
        break;
      case ACT_BYTE:
        mode = Mode.Byte;
        break;
      case ACT_KANJI:
        mode = Mode.Kanji;
        break;
      default: {
        const nextBegin = i - 1;
        if (begin === nextBegin) {
          mode = Mode.Byte;
          break;
        }
        segments.push({ mode: Mode.Kanji, begin: oldBegin, end: nextBegin });
        segments.push({ mode: Mode.Byte, begin: nextBegin, end: nextBegin + 1 });
        begin = i;
        continue;
      }
    }
    begin = i;
    segments.push({ mode, begin: oldBegin, end: i });
  }
  return segments;
}
function optimizeSegments(segments, version) {
  if (segments.length === 0) return [];
  const out = [];
  let last = segments[0];
  let lastSize = encodedLen(last, version);
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i];
    const segSize = encodedLen(segment, version);
    const merged = {
      mode: modeMax(last.mode, segment.mode),
      begin: last.begin,
      end: segment.end
    };
    const newSize = encodedLen(merged, version);
    if (lastSize + segSize >= newSize) {
      last = merged;
      lastSize = newSize;
    } else {
      out.push(last);
      last = segment;
      lastSize = segSize;
    }
  }
  out.push(last);
  return out;
}

// node_modules/@blockchaincommons/multipart-ur/src/qr/bits.ts
var Bits = class {
  data = [];
  bitOffset = 0;
  version;
  constructor(version) {
    this.version = version;
  }
  /** Appends the low `n` bits of `number`, most significant first. */
  pushNumber(n, number) {
    const b = this.bitOffset + n;
    const last = this.data.length - 1;
    if (this.bitOffset === 0) {
      if (b <= 8) {
        this.data.push(number << 8 - b & 255);
      } else {
        this.data.push(number >> b - 8 & 255);
        this.data.push(number << 16 - b & 255);
      }
    } else if (b <= 8) {
      this.data[last] |= number << 8 - b & 255;
    } else if (b <= 16) {
      this.data[last] |= number >> b - 8 & 255;
      this.data.push(number << 16 - b & 255);
    } else {
      this.data[last] |= number >> b - 8 & 255;
      this.data.push(number >> b - 16 & 255);
      this.data.push(number << 24 - b & 255);
    }
    this.bitOffset = b & 7;
  }
  /** `pushNumber`, failing with "data too long" when `number` needs more than `n` bits. */
  pushNumberChecked(n, number) {
    if (n > 16 || number >= 1 << n) throw new QrFailure("data too long");
    this.pushNumber(n, number);
  }
  /** The bits pushed so far. */
  get length() {
    return this.bitOffset === 0 ? this.data.length * 8 : (this.data.length - 1) * 8 + this.bitOffset;
  }
  pushModeIndicator(mode) {
    let indicator;
    switch (mode) {
      case Mode.Numeric:
        indicator = 1;
        break;
      case Mode.Alphanumeric:
        indicator = 2;
        break;
      case Mode.Byte:
        indicator = 4;
        break;
      case Mode.Kanji:
        indicator = 8;
        break;
    }
    try {
      this.pushNumberChecked(4, indicator);
    } catch {
      throw new QrFailure("unsupported character set");
    }
  }
  pushHeader(mode, rawDataLen) {
    const lengthBits = lengthBitsCount(mode, this.version);
    this.pushModeIndicator(mode);
    this.pushNumberChecked(lengthBits, rawDataLen);
  }
  pushNumericData(data) {
    this.pushHeader(Mode.Numeric, data.length);
    for (let i = 0; i < data.length; i += 3) {
      const chunk = Math.min(3, data.length - i);
      let number = 0;
      for (let j = 0; j < chunk; j++) number = number * 10 + (data[i + j] - 48);
      this.pushNumber(chunk * 3 + 1, number);
    }
  }
  pushAlphanumericData(data) {
    this.pushHeader(Mode.Alphanumeric, data.length);
    for (let i = 0; i < data.length; i += 2) {
      const chunk = Math.min(2, data.length - i);
      let number = 0;
      for (let j = 0; j < chunk; j++) number = number * 45 + alphanumericDigit(data[i + j]);
      this.pushNumber(chunk * 5 + 1, number);
    }
  }
  pushByteData(data) {
    this.pushHeader(Mode.Byte, data.length);
    for (const b of data) this.pushNumber(8, b);
  }
  pushKanjiData(data) {
    this.pushHeader(Mode.Kanji, Math.floor(data.length / 2));
    for (let i = 0; i < data.length; i += 2) {
      if (i + 1 >= data.length) throw new QrFailure("invalid character");
      const cp = data[i] * 256 + data[i + 1];
      const bytes = cp < 57408 ? cp - 33088 : cp - 49472;
      const number = (bytes >> 8) * 192 + (bytes & 255);
      this.pushNumber(13, number);
    }
  }
  pushSegments(data, segments) {
    for (const segment of segments) {
      const slice = data.subarray(segment.begin, segment.end);
      switch (segment.mode) {
        case Mode.Numeric:
          this.pushNumericData(slice);
          break;
        case Mode.Alphanumeric:
          this.pushAlphanumericData(slice);
          break;
        case Mode.Byte:
          this.pushByteData(slice);
          break;
        case Mode.Kanji:
          this.pushKanjiData(slice);
          break;
      }
    }
  }
  /** Appends the terminator and pads to the version's data capacity. */
  pushTerminator(level) {
    const curLength = this.length;
    const dataLength = DATA_LENGTHS[this.version - 1][level];
    if (curLength > dataLength) throw new QrFailure("data too long");
    const terminatorSize = Math.min(4, dataLength - curLength);
    if (terminatorSize > 0) this.pushNumber(terminatorSize, 0);
    if (this.length < dataLength) {
      this.bitOffset = 0;
      const paddingBytesCount = Math.floor(dataLength / 8) - this.data.length;
      for (let i = 0; i < paddingBytesCount; i++)
        this.data.push(i % 2 === 0 ? 236 : 17);
    }
    if (this.length < dataLength) this.data.push(0);
  }
};
function alphanumericDigit(character) {
  if (character >= 48 && character <= 57) return character - 48;
  if (character >= 65 && character <= 90) return character - 65 + 10;
  switch (character) {
    case 32:
      return 36;
    case 36:
      return 37;
    case 37:
      return 38;
    case 42:
      return 39;
    case 43:
      return 40;
    case 45:
      return 41;
    case 46:
      return 42;
    case 47:
      return 43;
    case 58:
      return 44;
    default:
      return 0;
  }
}
function findMinVersion(length, level) {
  let base = 0;
  let size = 39;
  while (size > 1) {
    const half = Math.floor(size / 2);
    const mid = base + half;
    base = DATA_LENGTHS[mid][level] > length ? base : mid;
    size -= half;
  }
  base = DATA_LENGTHS[base][level] >= length ? base : base + 1;
  return base + 1;
}
function encodeAuto(data, level) {
  const segments = parseSegments(data);
  for (const version of [9, 26, 40]) {
    const optimized = optimizeSegments(segments, version);
    const totalLen = totalEncodedLen(optimized, version);
    const capacity = DATA_LENGTHS[version - 1][level];
    if (totalLen <= capacity) {
      const minVersion = findMinVersion(totalLen, level);
      const bits = new Bits(minVersion);
      bits.pushSegments(data, optimized);
      bits.pushTerminator(level);
      return { version: minVersion, bytes: Uint8Array.from(bits.data) };
    }
  }
  throw new QrFailure("data too long");
}
function encodeFixed(data, level, version) {
  if (!Number.isInteger(version) || version < 1 || version > 40) {
    throw new QrFailure("invalid version");
  }
  const segments = parseSegments(data);
  const optimized = optimizeSegments(segments, version);
  const totalLen = totalEncodedLen(optimized, version);
  const capacity = DATA_LENGTHS[version - 1][level];
  if (totalLen > capacity) throw new QrFailure("data too long");
  const bits = new Bits(version);
  bits.pushSegments(data, optimized);
  bits.pushTerminator(level);
  return { version, bytes: Uint8Array.from(bits.data) };
}

// node_modules/@blockchaincommons/multipart-ur/src/qr/canvas.ts
var EMPTY = 0;
var MASKED_LIGHT = 1;
var MASKED_DARK = 2;
var UNMASKED_LIGHT = 3;
var UNMASKED_DARK = 4;
var LIGHT = 0;
var DARK = 1;
function isDark(module) {
  return module === MASKED_DARK || module === UNMASKED_DARK;
}
var DataModuleIter = class {
  x;
  y;
  width;
  constructor(version) {
    this.width = versionWidth(version);
    this.x = this.width - 1;
    this.y = this.width - 1;
  }
  /** The next `[x, y]`, or `null` once every column is spent. */
  next() {
    const adjustedRefCol = this.x <= 6 ? this.x + 1 : this.x;
    if (adjustedRefCol <= 0) return null;
    const res = [this.x, this.y];
    const columnType = (this.width - adjustedRefCol) % 4;
    if (columnType === 2 && this.y > 0) {
      this.y -= 1;
      this.x += 1;
    } else if (columnType === 0 && this.y < this.width - 1) {
      this.y += 1;
      this.x += 1;
    } else if ((columnType === 0 || columnType === 2) && this.x === 7) {
      this.x -= 2;
    } else {
      this.x -= 1;
    }
    return res;
  }
};
var MASK_FUNCTIONS = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x, _y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => x * y % 2 + x * y % 3 === 0,
  (x, y) => (x * y % 2 + x * y % 3) % 2 === 0,
  (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0
];
var FINDER_PATTERN = [DARK, LIGHT, DARK, DARK, DARK, LIGHT, DARK];
var Canvas = class _Canvas {
  width;
  version;
  level;
  modules;
  constructor(version, level, modules) {
    this.width = versionWidth(version);
    this.version = version;
    this.level = level;
    this.modules = modules ?? new Uint8Array(this.width * this.width);
  }
  /** The index of `(x, y)`; negative coordinates count from the far edge. */
  index(x, y) {
    const xx = x < 0 ? x + this.width : x;
    const yy = y < 0 ? y + this.width : y;
    return yy * this.width + xx;
  }
  get(x, y) {
    return this.modules[this.index(x, y)];
  }
  /** Sets a fixed module. */
  put(x, y, color) {
    this.modules[this.index(x, y)] = color === DARK ? MASKED_DARK : MASKED_LIGHT;
  }
  drawFinderPatternAt(x, y) {
    const [dxLeft, dxRight] = x >= 0 ? [-3, 4] : [-4, 3];
    const [dyTop, dyBottom] = y >= 0 ? [-3, 4] : [-4, 3];
    for (let j = dyTop; j <= dyBottom; j++) {
      for (let i = dxLeft; i <= dxRight; i++) {
        const ai = Math.abs(i);
        const aj = Math.abs(j);
        let color;
        if (ai === 4 || aj === 4) color = LIGHT;
        else if (ai === 3 || aj === 3) color = DARK;
        else if (ai === 2 || aj === 2) color = LIGHT;
        else color = DARK;
        this.put(x + i, y + j, color);
      }
    }
  }
  drawFinderPatterns() {
    this.drawFinderPatternAt(3, 3);
    this.drawFinderPatternAt(-4, 3);
    this.drawFinderPatternAt(3, -4);
  }
  drawAlignmentPatternAt(x, y) {
    if (this.get(x, y) !== EMPTY) return;
    for (let j = -2; j <= 2; j++) {
      for (let i = -2; i <= 2; i++) {
        const dark = Math.abs(i) === 2 || Math.abs(j) === 2 || i === 0 && j === 0;
        this.put(x + i, y + j, dark ? DARK : LIGHT);
      }
    }
  }
  drawAlignmentPatterns() {
    if (this.version === 1) return;
    if (this.version <= 6) {
      this.drawAlignmentPatternAt(-7, -7);
      return;
    }
    const positions = ALIGNMENT_PATTERN_POSITIONS[this.version - 7];
    for (const x of positions) {
      for (const y of positions) this.drawAlignmentPatternAt(x, y);
    }
  }
  /** A horizontal or vertical line, `colorEven` on even coordinates and `colorOdd` on odd ones. */
  drawLine(x1, y1, x2, y2, colorEven, colorOdd) {
    if (y1 === y2) {
      for (let x = x1; x <= x2; x++) this.put(x, y1, x % 2 === 0 ? colorEven : colorOdd);
    } else {
      for (let y = y1; y <= y2; y++) this.put(x1, y, y % 2 === 0 ? colorEven : colorOdd);
    }
  }
  drawTimingPatterns() {
    const width = this.width;
    this.drawLine(8, 6, width - 9, 6, DARK, LIGHT);
    this.drawLine(6, 8, 6, width - 9, DARK, LIGHT);
  }
  /** Plots `bits` bits of `number`, most significant first, one per coordinate. */
  drawNumber(number, bits, onColor, offColor, coords) {
    let mask = 1 << bits - 1;
    for (const [x, y] of coords) {
      this.put(x, y, (mask & number) === 0 ? offColor : onColor);
      mask >>= 1;
    }
  }
  drawFormatInfoPatternsWithNumber(formatInfo) {
    this.drawNumber(formatInfo, 15, DARK, LIGHT, FORMAT_INFO_COORDS_QR_MAIN);
    this.drawNumber(formatInfo, 15, DARK, LIGHT, FORMAT_INFO_COORDS_QR_SIDE);
    this.put(8, -8, DARK);
  }
  drawVersionInfoPatterns() {
    if (this.version <= 6) return;
    const versionInfo = VERSION_INFOS[this.version - 7];
    this.drawNumber(versionInfo, 18, DARK, LIGHT, VERSION_INFO_COORDS_BL);
    this.drawNumber(versionInfo, 18, DARK, LIGHT, VERSION_INFO_COORDS_TR);
  }
  /** Every function pattern; the format information area is reserved as light modules. */
  drawAllFunctionalPatterns() {
    this.drawFinderPatterns();
    this.drawAlignmentPatterns();
    this.drawFormatInfoPatternsWithNumber(0);
    this.drawTimingPatterns();
    this.drawVersionInfoPatterns();
  }
  /** Places the codewords' bits into the empty modules, in placement order. */
  drawCodewords(codewords, coords) {
    for (const b of codewords) {
      for (let j = 7; j >= 0; j--) {
        const module = (b & 1 << j) === 0 ? UNMASKED_LIGHT : UNMASKED_DARK;
        let placed = false;
        for (let c = coords.next(); c !== null; c = coords.next()) {
          const idx = this.index(c[0], c[1]);
          if (this.modules[idx] === EMPTY) {
            this.modules[idx] = module;
            placed = true;
            break;
          }
        }
        if (!placed) return;
      }
    }
  }
  /** Draws the data codewords, then the error-correction codewords. */
  drawData(data, ec) {
    const coords = new DataModuleIter(this.version);
    this.drawCodewords(data, coords);
    this.drawCodewords(ec, coords);
  }
  /** Applies mask `pattern` to the data modules and writes the format information. */
  applyMask(pattern) {
    const maskFn = MASK_FUNCTIONS[pattern];
    const width = this.width;
    const modules = this.modules;
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < width; y++) {
        const idx = y * width + x;
        const module = modules[idx];
        if (module === MASKED_LIGHT || module === MASKED_DARK) continue;
        const invert = maskFn(x, y);
        if (module === EMPTY) modules[idx] = invert ? MASKED_DARK : MASKED_LIGHT;
        else if (module === UNMASKED_LIGHT) modules[idx] = invert ? MASKED_DARK : MASKED_LIGHT;
        else modules[idx] = invert ? MASKED_LIGHT : MASKED_DARK;
      }
    }
    const simpleFormatNumber = (this.level ^ 1) << 3 | pattern;
    this.drawFormatInfoPatternsWithNumber(FORMAT_INFOS_QR[simpleFormatNumber]);
  }
  /** The colour of every module, 1 for dark, row-major. */
  colors() {
    const out = new Uint8Array(this.modules.length);
    for (let i = 0; i < out.length; i++) out[i] = isDark(this.modules[i]) ? 1 : 0;
    return out;
  }
  /** Runs of five or more equal modules in a row (or column) score their length minus two. */
  adjacentPenaltyScore(colors, horizontal) {
    const width = this.width;
    let totalScore = 0;
    for (let i = 0; i < width; i++) {
      let lastColor = -1;
      let consecutiveLen = 1;
      for (let j = 0; j <= width; j++) {
        const color = j === width ? -1 : horizontal ? colors[i * width + j] : colors[j * width + i];
        if (color === lastColor) {
          consecutiveLen += 1;
        } else {
          lastColor = color;
          if (consecutiveLen >= 5) totalScore = totalScore + consecutiveLen - 2 & 65535;
          consecutiveLen = 1;
        }
      }
    }
    return totalScore;
  }
  /** Every 2×2 block of equal modules scores three. */
  blockPenaltyScore(colors) {
    const width = this.width;
    let totalScore = 0;
    for (let j = 0; j < width - 1; j++) {
      const row = j * width;
      const below = row + width;
      for (let i = 0; i < width - 1; i++) {
        const here = colors[row + i];
        if (here === colors[row + i + 1] && here === colors[below + i] && here === colors[below + i + 1]) {
          totalScore = totalScore + 3 & 65535;
        }
      }
    }
    return totalScore;
  }
  /**
   * Every `#.###.#` run with four light modules (or the edge) on at least
   * one side scores forty; the finder patterns' own runs are subtracted.
   */
  finderPenaltyScore(colors, horizontal) {
    const width = this.width;
    const step = horizontal ? 1 : width;
    const lineStep = horizontal ? width : 1;
    let totalScore = 0;
    for (let i = 0; i < width; i++) {
      const base = i * lineStep;
      for (let j = 0; j < width - 6; j++) {
        let matches = true;
        for (let k = 0; k < 7; k++) {
          if (colors[base + (j + k) * step] !== FINDER_PATTERN[k]) {
            matches = false;
            break;
          }
        }
        if (!matches) continue;
        let leftDark = false;
        for (let k = Math.max(0, j - 4); k < j; k++) {
          if (colors[base + k * step] === DARK) {
            leftDark = true;
            break;
          }
        }
        let rightDark = false;
        for (let k = j + 7; k < Math.min(width, j + 11); k++) {
          if (colors[base + k * step] === DARK) {
            rightDark = true;
            break;
          }
        }
        if (!leftDark || !rightDark) totalScore = totalScore + 40 & 65535;
      }
    }
    return totalScore - 360 & 65535;
  }
  /** The distance of the dark-module ratio from one half, in half-percent steps. */
  balancePenaltyScore(colors) {
    let darkModules = 0;
    for (const c of colors) darkModules += c;
    const ratio = Math.floor(darkModules * 200 / colors.length);
    return (ratio >= 100 ? ratio - 100 : 100 - ratio) & 65535;
  }
  /** The sum of the four penalty scores, as the reference's 16-bit total. */
  totalPenaltyScore() {
    const colors = this.colors();
    return this.adjacentPenaltyScore(colors, true) + this.adjacentPenaltyScore(colors, false) + this.blockPenaltyScore(colors) + this.finderPenaltyScore(colors, true) + this.finderPenaltyScore(colors, false) + this.balancePenaltyScore(colors) & 65535;
  }
  /** The canvas masked with the first of the eight patterns that scores lowest. */
  applyBestMask() {
    let best = new _Canvas(this.version, this.level, this.modules.slice());
    best.applyMask(0);
    let bestScore = best.totalPenaltyScore();
    for (let pattern = 1; pattern < 8; pattern++) {
      const candidate = new _Canvas(this.version, this.level, this.modules.slice());
      candidate.applyMask(pattern);
      const score = candidate.totalPenaltyScore();
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  }
  /** One byte per module, 1 for dark, row-major. */
  toModules() {
    return this.colors();
  }
};

// node_modules/@blockchaincommons/multipart-ur/src/qr/ec.ts
var EXP_TABLE = new Uint8Array(256);
var LOG_TABLE = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP_TABLE[i] = x;
    LOG_TABLE[x] = i;
    x <<= 1;
    if (x >= 256) x ^= 285;
  }
  EXP_TABLE[255] = 1;
  LOG_TABLE[0] = 255;
}
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP_TABLE[(LOG_TABLE[a] + LOG_TABLE[b]) % 255];
}
var GENERATOR_POLYNOMIALS = [];
{
  let poly = [1];
  GENERATOR_POLYNOMIALS.push(new Uint8Array(0));
  for (let n = 1; n <= 69; n++) {
    const root = EXP_TABLE[n - 1];
    const next = new Array(poly.length + 1).fill(0);
    for (let i = 0; i < poly.length; i++) {
      next[i] ^= poly[i];
      next[i + 1] ^= gfMul(poly[i], root);
    }
    poly = next;
    GENERATOR_POLYNOMIALS.push(Uint8Array.from(poly.slice(1), (c) => LOG_TABLE[c]));
  }
}
function createErrorCorrectionCode(data, ecCodeSize) {
  const dataLen = data.length;
  const logDen = GENERATOR_POLYNOMIALS[ecCodeSize];
  const res = new Uint8Array(dataLen + ecCodeSize);
  res.set(data);
  for (let i = 0; i < dataLen; i++) {
    const leadCoeff = res[i];
    if (leadCoeff === 0) continue;
    const logLeadCoeff = LOG_TABLE[leadCoeff];
    const n = Math.min(res.length - i - 1, logDen.length);
    for (let k = 0; k < n; k++) {
      res[i + 1 + k] ^= EXP_TABLE[(logDen[k] + logLeadCoeff) % 255];
    }
  }
  return res.subarray(dataLen);
}
function interleave(blocks) {
  const lastBlockLen = blocks[blocks.length - 1].length;
  const res = [];
  for (let i = 0; i < lastBlockLen; i++) {
    for (const block of blocks) {
      if (i < block.length) res.push(block[i]);
    }
  }
  return Uint8Array.from(res);
}
function constructCodewords(rawbits, version, level) {
  const [block1Size, block1Count, block2Size] = DATA_BYTES_PER_BLOCK[version - 1][level];
  const block1End = block1Size * block1Count;
  const blocks = [];
  for (let i = 0; i < block1End; i += block1Size) blocks.push(rawbits.subarray(i, i + block1Size));
  if (block2Size > 0) {
    for (let i = block1End; i < rawbits.length; i += block2Size) {
      blocks.push(rawbits.subarray(i, i + block2Size));
    }
  }
  const ecBytes = EC_BYTES_PER_BLOCK[version - 1][level];
  const ecCodes = blocks.map((block) => createErrorCorrectionCode(block, ecBytes));
  return { data: interleave(blocks), ec: interleave(ecCodes) };
}

// node_modules/@blockchaincommons/multipart-ur/src/qr/index.ts
var LEVELS = { L: 0, M: 1, Q: 2, H: 3 };
function encodeQr(message, level, requestedVersion) {
  try {
    const ecLevel = LEVELS[level];
    const { version, bytes } = requestedVersion === void 0 ? encodeAuto(message, ecLevel) : encodeFixed(message, ecLevel, requestedVersion);
    const { data, ec } = constructCodewords(bytes, version, ecLevel);
    const canvas = new Canvas(version, ecLevel);
    canvas.drawAllFunctionalPatterns();
    canvas.drawData(data, ec);
    const masked = canvas.applyBestMask();
    return { width: masked.width, modules: masked.toModules() };
  } catch (e) {
    if (e instanceof QrFailure) throw MurError.qrEncode(e.kind, e);
    throw e;
  }
}
export {
  encodeQr
};
