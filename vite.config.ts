import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import cesium from 'vite-plugin-cesium';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  decode2D,
  decode3D,
  encode2D,
  encode3D,
  getGridBounds,
} from './src/core/BeidouGridCode';
import { generatePathGridsPure } from './src/core/BeidouGridEngine';
import type { GridLevel, PathGridGenerationRequest } from './src/types/beidou';

interface LocalGisRoots {
  tiles3dGzip: string;
  tiles3dRaw: string;
  tiles: string;
  terrain: string;
}

function resolveOptionalDir(rawPath: string | undefined, fallbackRelative: string): string {
  const trimmed = (rawPath ?? '').trim();
  return path.resolve(trimmed || fallbackRelative);
}

function safeResolveWithin(rootDir: string, relativePath: string): string | null {
  const cleanRel = relativePath.replace(/^[/\\]+/, '');
  const resolved = path.resolve(rootDir, cleanRel);
  const rootPrefix = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;
  if (resolved !== rootDir && !resolved.startsWith(rootPrefix)) {
    return null;
  }
  return resolved;
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(data));
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let totalLen = 0;
    req.on('data', (chunk: Uint8Array) => {
      chunks.push(chunk);
      totalLen += chunk.byteLength;
    });
    req.on('end', () => {
      const merged = new Uint8Array(totalLen);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
      }
      resolve(new TextDecoder().decode(merged));
    });
    req.on('error', reject);
  });
}

function serveFileWithGzip(
  res: ServerResponse,
  filePath: string,
  contentType: string,
  method = 'GET',
) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=3600');

  try {
    const head = new Uint8Array(2);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    if (head[0] === 0x1f && head[1] === 0x8b) {
      res.setHeader('Content-Encoding', 'gzip');
    }
  } catch {
    // ignore
  }

  if (method === 'HEAD') {
    res.statusCode = 200;
    return res.end();
  }
  return fs.createReadStream(filePath).pipe(res);
}

/**
 * 本地可选 GIS / 3D Tiles 静态托管与北斗网格化 REST API 中间件
 * 所有本地数据目录均通过环境变量注入，未配置时自动降级至项目内 ./data 目录与内置示范数据
 */
