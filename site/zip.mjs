// 极简 zip **目录**读取器（零依赖，只用 node 内置）。
//
// 只做一件事：把 zip 的中央目录读出来，列出每个条目的名字、压缩前后大小与 CRC。
// 不负责解压 —— 审核要看的是「包里到底有什么」，不是把内容取出来。
//
// 为什么不用 `tar -tf`：GNU tar 读不了 zip，只有 Windows 自带的 bsdtar 能读。服务器上
// 可能是 GNU tar，那就会静默失败；而这个实现到哪都一样。
//
// 按偏移量读，不把整个包读进内存（上传上限 100 MB，读进内存也能活，但没必要）。
//
// 另有 `readZipFile()`：**取单一条目的内容**（用来读包里的 pack.json，好把原作者预填出来）。
// 它仍然只用 node 内置：展开用内置 zlib 的 inflateRaw。仍然不落地、不执行包里的东西。
import { open, stat } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

/** 从尾部往前找 EOCD（zip 注释最长 65535 字节，所以最多回看 64 KiB + 22）。 */
function findEocd(buf) {
  for (let i = buf.length - EOCD_MIN; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * 读一个 zip 的中央目录。
 * @param {string} file
 * @returns {Promise<Array<{name: string, compSize: number, uncompSize: number, crc32: number, method: number, dir: boolean}>>}
 */
export async function readZipEntries(file) {
  const fh = await open(file, 'r');
  try {
    const { size } = await stat(file);
    if (size < EOCD_MIN) throw new Error('不是 zip（文件太小）');

    const tailLen = Math.min(size, MAX_COMMENT + EOCD_MIN);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    const eocdRel = findEocd(tail);
    if (eocdRel < 0) throw new Error('不是 zip（找不到中央目录结尾记录）');
    const eocd = size - tailLen + eocdRel;

    const head = Buffer.alloc(EOCD_MIN);
    await fh.read(head, 0, EOCD_MIN, eocd);
    const count = head.readUInt16LE(10);
    const cdSize = head.readUInt32LE(12);
    let cdOffset = head.readUInt32LE(16);

    // zip64：字段被写成 0xFFFFFFFF 时，真值在 zip64 记录里。本仓库的包不会这么大，
    // 但遇到了要明说，而不是给出错数字。
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || count === 0xffff) {
      throw new Error('这是 zip64 包，本工具不支持（把包拆小或换普通 zip）');
    }
    if (cdOffset + cdSize > size) throw new Error('zip 中央目录越界（文件可能损坏）');

    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);

    const out = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== CD_SIG) throw new Error(`第 ${i + 1} 条目录记录签名不对（zip 可能损坏）`);
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc32 = cd.readUInt32LE(p + 16);
      const compSize = cd.readUInt32LE(p + 20);
      const uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const rawName = cd.subarray(p + 46, p + 46 + nameLen);
      // 位 11 = UTF-8 文件名；没设的按 CP437，但中文包基本都会设，没设的就按 latin1 兜着
      const name = (flags & 0x800) !== 0 ? rawName.toString('utf8') : rawName.toString('latin1');
      // localOffset 是「读单个条目内容」要用的（记录头 42 字节处），所以顺手留下。
      out.push({ name, compSize, uncompSize, crc32, method, dir: name.endsWith('/'),
        flags, localOffset: cd.readUInt32LE(p + 42) });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** zip 魔数：PK\x03\x04（空 zip 是 PK\x05\x06）。 */
export function looksLikeZip(head) {
  if (head.length < 4) return false;
  return head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05) && (head[3] === 0x04 || head[3] === 0x06);
}

/**
 * 把 zip 读成一个 Map<条目名, Buffer>，**只留下你想要的那几条**（默认一条都不要）。
 *
 * 为什么要它：兼容包那条路要读包里的 `pack.json`，才好在页面上**把原作者预填出来**，
 * 并在通过时核对「原 description 一字未变」。所以确实需要内容，不能只读中央目录。
 *
 * 规矩（和这个文件其它的部分一致）：
 *   · 只用 node 内置 —— store 直接取，deflate 用内置 zlib 的 inflateRaw；**不 shell 调 unzip**；
 *   · **不落盘**：解出来的东西只在内存里过一遍就扔，包本身仍然只存不解压；
 *   · 只要 `want` 点名的那几条；不点名的连解都不解（省内存，也少碰不该碰的东西）。
 */
export async function readZipFile(file, want = []) {
  const wanted = new Set(want.map((s) => String(s)));
  const names = await readZipEntries(file);
  const byName = new Map();
  for (const e of names) if (!e.dir && wanted.has(e.name)) byName.set(e.name, e);
  const outMap = new Map();
  if (!byName.size) return outMap;

  const fh = await open(file, 'r');
  try {
    const { size } = await stat(file);
    for (const [name, e] of byName) {
      if (e.flags & 0x1) throw new Error(`${name} 是加密条目，读不了`);
      if (e.localOffset + 30 > size) throw new Error(`${name} 的本地头越界（zip 可能损坏）`);
      const lh = Buffer.alloc(30);
      await fh.read(lh, 0, 30, e.localOffset);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`${name} 的本地文件头签名不对（zip 可能损坏）`);
      const nLen = lh.readUInt16LE(26);
      const xLen = lh.readUInt16LE(28);
      const start = e.localOffset + 30 + nLen + xLen;
      const raw = Buffer.alloc(e.compSize);
      if (e.compSize) await fh.read(raw, 0, e.compSize, start);
      if (e.method === 0) outMap.set(name, raw);
      else if (e.method === 8) outMap.set(name, inflateRawSync(raw));
      else throw new Error(`${name} 的压缩方式 ${e.method} 不是 store/deflate，读不了`);
    }
    return outMap;
  } finally {
    await fh.close();
  }
}
