'use strict';

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });

const MEDIA_TYPES = Object.freeze({
  'image/png': { kind: 'image', extension: '.png' },
  'image/jpeg': { kind: 'image', extension: '.jpg' },
  'video/mp4': { kind: 'video', extension: '.mp4' },
  'video/quicktime': { kind: 'video', extension: '.mov' },
  'video/webm': { kind: 'video', extension: '.webm' },
});

function extensionForMediaType(mediaType) {
  return MEDIA_TYPES[mediaType] && MEDIA_TYPES[mediaType].extension;
}

const ISO_IMAGE_BRANDS = new Set(['avif', 'avis', 'heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']);
const ISO_VIDEO_BRANDS = new Set([
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'avc1', 'mp41', 'mp42',
  'M4V ', 'M4VH', 'M4VP', 'qt  ', '3gp4', '3gp5', '3g2a', 'dash', 'cmfc', 'cmfs',
]);
const MAX_CONTAINER_ELEMENTS = 50_000;
const MAX_PNG_COMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_PNG_DECODED_BYTES = 128 * 1024 * 1024;
const MAX_PNG_PIXELS = 100_000_000;
const MAX_PNG_SCANLINES = 100_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();
const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc9, 0xca, 0xcb]);

function invalidContainer() {
  const error = new Error('invalid media container');
  error.code = 'INVALID_MEDIA_CONTAINER';
  return error;
}

function readExactly(fd, position, length) {
  const buffer = Buffer.allocUnsafe(length);
  let total = 0;
  while (total < length) {
    const read = fs.readSync(fd, buffer, total, length - total, position + total);
    if (!read) throw invalidContainer();
    total += read;
  }
  return buffer;
}

function takeContainerElement(budget) {
  budget.count += 1;
  if (budget.count > MAX_CONTAINER_ELEMENTS) throw invalidContainer();
}