function beidouAndLocalGisPlugin(gisRoots: LocalGisRoots): Plugin {
  const attachMiddleware = (middlewares: {
    use: (
      handler: (
        req: IncomingMessage,
        res: ServerResponse,
        next: () => void,
      ) => void,
    ) => void;
  }) => {
    middlewares.use(async (req, res, next) => {
      const reqUrl = req.url ?? '/';
      const parsed = new URL(reqUrl, 'http://localhost');
      const pathname = decodeURIComponent(parsed.pathname);

      // 1. 本地 GIS 与 3D Tiles 资产探测
      if (pathname === '/api/local-assets/status') {
        const has3dTile = (name: string) =>
          fs.existsSync(path.join(gisRoots.tiles3dGzip, name, 'tileset.json')) ||
          fs.existsSync(path.join(gisRoots.tiles3dRaw, name, 'tileset.json'));

        return sendJson(res, 200, {
          tiles: fs.existsSync(gisRoots.tiles),
          terrain: fs.existsSync(path.join(gisRoots.terrain, 'layer.json')),
          tilesets: {
            shenzhen: has3dTile('shenzhen'),
            luohu: has3dTile('luohu'),
            guangzhou: has3dTile('guangzhou'),
            hongkong: has3dTile('hongkong'),
            macau: has3dTile('macau'),
          },
        });
      }

      // 2. 北斗网格编码 REST API (1.3 需求接口)
      if (pathname === '/api/beidou/health') {
        return sendJson(res, 200, {
          ok: true,
          standard: 'GB/T 39409-2020 & GB/T 20254',
          endpoints: [
            'POST /api/beidou/encode',
            'GET /api/beidou/decode?code=...',
            'POST /api/beidou/path-grids',
          ],
        });
      }

      if (pathname === '/api/beidou/encode' && req.method === 'POST') {
        try {
          const body = JSON.parse(await readRequestBody(req)) as {
            lon: number;
            lat: number;
            height?: number;
            level?: GridLevel;
          };
          const level = (body.level ?? 6) as GridLevel;
          const height = body.height ?? 0;
          const code2D = encode2D(body.lat, body.lon, level);
          const code3D = encode3D(body.lat, body.lon, height, level);
          return sendJson(res, 200, {
            code2D,
            code3D,
            bounds2D: decode2D(code2D),
            bounds3D: decode3D(code3D),
          });
        } catch (err) {
          return sendJson(res, 400, {
            error: err instanceof Error ? err.message : 'Invalid encode payload',
          });
        }
      }

      if (pathname === '/api/beidou/decode' && req.method === 'GET') {
        try {
          const code = parsed.searchParams.get('code') ?? '';
          return sendJson(res, 200, getGridBounds(code));
        } catch (err) {
          return sendJson(res, 400, {
            error: err instanceof Error ? err.message : 'Invalid code',
          });
        }
      }

      if (pathname === '/api/beidou/path-grids' && req.method === 'POST') {
        try {
          const body = JSON.parse(
            await readRequestBody(req),
          ) as PathGridGenerationRequest;
          const result = generatePathGridsPure(body);
          return sendJson(res, 200, result);
        } catch (err) {
          return sendJson(res, 400, {
            error: err instanceof Error ? err.message : 'Invalid path-grids payload',
          });
        }
      }

      // 3. 本地可选 3D Tiles 静态服务 (/3dtiles_data/*)
      if (pathname.startsWith('/3dtiles_data/')) {
        const rel = pathname.replace(/^\/3dtiles_data\//, '');
        let filePath = safeResolveWithin(gisRoots.tiles3dGzip, rel);
        if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          filePath = safeResolveWithin(gisRoots.tiles3dRaw, rel);
        }
        if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ct = filePath.endsWith('.json')
            ? 'application/json'
            : filePath.endsWith('.glb')
              ? 'model/gltf-binary'
              : 'application/octet-stream';
          return serveFileWithGzip(res, filePath, ct, req.method);
        }
      }

      // 4. 本地可选离线影像瓦片 (/tiles/*)
      if (pathname.startsWith('/tiles/')) {
        const rel = pathname.replace(/^\/tiles\//, '');
        const filePath = safeResolveWithin(gisRoots.tiles, rel);
        if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          return serveFileWithGzip(res, filePath, 'image/jpeg', req.method);
        }
      }

      // 5. 本地可选离线地形 (/terrain/*)
      if (pathname.startsWith('/terrain/')) {
        const rel = pathname.replace(/^\/terrain\//, '');
        const filePath = safeResolveWithin(gisRoots.terrain, rel);
        if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ct = filePath.endsWith('.json')
            ? 'application/json'
            : filePath.endsWith('.terrain')
              ? 'application/vnd.quantized-mesh,application/octet-stream;extensions=octvertexnormals'
              : 'application/octet-stream';
          return serveFileWithGzip(res, filePath, ct, req.method);
        }
      }

      next();
    });
  };

  return {
    name: 'beidou-grid-and-local-gis',
    configureServer(server) {
      attachMiddleware(server.middlewares);
    },
    configurePreviewServer(server) {
      attachMiddleware(server.middlewares);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const gisRoots: LocalGisRoots = {
    tiles3dGzip: resolveOptionalDir(env.LOCAL_3DTILES_GZIP_DIR, './data/3dtiles_gzip'),
    tiles3dRaw: resolveOptionalDir(env.LOCAL_3DTILES_DIR, './data/3dtiles'),
    tiles: resolveOptionalDir(env.LOCAL_TILES_DIR, './data/tiles'),
    terrain: resolveOptionalDir(env.LOCAL_TERRAIN_DIR, './data/terrain'),
  };

  return {
    plugins: [react(), cesium(), beidouAndLocalGisPlugin(gisRoots)],
    server: {
      port: 5173,
    },
  };
});
