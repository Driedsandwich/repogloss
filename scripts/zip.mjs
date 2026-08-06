// 最小限の ZIP の読み書き。外部パッケージを増やさないために自前で持つ。
// 使うのは「保存」と「deflate」だけで、暗号化・zip64・分割には対応しない
// （配布物は 13 ファイル・十数万バイトなので、そこまでは要らない）。
//
// 作るものが毎回1バイトも変わらないようにする。日時は固定し、並び順は
// 呼び出し側が渡した順のまま、追加の属性も入れない。ここが揺れると
// 「同じ中身なのにハッシュが違う」になり、突き合わせの意味が無くなる。
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// 1980-01-01 00:00:00 に固定する。作った時刻を入れると毎回ハッシュが変わる。
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

/* entries: [{ name, data }] を、渡された順のまま ZIP にする */
export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    if (name.includes('\\')) throw new Error(`ZIP の中の区切りは / に揃える: ${name}`);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    // 縮まないファイル（PNG など）は、そのまま入れたほうが小さい
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // 展開に必要なバージョン
    local.writeUInt16LE(0, 6);           // フラグ（暗号化なし・後置サイズなし）
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // extra なし
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);    // 作成側（UNIX / spec 3.0）
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);        // extra なし
    central.writeUInt16LE(0, 32);        // コメントなし
    central.writeUInt16LE(0, 34);        // ディスク番号
    central.writeUInt16LE(0, 36);        // 内部属性
    central.writeUInt32LE(0x81a40000, 38);   // 0644 の通常ファイル
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);   // 中央ディレクトリの大きさ
  eocd.writeUInt32LE(localPart.length, 16);     // 中央ディレクトリの位置
  eocd.writeUInt16LE(0, 20);            // ZIP 全体のコメントなし
  return Buffer.concat([localPart, centralPart, eocd]);
}

/* ZIP を読み、[{ name, data }] を返す。壊れていれば例外にする。
   末尾に足されたごみも見つける（unzip -t は素通りさせる）。 */
export function readZip(buf) {
  if (buf.length < 22) throw new Error('ZIP として短すぎる');
  // コメントを許さない前提なので、EOCD はちょうど末尾 22 バイトにあるはず。
  // ここを「後ろから探す」にすると、末尾へ足されたごみを見逃す。
  const eocdAt = buf.length - 22;
  if (buf.readUInt32LE(eocdAt) !== 0x06054b50) {
    throw new Error('末尾が ZIP の終端record になっていない（後ろに何か足されている疑い）');
  }
  if (buf.readUInt16LE(eocdAt + 20) !== 0) throw new Error('ZIP 全体のコメントが入っている');
  const count = buf.readUInt16LE(eocdAt + 10);
  const cdSize = buf.readUInt32LE(eocdAt + 12);
  const cdOffset = buf.readUInt32LE(eocdAt + 16);
  if (cdOffset + cdSize !== eocdAt) throw new Error('中央ディレクトリの位置か大きさが合わない');

  const out = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`${i} 件目の見出しが壊れている`);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + cmtLen;

    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(`${name} の本体見出しが壊れている`);
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    // 名前は本体側と見出し側の2か所にある。片方だけ書き換えられていないか確かめる
    // （中央ディレクトリだけを読むと、本体側のすり替えに気づけない）。
    const localName = buf.subarray(lho + 30, lho + 30 + lNameLen).toString('utf8');
    if (localName !== name) {
      throw new Error(`名前が2か所で食い違う: 見出し ${name} / 本体 ${localName}`);
    }
    const start = lho + 30 + lNameLen + lExtraLen;
    const body = buf.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    if (method !== 0 && method !== 8) throw new Error(`${name} が未対応の圧縮方式 ${method}`);
    if (data.length !== usize) throw new Error(`${name} の大きさが記録と違う`);
    if (crc32(data) !== crc) throw new Error(`${name} の中身が記録と違う（CRC 不一致）`);
    out.push({ name, data });
  }
  if (p !== eocdAt) throw new Error('中央ディレクトリの末尾が終端record と合わない');
  return out;
}
