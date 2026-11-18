const SHT_DYNAMIC = 6;
const DT_NULL = 0n;
const DT_NEEDED = 1n;

/** DT_NEEDED of a 64-bit little-endian ELF (every Linux target), in file order. Throws `not_elf64le` otherwise. */
export const readElfNeeded = (elf: Buffer): string[] => {
  if (elf.length < 64 || elf.readUInt32BE(0) !== 0x7f454c46 || elf[4] !== 2 || elf[5] !== 1) throw new Error("not_elf64le");
  const sectionHeaders = Number(elf.readBigUInt64LE(0x28));
  const sectionHeaderSize = elf.readUInt16LE(0x3a);
  const sectionCount = elf.readUInt16LE(0x3c);
  const section = (index: number) => {
    const at = sectionHeaders + index * sectionHeaderSize;
    return { type: elf.readUInt32LE(at + 4), offset: Number(elf.readBigUInt64LE(at + 0x18)), size: Number(elf.readBigUInt64LE(at + 0x20)), link: elf.readUInt32LE(at + 0x28) };
  };
  for (let index = 0; index < sectionCount; index++) {
    const dynamic = section(index);
    if (dynamic.type !== SHT_DYNAMIC) continue;
    const strings = section(dynamic.link);
    const needed: string[] = [];
    for (let at = dynamic.offset; at + 16 <= dynamic.offset + dynamic.size; at += 16) {
      const tag = elf.readBigUInt64LE(at);
      if (tag === DT_NULL) break;
      if (tag !== DT_NEEDED) continue;
      const start = strings.offset + Number(elf.readBigUInt64LE(at + 8));
      needed.push(elf.toString("latin1", start, elf.indexOf(0, start)));
    }
    return needed;
  }
  return [];
};

/**
 * Bundled libraries (map keys, map order) that the roots never reach through bundled libraries: only a host
 * library needs them, and a host library resolves its dependencies from the host, so they are never loaded.
 */
export const findUnreachableLibraries = (needed: ReadonlyMap<string, readonly string[]>, roots: readonly string[]): string[] => {
  const reached = new Set(roots);
  const queue = [...roots];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    for (const dep of needed.get(file) ?? []) {
      if (!needed.has(dep) || reached.has(dep)) continue;
      reached.add(dep);
      queue.push(dep);
    }
  }
  return [...needed.keys()].filter((name) => !reached.has(name));
};

/** ffmpeg's own libraries as the windows build names them: `<library>-<major>.dll`. */
const FFMPEG_DLL = /^(avcodec|avdevice|avfilter|avformat|avutil|postproc|swresample|swscale)-\d+\.dll$/i;

/**
 * The DLLs (input order) of a windows bundle listing that are not ffmpeg's own. Everything else (codecs, mpv's
 * libraries, the shader compilers, the mingw runtime) links statically; Windows provides the system DLLs.
 */
export const findForeignDlls = (names: readonly string[]): string[] =>
  names.filter((name) => /\.dll$/i.test(name) && !FFMPEG_DLL.test(name));
