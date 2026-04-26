export type ZipEntry = {
  path: string;
  content: string;
  updatedAt?: string | null;
};

type ZipEntrySource = Iterable<ZipEntry> | AsyncIterable<ZipEntry>;

export function toAsciiDownloadName(value: string, fallback: string) {
  const cleaned = String(value ?? "")
    .replace(/[^\x20-\x7e]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
}

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(value: Date) {
  const year = Math.min(2107, Math.max(1980, value.getFullYear()));
  const month = value.getMonth() + 1;
  const day = value.getDate();
  const hours = value.getHours();
  const minutes = value.getMinutes();
  const seconds = Math.floor(value.getSeconds() / 2);
  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day
  };
}

function createZipEndRecord(entryCount: number, centralSize: number, centralOffset: number) {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return end;
}

function isAsyncZipEntrySource(source: ZipEntrySource): source is AsyncIterable<ZipEntry> {
  return Symbol.asyncIterator in Object(source);
}

async function* iterateZipEntries(source: ZipEntrySource) {
  if (isAsyncZipEntrySource(source)) {
    for await (const entry of source) yield entry;
    return;
  }
  for (const entry of source) yield entry;
}

export function buildZipStream(entries: ZipEntrySource) {
  const centralDirectory: Buffer[] = [];
  let offset = 0;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let writtenEntries = 0;
      try {
        for await (const entry of iterateZipEntries(entries)) {
          const fileName = Buffer.from(entry.path, "utf8");
          const content = Buffer.from(entry.content, "utf8");
          const crc = crc32(content);
          const dateTime = toDosDateTime(entry.updatedAt ? new Date(entry.updatedAt) : new Date());
          const flags = 0x0800;

          const localHeader = Buffer.alloc(30);
          localHeader.writeUInt32LE(0x04034b50, 0);
          localHeader.writeUInt16LE(20, 4);
          localHeader.writeUInt16LE(flags, 6);
          localHeader.writeUInt16LE(0, 8);
          localHeader.writeUInt16LE(dateTime.time, 10);
          localHeader.writeUInt16LE(dateTime.date, 12);
          localHeader.writeUInt32LE(crc, 14);
          localHeader.writeUInt32LE(content.length, 18);
          localHeader.writeUInt32LE(content.length, 22);
          localHeader.writeUInt16LE(fileName.length, 26);
          localHeader.writeUInt16LE(0, 28);

          controller.enqueue(localHeader);
          controller.enqueue(fileName);
          controller.enqueue(content);

          const centralHeader = Buffer.alloc(46);
          centralHeader.writeUInt32LE(0x02014b50, 0);
          centralHeader.writeUInt16LE(20, 4);
          centralHeader.writeUInt16LE(20, 6);
          centralHeader.writeUInt16LE(flags, 8);
          centralHeader.writeUInt16LE(0, 10);
          centralHeader.writeUInt16LE(dateTime.time, 12);
          centralHeader.writeUInt16LE(dateTime.date, 14);
          centralHeader.writeUInt32LE(crc, 16);
          centralHeader.writeUInt32LE(content.length, 20);
          centralHeader.writeUInt32LE(content.length, 24);
          centralHeader.writeUInt16LE(fileName.length, 28);
          centralHeader.writeUInt16LE(0, 30);
          centralHeader.writeUInt16LE(0, 32);
          centralHeader.writeUInt16LE(0, 34);
          centralHeader.writeUInt16LE(0, 36);
          centralHeader.writeUInt32LE(0, 38);
          centralHeader.writeUInt32LE(offset, 42);

          centralDirectory.push(centralHeader, fileName);
          offset += localHeader.length + fileName.length + content.length;
          writtenEntries += 1;
        }

        const centralSize = centralDirectory.reduce((total, part) => total + part.length, 0);
        const end = createZipEndRecord(writtenEntries, centralSize, offset);
        for (const part of centralDirectory) controller.enqueue(part);
        controller.enqueue(end);
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    }
  });
}
