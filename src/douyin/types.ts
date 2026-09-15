export interface Anchor {
  name: string;
  webRid: string;
  videoUrl?: string;
  enabled: boolean;
}
export interface LiveInfo {
  isLive: boolean;
  roomId: string;
  title: string;
  streamUrl: string;
  flvUrl?: string;
  hlsUrl?: string;
  streamFormat: 'flv' | 'hls' | 'none';
  startTime?: string;
}
export enum AnchorState {
  OFFLINE = 'OFFLINE',
  CHECKING = 'CHECKING',
  LIVE = 'LIVE',
  RESOLVING_STREAM = 'RESOLVING_STREAM',
  RECORDING = 'RECORDING',
  ERROR = 'ERROR',
}
