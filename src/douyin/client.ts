import axios, { AxiosInstance } from 'axios';
import {logger} from "../logger";

const UA_DEFAULT =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

export class DouyinClient {
  private http: AxiosInstance;
  private ttwidCache = new Map<string, string>();

  constructor() {
    this.http = axios.create({
      timeout: 15000,
      headers: { 'User-Agent': process.env.DOUYIN_USER_AGENT || UA_DEFAULT },
      validateStatus: () => true,
    });
  }

  async ensureTtwid(webRid: string): Promise<string | null> {
    const cached = this.ttwidCache.get(webRid);
    if (cached) return cached;

    const resp = await this.http.get(`https://live.douyin.com/${webRid}`, { maxRedirects: 5 });
    const setCookie = resp.headers['set-cookie'];
    if (!setCookie) return null;
    for (const c of setCookie) {
      if (c.startsWith('ttwid=')) {
        const val = c.split(';')[0];
        this.ttwidCache.set(webRid, val);
        return val;
      }
    }
    return null;
  }

  invalidateTtwid(webRid: string): void { this.ttwidCache.delete(webRid); }

  async enterRoom(webRid: string): Promise<any> {
    const ttwid = await this.ensureTtwid(webRid);
    const params = {
      aid: '6383', app_name: 'douyin_web', live_id: '1',
      device_platform: 'web', language: 'zh-CN', cookie_enabled: 'true',
      screen_width: '1920', screen_height: '1080',
      browser_language: 'zh-CN', browser_platform: 'Win32',
      browser_name: 'Chrome', browser_version: '126.0.0.0',
      web_rid: webRid, enter_from: 'web_live', is_need_double_stream: 'false',
    };
    const headers: Record<string, string> = { 'Referer': `https://live.douyin.com/${webRid}` };
    if (ttwid) headers['Cookie'] = ttwid;
    const resp = await this.http.get('https://live.douyin.com/webcast/room/web/enter/', { params, headers });
    return resp.data;
  }
}
