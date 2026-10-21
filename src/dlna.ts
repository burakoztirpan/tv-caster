import dgram from 'node:dgram';

const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
const RC = 'urn:schemas-upnp-org:service:RenderingControl:1';

export type Tv = { base: string; avt: string; rc: string; name: string };
let cached: Tv | undefined;

function ssdp(timeoutMs = 3000): Promise<string | undefined> {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const msg = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\n' +
        'ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n',
    );
    const done = (v?: string) => { clearTimeout(t); try { s.close(); } catch {} resolve(v); };
    const t = setTimeout(() => done(), timeoutMs);
    s.on('message', (m) => {
      const loc = /^location:\s*(.+)$/im.exec(m.toString())?.[1]?.trim();
      if (loc) done(loc);
    });
    s.bind(() => { s.send(msg, 1900, '239.255.255.250'); s.send(msg, 1900, '239.255.255.250'); });
  });
}

export async function getTv(): Promise<Tv> {
  if (cached) return cached;
  const loc = process.env.TV_DESC_URL || (process.env.TV_IP ? `http://${process.env.TV_IP}:9197/dmr` : await ssdp());
  if (!loc) throw new Error('TV not found via SSDP. Is it on? Set TV_IP in .env.');
  const xml = await (await fetch(loc)).text();
  const ctrl = (type: string) => {
    const block = xml.split('<service>').find((b) => b.includes(type));
    const url = block && /<controlURL>([^<]+)<\/controlURL>/.exec(block)?.[1];
    if (!url) throw new Error(`TV does not offer ${type}`);
    return new URL(url, loc).href;
  };
  cached = {
    base: loc,
    avt: ctrl(AVT),
    rc: ctrl(RC),
    name: /<friendlyName>([^<]+)/.exec(xml)?.[1] ?? 'TV',
  };
  console.log(`[dlna] TV: ${cached.name} @ ${loc}`);
  return cached;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function soap(url: string, service: string, action: string, args: Record<string, string | number>) {
  const body =
    `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}">` +
    Object.entries(args).map(([k, v]) => `<${k}>${esc(String(v))}</${k}>`).join('') +
    `</u:${action}></s:Body></s:Envelope>`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${service}#${action}"` },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`[dlna] ${action} HTTP ${res.status}: ${/<errorDescription>([^<]*)/.exec(text)?.[1] ?? text.slice(0, 300)}`);
  return text;
}

const tag = (xml: string, t: string) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(xml)?.[1] ?? '';

export async function cast(url: string, mime: string, title = 'TV Cast') {
  const tv = await getTv();
  const didl =
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">' +
    `<item id="0" parentID="-1" restricted="1"><dc:title>${esc(title)}</dc:title>` +
    '<upnp:class>object.item.videoItem</upnp:class>' +
    `<res protocolInfo="http-get:*:${mime}:DLNA.ORG_OP=${mime === 'video/mp2t' ? '00' : '01'};DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000">${esc(url)}</res>` +
    '</item></DIDL-Lite>';
  await soap(tv.avt, AVT, 'Stop', { InstanceID: 0 }).catch(() => {});
  // right after a Stop the TV can still be TRANSITIONING; a few spaced retries (not a burst) get through
  for (let i = 0; ; i++) {
    try {
      await soap(tv.avt, AVT, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: url, CurrentURIMetaData: didl });
      break;
    } catch (e: any) {
      if (i >= 3 || !/Transition not available/.test(e.message)) throw e;
      await new Promise((ok) => setTimeout(ok, 1500));
    }
  }
  await soap(tv.avt, AVT, 'Play', { InstanceID: 0, Speed: 1 });
  console.log(`[dlna] sent to TV: ${url} (${mime})`);
}

export const play = async () => soap((await getTv()).avt, AVT, 'Play', { InstanceID: 0, Speed: 1 });
export const pause = async () => soap((await getTv()).avt, AVT, 'Pause', { InstanceID: 0 });
export const stop = async () => soap((await getTv()).avt, AVT, 'Stop', { InstanceID: 0 });

const hms = (s: number) => new Date(Math.max(0, s) * 1000).toISOString().slice(11, 19);
const secs = (t: string) => t.split(':').reduce((a, p) => a * 60 + Number(p), 0) || 0;

export async function status() {
  const tv = await getTv();
  const [ti, pi] = await Promise.all([
    soap(tv.avt, AVT, 'GetTransportInfo', { InstanceID: 0 }),
    soap(tv.avt, AVT, 'GetPositionInfo', { InstanceID: 0 }),
  ]);
  return { state: tag(ti, 'CurrentTransportState'), position: tag(pi, 'RelTime'), duration: tag(pi, 'TrackDuration') };
}

export async function seekTo(sec: number) {
  await soap((await getTv()).avt, AVT, 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: hms(sec) });
}

export async function getVolume() {
  const tv = await getTv();
  const [v, m] = await Promise.all([
    soap(tv.rc, RC, 'GetVolume', { InstanceID: 0, Channel: 'Master' }),
    soap(tv.rc, RC, 'GetMute', { InstanceID: 0, Channel: 'Master' }),
  ]);
  return { volume: Number(tag(v, 'CurrentVolume')), muted: tag(m, 'CurrentMute') === '1' };
}

export async function setVolume(v: number) {
  v = Math.round(Math.min(100, Math.max(0, v)));
  await soap((await getTv()).rc, RC, 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: v });
  return v;
}

export const setMute = async (on: boolean) =>
  soap((await getTv()).rc, RC, 'SetMute', { InstanceID: 0, Channel: 'Master', DesiredMute: on ? 1 : 0 });
