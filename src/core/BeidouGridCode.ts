/**
 * BeiDou Grid Location Code Core Library (TypeScript)
 * 北斗网格位置码核心编码引擎
 * 遵循 GB/T 39409-2020《北斗网格位置码》与 GB/T 20254 地理网格空间剖分规范
 * 参考自 Cesium-Bei-Dou-Grid/src/utils/BeidouGridCode.js 并修复浮点边界及2D/3D互逆一致性问题
 */

import type {
  GridBounds,
  GridBounds2D,
  GridBounds3D,
  GridLevel,
  GridLevelSpec,
} from '../types/beidou';

// CGCS2000 地球长半轴 (米)
export const R0 = 6378137.0;

// 赤道 1 角秒对应弧长 (米)
export const SEC_TO_METER = (R0 * Math.PI) / (180 * 3600);

// 纬度字母编码 (A-V, 22个字母, 每级4°, 覆盖0°~88°)
export const LAT_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUV';

// 十五进制字符 (0-E)
export const HEX15_CHARS = '0123456789ABCDE';

// 八进制字符 (0-7)
export const OCT_CHARS = '01234567';

// 十二进制字符 (0-B)
export const BASE12_CHARS = '0123456789AB';

// 高度域各级别标称步长 (米) - GB/T 39409-2020
export const HEIGHT_STEPS: readonly number[] = [
  445280,
  55660,
  27830,
  1850,
  123.69,
  61.84,
  7.73,
  0.97,
  0.121,
  0.015,
];

export const LEVEL_TO_2D_LENGTH: Record<GridLevel, number> = {
  1: 4,
  2: 6,
  3: 7,
  4: 9,
  5: 11,
  6: 12,
  7: 14,
  8: 16,
  9: 18,
  10: 20,
};

export const LEVEL_TO_3D_LENGTH: Record<GridLevel, number> = {
  1: 7,
  2: 10,
  3: 12,
  4: 15,
  5: 18,
  6: 20,
  7: 23,
  8: 26,
  9: 29,
  10: 32,
};

export const LENGTH_TO_3D_LEVEL: Record<number, GridLevel> = {
  7: 1,
  10: 2,
  12: 3,
  15: 4,
  18: 5,
  20: 6,
  23: 7,
  26: 8,
  29: 9,
  32: 10,
};

