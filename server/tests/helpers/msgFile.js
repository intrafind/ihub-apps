// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A minimal Outlook message as an OLE2 compound file: the subject and the
 * plain body as UTF-16 property streams in the mini stream, one FAT sector,
 * one directory sector, one mini FAT sector. Enough for msgreader, and free
 * of anyone's mail.
 */
export function makeMsg({ subject, body }) {
  const SECTOR = 512;
  const MINI = 64;
  const ENDOFCHAIN = 0xfffffffe;
  const FATSECT = 0xfffffffd;
  const FREESECT = 0xffffffff;
  const NOSTREAM = 0xffffffff;
  const streams = [
    { name: '__substg1.0_0037001F', data: Buffer.from(subject, 'utf16le') },
    { name: '__substg1.0_1000001F', data: Buffer.from(body, 'utf16le') }
  ];
  const miniSectors = [];
  const miniFat = [];
  for (const stream of streams) {
    stream.start = miniSectors.length;
    const count = Math.max(1, Math.ceil(stream.data.length / MINI));
    for (let i = 0; i < count; i += 1) {
      const chunk = Buffer.alloc(MINI);
      stream.data.copy(chunk, 0, i * MINI, Math.min(stream.data.length, (i + 1) * MINI));
      miniSectors.push(chunk);
      miniFat.push(i === count - 1 ? ENDOFCHAIN : stream.start + i + 1);
    }
  }
  const miniStream = Buffer.concat(miniSectors);
  const containerSectors = Math.ceil(miniStream.length / SECTOR);
  // Sectors: 0 FAT, 1 directory, 2 mini FAT, 3… the mini stream container.
  const fat = Buffer.alloc(SECTOR, 0xff);
  const fatEntries = [FATSECT, ENDOFCHAIN, ENDOFCHAIN];
  for (let i = 0; i < containerSectors; i += 1) {
    fatEntries.push(i === containerSectors - 1 ? ENDOFCHAIN : 4 + i);
  }
  fatEntries.forEach((value, index) => fat.writeUInt32LE(value, index * 4));
  const miniFatSector = Buffer.alloc(SECTOR, 0xff);
  miniFat.forEach((value, index) => miniFatSector.writeUInt32LE(value, index * 4));
  const entry = ({ name, type, left, right, child, start, size }) => {
    const buf = Buffer.alloc(128);
    const utf16 = Buffer.from(name, 'utf16le');
    utf16.copy(buf, 0);
    buf.writeUInt16LE(utf16.length + 2, 64);
    buf.writeUInt8(type, 66);
    buf.writeUInt8(1, 67); // black
    buf.writeUInt32LE(left, 68);
    buf.writeUInt32LE(right, 72);
    buf.writeUInt32LE(child, 76);
    buf.writeUInt32LE(start, 116);
    buf.writeUInt32LE(size, 120);
    return buf;
  };
  const directory = Buffer.concat([
    entry({
      name: 'Root Entry',
      type: 5,
      left: NOSTREAM,
      right: NOSTREAM,
      child: 1,
      start: 3,
      size: miniStream.length
    }),
    entry({
      name: streams[0].name,
      type: 2,
      left: NOSTREAM,
      right: 2,
      child: NOSTREAM,
      start: streams[0].start,
      size: streams[0].data.length
    }),
    entry({
      name: streams[1].name,
      type: 2,
      left: NOSTREAM,
      right: NOSTREAM,
      child: NOSTREAM,
      start: streams[1].start,
      size: streams[1].data.length
    }),
    Buffer.alloc(128)
  ]);
  const header = Buffer.alloc(SECTOR);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(header, 0);
  header.writeUInt16LE(0x3e, 24); // minor version
  header.writeUInt16LE(3, 26); // major version
  header.writeUInt16LE(0xfffe, 28); // byte order
  header.writeUInt16LE(9, 30); // sector shift
  header.writeUInt16LE(6, 32); // mini sector shift
  header.writeUInt32LE(1, 44); // FAT sectors
  header.writeUInt32LE(1, 48); // first directory sector
  header.writeUInt32LE(4096, 56); // mini stream cutoff
  header.writeUInt32LE(2, 60); // first mini FAT sector
  header.writeUInt32LE(1, 64); // mini FAT sectors
  header.writeUInt32LE(ENDOFCHAIN, 68); // first DIFAT sector
  header.writeUInt32LE(0, 72); // DIFAT sectors
  for (let i = 0; i < 109; i += 1) header.writeUInt32LE(i === 0 ? 0 : FREESECT, 76 + i * 4);
  const container = Buffer.alloc(containerSectors * SECTOR);
  miniStream.copy(container, 0);
  return Buffer.concat([header, fat, directory, miniFatSector, container]);
}
