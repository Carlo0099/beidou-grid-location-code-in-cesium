import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BeidouGridCode,
  decode2D,
  decode3D,
  encode2D,
  encode3D,
  extract2DCode,
  getNeighbors,
  recommendLevelFromAltitude,
  validateCode,
} from '../core/BeidouGridCode';
import {
  analyzeFlightPlanAndDetour,
  enumerate2DGridsInBounds,
  tracePathToBeidouGrids,
} from '../core/BeidouGridEngine';
import { voxelizeBuildingsToBeidouAirspace } from '../core/AirspaceVoxelizer';
import {
  createConflictFlightRouteAt,
  createSampleCbdBuildings,
} from '../core/SampleCityData';
import {
  extractWgs84PointsFromGeoJson,
  generatePathGridsPure,
} from '../api/BeidouGridApi';
import {
  computeConvexHull2D,
  parseGlbBufferToBuildings,
} from '../core/TilesetBuildingExtractor';
import type { GridLevel } from '../types/beidou';

test('2D & 3D Beidou encoding/decoding roundtrips cleanly across levels 1-10', () => {
  const samples = [
    { lat: 39.99316111, lon: 116.31260278, h: 120 },
    { lat: 22.543099, lon: 114.057868, h: 61.84 },
    { lat: -33.8688, lon: 151.2093, h: 45 },
    { lat: 40.7128, lon: -74.006, h: 250 },
  ];

  for (const s of samples) {
    for (let lv = 1; lv <= 10; lv++) {
      const level = lv as GridLevel;
      const c2 = encode2D(s.lat, s.lon, level);
      const b2 = decode2D(c2);
      assert.equal(b2.level, level);
      assert.ok(
        s.lat >= b2.minLat - 1e-9 && s.lat <= b2.maxLat + 1e-9,
        `L${level} lat ${s.lat} not in [${b2.minLat}, ${b2.maxLat}]`,
      );
      assert.ok(
        s.lon >= b2.minLon - 1e-9 && s.lon <= b2.maxLon + 1e-9,
        `L${level} lon ${s.lon} not in [${b2.minLon}, ${b2.maxLon}]`,
      );

      const c3 = encode3D(s.lat, s.lon, s.h, level);
      assert.equal(extract2DCode(c3), c2, `L${level} extract2DCode mismatch`);
      assert.equal(validateCode(c3), true);

      const b3 = decode3D(c3);
      assert.equal(b3.level, level);
      assert.ok(
        s.h >= b3.minHeight - 1e-4 && s.h <= b3.maxHeight + 1e-4,
        `L${level} height ${s.h} not in [${b3.minHeight}, ${b3.maxHeight}]`,
      );
    }
  }
});

test('Beijing L10 reference code matches GB/T 39409-2020 sample', () => {
  const c3 = encode3D(39.99316111, 116.31260278, 0, 10);
  assert.equal(c3, 'N050J0047050390B8020550340610520');
  assert.equal(extract2DCode(c3), 'N50J47539B8255346152');
  assert.equal(BeidouGridCode.encode2D(39.99316111, 116.31260278, 5), 'N50J47539B8');
});

test('getNeighbors returns distinct valid 2D and 3D neighbor codes', () => {
  const c3 = encode3D(22.543099, 114.057868, 120, 7);
  const n = getNeighbors(c3);
  assert.ok(n.north && n.north !== c3);
  assert.ok(n.south && n.south !== c3);
  assert.ok(n.east && n.east !== c3);
  assert.ok(n.west && n.west !== c3);
  assert.ok(n.up && n.up !== c3);
  assert.ok(n.down && n.down !== c3);
  assert.equal(validateCode(n.up!), true);
});

test('enumerate2DGridsInBounds covers bounding area without duplicates', () => {
  const cells = enumerate2DGridsInBounds(
    { minLon: 114.05, maxLon: 114.06, minLat: 22.54, maxLat: 22.55 },
    6,
    { maxCells: 500 },
  );
  assert.ok(cells.length > 10);
  const uniqueCodes = new Set(cells.map((c) => c.code2D));
  assert.equal(uniqueCodes.size, cells.length);
});

test('Building voxelization generates obstacle + buffer voxels and detects flight conflicts + detour', () => {
  const buildings = createSampleCbdBuildings(114.057868, 22.543099);
  const roi = {
    minLon: 114.052,
    maxLon: 114.064,
    minLat: 22.538,
    maxLat: 22.548,
  };

  const vox = voxelizeBuildingsToBeidouAirspace(buildings, roi, {
    level: 7,
    verticalStepMeters: 15,
    horizontalBufferMeters: 15,
    verticalBufferMeters: 15,
    minAirspaceHeight: 0,
    maxAirspaceHeight: 360,
    includeAirspaceStrata: true,
    maxVoxels: 4500,
  });

  assert.ok(vox.obstacleCells.length > 50, 'should generate building obstacle voxels');
  assert.ok(vox.bufferCells.length > 50, 'should generate buffer voxels');
  assert.ok(vox.airspaceStrataCells.length > 10, 'should generate strata cells');

  // 穿楼测试航线应触发避障冲突并成功规划绿色无冲突绕飞航线
  const crossFlight = createConflictFlightRouteAt(114.057868, 22.543099);
  const analysis = analyzeFlightPlanAndDetour(
    crossFlight,
    vox.obstacleCells,
    vox.bufferCells,
    {
      level: 7,
      verticalStepMeters: 15,
      corridorRadiusMeters: 15,
      maxAirspaceHeight: 360,
    },
  );

  assert.equal(analysis.isSafe, false, 'low-altitude cross-CBD route must hit obstacles');
  assert.ok(analysis.summary.conflictCount + analysis.summary.bufferWarningCount > 0);
  assert.equal(analysis.summary.hasDetour, true, 'must compute A* detour route');
  assert.ok(analysis.detourWaypoints.length >= 2);
});