export const GRID_LEVEL_SPECS: readonly GridLevelSpec[] = [
  {
    level: 1,
    name: '一级网格 (全球宏观)',
    angularLabel: '6° × 4°',
    lonDeg: 6,
    latDeg: 4,
    approxGroundMeters: 445280,
    heightResolutionMeters: 445280,
    codeLength2D: 4,
    codeLength3D: 7,
    recommendedScale: '全球/大洲尺度 (>1500 km)',
  },
  {
    level: 2,
    name: '二级网格 (省域空域)',
    angularLabel: "30' × 30'",
    lonDeg: 0.5,
    latDeg: 0.5,
    approxGroundMeters: 55660,
    heightResolutionMeters: 55660,
    codeLength2D: 6,
    codeLength3D: 10,
    recommendedScale: '省域/城市群 (250~1500 km)',
  },
  {
    level: 3,
    name: '三级网格 (都市圈)',
    angularLabel: "15' × 10'",
    lonDeg: 15 / 60,
    latDeg: 10 / 60,
    approxGroundMeters: 27830,
    heightResolutionMeters: 27830,
    codeLength2D: 7,
    codeLength3D: 12,
    recommendedScale: '大都市圈 (60~250 km)',
  },
  {
    level: 4,
    name: '四级网格 (城区管理)',
    angularLabel: "1' × 1'",
    lonDeg: 1 / 60,
    latDeg: 1 / 60,
    approxGroundMeters: 1850,
    heightResolutionMeters: 1850,
    codeLength2D: 9,
    codeLength3D: 15,
    recommendedScale: '行政区/街道 (12~60 km)',
  },
  {
    level: 5,
    name: '五级网格 (低空扇区)',
    angularLabel: '4" × 4"',
    lonDeg: 4 / 3600,
    latDeg: 4 / 3600,
    approxGroundMeters: 123.69,
    heightResolutionMeters: 123.69,
    codeLength2D: 11,
    codeLength3D: 18,
    recommendedScale: '低空空域单元 (2.5~12 km)',
  },
  {
    level: 6,
    name: '六级网格 (街区航道)',
    angularLabel: '2" × 2"',
    lonDeg: 2 / 3600,
    latDeg: 2 / 3600,
    approxGroundMeters: 61.84,
    heightResolutionMeters: 61.84,
    codeLength2D: 12,
    codeLength3D: 20,
    recommendedScale: '城市街区/大型建筑 (0.6~2.5 km)',
  },
  {
    level: 7,
    name: '七级网格 (建筑避障)',
    angularLabel: '1/4" × 1/4"',
    lonDeg: 0.25 / 3600,
    latDeg: 0.25 / 3600,
    approxGroundMeters: 7.73,
    heightResolutionMeters: 7.73,
    codeLength2D: 14,
    codeLength3D: 23,
    recommendedScale: '精细建筑体元/无人机避障 (<600 m)',
  },
  {
    level: 8,
    name: '八级网格 (亚米定位)',
    angularLabel: '1/32" × 1/32"',
    lonDeg: 0.03125 / 3600,
    latDeg: 0.03125 / 3600,
    approxGroundMeters: 0.97,
    heightResolutionMeters: 0.97,
    codeLength2D: 16,
    codeLength3D: 26,
    recommendedScale: '起降坪精细识别 (<80 m)',
  },
  {
    level: 9,
    name: '九级网格 (分米精测)',
    angularLabel: '1/256" × 1/256"',
    lonDeg: 0.00390625 / 3600,
    latDeg: 0.00390625 / 3600,
    approxGroundMeters: 0.121,
    heightResolutionMeters: 0.121,
    codeLength2D: 18,
    codeLength3D: 29,
    recommendedScale: '设备级精准停靠',
  },
  {
    level: 10,
    name: '十级网格 (厘米极精)',
    angularLabel: '1/2048" × 1/2048"',
    lonDeg: 0.00048828125 / 3600,
    latDeg: 0.00048828125 / 3600,
    approxGroundMeters: 0.015,
    heightResolutionMeters: 0.015,
    codeLength2D: 20,
    codeLength3D: 32,
    recommendedScale: '厘米级空间基准',
  },
];

// 角秒级容差，防止边界坐标因二进制浮点误差退格
const SEC_EPSILON = 1e-7;
const HEIGHT_EPSILON = 1e-5;

function clampCoord(lat: number, lon: number): { lat: number; lon: number } {
  const clampedLat = Math.max(-87.999999, Math.min(87.999999, lat));
  // 将经度归一化到 [-180, 180)
  let normLon = ((((lon + 180) % 360) + 360) % 360) - 180;
  if (normLon >= 180) normLon = 179.9999999;
  return { lat: clampedLat, lon: normLon };
}

function assertLevel(level: number): asserts level is GridLevel {
  if (!Number.isInteger(level) || level < 1 || level > 10) {
    throw new Error(`Grid level must be an integer between 1 and 10, received: ${level}`);
  }
}

export function getLevelSpec(level: GridLevel): GridLevelSpec {
  return GRID_LEVEL_SPECS[level - 1];
}

/**
 * 内部统一计算每级 2D 码元（基于精确角秒算术，保证 2D 与 3D 剖分完全对齐且可逆）
 */
