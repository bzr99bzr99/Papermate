import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const sizes = [16, 32, 48, 64, 128, 256];
const icons = [
  {
    sourcePath: join(rootDir, "papermate.png"),
    iconPath: join(rootDir, "papermate.ico"),
  },
  {
    sourcePath: join(rootDir, "scripts", "papermate-uninstall-icon.svg"),
    iconPath: join(rootDir, "papermate-uninstall.ico"),
  },
];

for (const { sourcePath, iconPath } of icons) {
  const source = await readFile(sourcePath);

  const images = await Promise.all(
    sizes.map(async (size) => {
      const png = await sharp(source).resize(size, size).png().toBuffer();
      return { size, data: png };
    }),
  );

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(images.length * 16);
  let offset = 6 + entries.length;
  images.forEach((image, index) => {
    const entry = index * 16;
    const dimension = image.size >= 256 ? 0 : image.size;
    entries.writeUInt8(dimension, entry);
    entries.writeUInt8(dimension, entry + 1);
    entries.writeUInt16LE(1, entry + 4);
    entries.writeUInt16LE(32, entry + 6);
    entries.writeUInt32LE(image.data.length, entry + 8);
    entries.writeUInt32LE(offset, entry + 12);
    offset += image.data.length;
  });

  await writeFile(iconPath, Buffer.concat([header, entries, ...images.map((image) => image.data)]));
  console.log(`Created ${iconPath}`);
}