test('Dynamic WGS84 path & GeoJSON API generates multi-level Beidou grid codes', () => {
  const geoJson = {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: [
        [114.0532, 22.5402, 120],
        [114.0595, 22.5441, 165],
      ],
    },
  };
  const pts = extractWgs84PointsFromGeoJson(geoJson);
  assert.equal(pts.length, 2);

  const trace = tracePathToBeidouGrids(pts, 6);
  assert.ok(trace.length >= 4);

  const resp = generatePathGridsPure({
    coordinates: pts,
    levels: [5, 6, 7],
    layerStyle: 'translucent-volume',
    corridorRadiusMeters: 10,
  });
  assert.equal(resp.levels.length, 3);
  assert.ok(resp.levels[2].cellCount >= resp.levels[1].cellCount);
  assert.ok(resp.levels[0].codes3D.every((c) => validateCode(c)));
});

test('TilesetBuildingExtractor extracts convex hull footprints from binary GLB', () => {
  const hull = computeConvexHull2D([
    [0, 0],
    [2, 0],
    [1, 0.5],
    [2, 2],
    [0, 2],
  ]);
  assert.equal(hull.length, 4);

  // Build minimal valid GLB at Shenzhen Futian ECEF origin
  const lonRad = (114.057868 * Math.PI) / 180;
  const latRad = (22.543099 * Math.PI) / 180;
  const a = 6378137;
  const e2 = 1 - (1 - 1 / 298.257223563) ** 2;
  const N = a / Math.sqrt(1 - e2 * Math.sin(latRad) ** 2);
  const ox = N * Math.cos(latRad) * Math.cos(lonRad);
  const oy = N * Math.cos(latRad) * Math.sin(lonRad);
  const oz = N * (1 - e2) * Math.sin(latRad);

  const sinLon = Math.sin(lonRad);
  const cosLon = Math.cos(lonRad);
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const enu = new Float64Array([
    -sinLon, cosLon, 0, 0,
    -sinLat * cosLon, -sinLat * sinLon, cosLat, 0,
    cosLat * cosLon, cosLat * sinLon, sinLat, 0,
    ox, oy, oz, 1,
  ]);

  const positions = new Float32Array([
    -15, -15, 0,
    15, -15, 0,
    15, 15, 0,
    -15, 15, 0,
    -15, -15, 120,
    15, 15, 120,
  ]);
  const featIds = new Float32Array([1, 1, 1, 1, 1, 1]);
  const binLen = positions.byteLength + featIds.byteLength;

  const gltfJsonObj = {
    asset: { version: '2.0' },
    nodes: [
      { mesh: 0 },
      { children: [0], matrix: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1] },
    ],
    scenes: [{ nodes: [1] }],
    scene: 0,
    meshes: [
      {
        primitives: [{ attributes: { POSITION: 0, _FEATURE_ID_0: 1 } }],
      },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 6, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 6, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: featIds.byteLength },
    ],
    buffers: [{ byteLength: binLen }],
  };

  let jsonStr = JSON.stringify(gltfJsonObj);
  while (Buffer.byteLength(jsonStr, 'utf8') % 4 !== 0) jsonStr += ' ';
  const jsonBuf = Buffer.from(jsonStr, 'utf8');

  const totalLen = 12 + 8 + jsonBuf.byteLength + 8 + binLen;
  const glb = new ArrayBuffer(totalLen);
  const dv = new DataView(glb);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, totalLen, true);
  dv.setUint32(12, jsonBuf.byteLength, true);
  dv.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(glb, 20, jsonBuf.byteLength).set(jsonBuf);

  const binHeader = 20 + jsonBuf.byteLength;
  dv.setUint32(binHeader, binLen, true);
  dv.setUint32(binHeader + 4, 0x004e4942, true);
  new Uint8Array(glb, binHeader + 8, positions.byteLength).set(
    new Uint8Array(positions.buffer),
  );
  new Uint8Array(glb, binHeader + 8 + positions.byteLength, featIds.byteLength).set(
    new Uint8Array(featIds.buffer),
  );

  const extracted = parseGlbBufferToBuildings(
    glb,
    enu,
    { minLon: 114.05, maxLon: 114.07, minLat: 22.53, maxLat: 22.55 },
    'test.glb',
    10,
  );
  assert.equal(extracted.length, 1);
  assert.ok(extracted[0].roofHeight > 115 && extracted[0].roofHeight < 125);
  assert.equal(extracted[0].polygon.length, 4);
});

test('recommendLevelFromAltitude adapts across all levels 1 to 10', () => {
  const altitudes = [
    5_000_000,
    500_000,
    120_000,
    18_000,
    1_500,
    400,
    80,
    10,
    2,
    0.4,
  ];
  const levels = altitudes.map((h) => recommendLevelFromAltitude(h));
  assert.deepEqual(levels, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