function compute2DLevelParts(lat: number, lon: number, level: GridLevel): {
  hemisphere: 'N' | 'S';
  parts: string[];
} {
  const safe = clampCoord(lat, lon);
  const hemisphere: 'N' | 'S' = safe.lat >= 0 ? 'N' : 'S';

  let lonSec = (safe.lon + 180) * 3600;
  let latSec = Math.abs(safe.lat) * 3600;
  const parts: string[] = [];

  // L1: 6° × 4° (21600" × 14400")
  const lonIdx1 = Math.min(59, Math.max(0, Math.floor((lonSec + SEC_EPSILON) / 21600)));
  const latIdx1 = Math.min(21, Math.max(0, Math.floor((latSec + SEC_EPSILON) / 14400)));
  parts.push(String(lonIdx1 + 1).padStart(2, '0') + LAT_LETTERS.charAt(latIdx1));
  if (level === 1) return { hemisphere, parts };

  lonSec = Math.max(0, lonSec - lonIdx1 * 21600);
  latSec = Math.max(0, latSec - latIdx1 * 14400);

  // L2: 30' × 30' (1800" × 1800")
  const lonIdx2 = Math.min(11, Math.max(0, Math.floor((lonSec + SEC_EPSILON) / 1800)));
  const latIdx2 = Math.min(7, Math.max(0, Math.floor((latSec + SEC_EPSILON) / 1800)));
  parts.push(BASE12_CHARS.charAt(lonIdx2) + String(latIdx2));
  if (level === 2) return { hemisphere, parts };

  lonSec = Math.max(0, lonSec - lonIdx2 * 1800);
  latSec = Math.max(0, latSec - latIdx2 * 1800);

  // L3: 15' × 10' (900" × 600"), Z序 0-5
  const lonIdx3 = Math.min(1, Math.max(0, Math.floor((lonSec + SEC_EPSILON) / 900)));
  const latIdx3 = Math.min(2, Math.max(0, Math.floor((latSec + SEC_EPSILON) / 600)));
  parts.push(String(latIdx3 * 2 + lonIdx3));
  if (level === 3) return { hemisphere, parts };

  lonSec = Math.max(0, lonSec - lonIdx3 * 900);
  latSec = Math.max(0, latSec - latIdx3 * 600);

  // L4: 1' × 1' (60" × 60")
  const lonIdx4 = Math.min(14, Math.max(0, Math.floor((lonSec + SEC_EPSILON) / 60)));
  const latIdx4 = Math.min(9, Math.max(0, Math.floor((latSec + SEC_EPSILON) / 60)));
  parts.push(HEX15_CHARS.charAt(lonIdx4) + String(latIdx4));
  if (level === 4) return { hemisphere, parts };

  lonSec = Math.max(0, lonSec - lonIdx4 * 60);
  latSec = Math.max(0, latSec - latIdx4 * 60);

  // L5: 4" × 4"
  const lonIdx5 = Math.min(14, Math.max(0, Math.floor((lonSec + SEC_EPSILON) / 4)));
  const latIdx5 = Math.min(14, Math.max(0, Math.floor((latSec + SEC_EPSILON) / 4)));
  parts.push(HEX15_CHARS.charAt(lonIdx5) + HEX15_CHARS.charAt(latIdx5));
  if (level === 5) return { hemisphere, parts };

  lonSec = Math.max(0, lonSec - lonIdx5 * 4);
  latSec = Math.max(0, latSec - latIdx5 * 4);

  // L6: 2" × 2", Z序 0-3
  const lonIdx6 = Math.min(1, Math.max(0, Math.floor((lonSec + SEC_EPSILON) / 2)));
  const latIdx6 = Math.min(1, Math.max(0, Math.floor((latSec + SEC_EPSILON) / 2)));
  parts.push(String(latIdx6 * 2 + lonIdx6));
  if (level === 6) return { hemisphere, parts };

  lonSec = Math.max(0, lonSec - lonIdx6 * 2);
  latSec = Math.max(0, latSec - latIdx6 * 2);

  // L7~L10: 每次 8×8 剖分
  let stepSec = 2;
  for (let lv = 7; lv <= level; lv++) {
    stepSec /= 8;
    const lonIdx = Math.min(7, Math.max(0, Math.floor((lonSec + SEC_EPSILON) / stepSec)));
    const latIdx = Math.min(7, Math.max(0, Math.floor((latSec + SEC_EPSILON) / stepSec)));
    parts.push(OCT_CHARS.charAt(lonIdx) + OCT_CHARS.charAt(latIdx));
    lonSec = Math.max(0, lonSec - lonIdx * stepSec);
    latSec = Math.max(0, latSec - latIdx * stepSec);
  }

  return { hemisphere, parts };
}

