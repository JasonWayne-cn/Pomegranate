// scripts/lib/pe.mjs
// 极简 PE 解析工具：供 Win7 补丁脚本与导入门禁共用。
// 只实现本项目需要的部分：头解析、RVA→文件偏移、静态/延迟导入表。

export function parsePe(buffer) {
  if (buffer.length < 0x40 || buffer.toString("ascii", 0, 2) !== "MZ") {
    throw new Error("not a PE file (missing MZ)");
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 24 > buffer.length || buffer.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error("not a PE file (missing PE\\0\\0)");
  }
  const machine = buffer.readUInt16LE(peOffset + 4);
  const sectionCount = buffer.readUInt16LE(peOffset + 6);
  const optionalSize = buffer.readUInt16LE(peOffset + 20);
  const optional = peOffset + 24;
  const magic = buffer.readUInt16LE(optional);
  if (magic !== 0x10b && magic !== 0x20b) {
    throw new Error(`unsupported optional header magic 0x${magic.toString(16)}`);
  }
  const pe32plus = magic === 0x20b;
  const imageBase = pe32plus
    ? Number(buffer.readBigUInt64LE(optional + 24))
    : buffer.readUInt32LE(optional + 28);
  const dataDirOffset = optional + (pe32plus ? 112 : 96);
  const dirs = [];
  for (let i = 0; i < 16; i++) {
    dirs.push({
      rva: buffer.readUInt32LE(dataDirOffset + i * 8),
      size: buffer.readUInt32LE(dataDirOffset + i * 8 + 4),
    });
  }
  const sections = [];
  const sectionsOffset = optional + optionalSize;
  for (let i = 0; i < sectionCount; i++) {
    const s = sectionsOffset + i * 40;
    sections.push({
      name: buffer.toString("ascii", s, s + 8).replace(/\0+$/, ""),
      virtualSize: buffer.readUInt32LE(s + 8),
      virtualAddress: buffer.readUInt32LE(s + 12),
      rawSize: buffer.readUInt32LE(s + 16),
      rawPointer: buffer.readUInt32LE(s + 20),
    });
  }
  return {
    peOffset,
    machine,
    optional,
    optionalSize,
    pe32plus,
    imageBase,
    dirs,
    sections,
    dataDirOffset,
    subsystemOffset: optional + 68,
    majorSubsystemOffset: optional + 48,
    minorSubsystemOffset: optional + 50,
  };
}

export function rvaToOffset(pe, rva) {
  for (const s of pe.sections) {
    const size = Math.max(s.virtualSize, s.rawSize);
    if (rva >= s.virtualAddress && rva < s.virtualAddress + size) {
      return s.rawPointer + (rva - s.virtualAddress);
    }
  }
  return -1;
}

export function readCString(buffer, offset) {
  if (offset < 0 || offset >= buffer.length) return null;
  let end = offset;
  while (end < buffer.length && buffer[end] !== 0) end++;
  return { text: buffer.toString("ascii", offset, end), end };
}

