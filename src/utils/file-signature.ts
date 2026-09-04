import path from "path";

export type SupportedImageType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

const signatures: Record<
  SupportedImageType,
  (buffer: Buffer) => boolean
> = {
  "image/jpeg": (buffer) => {
    return (
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    );
  },

  "image/png": (buffer) => {
    return (
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    );
  },

  "image/gif": (buffer) => {
    if (buffer.length < 6) {
      return false;
    }

    const header = buffer.subarray(0, 6).toString("ascii");

    return header === "GIF87a" || header === "GIF89a";
  },

  "image/webp": (buffer) => {
    if (buffer.length < 12) {
      return false;
    }

    const riff = buffer.subarray(0, 4).toString("ascii");
    const webp = buffer.subarray(8, 12).toString("ascii");

    return riff === "RIFF" && webp === "WEBP";
  },
};

export function hasValidImageSignature(
  buffer: Buffer,
  mimeType: string
): boolean {
  const validator =
    signatures[mimeType as SupportedImageType];

  if (!validator) {
    return false;
  }

  return validator(buffer);
}

export function hasValidImageExtension(
  filename: string,
  mimeType: string
): boolean {
  const extension = path
    .extname(filename)
    .toLowerCase();

  const expectedExtensions: Record<
    SupportedImageType,
    string[]
  > = {
    "image/jpeg": [".jpg", ".jpeg"],
    "image/png": [".png"],
    "image/gif": [".gif"],
    "image/webp": [".webp"],
  };

  const allowed =
    expectedExtensions[mimeType as SupportedImageType];

  if (!allowed) {
    return false;
  }

  return allowed.includes(extension);
}