/**
 * 北斗二维网格位置码编码 (1-10级，最长20位)
 */
export function encode2D(lat: number, lon: number, level: GridLevel): string {
  assertLevel(level);
  const { hemisphere, parts } = compute2DLevelParts(lat, lon, level);
  return hemisphere + parts.join('');
}

/**
 * 解码北斗二维网格位置码
 */
export function decode2D(codeInput: string): GridBounds2D {
  if (!codeInput || codeInput.trim().length < 4) {
    throw new Error('Invalid 2D code: minimum length is 4 characters');
  }

  const code = codeInput.trim().toUpperCase();
  const hemisphere = code.charAt(0);
  if (hemisphere !== 'N' && hemisphere !== 'S') {
    throw new Error(`Invalid hemisphere indicator in code: ${code}`);
  }
  const isNorth = hemisphere === 'N';

  let minLatSec = 0;
  let minLonSec = 0;
  let gridLatSec = 4 * 3600;
  let gridLonSec = 6 * 3600;
  let level: GridLevel = 1;

  // L1 (pos 1..3)
  const lon1 = parseInt(code.substring(1, 3), 10) - 1;
  const lat1 = LAT_LETTERS.indexOf(code.charAt(3));
  if (Number.isNaN(lon1) || lon1 < 0 || lon1 >= 60 || lat1 < 0) {
    throw new Error(`Invalid level 1 code: ${code}`);
  }
  minLonSec = lon1 * 21600;
  minLatSec = lat1 * 14400;

  // L2 (pos 4..5)
  if (code.length >= 6) {
    const lon2 = BASE12_CHARS.indexOf(code.charAt(4));
    const lat2 = parseInt(code.charAt(5), 10);
    if (lon2 < 0 || Number.isNaN(lat2) || lat2 < 0 || lat2 >= 8) {
      throw new Error(`Invalid level 2 code: ${code}`);
    }
    minLonSec += lon2 * 1800;
    minLatSec += lat2 * 1800;
    gridLonSec = 1800;
    gridLatSec = 1800;
    level = 2;
  }

  // L3 (pos 6)
  if (code.length >= 7) {
    const z3 = parseInt(code.charAt(6), 10);
    if (Number.isNaN(z3) || z3 < 0 || z3 > 5) {
      throw new Error(`Invalid level 3 code: ${code}`);
    }
    minLonSec += (z3 % 2) * 900;
    minLatSec += Math.floor(z3 / 2) * 600;
    gridLonSec = 900;
    gridLatSec = 600;
    level = 3;
  }

  // L4 (pos 7..8)
  if (code.length >= 9) {
    const lon4 = HEX15_CHARS.indexOf(code.charAt(7));
    const lat4 = parseInt(code.charAt(8), 10);
    if (lon4 < 0 || Number.isNaN(lat4) || lat4 < 0 || lat4 > 9) {
      throw new Error(`Invalid level 4 code: ${code}`);
    }
    minLonSec += lon4 * 60;
    minLatSec += lat4 * 60;
    gridLonSec = 60;
    gridLatSec = 60;
    level = 4;
  }

  // L5 (pos 9..10)
  if (code.length >= 11) {
    const lon5 = HEX15_CHARS.indexOf(code.charAt(9));
    const lat5 = HEX15_CHARS.indexOf(code.charAt(10));
    if (lon5 < 0 || lat5 < 0) {
      throw new Error(`Invalid level 5 code: ${code}`);
    }
    minLonSec += lon5 * 4;
    minLatSec += lat5 * 4;
    gridLonSec = 4;
    gridLatSec = 4;
    level = 5;
  }

  // L6 (pos 11)
  if (code.length >= 12) {
    const z6 = parseInt(code.charAt(11), 10);
    if (Number.isNaN(z6) || z6 < 0 || z6 > 3) {
      throw new Error(`Invalid level 6 code: ${code}`);
    }
    minLonSec += (z6 % 2) * 2;
    minLatSec += Math.floor(z6 / 2) * 2;
    gridLonSec = 2;
    gridLatSec = 2;
    level = 6;
  }

  // L7 ~ L10
  const octSteps = [
    { minLen: 14, idx: 12, step: 2 / 8, lv: 7 as GridLevel },
    { minLen: 16, idx: 14, step: 2 / 64, lv: 8 as GridLevel },
    { minLen: 18, idx: 16, step: 2 / 512, lv: 9 as GridLevel },
    { minLen: 20, idx: 18, step: 2 / 4096, lv: 10 as GridLevel },
  ];

  for (const cfg of octSteps) {
    if (code.length >= cfg.minLen) {
      const lonIdx = OCT_CHARS.indexOf(code.charAt(cfg.idx));
      const latIdx = OCT_CHARS.indexOf(code.charAt(cfg.idx + 1));
      if (lonIdx < 0 || latIdx < 0) {
        throw new Error(`Invalid level ${cfg.lv} code: ${code}`);
      }
      minLonSec += lonIdx * cfg.step;
      minLatSec += latIdx * cfg.step;
      gridLonSec = cfg.step;
      gridLatSec = cfg.step;
      level = cfg.lv;
    }
  }

  let minLat = minLatSec / 3600;
  let maxLat = (minLatSec + gridLatSec) / 3600;
  const minLon = minLonSec / 3600 - 180;
  const maxLon = (minLonSec + gridLonSec) / 3600 - 180;

  if (!isNorth) {
    const nextMinLat = -maxLat;
    const nextMaxLat = -minLat;
    minLat = nextMinLat;
    maxLat = nextMaxLat;
  }

  return {
    code,
    level,
    minLat,
    maxLat,
    minLon,
    maxLon,
    centerLat: (minLat + maxLat) / 2,
    centerLon: (minLon + maxLon) / 2,
  };
}

