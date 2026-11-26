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
import {
  buildSparseVoxelIndexFromTileset,
  lookupFutianVoxelHeight,
  planMassiveVoxelRenderFrame,
  rasterizeGlbTrianglesToL7Columns,
  streamConformalVoxelsForViewport,
} from '../core/MassiveVoxelEngine';
import {
  buildChunkGeometryPayload,
  buildGlobalShellLineBuffers,
  buildGroundLineBuffer,
  buildViewportGridLineBuffers,
  createRuntimeTriangleLookup,
  greedyMergeBuildingBands,
  type CompactColumnInput,
  type LineGeometryBuffers,
} from '../core/VoxelBufferBuilder';
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
    extensions: {
      EXT_structural_metadata: {
        propertyTables: [{ class: 'building', count: 1 }],
      },
    },
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

test('MassiveVoxelEngine rasterizes GLB prism into L7 columns and streams conformal voxels', async () => {
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

  // Roof triangle pair covering ~40m x 40m at 120m height (CesiumLab Z-up coords cancelled by root node matrix)
  const positions = new Float32Array([
    -20, -20, 120,
    20, -20, 120,
    20, 20, 120,
    -20, 20, 120,
  ]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const featIds = new Float32Array([0, 0, 0, 0]);
  const binLen = positions.byteLength + indices.byteLength + featIds.byteLength;

  const gltfJsonObj = {
    asset: { version: '2.0' },
    extensions: {
      EXT_structural_metadata: {
        propertyTables: [{ class: 'building', count: 1 }],
      },
    },
    nodes: [
      { mesh: 0 },
      { children: [0], matrix: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1] },
    ],
    scenes: [{ nodes: [1] }],
    scene: 0,
    meshes: [
      {
        primitives: [{ attributes: { POSITION: 0, _FEATURE_ID_0: 2 }, indices: 1 }],
      },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' },
      { bufferView: 2, componentType: 5126, count: 4, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength },
      {
        buffer: 0,
        byteOffset: positions.byteLength + indices.byteLength,
        byteLength: featIds.byteLength,
      },
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
  new Uint8Array(glb, binHeader + 8 + positions.byteLength, indices.byteLength).set(
    new Uint8Array(indices.buffer),
  );
  new Uint8Array(
    glb,
    binHeader + 8 + positions.byteLength + indices.byteLength,
    featIds.byteLength,
  ).set(new Uint8Array(featIds.buffer));

  const accum = {
    featureCount: 0,
    columnMap: new Map<number, { minH: number; maxH: number }>(),
  };
  rasterizeGlbTrianglesToL7Columns(glb, enu, accum);

  assert.equal(accum.featureCount, 1);
  assert.ok(accum.columnMap.size >= 15, `expected >= 15 L7 columns, got ${accum.columnMap.size}`);
  const sampleRec = Array.from(accum.columnMap.values())[0];
  assert.ok(sampleRec.maxH > 115 && sampleRec.maxH < 125);

  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('tileset.json')) {
        return new Response(
          JSON.stringify({
            asset: { version: '1.1' },
            root: {
              transform: Array.from(enu),
              geometricError: 100,
              children: [
                {
                  geometricError: 0,
                  content: { uri: 'prism.glb' },
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(glb, { status: 200 });
    }) as typeof fetch;

    const index = await buildSparseVoxelIndexFromTileset('/mock-futian/tileset.json');
    assert.equal(index.tilesTotal, 1);
    assert.equal(index.tilesParsed, 1);
    assert.ok(index.occupiedColumnsL7 >= 15);
    assert.equal(index.virtualCapacityL8, index.virtualCapacityL7 * 512);
    assert.equal(index.virtualCapacityL10, index.virtualCapacityL8 * 262144);

    const roofHeight = lookupFutianVoxelHeight(index, 114.057868, 22.543099);
    assert.ok(roofHeight > 115 && roofHeight < 125);

    const streamedL7 = streamConformalVoxelsForViewport(
      index,
      { minLon: 114.057, maxLon: 114.059, minLat: 22.542, maxLat: 22.544 },
      900,
      {
        voxelStyle: 'height-heatmap',
        lodMode: 7,
        includeGroundCarpet: true,
        minElevationFilterMeters: 0,
      },
    );
    assert.ok(streamedL7.cells.length > 0);
    assert.ok(streamedL7.groundGrid !== null);
    assert.ok(streamedL7.groundCellCount > 0);
    assert.ok(streamedL7.cells.some((c) => c.maxHeight > 100));
    // 验证全楼高度包裹：外立面柱体必须自低矮暴露底端一直向上分带覆盖至屋顶，不可仅绘制屋顶盖
    assert.ok(
      streamedL7.cells.some((c) => c.minHeight < 5) &&
        streamedL7.cells.some((c) => c.minHeight >= 40 && c.maxHeight > 100),
      'Expected full-height building elevation bands from ground to roof',
    );
    assert.equal(validateCode(streamedL7.cells[0].code3D), true);

    // 验证最大支持 L10 (1.5cm · 32位三维编码 / 20位二维编码) 局部高清共形细分
    const streamedL10 = streamConformalVoxelsForViewport(
      index,
      { minLon: 114.0578, maxLon: 114.0579, minLat: 22.54305, maxLat: 22.54315 },
      122,
      {
        voxelStyle: 'conformal-white',
        lodMode: 10,
        includeGroundCarpet: true,
        minElevationFilterMeters: 0,
        cameraPos: { lon: 114.057868, lat: 22.54305 },
      },
    );
    assert.equal(streamedL10.activeLevel, 10);
    assert.ok(streamedL10.cells.length > 0);
    assert.ok(streamedL10.facadeColumns.length > 0);
    assert.ok(streamedL10.cells.every((c) => c.level === 10));
    const l10BuildingCell = streamedL10.cells.find((c) => c.category !== 'conformal-ground');
    assert.ok(l10BuildingCell, 'Expected L10 building conformal cell');
    assert.equal(l10BuildingCell.level, 10);
    assert.equal(l10BuildingCell.code2D.length, 20);
    assert.equal(l10BuildingCell.code3D.length, 32);
    assert.equal(validateCode(l10BuildingCell.code3D), true);

    // 验证自适应 L6-L10 在斜角视角下覆盖全视口地形与建筑，不丢失近景前景
    const streamedAuto = streamConformalVoxelsForViewport(
      index,
      { minLon: 114.05, maxLon: 114.07, minLat: 22.53, maxLat: 22.56 },
      406,
      {
        voxelStyle: 'conformal-white',
        lodMode: 'auto',
        includeGroundCarpet: true,
        minElevationFilterMeters: 0,
        cameraPos: { lon: 114.057868, lat: 22.531 },
      },
    );
    assert.ok(streamedAuto.facadeColumns.length > 0);
    assert.ok(streamedAuto.groundGrid !== null);
    assert.ok(streamedAuto.groundGrid.minLat <= 22.5301 && streamedAuto.groundGrid.maxLat >= 22.5599);

    // 验证 244Hz 分块规划器 (L7 分块池懒解析 + L10 厘米级直出)
    const planL7 = planMassiveVoxelRenderFrame(
      index,
      { minLon: 114.057, maxLon: 114.059, minLat: 22.542, maxLat: 22.544 },
      900,
      {
        voxelStyle: 'height-heatmap',
        lodMode: 7,
        includeGroundCarpet: true,
        minElevationFilterMeters: 0,
      },
    );
    assert.equal(planL7.isChunkedMode, true);
    assert.ok(planL7.visibleCacheKeys.length > 0);
    assert.ok(planL7.resolveChunkColumns(planL7.visibleCacheKeys[0]).length > 0);
    assert.ok(planL7.groundGrid !== null);

    const planL10 = planMassiveVoxelRenderFrame(
      index,
      { minLon: 114.0578, maxLon: 114.0579, minLat: 22.54305, maxLat: 22.54315 },
      122,
      {
        voxelStyle: 'conformal-white',
        lodMode: 10,
        includeGroundCarpet: true,
        minElevationFilterMeters: 0,
        cameraPos: { lon: 114.057868, lat: 22.54305 },
      },
    );
    assert.equal(planL10.isChunkedMode, false);
    assert.equal(planL10.activeLevel, 10);
    assert.ok(planL10.directFineColumns.length > 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('VoxelBufferBuilder builds valid indexed LINES and merges adjacent columns via 2D greedy meshing', () => {
  const stepLon = 0.00008;
  const stepLat = 0.00008;
  const baseLon = 114.057;
  const baseLat = 22.543;
  const cols: CompactColumnInput[] = [];

  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 3; c++) {
      cols.push({
        col: c,
        row: r,
        minLon: baseLon + c * stepLon,
        maxLon: baseLon + (c + 1) * stepLon,
        minLat: baseLat + r * stepLat,
        maxLat: baseLat + (r + 1) * stepLat,
        maxH: 30,
        baseHeight: 0,
        roofHeight: 31.4,
        layerStepMeters: 7.73,
        exposedE: c === 2,
        exposedW: c === 0,
        exposedN: r === 1,
        exposedS: r === 0,
        neighborHE: c === 2 ? 0 : 30,
        neighborHW: c === 0 ? 0 : 30,
        neighborHN: r === 1 ? 0 : 30,
        neighborHS: r === 0 ? 0 : 30,
        category: 'conformal-low',
      });
    }
  }

  // 3x2 相同高程柱体在 2D 贪心合并后，每高度分带应压缩至 1 个合并盒体（共 4 个高程带，显著少于原始 24 个）
  const merged = greedyMergeBuildingBands(cols);
  assert.ok(merged.length > 0 && merged.length <= 6, `Expected greedy merged count <= 6, got ${merged.length}`);
  assert.ok(
    merged.some((m) => Math.abs((m.maxLon - m.minLon) - 3 * stepLon) < 1e-9),
    'Expected horizontal X merge across 3 columns',
  );
  assert.ok(
    merged.some((m) => Math.abs((m.maxLat - m.minLat) - 2 * stepLat) < 1e-9),
    'Expected horizontal Y merge across 2 rows',
  );

  const wirePayload = buildChunkGeometryPayload('test-wire', cols, false);
  assert.equal(wirePayload.boxCount, 0);
  assert.equal(wirePayload.boxMatrices, null);
  assert.ok(wirePayload.facadeLines && wirePayload.facadeLines.indices.length % 2 === 0);
  assert.ok(wirePayload.roofLines && wirePayload.roofLines.indices.length % 2 === 0);
  const facadeVerts = wirePayload.facadeLines.positions.length / 3;
  for (const idx of wirePayload.facadeLines.indices) {
    assert.ok(idx < facadeVerts);
  }

  const volPayload = buildChunkGeometryPayload('test-vol', cols, true);
  assert.equal(volPayload.boxCount, merged.length);
  assert.ok(volPayload.boxMatrices && volPayload.boxMatrices.length === merged.length * 16);

  const groundBuf = buildGroundLineBuffer({
    minLon: 114.05,
    maxLon: 114.06,
    minLat: 22.54,
    maxLat: 22.55,
    stepLon: 0.002,
    stepLat: 0.002,
    elevationMeters: 0.12,
    level: 7,
  });
  assert.ok(groundBuf !== null);
  assert.equal(groundBuf.indices.length % 2, 0);
});

test('planMassiveVoxelRenderFrame strictly increases grid density and covers viewport across L7 -> L8 -> L9 -> L10', () => {
  const step7 = 0.0000833333;
  const colsPerSide = 64; // 64x64 = 4,096 L7 occupied columns (~136m city skyline density)
  const chunkMap = new Map<string, {
    key: string;
    minLon: number;
    maxLon: number;
    minLat: number;
    maxLat: number;
    maxRoofH: number;
    columns: Array<{ col: number; row: number; minH: number; maxH: number }>;
  }>();
  const columnHeightMap = new Map<number, number>();
  const anchorLon = 113.5;
  const anchorLat = 22.0;
  const baseLon = 114.05;
  const baseLat = 22.53;
  const startCol = Math.floor((baseLon - anchorLon) / step7);
  const startRow = Math.floor((baseLat - anchorLat) / step7);

  for (let r = 0; r < colsPerSide; r++) {
    for (let c = 0; c < colsPerSide; c++) {
      const col = startCol + c;
      const row = startRow + r;
      const blockId = (Math.floor(c / 4) + Math.floor(r / 4)) % 4;
      const maxH = 40 + blockId * 35;
      columnHeightMap.set((col + 32768) * 65536 + (row + 32768), maxH);
      const ckCol = Math.floor(col / 16);
      const ckRow = Math.floor(row / 16);
      const cKey = `${ckCol}_${ckRow}`;
      let chunk = chunkMap.get(cKey);
      if (!chunk) {
        chunk = {
          key: cKey,
          minLon: anchorLon + ckCol * 16 * step7,
          maxLon: anchorLon + (ckCol + 1) * 16 * step7,
          minLat: anchorLat + ckRow * 16 * step7,
          maxLat: anchorLat + (ckRow + 1) * 16 * step7,
          maxRoofH: maxH,
          columns: [],
        };
        chunkMap.set(cKey, chunk);
      } else if (maxH > chunk.maxRoofH) {
        chunk.maxRoofH = maxH;
      }
      chunk.columns.push({ col, row, minH: 0, maxH });
    }
  }

  const synthIndex = {
    level: 7 as const,
    stepLon: step7,
    stepLat: step7,
    bounds: {
      minLon: baseLon,
      maxLon: baseLon + colsPerSide * step7,
      minLat: baseLat,
      maxLat: baseLat + colsPerSide * step7,
    },
    maxHeightMeters: 180,
    tilesTotal: 15,
    tilesParsed: 15,
    featureCount: 4096,
    occupiedColumnsL7: 4096,
    occupiedVoxelsL7: 40960,
    virtualCapacityL7: 409600,
    virtualCapacityL8: 1000000,
    virtualCapacityL10: 100000000,
    parseTimeMs: 120,
    columnHeightMap,
    chunks: Array.from(chunkMap.values()),
  };

  const skylineViewport = synthIndex.bounds;
  const runPlan = (lodMode: 7 | 8 | 9 | 10, camHeight = 136, pitchDeg?: number) =>
    planMassiveVoxelRenderFrame(synthIndex, skylineViewport, camHeight, {
      voxelStyle: 'height-heatmap',
      lodMode,
      includeGroundCarpet: true,
      minElevationFilterMeters: 0,
      cameraPos: { lon: baseLon + 0.0005, lat: baseLat + 0.0003 },
      cameraHeadingDeg: 0,
      cameraPitchDeg: pitchDeg,
    });

  const p7 = runPlan(7);
  const p8 = runPlan(8);
  const p9 = runPlan(9);
  const p10 = runPlan(10);

  const total7 = p7.estimatedVisibleCols + p7.groundCellCount;
  const total8 = p8.estimatedVisibleCols + p8.groundCellCount;
  const total9 = p9.estimatedVisibleCols + p9.groundCellCount;
  const total10 = p10.estimatedVisibleCols + p10.groundCellCount;

  assert.ok(
    p8.estimatedVisibleCols > p7.estimatedVisibleCols &&
      p9.estimatedVisibleCols > p8.estimatedVisibleCols &&
      p10.estimatedVisibleCols > p9.estimatedVisibleCols,
    `Expected strictly increasing building cols: L7=${p7.estimatedVisibleCols}, L8=${p8.estimatedVisibleCols}, L9=${p9.estimatedVisibleCols}, L10=${p10.estimatedVisibleCols}`,
  );
  assert.ok(
    total7 < total8 && total8 < total9 && total9 < total10,
    `Expected strictly increasing total rendered voxels: L7=${total7}, L8=${total8}, L9=${total9}, L10=${total10}`,
  );
  // 同一城市视口下，L8/L9/L10 全景建筑柱不低于原始 4,096 根覆盖且前景细分展开有效
  assert.equal(p8.directFineColumns.length, 4096);
  assert.equal(p8.directFineColumns[0].subDiv, 8);
  assert.ok((p9.directFineColumns[0].subDiv ?? 1) >= 32);
  assert.ok((p10.directFineColumns[0].subDiv ?? 1) >= 64);

  // 低仰角斜视（视口向北延展至远方地平线）时，最高细化网格必须牢牢锁定在近相机前景建筑，绝不能向远方漂移
  const longHorizonBounds = {
    minLon: baseLon - 0.002,
    maxLon: baseLon + colsPerSide * step7 + 0.002,
    minLat: baseLat,
    maxLat: baseLat + 0.04, // ~4.4km 远处地平线
  };
  const shallowObliqueL10 = planMassiveVoxelRenderFrame(synthIndex, longHorizonBounds, 197, {
    voxelStyle: 'height-heatmap',
    lodMode: 10,
    includeGroundCarpet: true,
    minElevationFilterMeters: 0,
    cameraPos: { lon: baseLon + 0.0025, lat: baseLat - 0.0005 },
    cameraHeadingDeg: 0,
    cameraPitchDeg: -18,
  });
  const fineCols = shallowObliqueL10.directFineColumns.filter((c) => (c.subDiv ?? 1) >= 32);
  const coarseFarCols = shallowObliqueL10.directFineColumns.filter(
    (c) => (c.subDiv ?? 1) <= 8 && c.minLat > baseLat + 0.004,
  );
  assert.ok(fineCols.length > 0, 'Expected foreground fine columns in shallow oblique view');
  assert.ok(coarseFarCols.length > 0, 'Expected coarser far columns at horizon');
  assert.ok(
    fineCols.every((c) => c.maxLat < baseLat + 0.003),
    'Refined subDiv >= 32 columns must stay anchored near camera foreground, not drift toward far horizon',
  );

  // Worker payload 在混合 subDiv (64/32/16/8/4/1) + 2D 贪心合并下必须生成合规索引几何
  const payload10 = buildChunkGeometryPayload('skyline-l10', p10.directFineColumns, true);
  assert.ok(payload10.facadeLines && payload10.facadeLines.indices.length % 2 === 0);
  assert.ok(payload10.roofLines && payload10.roofLines.indices.length % 2 === 0);
  assert.ok(payload10.boxCount > 0 && payload10.boxCount < 4096);

  // 自定义高程梯度颜色阈值应准确隔离缓存键并触发对应高度分级切片
  const customPlan = planMassiveVoxelRenderFrame(synthIndex, skylineViewport, 200, {
    voxelStyle: 'height-heatmap',
    lodMode: 7,
    includeGroundCarpet: false,
    minElevationFilterMeters: 0,
    elevationThresholds: [20, 50, 90],
  });
  assert.ok(customPlan.visibleCacheKeys[0].includes('t20_50_90'));
  const customPayload = buildChunkGeometryPayload(
    'custom-thresholds',
    customPlan.resolveChunkColumns(customPlan.visibleCacheKeys[0]),
    true,
    [20, 50, 90],
  );
  assert.ok(
    customPayload.boxCategories.includes('conformal-super'),
    'Expected heights >= 90m to classify as conformal-super under [20, 50, 90]',
  );

  // L6 及远景大范围 (>220 宏块) 必须切换为全合并单批次 (isChunkedMode=false) 以避免千次 DrawCall 掉帧
  const p6SingleBatch = planMassiveVoxelRenderFrame(synthIndex, skylineViewport, 6500, {
    voxelStyle: 'height-heatmap',
    lodMode: 6,
    includeGroundCarpet: true,
    minElevationFilterMeters: 0,
  });
  assert.equal(p6SingleBatch.isChunkedMode, false);
  assert.ok(p6SingleBatch.directFineColumns.length > 0 && p6SingleBatch.directFineColumns.length < 4096);

  // 远景超 220 宏块 (模拟 13km 全福田全景) 时，L7 与自适应模式均自动切换单批合批，L10 走近 180 块+L6 远景金字塔
  const wideChunks: typeof synthIndex.chunks = [];
  const wideMap = new Map<number, number>();
  for (let cr = 0; cr < 16; cr++) {
    for (let cc = 0; cc < 16; cc++) {
      const col = startCol + cc * 16;
      const row = startRow + cr * 16;
      wideMap.set((col + 32768) * 65536 + (row + 32768), 80);
      wideChunks.push({
        key: `${Math.floor(col / 16)}_${Math.floor(row / 16)}`,
        minLon: anchorLon + col * step7,
        maxLon: anchorLon + (col + 16) * step7,
        minLat: anchorLat + row * step7,
        maxLat: anchorLat + (row + 16) * step7,
        maxRoofH: 80,
        columns: [{ col, row, minH: 0, maxH: 80 }],
      });
    }
  }
  const wideIndex = {
    ...synthIndex,
    bounds: {
      minLon: wideChunks[0].minLon,
      maxLon: wideChunks[wideChunks.length - 1].maxLon,
      minLat: wideChunks[0].minLat,
      maxLat: wideChunks[wideChunks.length - 1].maxLat,
    },
    columnHeightMap: wideMap,
    chunks: wideChunks,
  };
  const wideL7 = planMassiveVoxelRenderFrame(wideIndex, wideIndex.bounds, 13500, {
    voxelStyle: 'height-heatmap',
    lodMode: 7,
    includeGroundCarpet: true,
    minElevationFilterMeters: 0,
  });
  assert.equal(wideL7.isChunkedMode, false);
  assert.equal(wideL7.directFineColumns.length, 256);

  const wideL8 = planMassiveVoxelRenderFrame(wideIndex, wideIndex.bounds, 13500, {
    voxelStyle: 'height-heatmap',
    lodMode: 8,
    includeGroundCarpet: true,
    minElevationFilterMeters: 0,
  });
  assert.equal(wideL8.isChunkedMode, false);
  assert.equal(wideL8.directFineColumns.length, 256);

  const wideL10 = planMassiveVoxelRenderFrame(wideIndex, wideIndex.bounds, 13500, {
    voxelStyle: 'height-heatmap',
    lodMode: 10,
    includeGroundCarpet: true,
    minElevationFilterMeters: 0,
  });
  assert.equal(wideL10.isChunkedMode, false);
  assert.ok(wideL10.directFineColumns.length === 256);
});

test('Tight conformal triangle rasterization shrinks L8/L9 envelope strictly to real building walls', () => {
  const step7 = 0.0000833333; // ~7.73m at Shenzhen
  const anchorLon = 113.5;
  const anchorLat = 22.0;
  const parentCol = Math.floor((114.0636 - anchorLon) / step7);
  const parentRow = Math.floor((22.5372 - anchorLat) / step7);
  const pMinLon = anchorLon + parentCol * step7;
  const pMaxLon = pMinLon + step7;
  const pMinLat = anchorLat + parentRow * step7;
  const pMaxLat = pMinLat + step7;

  // 在 7.73m x 7.73m 的 L7 父格子正中放置一条仅 ~2m 宽的瘦高楼栋屋顶三角面 (前后左右留下大片空地)
  const slimMinLon = pMinLon + step7 * 0.375;
  const slimMaxLon = pMinLon + step7 * 0.625; // 宽度仅有父块的 25% (~1.93m)
  const slimMinLat = pMinLat + step7 * 0.125;
  const slimMaxLat = pMinLat + step7 * 0.875;

  const toI32Lon = (lon: number) => Math.round((lon - anchorLon) * 1e9);
  const toI32Lat = (lat: number) => Math.round((lat - anchorLat) * 1e9);
  const triData = new Int32Array([
    toI32Lon(slimMinLon), toI32Lat(slimMinLat), 50_000,
    toI32Lon(slimMaxLon), toI32Lat(slimMinLat), 50_000,
    toI32Lon(slimMaxLon), toI32Lat(slimMaxLat), 50_000,
    toI32Lon(slimMinLon), toI32Lat(slimMinLat), 50_000,
    toI32Lon(slimMaxLon), toI32Lat(slimMaxLat), 50_000,
    toI32Lon(slimMinLon), toI32Lat(slimMaxLat), 50_000,
  ]);
  const cChunk = Math.floor(parentCol / 16);
  const rChunk = Math.floor(parentRow / 16);
  const triLookup = createRuntimeTriangleLookup({
    triData,
    triCount: 2,
    chunkKeys: [`${cChunk}_${rChunk}`],
    chunkOffsets: new Uint32Array([0, 2]),
    chunkTriIndices: new Uint32Array([0, 1]),
  });

  const parentColInput: CompactColumnInput = {
    col: parentCol,
    row: parentRow,
    minLon: pMinLon,
    maxLon: pMaxLon,
    minLat: pMinLat,
    maxLat: pMaxLat,
    maxH: 50,
    baseHeight: 0,
    roofHeight: 50.24,
    layerStepMeters: 1.93,
    exposedE: true,
    exposedW: true,
    exposedN: true,
    exposedS: true,
    neighborHE: 0,
    neighborHW: 0,
    neighborHN: 0,
    neighborHS: 0,
    category: 'conformal-mid',
    subDiv: 8,
    sxStart: 0,
    sxEnd: 7,
    syStart: 0,
    syEnd: 7,
  };

  const payload = buildChunkGeometryPayload(
    'tight-l8-test',
    [parentColInput],
    true,
    [45, 120, 210],
    triLookup,
  );
  // 8x8 = 64 个 L8 子格中，瘦楼只应占据核心区域 (约 2~3 列 x 6~7 行 = 12~24 格)，绝对不可把两侧空草地算成 64 格
  assert.ok(
    payload.occupiedColCount !== undefined &&
      payload.occupiedColCount > 0 &&
      payload.occupiedColCount <= 28,
    `Expected tightened occupiedColCount <= 28 inside 64 sub-cells, got ${payload.occupiedColCount}`,
  );
  assert.ok(payload.boxCount > 0 && payload.boxMatrices);
  assert.ok(payload.roofLines && payload.roofLines.indices.length > 0);
  // 验证包络盒经度中心位移和尺寸严格收缩（box 中心与宽度紧贴瘦高建筑而非膨胀满 7.73m）
  const firstBoxTx = payload.boxMatrices[12];
  const firstBoxTy = payload.boxMatrices[13];
  const firstBoxTz = payload.boxMatrices[14];
  const firstScaleX = Math.hypot(
    payload.boxMatrices[0],
    payload.boxMatrices[1],
    payload.boxMatrices[2],
  );
  assert.ok(Number.isFinite(firstBoxTx) && Number.isFinite(firstBoxTy) && Number.isFinite(firstBoxTz));
  assert.ok(
    firstScaleX > 1.5 && firstScaleX < 4.0,
    `Expected tight slab box X width ~2-3m (< 4m), got ${firstScaleX.toFixed(2)}m`,
  );
});

test('L8/L9/L10 chunk-aligned near budget leaves zero mid-ring bare building gaps', () => {
  const step7 = 0.0000833333;
  const anchorLon = 113.5;
  const anchorLat = 22.0;
  const baseChunkCol = Math.floor((114.04 - anchorLon) / (step7 * 16));
  const baseChunkRow = Math.floor((22.52 - anchorLat) / (step7 * 16));

  const buildDenseCity = (chunkSideCount: number) => {
    const chunks: Array<{
      key: string;
      minLon: number;
      maxLon: number;
      minLat: number;
      maxLat: number;
      maxRoofH: number;
      columns: Array<{ col: number; row: number; minH: number; maxH: number }>;
    }> = [];
    const columnHeightMap = new Map<number, number>();
    const expectedL6Keys = new Set<string>();

    for (let cr = 0; cr < chunkSideCount; cr++) {
      for (let cc = 0; cc < chunkSideCount; cc++) {
        const chunkCol = baseChunkCol + cc;
        const chunkRow = baseChunkRow + cr;
        const cols: Array<{ col: number; row: number; minH: number; maxH: number }> = [];
        for (let rOff = 1; rOff < 16; rOff += 2) {
          for (let cOff = 1; cOff < 16; cOff += 2) {
            const col = chunkCol * 16 + cOff;
            const row = chunkRow * 16 + rOff;
            const h = 95;
            cols.push({ col, row, minH: 0, maxH: h });
            columnHeightMap.set((col + 32768) * 65536 + (row + 32768), h);
            expectedL6Keys.add(`${Math.floor(col / 8)}_${Math.floor(row / 8)}`);
          }
        }
        chunks.push({
          key: `${chunkCol}_${chunkRow}`,
          minLon: anchorLon + chunkCol * 16 * step7,
          maxLon: anchorLon + (chunkCol + 1) * 16 * step7,
          minLat: anchorLat + chunkRow * 16 * step7,
          maxLat: anchorLat + (chunkRow + 1) * 16 * step7,
          maxRoofH: 95,
          columns: cols,
        });
      }
    }

    const totalCols = chunks.length * 64;
    return {
      index: {
        level: 7 as const,
        stepLon: step7,
        stepLat: step7,
        bounds: {
          minLon: chunks[0].minLon,
          maxLon: chunks[chunks.length - 1].maxLon,
          minLat: chunks[0].minLat,
          maxLat: chunks[chunks.length - 1].maxLat,
        },
        maxHeightMeters: 150,
        tilesTotal: 15,
        tilesParsed: 15,
        featureCount: totalCols,
        occupiedColumnsL7: totalCols,
        occupiedVoxelsL7: totalCols * 5,
        virtualCapacityL7: totalCols,
        virtualCapacityL8: totalCols * 64,
        virtualCapacityL10: totalCols * 262144,
        parseTimeMs: 1,
        columnHeightMap,
        chunks,
      },
      expectedL6Keys,
    };
  };

  const verifyZeroGaps = (
    name: string,
    city: ReturnType<typeof buildDenseCity>,
    cameraHeightMeters: number,
    lodMode: 8 | 9 | 10,
  ) => {
    const plan = planMassiveVoxelRenderFrame(city.index, city.index.bounds, cameraHeightMeters, {
      voxelStyle: 'height-heatmap',
      lodMode,
      includeGroundCarpet: false,
      minElevationFilterMeters: 0,
    });
    assert.equal(plan.isChunkedMode, false, `${name}: expected direct/macro combined batch`);
    const coveredL6Keys = new Set<string>();
    const l6Step = step7 * 8;
    let fineColCount = 0;
    let macroL6Count = 0;
    for (const c of plan.directFineColumns) {
      const midLon = (c.minLon + c.maxLon) * 0.5;
      const midLat = (c.minLat + c.maxLat) * 0.5;
      const l6Col = Math.floor((midLon - anchorLon) / l6Step);
      const l6Row = Math.floor((midLat - anchorLat) / l6Step);
      coveredL6Keys.add(`${l6Col}_${l6Row}`);
      if (c.maxLon - c.minLon > step7 * 4) {
        macroL6Count++;
      } else {
        fineColCount++;
      }
    }
    assert.ok(fineColCount > 0 && fineColCount <= 6500, `${name}: fine cols bounded (${fineColCount})`);
    assert.ok(macroL6Count > 0, `${name}: expected outer L6 fallback (${macroL6Count})`);
    for (const key of city.expectedL6Keys) {
      assert.ok(coveredL6Keys.has(key), `${name}: missing coverage at L6 cell ${key}`);
    }
  };

  // Scene A: <= 180 chunks (144 chunks) yet > 6,500 columns (9,216 L7 columns)
  const denseCompactCity = buildDenseCity(12);
  verifyZeroGaps('Dense-144ch-L8', denseCompactCity, 1727, 8);
  verifyZeroGaps('Dense-144ch-L9', denseCompactCity, 673, 9);

  // Scene B: > 180 chunks (400 chunks, 25,600 L7 columns), mirroring mid/far panoramic L10
  const wideDenseCity = buildDenseCity(20);
  verifyZeroGaps('Wide-400ch-L8', wideDenseCity, 1727, 8);
  verifyZeroGaps('Wide-400ch-L10', wideDenseCity, 11500, 10);
});

test('buildGlobalShellLineBuffers & buildViewportGridLineBuffers produce valid indexed LINES for 1.1 Global', () => {
  const assertValidLines = (buf: LineGeometryBuffers | null, label: string) => {
    assert.ok(buf !== null, `${label}: expected non-null line buffers`);
    const vCount = buf.positions.length / 3;
    assert.equal(buf.positions.length % 3, 0);
    assert.equal(buf.indices.length % 2, 0);
    assert.ok(vCount >= 2 && buf.indices.length >= 2);
    for (let i = 0; i < buf.positions.length; i++) {
      assert.ok(Number.isFinite(buf.positions[i]), `${label}: non-finite coordinate`);
    }
    for (let i = 0; i < buf.indices.length; i++) {
      assert.ok(buf.indices[i] < vCount, `${label}: index out of bounds`);
    }
    assert.ok(
      Number.isFinite(buf.boundingRadius) && buf.boundingRadius > 0,
      `${label}: valid boundingRadius`,
    );
  };

  // L1 全球 4 层球壳与立柱
  const shell = buildGlobalShellLineBuffers({
    minLon: -180,
    maxLon: 180,
    minLat: -84,
    maxLat: 84,
    stepLon: 6,
    stepLat: 4,
    layerAlts: [15_000, 320_000, 640_000, 960_000],
    arcStepDeg: 3,
  });
  assertValidLines(shell.innerLines, 'L1-inner');
  assertValidLines(shell.outerLines, 'L1-outer');
  assertValidLines(shell.pillarLines, 'L1-pillars');
  assert.equal(shell.outerLines!.indices.length / 2, 43 * 120 + 60 * 84);
  assert.equal(shell.pillarLines!.indices.length / 2, 43 * 60);
  assert.ok(shell.outerLines!.boundingRadius > 6_000_000);

  // L2-L10 视口网格（规则正交快速路径 arcSubdiv=1）
  const lons = Array.from({ length: 60 }, (_, i) => 114.0 + i * 0.001);
  const lats = Array.from({ length: 50 }, (_, j) => 22.5 + j * 0.001);
  const vpFast = buildViewportGridLineBuffers({
    lons,
    lats,
    layerAlts: [1.5, 11.5, 21.5, 31.5],
    arcSubdiv: 1,
    includePillars: true,
    pillarStep: 2,
  });
  assertValidLines(vpFast.baseLines, 'VP-fast-base');
  assertValidLines(vpFast.midLines, 'VP-fast-mid');
  assertValidLines(vpFast.topLines, 'VP-fast-top');
  assertValidLines(vpFast.pillarLines, 'VP-fast-pillars');
  assert.equal(vpFast.baseLines!.positions.length / 3, 60 * 50);
  assert.equal(vpFast.baseLines!.indices.length / 2, 50 * 59 + 60 * 49);

  // L2-L3 曲线细分路径 arcSubdiv=4
  const vpCurved = buildViewportGridLineBuffers({
    lons: [100, 106, 112],
    lats: [20, 24, 28],
    layerAlts: [80, 1080],
    arcSubdiv: 4,
    includePillars: true,
    pillarStep: 1,
  });
  assertValidLines(vpCurved.baseLines, 'VP-curved-base');
  assertValidLines(vpCurved.topLines, 'VP-curved-top');
  assertValidLines(vpCurved.pillarLines, 'VP-curved-pillars');
  assert.equal(vpCurved.midLines, null);
});