function readThunkNames(buffer, pe, intRva, dll) {
  const functions = [];
  if (!intRva) return functions;
  const intOffset = rvaToOffset(pe, intRva);
  if (intOffset < 0) return functions;
  const thunkSize = pe.pe32plus ? 8 : 4;
  const seen = new Set();
  for (let off = intOffset; off + thunkSize <= buffer.length; off += thunkSize) {
    let value;
    let ordinal = false;
    if (pe.pe32plus) {
      const big = buffer.readBigUInt64LE(off);
      if (big === 0n) break;
      ordinal = big >> 63n === 1n;
      value = Number(big);
    } else {
      value = buffer.readUInt32LE(off);
      if (value === 0) break;
      ordinal = value >>> 31 === 1;
    }
    if (ordinal) {
      functions.push({ dll, name: `#${value & 0xffff}`, ordinal: true, offset: -1 });
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    const nameOffset = rvaToOffset(pe, value);
    if (nameOffset < 0) continue;
    const parsed = readCString(buffer, nameOffset + 2); // 跳过 2 字节 Hint
    if (!parsed) continue;
    functions.push({ dll, name: parsed.text, ordinal: false, offset: nameOffset + 2 });
  }
  return functions;
}

/** 解析静态导入与延迟导入，返回 { static: [], delay: [] }（每项含 dll / dllOffset / functions） */
export function parseImports(buffer, pe) {
  const result = { static: [], delay: [] };

  const importDir = pe.dirs[1];
  if (importDir.rva) {
    const descOffset = rvaToOffset(pe, importDir.rva);
    if (descOffset >= 0) {
      for (let d = descOffset; d + 20 <= buffer.length; d += 20) {
        const nameRva = buffer.readUInt32LE(d + 12);
        if (nameRva === 0) break;
        const nameOffset = rvaToOffset(pe, nameRva);
        const parsed = nameOffset >= 0 ? readCString(buffer, nameOffset) : null;
        if (!parsed) continue;
        const originalFirstThunk = buffer.readUInt32LE(d);
        const firstThunk = buffer.readUInt32LE(d + 16);
        result.static.push({
          dll: parsed.text,
          dllOffset: nameOffset,
          functions: readThunkNames(buffer, pe, originalFirstThunk || firstThunk, parsed.text),
        });
      }
    }
  }

  const delayDir = pe.dirs[13];
  if (delayDir.rva) {
    const descOffset = rvaToOffset(pe, delayDir.rva);
    if (descOffset >= 0) {
      for (let d = descOffset; d + 32 <= buffer.length; d += 32) {
        const attributes = buffer.readUInt32LE(d);
        const nameField = buffer.readUInt32LE(d + 4);
        if (nameField === 0) break;
        const toRva = (v) => (attributes & 1 ? v : v - pe.imageBase);
        const nameRva = toRva(nameField);
        const nameOffset = rvaToOffset(pe, nameRva);
        const parsed = nameOffset >= 0 ? readCString(buffer, nameOffset) : null;
        if (!parsed) continue;
        const intRva = toRva(buffer.readUInt32LE(d + 16));
        result.delay.push({
          dll: parsed.text,
          dllOffset: nameOffset,
          functions: readThunkNames(buffer, pe, intRva, parsed.text),
        });
      }
    }
  }

  return result;
}

/** 解析 PE 导出表，返回导出函数名集合 */
export function parseExports(buffer, pe) {
  const names = new Set();
  const exportDir = pe.dirs[0];
  if (!exportDir.rva) return names;
  const exportOffset = rvaToOffset(pe, exportDir.rva);
  if (exportOffset < 0) return names;
  const numberOfNames = buffer.readUInt32LE(exportOffset + 24);
  const addressOfNames = buffer.readUInt32LE(exportOffset + 32);
  const namesOffset = rvaToOffset(pe, addressOfNames);
  if (namesOffset < 0) return names;
  for (let i = 0; i < numberOfNames; i++) {
    const nameRva = buffer.readUInt32LE(namesOffset + i * 4);
    const nameOffset = rvaToOffset(pe, nameRva);
    const parsed = nameOffset >= 0 ? readCString(buffer, nameOffset) : null;
    if (parsed) names.add(parsed.text);
  }
  return names;
}

/** 原地写入不超过原长度的 ASCII 字符串（NUL 填充） */
export function writeCStringInPlace(buffer, offset, oldText, newText) {
  if (newText.length > oldText.length) {
    throw new Error(`replacement "${newText}" is longer than "${oldText}"`);
  }
  buffer.write(newText, offset, "ascii");
  buffer.fill(0, offset + newText.length, offset + oldText.length);
}

/** 解析 .def 文件的 EXPORTS 段，返回导出名集合 */
export function parseDefExports(defText) {
  const names = new Set();
  let inExports = false;
  for (const rawLine of defText.split(/\r?\n/)) {
    const line = rawLine.replace(/;.*$/, "").trim();
    if (!line) continue;
    if (/^EXPORTS$/i.test(line)) {
      inExports = true;
      continue;
    }
    if (!inExports) continue;
    const m = line.match(/^([A-Za-z_#?][\w@$?]*)/);
    if (m) names.add(m[1]);
  }
  return names;
}