function updatePngCrc(crc, bytes) {
  let value = crc >>> 0;
  for (const byte of bytes) value = PNG_CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

function pngChunkCrc(fd, typeBytes, dataStart, length) {
  let crc = updatePngCrc(0xffffffff, typeBytes);
  if (!length) return (crc ^ 0xffffffff) >>> 0;
  const buffer = Buffer.allocUnsafe(Math.min(length, 64 * 1024));
  let position = dataStart;
  let remaining = length;
  while (remaining > 0) {
    const wanted = Math.min(remaining, buffer.length);
    const read = fs.readSync(fd, buffer, 0, wanted, position);
    if (read !== wanted) throw invalidContainer();
    crc = updatePngCrc(crc, buffer.subarray(0, read));
    position += read;
    remaining -= read;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isPngChunkType(typeBytes) {
  const isLetter = (byte) => (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
  // PNG chunk names are four ASCII letters; the reserved third bit must remain uppercase.
  return [...typeBytes].every(isLetter) && !(typeBytes[2] & 0x20);
}

function readPngHeader(fd, dataStart) {
  const data = readExactly(fd, dataStart, 13);
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const bitDepth = data[8];
  const colorType = data[9];
  const allowedDepths = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (!width || width > 0x7fffffff || !height || height > 0x7fffffff
      || !allowedDepths[colorType] || !allowedDepths[colorType].includes(bitDepth)
      || data[10] !== 0 || data[11] !== 0 || ![0, 1].includes(data[12])) {
    throw invalidContainer();
  }
  return { width, height, bitDepth, colorType, interlace: data[12] };
}

function pngImageLayout(header) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.colorType];
  const bitsPerPixel = BigInt(channels * header.bitDepth);
  const pixelCount = BigInt(header.width) * BigInt(header.height);
  if (pixelCount > BigInt(MAX_PNG_PIXELS)) throw invalidContainer();
  const passSpecs = header.interlace === 0
    ? [[0, 0, 1, 1]]
    : [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
      [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  const passes = [];
  let totalBytes = 0n;
  let totalScanlines = 0n;
  for (const [xStart, yStart, xStep, yStep] of passSpecs) {
    const width = header.width <= xStart ? 0 : Math.ceil((header.width - xStart) / xStep);
    const height = header.height <= yStart ? 0 : Math.ceil((header.height - yStart) / yStep);
    if (!width || !height) continue;
    const rowBytes = (BigInt(width) * bitsPerPixel + 7n) / 8n;
    totalBytes += BigInt(height) * (rowBytes + 1n);
    totalScanlines += BigInt(height);
    if (totalBytes > BigInt(MAX_PNG_DECODED_BYTES)
        || totalScanlines > BigInt(MAX_PNG_SCANLINES)) throw invalidContainer();
    passes.push({ height, rowBytes: Number(rowBytes) });
  }
  if (!passes.length || totalBytes < 1n) throw invalidContainer();
  return { passes, totalBytes: Number(totalBytes) };
}

function readPngImageData(fd, ranges, totalLength) {
  if (totalLength < 1 || totalLength > MAX_PNG_COMPRESSED_BYTES) throw invalidContainer();
  const compressed = Buffer.allocUnsafe(totalLength);
  let outputOffset = 0;
  for (const range of ranges) {
    let position = range.start;
    let remaining = range.length;
    while (remaining > 0) {
      const read = fs.readSync(fd, compressed, outputOffset, remaining, position);
      if (!read) throw invalidContainer();
      outputOffset += read;
      position += read;
      remaining -= read;
    }
  }
  if (outputOffset !== totalLength) throw invalidContainer();
  return compressed;
}

function validatePngImageData(fd, header, ranges, totalLength) {
  const layout = pngImageLayout(header);
  const compressed = readPngImageData(fd, ranges, totalLength);
  let decoded;
  let consumed;
  try {
    const result = zlib.inflateSync(compressed, {
      info: true,
      maxOutputLength: layout.totalBytes,
    });
    decoded = result.buffer;
    consumed = result.engine.bytesWritten;
  } catch (_) {
    throw invalidContainer();
  }
  // Node's inflater otherwise accepts garbage after the first zlib stream. PNG IDAT may contain
  // exactly one complete stream, and its decoded byte count is fixed by IHDR/Adam7 geometry.
  if (consumed !== compressed.length || decoded.length !== layout.totalBytes)
    throw invalidContainer();
  let offset = 0;
  for (const pass of layout.passes) {
    for (let row = 0; row < pass.height; row += 1) {
      if (decoded[offset] > 4) throw invalidContainer();
      offset += pass.rowBytes + 1;
    }
  }
  if (offset !== decoded.length) throw invalidContainer();
}

/**
 * Validate the PNG container and its compressed scanline stream without reconstructing pixels.
 * CRC is checked for every chunk, while bounded inflate verifies the exact IHDR/Adam7 layout and
 * legal row filters so a syntactically plausible but undecodable image cannot become reusable.
 */
function inspectPng(fd, fileSize) {
  const budget = { count: 0 };
  let offset = PNG_SIGNATURE.length;
  let header = null;
  let seenPalette = false;
  let seenImageData = false;
  let imageDataClosed = false;
  let imageDataBytes = 0;
  const imageDataRanges = [];
  try {
    if (fileSize < PNG_SIGNATURE.length + 12
        || !readExactly(fd, 0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
    while (offset < fileSize) {
      takeContainerElement(budget);
      if (fileSize - offset < 12) throw invalidContainer();
      const chunkHeader = readExactly(fd, offset, 8);
      const length = chunkHeader.readUInt32BE(0);
      const typeBytes = chunkHeader.subarray(4, 8);
      if (length > 0x7fffffff || !isPngChunkType(typeBytes)) throw invalidContainer();
      const type = typeBytes.toString('ascii');
      const dataStart = offset + 8;
      const crcStart = dataStart + length;
      const chunkEnd = crcStart + 4;
      if (!Number.isSafeInteger(chunkEnd) || chunkEnd > fileSize) throw invalidContainer();
      const expectedCrc = readExactly(fd, crcStart, 4).readUInt32BE(0);
      if (pngChunkCrc(fd, typeBytes, dataStart, length) !== expectedCrc) throw invalidContainer();

      if (!header && type !== 'IHDR') throw invalidContainer();
      if (seenImageData && type !== 'IDAT' && type !== 'IEND') imageDataClosed = true;
      if (type === 'IHDR') {
        if (header || offset !== PNG_SIGNATURE.length || length !== 13) throw invalidContainer();
        header = readPngHeader(fd, dataStart);
      } else if (type === 'PLTE') {
        if (!header || seenPalette || seenImageData || [0, 4].includes(header.colorType)
            || length < 3 || length > 768 || length % 3 !== 0
            || (header.colorType === 3 && length / 3 > 2 ** header.bitDepth)) {
          throw invalidContainer();
        }
        seenPalette = true;
      } else if (type === 'IDAT') {
        if (!header || imageDataClosed || (header.colorType === 3 && !seenPalette))
          throw invalidContainer();
        seenImageData = true;
        if (length > MAX_PNG_COMPRESSED_BYTES - imageDataBytes) throw invalidContainer();
        imageDataBytes += length;
        imageDataRanges.push({ start: dataStart, length });
      } else if (type === 'IEND') {
        if (!header || length !== 0 || !seenImageData || imageDataBytes < 1
            || (header.colorType === 3 && !seenPalette) || chunkEnd !== fileSize) {
          throw invalidContainer();
        }
        validatePngImageData(fd, header, imageDataRanges, imageDataBytes);
        return { kind: 'image', mediaType: 'image/png', extension: '.png' };
      } else if (!(typeBytes[0] & 0x20)) {
        // A decoder cannot safely ignore an unknown critical chunk.
        throw invalidContainer();
      }
      offset = chunkEnd;
    }
  } catch (error) {
    if (error.code === 'INVALID_MEDIA_CONTAINER') return null;
    throw error;
  }
  return null;
}

function readJpegMarker(fd, offset, fileSize) {
  if (fileSize - offset < 2 || readExactly(fd, offset, 1)[0] !== 0xff)
    throw invalidContainer();
  let cursor = offset + 1;
  let fillBytes = 0;
  let code;
  do {
    if (cursor >= fileSize || fillBytes > 64) throw invalidContainer();
    code = readExactly(fd, cursor, 1)[0];
    cursor += 1;
    fillBytes += 1;
  } while (code === 0xff);
  if (code === 0x00) throw invalidContainer();
  return { code, start: offset, end: cursor };
}

function readJpegSegment(fd, markerEnd, fileSize) {
  if (fileSize - markerEnd < 2) throw invalidContainer();
  const length = readExactly(fd, markerEnd, 2).readUInt16BE(0);
  if (length < 2 || length > fileSize - markerEnd) throw invalidContainer();
  return { dataStart: markerEnd + 2, end: markerEnd + length, payloadLength: length - 2 };
}

function readJpegFrame(fd, segment, markerCode) {
  if (segment.payloadLength < 6) throw invalidContainer();
  const header = readExactly(fd, segment.dataStart, 6);
  const precision = header[0];
  const height = header.readUInt16BE(1);
  const width = header.readUInt16BE(3);
  const componentCount = header[5];
  if (!width || !height || componentCount < 1 || componentCount > 4
      || segment.payloadLength !== 6 + componentCount * 3
      || (markerCode === 0xc0 && precision !== 8)
      || ([0xc1, 0xc2, 0xc9, 0xca].includes(markerCode) && ![8, 12].includes(precision))
      || ([0xc3, 0xcb].includes(markerCode) && (precision < 2 || precision > 16))) {
    throw invalidContainer();
  }
  const componentBytes = readExactly(fd, segment.dataStart + 6, componentCount * 3);
  const components = new Set();
  for (let index = 0; index < componentCount; index += 1) {
    const id = componentBytes[index * 3];
    const sampling = componentBytes[index * 3 + 1];
    const horizontal = sampling >>> 4;
    const vertical = sampling & 0x0f;
    const quantizationTable = componentBytes[index * 3 + 2];
    if (components.has(id) || horizontal < 1 || horizontal > 4 || vertical < 1 || vertical > 4
        || quantizationTable > 3) throw invalidContainer();
    components.add(id);
  }
  return { markerCode, components };
}

function readJpegScan(fd, segment, frame) {
  if (!frame || segment.payloadLength < 4) throw invalidContainer();
  const componentCount = readExactly(fd, segment.dataStart, 1)[0];
  if (componentCount < 1 || componentCount > frame.components.size
      || segment.payloadLength !== 4 + componentCount * 2) throw invalidContainer();
  const scanBytes = readExactly(fd, segment.dataStart + 1, componentCount * 2 + 3);
  const components = new Set();
  for (let index = 0; index < componentCount; index += 1) {
    const id = scanBytes[index * 2];
    const tables = scanBytes[index * 2 + 1];
    if (!frame.components.has(id) || components.has(id) || (tables >>> 4) > 3 || (tables & 0x0f) > 3)
      throw invalidContainer();
    components.add(id);
  }
  const parameterOffset = componentCount * 2;
  const spectralStart = scanBytes[parameterOffset];
  const spectralEnd = scanBytes[parameterOffset + 1];
  const approximationHigh = scanBytes[parameterOffset + 2] >>> 4;
  const approximationLow = scanBytes[parameterOffset + 2] & 0x0f;
  if ([0xc0, 0xc1, 0xc9].includes(frame.markerCode)) {
    if (spectralStart !== 0 || spectralEnd !== 63 || approximationHigh !== 0 || approximationLow !== 0)
      throw invalidContainer();
  } else if ([0xc2, 0xca].includes(frame.markerCode)) {
    if (spectralStart > spectralEnd || spectralEnd > 63
        || (spectralStart === 0 && spectralEnd !== 0)
        || (spectralStart > 0 && componentCount !== 1)
        || approximationHigh > 13 || approximationLow > 13
        || (approximationHigh && approximationHigh !== approximationLow + 1)) {
      throw invalidContainer();
    }
  } else if (spectralStart < 1 || spectralStart > 7 || spectralEnd !== 0
      || approximationHigh !== 0) {
    throw invalidContainer();
  }
  return components;
}

function scanJpegEntropy(fd, start, fileSize, budget, buffer) {
  let nextOffset = start;
  let index = 0;
  let buffered = 0;
  let dataBytes = 0;
  const nextByte = () => {
    if (index >= buffered) {
      buffered = fs.readSync(fd, buffer, 0, Math.min(buffer.length, fileSize - nextOffset), nextOffset);
      index = 0;
      if (!buffered) throw invalidContainer();
    }
    const result = { value: buffer[index], offset: nextOffset };
    index += 1;
    nextOffset += 1;
    return result;
  };

  while (nextOffset < fileSize) {
    const byte = nextByte();
    if (byte.value !== 0xff) {
      dataBytes += 1;
      continue;
    }
    const markerStart = byte.offset;
    let fillBytes = 0;
    let code;
    do {
      if (nextOffset >= fileSize || fillBytes > 64) throw invalidContainer();
      code = nextByte().value;
      fillBytes += 1;
    } while (code === 0xff);
    if (code === 0x00) {
      dataBytes += 1;
      continue;
    }
    takeContainerElement(budget);
    if ((code >= 0xd0 && code <= 0xd7) || code === 0x01) continue;
    if (!dataBytes) throw invalidContainer();
    return markerStart;
  }
  throw invalidContainer();
}

function isJpegSegmentMarker(code) {
  return JPEG_SOF_MARKERS.has(code) || code === 0xc4 || code === 0xcc || code === 0xda
    || code === 0xdb || code === 0xdd || code === 0xfe || (code >= 0xe0 && code <= 0xef);
}

/**
 * Validate a standalone JPEG marker stream without decoding entropy-coded pixels. Segment lengths,
 * frame/scan metadata, byte stuffing, restart markers and the terminal EOI are all fail-closed.
 */
function inspectJpeg(fd, fileSize) {
  const budget = { count: 0 };
  // Progressive JPEGs can contain many scans; reuse one bounded buffer instead of allocating
  // 64 KiB for every SOS segment in a hostile file.
  const entropyBuffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(fileSize, 1)));
  let offset = 2;
  let frame = null;
  let scanCount = 0;
  const scannedComponents = new Set();
  try {
    if (fileSize < 4 || !readExactly(fd, 0, 2).equals(Buffer.from([0xff, 0xd8]))) return null;
    while (offset < fileSize) {
      takeContainerElement(budget);
      const marker = readJpegMarker(fd, offset, fileSize);
      offset = marker.end;
      if (marker.code === 0xd9) {
        if (!frame || !scanCount || scannedComponents.size !== frame.components.size
            || offset !== fileSize) throw invalidContainer();
        return { kind: 'image', mediaType: 'image/jpeg', extension: '.jpg' };
      }
      if (marker.code === 0xd8 || marker.code === 0x00
          || (marker.code >= 0xd0 && marker.code <= 0xd7) || !isJpegSegmentMarker(marker.code)) {
        throw invalidContainer();
      }
      const segment = readJpegSegment(fd, marker.end, fileSize);
      if (JPEG_SOF_MARKERS.has(marker.code)) {
        if (frame) throw invalidContainer();
        frame = readJpegFrame(fd, segment, marker.code);
      } else if (marker.code === 0xda) {
        const scanComponents = readJpegScan(fd, segment, frame);
        for (const component of scanComponents) scannedComponents.add(component);
        scanCount += 1;
        offset = scanJpegEntropy(fd, segment.end, fileSize, budget, entropyBuffer);
        continue;
      } else if (marker.code === 0xdd && segment.payloadLength !== 2) {
        throw invalidContainer();
      }
      offset = segment.end;
    }
  } catch (error) {
    if (error.code === 'INVALID_MEDIA_CONTAINER') return null;
    throw error;
  }
  return null;
}

function readIsoBoxHeader(fd, offset, scopeEnd, fileEnd, budget) {
  takeContainerElement(budget);
  if (!Number.isSafeInteger(offset) || scopeEnd - offset < 8) throw invalidContainer();
  const basic = readExactly(fd, offset, 8);
  const size32 = basic.readUInt32BE(0);
  const type = basic.subarray(4, 8).toString('latin1');
  let headerSize = 8;
  let size;
  if (size32 === 1) {
    const largeSize = readExactly(fd, offset + 8, 8).readBigUInt64BE(0);
    if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidContainer();
    size = Number(largeSize);
    headerSize = 16;
  } else if (size32 === 0) {
    // size=0 extends to EOF. Nested boxes may not escape their parent scope.
    if (scopeEnd !== fileEnd) throw invalidContainer();
    size = fileEnd - offset;
  } else {
    size = size32;
  }
  if (type === 'uuid') headerSize += 16;
  if (size < headerSize || size > scopeEnd - offset) throw invalidContainer();
  return {
    type,
    start: offset,
    dataStart: offset + headerSize,
    end: offset + size,
    size,
  };
}

function someIsoBoxes(fd, start, end, fileEnd, budget, visitor) {
  let offset = start;
  while (offset < end) {
    const box = readIsoBoxHeader(fd, offset, end, fileEnd, budget);
    if (visitor(box)) return true;
    if (box.end <= offset) throw invalidContainer();
    offset = box.end;
  }
  return false;
}

function readIsoBrands(fd, box) {
  const payloadSize = box.end - box.dataStart;
  if (payloadSize < 8 || payloadSize > 64 * 1024 || (payloadSize - 8) % 4 !== 0)
    throw invalidContainer();
  const payload = readExactly(fd, box.dataStart, payloadSize);
  const brands = [payload.subarray(0, 4).toString('latin1')];
  for (let offset = 8; offset < payload.length; offset += 4)
    brands.push(payload.subarray(offset, offset + 4).toString('latin1'));
  return brands;
}

function inspectIsoBmff(fd, fileSize) {
  const budget = { count: 0 };
  let brands = null;
  let hasMovie = false;
  let hasMediaData = false;
  try {
    someIsoBoxes(fd, 0, fileSize, fileSize, budget, (box) => {
      if (box.type === 'ftyp') {
        if (brands) throw invalidContainer();
        brands = readIsoBrands(fd, box);
      } else if (box.type === 'moov') {
        if (hasMovie) throw invalidContainer();
        hasMovie = true;
      } else if (box.type === 'mdat' && box.end > box.dataStart) {
        hasMediaData = true;
      }
      // Scan the complete top-level scope; accepting early would hide malformed trailing boxes.
      return false;
    });
  } catch (error) {
    if (error.code === 'INVALID_MEDIA_CONTAINER') return null;
    throw error;
  }
  if (!brands || !hasMovie || !hasMediaData || ISO_IMAGE_BRANDS.has(brands[0])
      || !brands.some((brand) => ISO_VIDEO_BRANDS.has(brand))) return null;
  const mediaType = brands.includes('qt  ') ? 'video/quicktime' : 'video/mp4';
  return { kind: 'video', mediaType, extension: extensionForMediaType(mediaType) };
}

function readEbmlVint(fd, offset, scopeEnd, isId) {
  if (offset >= scopeEnd) throw invalidContainer();
  const first = readExactly(fd, offset, 1)[0];
  let marker = 0x80;
  let length = 1;
  const maxLength = isId ? 4 : 8;
  while (!(first & marker) && length <= maxLength) {
    marker >>= 1;
    length += 1;
  }
  if (!marker || length > maxLength || offset + length > scopeEnd) throw invalidContainer();
  const bytes = readExactly(fd, offset, length);
  let value = BigInt(isId ? bytes[0] : (bytes[0] & (marker - 1)));
  for (let index = 1; index < bytes.length; index += 1)
    value = (value << 8n) | BigInt(bytes[index]);
  if (isId) return { length, value: Number(value), unknown: false };
  const unknownValue = (1n << BigInt(7 * length)) - 1n;
  if (value === unknownValue) return { length, value: null, unknown: true };
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidContainer();
  return { length, value: Number(value), unknown: false };
}

function readEbmlElementHeader(fd, offset, scopeEnd, budget) {
  takeContainerElement(budget);
  const id = readEbmlVint(fd, offset, scopeEnd, true);
  const size = readEbmlVint(fd, offset + id.length, scopeEnd, false);
  const dataStart = offset + id.length + size.length;
  const dataEnd = size.unknown ? scopeEnd : dataStart + size.value;
  if (dataEnd < dataStart || dataEnd > scopeEnd) throw invalidContainer();
  return { id: id.value, start: offset, dataStart, end: dataEnd, unknownSize: size.unknown };
}

function readEbmlUnsigned(fd, element) {
  const length = element.end - element.dataStart;
  if (element.unknownSize || length < 1 || length > 8) throw invalidContainer();
  const bytes = readExactly(fd, element.dataStart, length);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function webmTracksHaveVideo(fd, tracks, budget) {
  if (tracks.unknownSize || tracks.end - tracks.dataStart > 16 * 1024 * 1024)
    throw invalidContainer();
  let offset = tracks.dataStart;
  let trackCount = 0;
  while (offset < tracks.end) {
    const entry = readEbmlElementHeader(fd, offset, tracks.end, budget);
    if (entry.id === 0xae) {
      if (entry.unknownSize || entry.end - entry.dataStart > 4 * 1024 * 1024)
        throw invalidContainer();
      trackCount += 1;
      if (trackCount > 256) throw invalidContainer();
      let childOffset = entry.dataStart;
      let trackType = null;
      while (childOffset < entry.end) {
        const child = readEbmlElementHeader(fd, childOffset, entry.end, budget);
        if (child.id === 0x83) {
          if (trackType !== null) throw invalidContainer();
          trackType = readEbmlUnsigned(fd, child);
        }
        if (child.end <= childOffset) throw invalidContainer();
        childOffset = child.end;
      }
      if (trackType === 1n) return true;
    }
    if (entry.end <= offset) throw invalidContainer();
    offset = entry.end;
  }
  return false;
}

function webmSegmentHasVideo(fd, segment, budget) {
  let offset = segment.dataStart;
  while (offset < segment.end) {
    const child = readEbmlElementHeader(fd, offset, segment.end, budget);
    if (child.id === 0x1654ae6b && webmTracksHaveVideo(fd, child, budget)) return true;
    // An unknown-size sibling consumes the remaining scope; there is no safe next offset.
    if (child.unknownSize) return false;
    if (child.end <= offset) throw invalidContainer();
    offset = child.end;
  }
  return false;
}

function inspectWebm(fd, fileSize) {
  const budget = { count: 0 };
  try {
    const ebml = readEbmlElementHeader(fd, 0, fileSize, budget);
    if (ebml.id !== 0x1a45dfa3 || ebml.unknownSize || ebml.end - ebml.dataStart > 64 * 1024)
      return null;
    let docType = null;
    let offset = ebml.dataStart;
    while (offset < ebml.end) {
      const child = readEbmlElementHeader(fd, offset, ebml.end, budget);
      if (child.id === 0x4282) {
        if (docType !== null) throw invalidContainer();
        const length = child.end - child.dataStart;
        if (child.unknownSize || length < 1 || length > 32) throw invalidContainer();
        docType = readExactly(fd, child.dataStart, length).toString('ascii')
          .replace(/\0+$/, '').toLowerCase();
      }
      if (child.end <= offset) throw invalidContainer();
      offset = child.end;
    }
    if (docType !== 'webm') return null;
    offset = ebml.end;
    while (offset < fileSize) {
      const element = readEbmlElementHeader(fd, offset, fileSize, budget);
      if (element.id === 0x18538067) {
        if (!webmSegmentHasVideo(fd, element, budget)) return null;
        return { kind: 'video', mediaType: 'video/webm', extension: '.webm' };
      }
      if (element.unknownSize || element.end <= offset) throw invalidContainer();
      offset = element.end;
    }
  } catch (error) {
    if (error.code === 'INVALID_MEDIA_CONTAINER') return null;
    throw error;
  }
  return null;
}

function probePlayableVideo(file) {
  try {
    const output = execFileSync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-read_intervals', '%+3',
      '-count_frames',
      '-show_entries', 'stream=codec_type,width,height,nb_read_frames',
      '-of', 'json',
      path.resolve(file),
    ], {
      encoding: 'utf8',
      timeout: 15_000,
      killSignal: 'SIGKILL',
      maxBuffer: 256 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const parsed = JSON.parse(output);
    const stream = Array.isArray(parsed.streams) ? parsed.streams[0] : null;
    const width = Number(stream && stream.width);
    const height = Number(stream && stream.height);
    const frames = Number(stream && stream.nb_read_frames);
    return !!stream && stream.codec_type === 'video'
      && Number.isInteger(width) && width > 0
      && Number.isInteger(height) && height > 0
      && Number.isInteger(frames) && frames > 0;
  } catch (_) {
    return false;
  }
}

function inspectMediaFile(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(64 * 1024);
  let headSize;
  let fileSize;
  let videoCandidate;
  try {
    fileSize = fs.fstatSync(fd).size;
    headSize = fs.readSync(fd, head, 0, head.length, 0);
    const bytes = head.subarray(0, headSize);
    if (bytes.length >= PNG_SIGNATURE.length
        && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))
      return inspectPng(fd, fileSize);
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8)
      return inspectJpeg(fd, fileSize);
    videoCandidate = inspectIsoBmff(fd, fileSize) || inspectWebm(fd, fileSize);
  } finally {
    fs.closeSync(fd);
  }
  return videoCandidate && probePlayableVideo(file) ? videoCandidate : null;
}

function safeOriginalName(value, fallback) {
  const normalized = String(value || '').replace(/\\/g, '/');
  const name = path.basename(normalized).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (name || fallback).slice(0, 180);
}

function safeId(value, label) {
  const id = String(value || '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new Error(`${label} 不合法`);
  return id;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read;
    do {
      read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read) hash.update(buffer.subarray(0, read));
    } while (read);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function linkOrCopy(from, to) {
  ensureDir(path.dirname(to));
  try {
    fs.linkSync(from, to);
  } catch (error) {
    if (error.code !== 'EXDEV' && error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    fs.copyFileSync(from, to);
  }
}

function createProjectStore({ dataDir, nowISO, idFactory }) {
  const projectsDir = path.join(dataDir, 'projects');
  ensureDir(projectsDir);

  const projectDir = (projectId) => path.join(projectsDir, safeId(projectId, 'Project ID'));
  const projectFile = (projectId) => path.join(projectDir(projectId), 'project.json');
  const revisionFile = (projectId, revisionId) =>
    path.join(projectDir(projectId), 'revisions', `${safeId(revisionId, 'Revision ID')}.json`);

  function get(projectId) {
    const file = projectFile(projectId);
    if (!fs.existsSync(file)) return null;
    try { return readJson(file); } catch (_) { return null; }
  }

  function save(project) {
    writeJson(projectFile(project.id), project);
    return project;
  }

  function list() {
    if (!fs.existsSync(projectsDir)) return [];
    return fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => get(entry.name))
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  function create({ name, template, brand, owner }) {
    const createdAt = nowISO();
    const project = {
      schemaVersion: 1,
      id: `project-${idFactory()}`,
      name: String(name || '').trim() || '未命名影片',
      template,
      brand: brand || null,
      owner: owner || '未署名',
      createdAt,
      updatedAt: createdAt,
      latestRevision: 0,
      assets: [],
      revisions: [],
    };
    ensureDir(path.join(projectDir(project.id), 'assets'));
    ensureDir(path.join(projectDir(project.id), 'revisions'));
    ensureDir(path.join(projectDir(project.id), 'outputs'));
    return save(project);
  }

  function addRevision(projectId, data) {
    const project = get(projectId);
    if (!project) throw new Error('找不到影片專案');
    const number = Number(project.latestRevision || 0) + 1;
    const id = `v${String(number).padStart(3, '0')}`;
    const revision = {
      schemaVersion: 1,
      id,
      number,
      projectId: project.id,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      status: 'draft',
      assetRefs: [],
      ...data,
    };
    writeJson(revisionFile(project.id, id), revision);
    project.latestRevision = number;
    project.updatedAt = revision.updatedAt;
    project.revisions.push({
      id,
      number,
      jobId: revision.jobId,
      status: revision.status,
      createdAt: revision.createdAt,
      updatedAt: revision.updatedAt,
      outputs: [],
    });
    save(project);
    return revision;
  }

  function getRevision(projectId, revisionId) {
    const file = revisionFile(projectId, revisionId);
    return fs.existsSync(file) ? readJson(file) : null;
  }

  function updateRevision(projectId, revisionId, patch) {
    const project = get(projectId);
    const revision = getRevision(projectId, revisionId);
    if (!project || !revision) return null;
    Object.assign(revision, patch, { updatedAt: nowISO() });
    writeJson(revisionFile(projectId, revisionId), revision);
    const summary = project.revisions.find((item) => item.id === revisionId);
    if (summary) {
      summary.status = revision.status;
      summary.updatedAt = revision.updatedAt;
      summary.outputs = revision.outputs || summary.outputs || [];
    }
    project.updatedAt = revision.updatedAt;
    save(project);
    return revision;
  }

  /**
   * 回收尚未送出的最新 Revision。這只給「建立後上傳失敗」的 rollback 使用；
   * 已排隊或較舊版本不能從這裡移除，避免形成版本缺口。
   */
  function abortRevision(projectId, revisionId, { pruneAssetIds = [] } = {}) {
    const project = get(projectId);
    const revision = getRevision(projectId, revisionId);
    if (!project || !revision) return null;
    if (revision.status !== 'draft') throw new Error('只有草稿版本可以回收');
    if (Number(revision.number) !== Number(project.latestRevision))
      throw new Error('只能回收最新的草稿版本');

    project.revisions = project.revisions.filter((item) => item.id !== revisionId);
    if (!project.revisions.length) {
      fs.rmSync(projectDir(projectId), { recursive: true, force: true });
      return { deletedProject: true, removedAssetIds: project.assets.map((item) => item.id) };
    }

    const remainingRefs = new Set();
    for (const item of project.revisions) {
      const saved = getRevision(projectId, item.id);
      for (const assetId of (saved && saved.assetRefs) || []) remainingRefs.add(assetId);
    }
    const candidates = new Set(pruneAssetIds.map(String));
    const removed = project.assets.filter((asset) => candidates.has(asset.id) && !remainingRefs.has(asset.id));
    const retained = project.assets.filter((asset) => !removed.includes(asset));
    project.assets = retained;
    project.latestRevision = Math.max(...project.revisions.map((item) => Number(item.number || 0)));
    project.updatedAt = nowISO();
    save(project);
    fs.unlinkSync(revisionFile(projectId, revisionId));
    for (const asset of removed) {
      if (retained.some((item) => item.path === asset.path)) continue;
      const file = path.resolve(projectDir(projectId), asset.path);
      if (file.startsWith(projectDir(projectId) + path.sep) && fs.existsSync(file)) fs.unlinkSync(file);
    }
    return { deletedProject: false, removedAssetIds: removed.map((item) => item.id) };
  }

  function ingestAsset(projectId, sourceFile, { originalName, kind = 'image' }) {
    const project = get(projectId);
    if (!project) throw new Error('找不到影片專案');
    if (!['image', 'video', 'speaker-video'].includes(kind)) throw new Error('素材類型不合法');
    const media = inspectMediaFile(sourceFile);
    if (!media) throw new Error('不支援或無法辨識的素材格式');
    const expectedKind = kind === 'speaker-video' ? 'video' : kind;
    if (media.kind !== expectedKind) throw new Error('素材內容與指定類型不一致');
    const sha256 = hashFile(sourceFile);
    const ext = media.extension;
    let asset = project.assets.find((item) => item.sha256 === sha256 && item.kind === kind);
    if (!asset) {
      const relativePath = path.join('assets', `${sha256}${ext}`);
      const target = path.join(projectDir(projectId), relativePath);
      // Project asset 是 durable immutable source；不要與仍可能被 pipeline 覆寫的
      // public/ 或 job input 共用 inode。Run 期間允許暫時副本，清掉 Run 後只留這份。
      if (!fs.existsSync(target)) fs.copyFileSync(sourceFile, target);
      asset = {
        id: `asset-${kind.replace(/[^a-z0-9]+/g, '-')}-${sha256.slice(0, 16)}`,
        kind,
        mediaType: media.mediaType,
        originalName: safeOriginalName(originalName, `素材${ext}`),
        sha256,
        size: fs.statSync(sourceFile).size,
        path: relativePath,
        createdAt: nowISO(),
      };
      project.assets.push(asset);
      project.updatedAt = nowISO();
      save(project);
    }
    return asset;
  }

  function materializeAsset(projectId, assetId, target) {
    const project = get(projectId);
    if (!project) throw new Error('找不到影片專案');
    const asset = project.assets.find((item) => item.id === assetId);
    if (!asset) throw new Error(`找不到素材 ${assetId}`);
    const source = path.resolve(projectDir(projectId), asset.path);
    if (!source.startsWith(projectDir(projectId) + path.sep) || !fs.existsSync(source))
      throw new Error(`素材 ${assetId} 的檔案不存在`);
    const media = inspectMediaFile(source);
    const expectedKind = asset.kind === 'speaker-video' ? 'video' : asset.kind;
    if (!media || media.kind !== expectedKind || (asset.mediaType && asset.mediaType !== media.mediaType)) {
      const error = new Error(`素材 ${assetId} 已損毀或內容與類型不一致，請重新加入`);
      error.statusCode = 422;
      throw error;
    }
    if (!asset.mediaType) {
      asset.mediaType = media.mediaType;
      save(project);
    }
    if (fs.existsSync(target)) fs.unlinkSync(target);
    linkOrCopy(source, target);
    return asset;
  }

  function assetPath(projectId, assetId) {
    const project = get(projectId);
    const asset = project && project.assets.find((item) => item.id === assetId);
    if (!asset) return null;
    const file = path.resolve(projectDir(projectId), asset.path);
    return file.startsWith(projectDir(projectId) + path.sep) ? file : null;
  }

  function outputDir(projectId) {
    return path.join(projectDir(projectId), 'outputs');
  }

  function outputPath(projectId, revisionId, name) {
    const safeName = path.basename(name).replace(/[^\p{L}\p{N}._-]+/gu, '-');
    const dir = outputDir(projectId);
    ensureDir(dir);
    let target = path.join(dir, `${safeId(revisionId, 'Revision ID')}-${safeName}`);
    let n = 2;
    const ext = path.extname(target);
    const base = target.slice(0, -ext.length);
    while (fs.existsSync(target)) target = `${base}-${n++}${ext}`;
    return target;
  }

  function detail(projectId, revisionId) {
    const project = get(projectId);
    if (!project) return null;
    const targetRevision = revisionId || `v${String(project.latestRevision).padStart(3, '0')}`;
    return { project, revision: getRevision(projectId, targetRevision) };
  }

  return {
    projectsDir,
    create,
    get,
    list,
    addRevision,
    getRevision,
    updateRevision,
    abortRevision,
    ingestAsset,
    materializeAsset,
    assetPath,
    projectDir,
    outputDir,
    outputPath,
    detail,
  };
}

module.exports = { createProjectStore, extensionForMediaType, inspectMediaFile };
