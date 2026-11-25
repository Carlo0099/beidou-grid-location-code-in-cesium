import type { BuildingFootprint } from '../types/beidou';

interface GlTFJson {
  nodes?: Array<{
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
  }>;
  scenes?: Array<{ nodes?: number[] }>;
  scene?: number;
  meshes?: Array<{
    primitives?: Array<{
      attributes?: Record<string, number>;
      extensions?: Record<string, unknown>;
    }>;
  }>;
  accessors?: Array<{
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
  }>;
  bufferViews?: Array<{
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
  }>;
}

interface TilesetNodeJson {
  boundingVolume?: {
    box?: number[];
    region?: number[];
    sphere?: number[];
  };
  content?: { uri?: string };
  contents?: Array<{ uri?: string }>;
  transform?: number[];
  children?: TilesetNodeJson[];
}

interface TilesetRootJson {
  root?: TilesetNodeJson;
}

type Mat4 = Float64Array; // 16-element column-major matrix

const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);
const WGS84_E2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);
const WGS84_EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);
const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

function mat4Identity(): Mat4 {
  return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    const b0 = b[col * 4];
    const b1 = b[col * 4 + 1];
    const b2 = b[col * 4 + 2];
    const b3 = b[col * 4 + 3];
    out[col * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[col * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[col * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[col * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

function ecefToLonLatHeight(X: number, Y: number, Z: number): [number, number, number] {
  const p = Math.hypot(X, Y);
  if (p < 1e-9) {
    const lat = Z >= 0 ? 90 : -90;
    return [0, lat, Math.abs(Z) - WGS84_B];
  }
  const lon = Math.atan2(Y, X);
  const theta = Math.atan2(Z * WGS84_A, p * WGS84_B);
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);
  const lat = Math.atan2(
    Z + WGS84_EP2 * WGS84_B * sinT * sinT * sinT,
    p - WGS84_E2 * WGS84_A * cosT * cosT * cosT,
  );
  const sinLat = Math.sin(lat);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const h = p / Math.cos(lat) - N;
  return [lon * RAD_TO_DEG, lat * RAD_TO_DEG, h];
}

/**
 * Andrew 单调链计算二维凸包，用于从 3D Tiles 顶点自动提取建筑外轮廓多边形
 */
export function computeConvexHull2D(points: Array<[number, number]>): Array<[number, number]> {
  if (points.length <= 3) return points;
  const sorted = [...points].sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));

  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: Array<[number, number]> = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: Array<[number, number]> = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function getNodeLocalMatrix(node: NonNullable<GlTFJson['nodes']>[number]): Mat4 {
  if (node.matrix && node.matrix.length === 16) {
    return new Float64Array(node.matrix);
  }
  const tx = node.translation?.[0] ?? 0;
  const ty = node.translation?.[1] ?? 0;
  const tz = node.translation?.[2] ?? 0;

  const qx = node.rotation?.[0] ?? 0;
  const qy = node.rotation?.[1] ?? 0;
  const qz = node.rotation?.[2] ?? 0;
  const qw = node.rotation?.[3] ?? 1;

  const sx = node.scale?.[0] ?? 1;
  const sy = node.scale?.[1] ?? 1;
  const sz = node.scale?.[2] ?? 1;

  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;

  return new Float64Array([
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ]);
}

/**
 * 解析 .glb (或嵌入 glTF 的 .b3dm) 并提取按 _FEATURE_ID_0 分组的建筑轮廓与高程
 */
export function parseGlbBufferToBuildings(
  arrayBuffer: ArrayBuffer,
  tileWorldTransform: Mat4,
  roi: { minLon: number; maxLon: number; minLat: number; maxLat: number },
  tileLabel: string,
  maxBuildings: number,
): BuildingFootprint[] {
  const dv = new DataView(arrayBuffer);
  if (arrayBuffer.byteLength < 20) return [];

  let glbView = dv;
  let glbOffset = 0;

  // 若为 .b3dm 封装格式，定位内嵌 glTF 起始偏移
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic === 'b3dm') {
    const ftJsonLen = dv.getUint32(12, true);
    const ftBinLen = dv.getUint32(16, true);
    const btJsonLen = dv.getUint32(20, true);
    const btBinLen = dv.getUint32(24, true);
    glbOffset = 28 + ftJsonLen + ftBinLen + btJsonLen + btBinLen;
    if (glbOffset + 20 >= arrayBuffer.byteLength) return [];
    glbView = new DataView(arrayBuffer, glbOffset);
  }

  const glbMagic = glbView.getUint32(0, true);
  if (glbMagic !== 0x46546c67) {
    return [];
  }

  const totalLen = glbView.getUint32(8, true);
  let cursor = 12;
  let gltfJson: GlTFJson | null = null;
  let binByteOffset = 0;
  let binByteLength = 0;

  while (cursor + 8 <= totalLen && glbOffset + cursor + 8 <= arrayBuffer.byteLength) {
    const chunkLen = glbView.getUint32(cursor, true);
    const chunkType = glbView.getUint32(cursor + 4, true);
    const dataStart = glbOffset + cursor + 8;
    if (chunkType === 0x4e4f534a) {
      const jsonBytes = new Uint8Array(arrayBuffer, dataStart, chunkLen);
      gltfJson = JSON.parse(new TextDecoder().decode(jsonBytes)) as GlTFJson;
    } else if (chunkType === 0x004e4942) {
      binByteOffset = dataStart;
      binByteLength = chunkLen;
    }
    cursor += 8 + chunkLen;
  }

  if (!gltfJson || !binByteLength || !gltfJson.meshes || !gltfJson.accessors || !gltfJson.bufferViews) {
    return [];
  }

  // glTF 规范为 Y-up，Cesium 在送入 tileWorldTransform 前执行 Y-up -> Z-up 变换
  const yUpToZUp = new Float64Array([
    1, 0, 0, 0,
    0, 0, 1, 0,
    0, -1, 0, 0,
    0, 0, 0, 1,
  ]);
  const baseMatrix = mat4Multiply(tileWorldTransform, yUpToZUp);

  const meshTransforms = new Map<number, Mat4[]>();
  const nodes = gltfJson.nodes ?? [];
  const visited = new Set<number>();

  const traverseNode = (nodeIdx: number, parentMat: Mat4) => {
    if (visited.has(nodeIdx)) return;
    visited.add(nodeIdx);
    const node = nodes[nodeIdx];
    if (!node) return;
    const worldMat = mat4Multiply(parentMat, getNodeLocalMatrix(node));
    if (node.mesh !== undefined) {
      const list = meshTransforms.get(node.mesh) ?? [];
      list.push(worldMat);
      meshTransforms.set(node.mesh, list);
    }
    if (node.children) {
      for (const childIdx of node.children) {
        traverseNode(childIdx, worldMat);
      }
    }
  };

  const sceneRoots =
    gltfJson.scenes?.[gltfJson.scene ?? 0]?.nodes ??
    (nodes.length > 0 ? [nodes.length - 1] : []);

  for (const rootIdx of sceneRoots) {
    traverseNode(rootIdx, baseMatrix);
  }
  for (let i = 0; i < nodes.length; i++) {
    if (!visited.has(i)) {
      traverseNode(i, baseMatrix);
    }
  }

  interface FeatureAccumulator {
    minLon: number;
    maxLon: number;
    minLat: number;
    maxLat: number;
    minH: number;
    maxH: number;
    pts: Array<[number, number]>;
  }

  const accMap = new Map<string, FeatureAccumulator>();

  const readScalar = (accessorIdx: number, vertexIdx: number): number => {
    const acc = gltfJson!.accessors![accessorIdx];
    const bv = gltfJson!.bufferViews![acc.bufferView ?? 0];
    const stride = bv.byteStride ?? (acc.componentType === 5126 ? 4 : acc.componentType === 5123 ? 2 : 1);
    const offset = binByteOffset + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0) + vertexIdx * stride;
    if (acc.componentType === 5126) return dv.getFloat32(offset, true);
    if (acc.componentType === 5123) return dv.getUint16(offset, true);
    if (acc.componentType === 5125) return dv.getUint32(offset, true);
    if (acc.componentType === 5121) return dv.getUint8(offset);
    return 0;
  };

  gltfJson.meshes.forEach((mesh, meshIdx) => {
    const mats = meshTransforms.get(meshIdx) ?? [baseMatrix];
    const mat = mats[0];

    mesh.primitives?.forEach((prim, primIdx) => {
      const posAccIdx = prim.attributes?.POSITION;
      if (posAccIdx === undefined) return;
      const posAcc = gltfJson!.accessors![posAccIdx];
      const posBv = gltfJson!.bufferViews![posAcc.bufferView ?? 0];
      const stride = posBv.byteStride ?? 12;
      const startByte = binByteOffset + (posBv.byteOffset ?? 0) + (posAcc.byteOffset ?? 0);

      const featAccIdx = prim.attributes?._FEATURE_ID_0 ?? prim.attributes?._BATCHID;
      const vertexStep = posAcc.count > 45000 ? 2 : 1;

      for (let v = 0; v < posAcc.count; v += vertexStep) {
        const bytePos = startByte + v * stride;
        const x = dv.getFloat32(bytePos, true);
        const y = dv.getFloat32(bytePos + 4, true);
        const z = dv.getFloat32(bytePos + 8, true);

        const [ex, ey, ez] = transformPoint(mat, x, y, z);
        const [lon, lat, h] = ecefToLonLatHeight(ex, ey, ez);

        if (
          lon < roi.minLon - 0.002 ||
          lon > roi.maxLon + 0.002 ||
          lat < roi.minLat - 0.002 ||
          lat > roi.maxLat + 0.002
        ) {
          continue;
        }

        const featId =
          featAccIdx !== undefined
            ? Math.round(readScalar(featAccIdx, v))
            : `${primIdx}_${Math.round(lon * 4000)}_${Math.round(lat * 4000)}`;
        const key = `${tileLabel}#${primIdx}#${featId}`;

        let acc = accMap.get(key);
        if (!acc) {
          if (accMap.size >= maxBuildings * 6) continue;
          acc = {
            minLon: lon,
            maxLon: lon,
            minLat: lat,
            maxLat: lat,
            minH: h,
            maxH: h,
            pts: [],
          };
          accMap.set(key, acc);
        } else {
          if (lon < acc.minLon) acc.minLon = lon;
          if (lon > acc.maxLon) acc.maxLon = lon;
          if (lat < acc.minLat) acc.minLat = lat;
          if (lat > acc.maxLat) acc.maxLat = lat;
          if (h < acc.minH) acc.minH = h;
          if (h > acc.maxH) acc.maxH = h;
        }

        if (acc.pts.length < 48) {
          acc.pts.push([lon, lat]);
        }
      }
    });
  });

  const buildings: BuildingFootprint[] = [];
  let idx = 0;

  for (const [key, acc] of accMap) {
    if (
      acc.maxLon < roi.minLon ||
      acc.minLon > roi.maxLon ||
      acc.maxLat < roi.minLat ||
      acc.minLat > roi.maxLat
    ) {
      continue;
    }
    const heightSpan = acc.maxH - acc.minH;
    if (heightSpan < 4) continue;

    const hull = computeConvexHull2D(acc.pts);
    const polygon =
      hull.length >= 3
        ? hull
        : ([
            [acc.minLon, acc.minLat],
            [acc.maxLon, acc.minLat],
            [acc.maxLon, acc.maxLat],
            [acc.minLon, acc.maxLat],
          ] as Array<[number, number]>);

    idx++;
    buildings.push({
      id: key,
      name: `3D Tiles 建筑 #${idx}`,
      source: '3dtiles-glb',
      minLon: acc.minLon,
      maxLon: acc.maxLon,
      minLat: acc.minLat,
      maxLat: acc.maxLat,
      baseHeight: Math.max(0, acc.minH),
      roofHeight: Math.max(4, acc.maxH),
      polygon,
    });
  }

  const roiCenterLon = (roi.minLon + roi.maxLon) * 0.5;
  const roiCenterLat = (roi.minLat + roi.maxLat) * 0.5;
  buildings.sort((a, b) => {
    const da =
      ((a.minLon + a.maxLon) * 0.5 - roiCenterLon) ** 2 +
      ((a.minLat + a.maxLat) * 0.5 - roiCenterLat) ** 2;
    const db =
      ((b.minLon + b.maxLon) * 0.5 - roiCenterLon) ** 2 +
      ((b.minLat + b.maxLat) * 0.5 - roiCenterLat) ** 2;
    return da - db;
  });

  return buildings.slice(0, maxBuildings);
}

function doesTileBoxIntersectRoi(
  box: number[],
  worldTransform: Mat4,
  roi: { minLon: number; maxLon: number; minLat: number; maxLat: number },
): boolean {
  const cx = box[0];
  const cy = box[1];
  const cz = box[2];
  const hx = Math.abs(box[3]) + Math.abs(box[6]) + Math.abs(box[9]);
  const hy = Math.abs(box[4]) + Math.abs(box[7]) + Math.abs(box[10]);

  const corners: Array<[number, number, number]> = [
    [cx - hx, cy - hy, cz],
    [cx + hx, cy - hy, cz],
    [cx + hx, cy + hy, cz],
    [cx - hx, cy + hy, cz],
  ];

  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;

  for (const [px, py, pz] of corners) {
    const [ex, ey, ez] = transformPoint(worldTransform, px, py, pz);
    const [lon, lat] = ecefToLonLatHeight(ex, ey, ez);
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  return !(
    maxLon < roi.minLon ||
    minLon > roi.maxLon ||
    maxLat < roi.minLat ||
    minLat > roi.maxLat
  );
}

/**
 * 自动从指定 3D Tileset URL 与感兴趣区域提取建筑轮廓与高程
 */
export async function extractBuildingsFrom3DTileset(
  tilesetUrl: string,
  roi: { minLon: number; maxLon: number; minLat: number; maxLat: number },
  options?: {
    altitudeOffset?: number;
    maxTiles?: number;
    maxBuildings?: number;
  },
): Promise<BuildingFootprint[]> {
  const maxTiles = options?.maxTiles ?? 8;
  const maxBuildings = options?.maxBuildings ?? 650;
  const altitudeOffset = options?.altitudeOffset ?? 0;

  const res = await fetch(tilesetUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch tileset.json: ${res.status}`);
  }
  const tilesetJson = (await res.json()) as TilesetRootJson;
  if (!tilesetJson.root) return [];

  const baseUrl = tilesetUrl.substring(0, tilesetUrl.lastIndexOf('/') + 1);
  const candidateUris: Array<{ uri: string; transform: Mat4 }> = [];

  const walkNode = (node: TilesetNodeJson, parentTransform: Mat4) => {
    const localTransform =
      node.transform && node.transform.length === 16
        ? new Float64Array(node.transform)
        : mat4Identity();
    const worldTransform = mat4Multiply(parentTransform, localTransform);

    let intersects = true;
    if (node.boundingVolume?.box) {
      intersects = doesTileBoxIntersectRoi(node.boundingVolume.box, worldTransform, roi);
    }

    if (!intersects) return;

    const uri = node.content?.uri ?? node.contents?.[0]?.uri;
    if (uri && (uri.endsWith('.glb') || uri.endsWith('.b3dm'))) {
      candidateUris.push({ uri, transform: worldTransform });
    }

    if (node.children) {
      for (const child of node.children) {
        walkNode(child, worldTransform);
      }
    }
  };

  walkNode(tilesetJson.root, mat4Identity());

  const applyAltitudeOffset = (mat: Mat4): Mat4 => {
    if (!altitudeOffset) return mat;
    const [lon, lat] = ecefToLonLatHeight(mat[12], mat[13], mat[14]);
    const cosLat = Math.cos(lat * DEG_TO_RAD);
    const cosLon = Math.cos(lon * DEG_TO_RAD);
    const sinLat = Math.sin(lat * DEG_TO_RAD);
    const sinLon = Math.sin(lon * DEG_TO_RAD);
    const dx = cosLat * cosLon * altitudeOffset;
    const dy = cosLat * sinLon * altitudeOffset;
    const dz = sinLat * altitudeOffset;
    const next = new Float64Array(mat);
    next[12] += dx;
    next[13] += dy;
    next[14] += dz;
    return next;
  };

  const results: BuildingFootprint[] = [];
  const selectedTiles = candidateUris.slice(0, maxTiles);

  await Promise.all(
    selectedTiles.map(async ({ uri, transform }) => {
      try {
        const tileRes = await fetch(baseUrl + uri);
        if (!tileRes.ok) return;
        const buf = await tileRes.arrayBuffer();
        const extracted = parseGlbBufferToBuildings(
          buf,
          applyAltitudeOffset(transform),
          roi,
          uri,
          Math.ceil(maxBuildings / Math.max(1, selectedTiles.length)) + 60,
        );
        results.push(...extracted);
      } catch {
        // 忽略单个瓦片异常
      }
    }),
  );

  const roiCenterLon = (roi.minLon + roi.maxLon) * 0.5;
  const roiCenterLat = (roi.minLat + roi.maxLat) * 0.5;
  results.sort((a, b) => {
    const da =
      ((a.minLon + a.maxLon) * 0.5 - roiCenterLon) ** 2 +
      ((a.minLat + a.maxLat) * 0.5 - roiCenterLat) ** 2;
    const db =
      ((b.minLon + b.maxLon) * 0.5 - roiCenterLon) ** 2 +
      ((b.minLat + b.maxLat) * 0.5 - roiCenterLat) ** 2;
    return da - db;
  });

  return results.slice(0, maxBuildings);
}
