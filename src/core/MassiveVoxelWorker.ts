import type { ElevationColorThresholds } from '../types/beidou';
import {
  buildChunkGeometryPayload,
  createRuntimeTriangleLookup,
  type ChunkGeometryPayload,
  type CompactColumnInput,
  type CompactTrianglePool,
  type RuntimeTriangleLookup,
} from './VoxelBufferBuilder';

export interface WorkerInitTrianglesRequest {
  type: 'init-triangles';
  pool: CompactTrianglePool;
}

export interface WorkerBuildChunkRequest {
  type?: 'build-chunk';
  jobId: number;
  chunkKey: string;
  columns: CompactColumnInput[];
  includeVolumes: boolean;
  elevationThresholds?: ElevationColorThresholds;
}

export interface WorkerBuildChunkResponse {
  jobId: number;
  payload: ChunkGeometryPayload;
}

let workerTriLookup: RuntimeTriangleLookup | null = null;

self.onmessage = (
  event: MessageEvent<WorkerInitTrianglesRequest | WorkerBuildChunkRequest>,
) => {
  const data = event.data;
  if (data.type === 'init-triangles') {
    workerTriLookup = createRuntimeTriangleLookup(data.pool);
    return;
  }

  const { jobId, chunkKey, columns, includeVolumes, elevationThresholds } = data;
  const payload = buildChunkGeometryPayload(
    chunkKey,
    columns,
    includeVolumes,
    elevationThresholds,
    workerTriLookup,
  );

  const transferables: Transferable[] = [];
  if (payload.facadeLines) {
    transferables.push(
      payload.facadeLines.positions.buffer,
      payload.facadeLines.indices.buffer,
    );
  }
  if (payload.roofLines) {
    transferables.push(
      payload.roofLines.positions.buffer,
      payload.roofLines.indices.buffer,
    );
  }
  if (payload.boxMatrices) {
    transferables.push(payload.boxMatrices.buffer);
  }

  const msg: WorkerBuildChunkResponse = { jobId, payload };
  (self as unknown as Worker).postMessage(msg, transferables);
};
