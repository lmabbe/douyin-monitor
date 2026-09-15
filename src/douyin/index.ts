import { DouyinClient } from './client.js';
import { Anchor, LiveInfo } from './types.js';

const client = new DouyinClient();

function extractRoom(data: any): any | null {
  const inner = data?.data;
  if (!inner) return null;
  if (inner.room) return inner.room;
  if (Array.isArray(inner.data) && inner.data.length > 0) return inner.data[0];
  return null;
}

let forceOfflineStartTime = 0;
export async function getLiveInfo(anchor: Anchor): Promise<LiveInfo> {
  const delaySec = Number(process.env.FORCE_OFFLINE_DELAY_SECONDS || '0');
  const forceAnchor = process.env.FORCE_OFFLINE_ANCHOR;
  if (forceAnchor && delaySec > 0) {
    if (forceOfflineStartTime === 0) forceOfflineStartTime = Date.now();
    const elapsed = (Date.now() - forceOfflineStartTime) / 1000;
    if (elapsed >= delaySec && anchor.name === forceAnchor) {
      console.log(`[TEST] 延迟 ${delaySec}s 后强制 offline: ${anchor.name}`);
      return offline();
    }
  }

  const data = await client.enterRoom(anchor.webRid);
  if (data?.status_code !== 0 && data?.status_code !== undefined) {
    client.invalidateTtwid(anchor.webRid);
    const retry = await client.enterRoom(anchor.webRid);
    const r = extractRoom(retry);
    return r ? buildLiveInfo(r) : offline();
  }
  const room = extractRoom(data);
  if (!room) return offline();
  return buildLiveInfo(room);
}

function buildLiveInfo(room: any): LiveInfo {
  if (room.status !== 2) return offline();
  const s = room.stream_url || {};
  const flvMap = s.flv_pull_url || {};
  const hlsMap = s.hls_pull_url_map || {};

  // 按优先级挑选：HLS FULL_HD1 > HD1 > SD1 > SD2 > 第一个
  const hlsUrl =
    hlsMap.FULL_HD1 || hlsMap.HD1 || hlsMap.SD1 || hlsMap.SD2 ||
    (Object.values(hlsMap)[0] as string | undefined);

  // FLV 作为最后兜底
  const flvUrl =
    flvMap.FULL_HD1 || flvMap.HD1 || flvMap.SD1 || flvMap.SD2 ||
    (Object.values(flvMap)[0] as string | undefined);

  // 【关键改动】优先 HLS
  const useHls = !!hlsUrl;
  const finalUrl = (useHls ? hlsUrl : flvUrl) || '';

  return {
    isLive: true,
    roomId: room.id_str || '',
    title: room.title || '',
    streamUrl: finalUrl,
    flvUrl: flvUrl || undefined,
    hlsUrl: hlsUrl || undefined,
    streamFormat: useHls ? 'hls' : (flvUrl ? 'flv' : 'none'),
    startTime: new Date().toISOString(),
  };
}

function offline(): LiveInfo {
  return { isLive: false, roomId: '', title: '', streamUrl: '', streamFormat: 'none' };
}

export * from './types.js';