/**
 * 高度编码部分计算
 */
function computeHeightLevelParts(height: number, level: GridLevel): {
  isUnderground: boolean;
  parts: string[];
} {
  const isUnderground = height < 0;
  const absH = Math.abs(height);
  const parts: string[] = [];

  // L1: 00-63 (445280m)
  const h1 = Math.min(63, Math.max(0, Math.floor((absH + HEIGHT_EPSILON) / HEIGHT_STEPS[0])));
  parts.push(String(h1).padStart(2, '0'));
  if (level === 1) return { isUnderground, parts };

  let dH = Math.max(0, absH - h1 * HEIGHT_STEPS[0]);

  for (let i = 2; i <= level; i++) {
    const step = HEIGHT_STEPS[i - 1];
    const hVal = Math.floor((dH + HEIGHT_EPSILON) / step);
    let clamped = 0;
    if (i === 4 || i === 5) {
      clamped = Math.min(14, Math.max(0, hVal));
      parts.push(clamped.toString(15).toUpperCase());
    } else if (i === 3 || i === 6) {
      clamped = Math.min(1, Math.max(0, hVal));
      parts.push(String(clamped));
    } else {
      clamped = Math.min(7, Math.max(0, hVal));
      parts.push(String(clamped));
    }
    dH = Math.max(0, dH - clamped * step);
  }

  return { isUnderground, parts };
}

export interface Beidou2DGeoContext {
  hemisphere: 'N' | 'S';
  parts: string[];
  code2D: string;
}

/**
 * 预计算二维编码上下文（用于同一经纬柱体多层高程复用，避免重复经纬度分段运算）
 */
export function compute2DGeoContext(
  lat: number,
  lon: number,
  level: GridLevel,
): Beidou2DGeoContext {
  assertLevel(level);
  const { hemisphere, parts } = compute2DLevelParts(lat, lon, level);
  return {
    hemisphere,
    parts,
    code2D: hemisphere + parts.join(''),
  };
}

/**
 * 使用预计算二维编码上下文快速拼接三维位置码（零额外经纬度角秒拆解开销）
 */
export function encode3DWithGeoContext(
  geo: Beidou2DGeoContext,
  height: number,
  level: GridLevel,
): string {
  const { isUnderground, parts: hParts } = computeHeightLevelParts(height, level);
  let code = geo.hemisphere + (isUnderground ? '1' : '0');
  for (let i = 0; i < level; i++) {
    code += geo.parts[i] + hParts[i];
  }
  return code;
}

/**
 * 北斗三维网格位置码编码 (GB/T 39409-2020 标准交叉编码, 十级32位)
 */
export function encode3D(lat: number, lon: number, height: number, level: GridLevel): string {
  assertLevel(level);
  const { hemisphere, parts: geoParts } = compute2DLevelParts(lat, lon, level);
  const { isUnderground, parts: hParts } = computeHeightLevelParts(height, level);

  let code = hemisphere + (isUnderground ? '1' : '0');
  for (let i = 0; i < level; i++) {
    code += geoParts[i] + hParts[i];
  }
  return code;
}

/**
 * 分离格式高度编码 (如 "+0000010")
 */
export function encodeHeight(height: number, level: GridLevel): string {
  assertLevel(level);
  const { isUnderground, parts } = computeHeightLevelParts(height, level);
  return (isUnderground ? '-' : '+') + parts.join('');
}

export function decodeHeight(heightCode: string): {
  minHeight: number;
  maxHeight: number;
  centerHeight: number;
  level: GridLevel;
} {
  if (!heightCode || heightCode.length < 2) {
    throw new Error('Invalid height code: minimum length is 2 characters');
  }
  const signChar = heightCode.charAt(0);
  if (signChar !== '+' && signChar !== '-') {
    throw new Error('Height code must start with + or -');
  }
  const isPositive = signChar === '+';
  const chars = heightCode.substring(1).toUpperCase();

  let baseHeight = 0;
  const h1Digits = chars.length >= 2 ? chars.substring(0, 2) : chars.substring(0, 1);
  const h1 = parseInt(h1Digits, 10);
  if (!Number.isNaN(h1)) {
    baseHeight += h1 * HEIGHT_STEPS[0];
  }

  let pos = h1Digits.length;
  let level: GridLevel = 1;

  for (let i = 2; i <= 10 && pos < chars.length; i++) {
    const c = chars.charAt(pos++);
    const val = parseInt(c, 16);
    if (!Number.isNaN(val)) {
      baseHeight += val * HEIGHT_STEPS[i - 1];
    }
    level = i as GridLevel;
  }

  const stepHeight = HEIGHT_STEPS[level - 1];
  const minHeight = isPositive ? baseHeight : -(baseHeight + stepHeight);
  const maxHeight = isPositive ? baseHeight + stepHeight : -baseHeight;

  return {
    minHeight,
    maxHeight,
    centerHeight: (minHeight + maxHeight) / 2,
    level,
  };
}

export function is3DCode(codeInput: string): boolean {
  if (!codeInput || typeof codeInput !== 'string') return false;
  const code = codeInput.trim().toUpperCase();
  if (code.includes('/')) return true;
  const prefix2 = code.substring(0, 2);
  if (prefix2 === 'N0' || prefix2 === 'N1' || prefix2 === 'S0' || prefix2 === 'S1') {
    return Boolean(LENGTH_TO_3D_LEVEL[code.length]);
  }
  return false;
}

export function extract2DCode(codeInput: string): string {
  if (!codeInput) return '';
  const code = codeInput.trim().toUpperCase();
  if (code.includes('/')) {
    return code.split('/')[0];
  }
  if (!is3DCode(code)) {
    return code;
  }

  let code2D = code.charAt(0);
  const len = code.length;
  if (len >= 7) code2D += code.substring(2, 5);
  if (len >= 10) code2D += code.substring(7, 9);
  if (len >= 12) code2D += code.charAt(10);
  if (len >= 15) code2D += code.substring(12, 14);
  if (len >= 18) code2D += code.substring(15, 17);
  if (len >= 20) code2D += code.charAt(18);
  if (len >= 23) code2D += code.substring(20, 22);
  if (len >= 26) code2D += code.substring(23, 25);
  if (len >= 29) code2D += code.substring(26, 28);
  if (len >= 32) code2D += code.substring(29, 31);
  return code2D;
}

function decodeGB3DHeight(code: string): {
  minHeight: number;
  maxHeight: number;
  centerHeight: number;
  level: GridLevel;
} {
  const isUnderground = code.charAt(1) === '1';
  const len = code.length;
  const level = LENGTH_TO_3D_LEVEL[len];
  if (!level) {
    throw new Error(`Invalid GB 3D code length: ${len}`);
  }

  let baseH = 0;
  const h1 = parseInt(code.substring(5, 7), 10);
  baseH += (Number.isNaN(h1) ? 0 : h1) * HEIGHT_STEPS[0];

  const slices: Array<{ lv: number; minLen: number; pos: number; radix: number }> = [
    { lv: 2, minLen: 10, pos: 9, radix: 10 },
    { lv: 3, minLen: 12, pos: 11, radix: 10 },
    { lv: 4, minLen: 15, pos: 14, radix: 16 },
    { lv: 5, minLen: 18, pos: 17, radix: 16 },
    { lv: 6, minLen: 20, pos: 19, radix: 10 },
    { lv: 7, minLen: 23, pos: 22, radix: 10 },
    { lv: 8, minLen: 26, pos: 25, radix: 10 },
    { lv: 9, minLen: 29, pos: 28, radix: 10 },
    { lv: 10, minLen: 32, pos: 31, radix: 10 },
  ];

  for (const s of slices) {
    if (level >= s.lv && len >= s.minLen) {
      const hv = parseInt(code.charAt(s.pos), s.radix);
      baseH += (Number.isNaN(hv) ? 0 : hv) * HEIGHT_STEPS[s.lv - 1];
    }
  }

  const step = HEIGHT_STEPS[level - 1];
  const minHeight = isUnderground ? -(baseH + step) : baseH;
  const maxHeight = isUnderground ? -baseH : baseH + step;

  return {
    minHeight,
    maxHeight,
    centerHeight: (minHeight + maxHeight) / 2,
    level,
  };
}

export function decode3D(codeInput: string): GridBounds3D {
  if (!codeInput) {
    throw new Error('Invalid 3D code');
  }
  const code = codeInput.trim().toUpperCase();

  if (code.includes('/')) {
    const [code2D, heightCode] = code.split('/');
    const result2D = decode2D(code2D);
    const heightResult = decodeHeight(heightCode);
    return {
      ...result2D,
      code,
      minHeight: heightResult.minHeight,
      maxHeight: heightResult.maxHeight,
      centerHeight: heightResult.centerHeight,
      is3D: true,
    };
  }

  if (is3DCode(code)) {
    const code2D = extract2DCode(code);
    const result2D = decode2D(code2D);
    const heightResult = decodeGB3DHeight(code);
    return {
      ...result2D,
      code,
      level: heightResult.level,
      minHeight: heightResult.minHeight,
      maxHeight: heightResult.maxHeight,
      centerHeight: heightResult.centerHeight,
      is3D: true,
    };
  }

  throw new Error(`Invalid 3D code format: ${code}`);
}

export function getGridBounds(code: string): GridBounds {
  return is3DCode(code) ? decode3D(code) : decode2D(code);
}

export function getGridCenter(code: string): { lat: number; lon: number; height?: number } {
  const bounds = getGridBounds(code);
  if ('centerHeight' in bounds) {
    return { lat: bounds.centerLat, lon: bounds.centerLon, height: bounds.centerHeight };
  }
  return { lat: bounds.centerLat, lon: bounds.centerLon };
}

export function validateCode(code: string): boolean {
  try {
    getGridBounds(code);
    return true;
  } catch {
    return false;
  }
}

export function getHeightResolution(level: GridLevel): number {
  return HEIGHT_STEPS[level - 1] ?? 100;
}

export interface GridNeighbors {
  north: string;
  south: string;
  east: string;
  west: string;
  northeast: string;
  northwest: string;
  southeast: string;
  southwest: string;
  up?: string;
  down?: string;
}

export function getNeighbors(code: string): GridNeighbors {
  const is3D = is3DCode(code);
  const code2D = is3D ? extract2DCode(code) : code;
  const bounds = decode2D(code2D);
  const level = bounds.level;
  const latStep = bounds.maxLat - bounds.minLat;
  const lonStep = bounds.maxLon - bounds.minLon;
  const cLat = bounds.centerLat;
  const cLon = bounds.centerLon;

  if (!is3D) {
    return {
      north: encode2D(cLat + latStep, cLon, level),
      south: encode2D(cLat - latStep, cLon, level),
      east: encode2D(cLat, cLon + lonStep, level),
      west: encode2D(cLat, cLon - lonStep, level),
      northeast: encode2D(cLat + latStep, cLon + lonStep, level),
      northwest: encode2D(cLat + latStep, cLon - lonStep, level),
      southeast: encode2D(cLat - latStep, cLon + lonStep, level),
      southwest: encode2D(cLat - latStep, cLon - lonStep, level),
    };
  }

  const bounds3D = decode3D(code);
  const hCenter = bounds3D.centerHeight;
  const hStep = bounds3D.maxHeight - bounds3D.minHeight;

  return {
    north: encode3D(cLat + latStep, cLon, hCenter, level),
    south: encode3D(cLat - latStep, cLon, hCenter, level),
    east: encode3D(cLat, cLon + lonStep, hCenter, level),
    west: encode3D(cLat, cLon - lonStep, hCenter, level),
    northeast: encode3D(cLat + latStep, cLon + lonStep, hCenter, level),
    northwest: encode3D(cLat + latStep, cLon - lonStep, hCenter, level),
    southeast: encode3D(cLat - latStep, cLon + lonStep, hCenter, level),
    southwest: encode3D(cLat - latStep, cLon - lonStep, hCenter, level),
    up: encode3D(cLat, cLon, hCenter + hStep, level),
    down: encode3D(cLat, cLon, hCenter - hStep, level),
  };
}

/**
 * 根据相机海拔高度自适应推荐北斗网格级别 (1-10级全覆盖，匹配视口尺寸)
 */
export function recommendLevelFromAltitude(altitudeMeters: number): GridLevel {
  if (altitudeMeters > 1_200_000) return 1;
  if (altitudeMeters > 220_000) return 2;
  if (altitudeMeters > 65_000) return 3;
  if (altitudeMeters > 6_500) return 4;
  if (altitudeMeters > 750) return 5;
  if (altitudeMeters > 240) return 6;
  if (altitudeMeters > 32) return 7;
  if (altitudeMeters > 4.5) return 8;
  if (altitudeMeters > 0.75) return 9;
  return 10;
}

export const BeidouGridCode = {
  version: '2.0.0-ts',
  R0,
  SEC_TO_METER,
  HEIGHT_STEPS,
  LEVEL_TO_2D_LENGTH,
  LEVEL_TO_3D_LENGTH,
  GRID_LEVEL_SPECS,
  getLevelSpec,
  compute2DGeoContext,
  encode3DWithGeoContext,
  encode2D,
  decode2D,
  encode3D,
  decode3D,
  encodeHeight,
  decodeHeight,
  is3DCode,
  extract2DCode,
  getGridBounds,
  getGridCenter,
  validateCode,
  getHeightResolution,
  getNeighbors,
  recommendLevelFromAltitude,
};

export default BeidouGridCode;
